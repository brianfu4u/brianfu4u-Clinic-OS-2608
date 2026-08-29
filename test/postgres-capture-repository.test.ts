import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext, Artifact, EvidenceFactCard } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { CaptureRepository } from "../src/persistence/capture-repository.ts";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import {
  applyMigrations,
  loadRepositoryMigrations,
} from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

type LoggedQuery = { text: string; values?: readonly unknown[] };

class PGlitePoolShim implements DatabasePool {
  readonly db = new PGlite();
  readonly queries: LoggedQuery[] = [];
  acquisitions = 0;
  releases = 0;

  async migrate(): Promise<void> {
    await applyMigrations(this.db, await loadRepositoryMigrations());
    this.queries.length = 0;
  }

  async connect(): Promise<DatabaseConnection> {
    this.acquisitions += 1;
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<DatabaseQueryResult<Row>> => {
        this.queries.push({ text, values });
        const result = await this.db.query<Row>(text, values as unknown[] | undefined);
        return { rows: result.rows };
      },
      release: () => {
        this.releases += 1;
      },
    };
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

const employee = (clinicId = "clinic-a"): ActorContext => ({
  clinicId,
  actorId: "employee-a",
  role: "EMPLOYEE",
});

function capture(
  clinicId = "clinic-a",
  artifactId = "artifact-a",
  factCardId = "fact-a",
): { artifact: Artifact; factCard: EvidenceFactCard } {
  return {
    artifact: {
      id: artifactId,
      clinicId,
      kind: "REGISTRATION",
      occurredAt: "2026-08-29T09:00:00.000Z",
      occurredAtSource: "source",
      sourceEmployeeId: "employee-a",
      identityAnchor: " PAT-001 ",
      payload: { source: "scan", nested: { count: 1 } },
      createdAt: "2026-08-29T09:00:01.000Z",
    },
    factCard: {
      id: factCardId,
      clinicId,
      artifactId,
      subjectType: "PATIENT",
      identityAnchor: " PAT-001 ",
      workflowFamily: "EYE_EXAM",
      occurredAt: "2026-08-29T09:00:00.000Z",
      fields: { registration: true, nested: { room: "03" } },
      missingFields: ["exam_report"],
      confidence: 0.9,
      parserVersion: "parser-1",
      lineageArtifactIds: [artifactId],
    },
  };
}

test("tenant transaction sets exact clinic after BEGIN and before business SQL", async () => {
  const events: LoggedQuery[] = [];
  const pool: DatabasePool = {
    async connect() {
      return {
        async query(text, values) {
          events.push({ text, values });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  await withTenantTransaction(pool, " clinic-exact ", async (client) => {
    await client.query("SELECT business_query WHERE id = $1", ["value"]);
  });
  assert.deepEqual(events.map(({ text }) => text), [
    "BEGIN",
    "SELECT set_config('app.clinic_id', $1, true)",
    "SELECT business_query WHERE id = $1",
    "COMMIT",
  ]);
  assert.deepEqual(events[1].values, [" clinic-exact "]);
});

test("tenant transaction success commits and releases exactly once", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    assert.equal(await withTenantTransaction(pool, "clinic-a", async () => "ok"), "ok");
    assert.deepEqual(pool.queries.map(({ text }) => text), [
      "BEGIN",
      "SELECT set_config('app.clinic_id', $1, true)",
      "COMMIT",
    ]);
    assert.equal(pool.releases, 1);
  } finally {
    await pool.close();
  }
});

test("tenant transaction failure rolls back and releases exactly once", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await assert.rejects(withTenantTransaction(pool, "clinic-a", async () => {
      throw new Error("operation failed");
    }), /operation failed/);
    assert.deepEqual(pool.queries.map(({ text }) => text), [
      "BEGIN",
      "SELECT set_config('app.clinic_id', $1, true)",
      "ROLLBACK",
    ]);
    assert.equal(pool.releases, 1);
  } finally {
    await pool.close();
  }
});

test("blank clinic fails before connection acquisition", async () => {
  const pool = new PGlitePoolShim();
  try {
    await assert.rejects(withTenantTransaction(pool, "   ", async () => undefined), /CLINIC_ID_REQUIRED/);
    assert.equal(pool.acquisitions, 0);
  } finally {
    await pool.close();
  }
});

test("malformed lineage or mismatched clinic persists neither row", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const malformed = capture();
    malformed.factCard.lineageArtifactIds = [];
    await assert.rejects(
      repository.saveCapture(employee(), malformed.artifact, malformed.factCard),
      (error: unknown) => error instanceof DomainError && error.code === "FACT_CARD_LINEAGE_INVALID",
    );
    const mismatched = capture();
    mismatched.factCard.clinicId = "clinic-b";
    await assert.rejects(
      repository.saveCapture(employee(), mismatched.artifact, mismatched.factCard),
      (error: unknown) => error instanceof DomainError && error.code === "TENANT_SCOPE_VIOLATION",
    );
    const wrongArtifact = capture();
    wrongArtifact.factCard.artifactId = "artifact-other";
    await assert.rejects(
      repository.saveCapture(employee(), wrongArtifact.artifact, wrongArtifact.factCard),
      (error: unknown) => error instanceof DomainError && error.code === "FACT_CARD_ARTIFACT_MISMATCH",
    );
    assert.equal(pool.acquisitions, 0);
    const counts = await pool.db.query<{ artifacts: number; facts: number }>(
      `SELECT (SELECT count(*)::int FROM artifact) AS artifacts,
              (SELECT count(*)::int FROM evidence_fact_card) AS facts`,
    );
    assert.deepEqual(counts.rows[0], { artifacts: 0, facts: 0 });
  } finally {
    await pool.close();
  }
});

test("Artifact and FactCard persist atomically and round-trip verbatim", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const input = capture();
    await repository.saveCapture(employee(), input.artifact, input.factCard);
    assert.deepEqual(await repository.getArtifact(employee(), input.artifact.id), input.artifact);
    assert.deepEqual(await repository.getFactCard(employee(), input.factCard.id), input.factCard);
  } finally {
    await pool.close();
  }
});

test("reordered JSON object keys replay idempotently", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const original = capture();
    await repository.saveCapture(employee(), original.artifact, original.factCard);
    const replay = capture();
    replay.artifact.payload = { nested: { count: 1 }, source: "scan" };
    replay.factCard.fields = { nested: { room: "03" }, registration: true };
    await repository.saveCapture(employee(), replay.artifact, replay.factCard);
    const counts = await pool.db.query<{ artifacts: number; facts: number }>(
      `SELECT (SELECT count(*)::int FROM artifact) AS artifacts,
              (SELECT count(*)::int FROM evidence_fact_card) AS facts`,
    );
    assert.deepEqual(counts.rows[0], { artifacts: 1, facts: 1 });
  } finally {
    await pool.close();
  }
});

test("conflicting Artifact replay fails without changing either row", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const original = capture();
    await repository.saveCapture(employee(), original.artifact, original.factCard);
    const conflict = capture();
    conflict.artifact.identityAnchor = "PAT-DIFFERENT";
    await assert.rejects(
      repository.saveCapture(employee(), conflict.artifact, conflict.factCard),
      (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_ID_CONFLICT",
    );
    assert.deepEqual(await repository.getArtifact(employee(), original.artifact.id), original.artifact);
    assert.deepEqual(await repository.getFactCard(employee(), original.factCard.id), original.factCard);
  } finally {
    await pool.close();
  }
});

test("conflicting FactCard replay rolls back a newly inserted Artifact", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const original = capture();
    await repository.saveCapture(employee(), original.artifact, original.factCard);
    const conflict = capture("clinic-a", "artifact-new", original.factCard.id);
    await assert.rejects(
      repository.saveCapture(employee(), conflict.artifact, conflict.factCard),
      (error: unknown) => error instanceof DomainError && error.code === "FACT_CARD_ID_CONFLICT",
    );
    assert.equal(await repository.getArtifact(employee(), conflict.artifact.id), null);
    assert.deepEqual(await repository.getFactCard(employee(), original.factCard.id), original.factCard);
  } finally {
    await pool.close();
  }
});

test("same IDs coexist in two clinics and tenant reads remain isolated", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const clinicA = capture("clinic-a");
    const clinicB = capture("clinic-b");
    clinicB.artifact.identityAnchor = "PAT-B";
    clinicB.factCard.identityAnchor = "PAT-B";
    await repository.saveCapture(employee("clinic-a"), clinicA.artifact, clinicA.factCard);
    await repository.saveCapture(employee("clinic-b"), clinicB.artifact, clinicB.factCard);
    assert.deepEqual(await repository.getArtifact(employee("clinic-a"), "artifact-a"), clinicA.artifact);
    assert.deepEqual(await repository.getArtifact(employee("clinic-b"), "artifact-a"), clinicB.artifact);
    assert.equal(await repository.getArtifact(employee("clinic-a"), "missing"), null);
  } finally {
    await pool.close();
  }
});

test("context clinic cannot be overridden by payload authority fields", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const input = capture();
    input.artifact.payload = { clinicId: "clinic-b", clinic_id: "clinic-b", source: "untrusted" };
    await repository.saveCapture(employee(), input.artifact, input.factCard);
    const row = await pool.db.query<{ clinic_id: string; payload: Record<string, unknown> }>(
      "SELECT clinic_id, payload FROM artifact WHERE id = 'artifact-a'",
    );
    assert.equal(row.rows[0].clinic_id, "clinic-a");
    assert.equal(row.rows[0].payload.clinic_id, "clinic-b");
  } finally {
    await pool.close();
  }
});

test("SQL injection text in clinic and IDs remains bound data", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const injection = "x'); DROP TABLE artifact; --";
    const input = capture(injection, injection, injection);
    await repository.saveCapture(employee(injection), input.artifact, input.factCard);
    assert.equal((await repository.getArtifact(employee(injection), injection))?.id, injection);
    const table = await pool.db.query("SELECT 1 FROM pg_tables WHERE tablename = 'artifact'");
    assert.equal(table.rows.length, 1);
    assert.ok(pool.queries.every(({ text }) => !text.includes(injection)));
  } finally {
    await pool.close();
  }
});

test("reads return detached domain values", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new CaptureRepository(pool);
  try {
    const input = capture();
    await repository.saveCapture(employee(), input.artifact, input.factCard);
    const artifact = await repository.getArtifact(employee(), input.artifact.id);
    const factCard = await repository.getFactCard(employee(), input.factCard.id);
    assert.ok(artifact && factCard);
    (artifact.payload as Record<string, unknown>).source = "mutated";
    factCard.fields.registration = false;
    factCard.missingFields.push("mutated");
    assert.deepEqual(await repository.getArtifact(employee(), input.artifact.id), input.artifact);
    assert.deepEqual(await repository.getFactCard(employee(), input.factCard.id), input.factCard);
  } finally {
    await pool.close();
  }
});

test("production pool adapter import has no connection attempt or fallback URL", async () => {
  const source = await readFile(
    new URL("../src/persistence/node-pg-pool.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /PGlite|process\.env|DATABASE_URL|postgres(?:ql)?:\/\//i);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      "import './src/persistence/node-pg-pool.ts'",
    ], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PGHOST: "invalid.invalid", PGCONNECT_TIMEOUT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
});
