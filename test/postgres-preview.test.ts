import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

import type { ActorContext } from "../src/domain/contracts.ts";
import type { DatabaseConnection, DatabasePool, DatabaseQueryResult } from "../src/persistence/database-contracts.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import type { ClinicalPreviewBackend } from "../src/preview/clinical-preview-backend.ts";
import { PostgresClinicalPreviewBackend } from "../src/preview/clinical-preview-backend.ts";
import { PreviewStore } from "../src/preview/preview-store.ts";
import { createConfiguredPreviewServer, createPreviewServer } from "../src/preview/server.ts";

const NOW = "2026-08-30T09:11:00.000Z";
const EMPLOYEE: ActorContext = { clinicId: "demo-clinic", actorId: "demo-employee", role: "EMPLOYEE" };
const OTHER_EMPLOYEE: ActorContext = { clinicId: "demo-clinic", actorId: "other-employee", role: "EMPLOYEE" };
const MANAGER: ActorContext = { clinicId: "demo-clinic", actorId: "demo-manager", role: "MANAGER" };

class Pool implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  async migrate() { await applyMigrations(this.db, await loadRepositoryMigrations()); }
  async connect(): Promise<DatabaseConnection> {
    this.acquisitions++;
    return {
      query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const result = await this.db.query<Row>(text, values as unknown[] | undefined);
        return { rows: result.rows } satisfies DatabaseQueryResult<Row>;
      },
      release() {},
    };
  }
  close() { return this.db.close(); }
}

async function server(
  backend: ClinicalPreviewBackend,
  run: (baseUrl: string, store: PreviewStore) => Promise<void>,
  clock: () => string = () => NOW,
) {
  const store = new PreviewStore("demo-clinic");
  const instance = createPreviewServer({
    store,
    clock,
    employeeContext: EMPLOYEE,
    managerContext: MANAGER,
    clinicalBackend: backend,
  });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  try { await run(baseUrl, store); }
  finally {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
}

async function json(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...options.headers } : options.headers,
  });
  return { response, body: await response.json() };
}

async function prepare(baseUrl: string) {
  await json(baseUrl, "/api/employee/status", {
    method: "PUT", body: JSON.stringify({ status: "ON_DUTY" }),
  });
  return (await json(baseUrl, "/api/employee/topics", {
    method: "POST", body: JSON.stringify({ title: "Postgres tracer" }),
  })).body.id as string;
}

function update(topicId: string, kind: "REGISTRATION" | "EXAM_REPORT", expectationId?: string) {
  return {
    topicId,
    kind,
    identityAnchor: "DEMO-001",
    workflowFamily: "EYE_EXAM",
    occurredAt: kind === "REGISTRATION" ? "2026-08-30T09:00:00.000Z" : "2026-08-30T09:10:00.000Z",
    text: kind === "REGISTRATION" ? "synthetic registration" : "synthetic report",
    ...(expectationId ? { expectationId } : {}),
  };
}

function registration(identityAnchor = "DEMO-001", occurredAt = "2026-08-30T09:00:00.000Z", key = "registration-0001") {
  return {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ identityAnchor, occurredAt }),
  } satisfies RequestInit;
}

function prescription(identityAnchor = "DEMO-001", occurredAt = "2026-08-30T09:05:00.000Z", key = "prescription-0001") {
  return {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ identityAnchor, occurredAt }),
  } satisfies RequestInit;
}

function previewStableId(prefix: string, context: ActorContext, key: string): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify([context.clinicId, context.actorId, key]))
    .digest("hex")
    .slice(0, 32)}`;
}

test("durable registration then prescription advances the persisted employee chain and survives restart", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    const backend = new PostgresClinicalPreviewBackend(pool);
    let expectationId = "";
    await server(backend, async (baseUrl) => {
      const health = await json(baseUrl, "/api/health");
      assert.equal(health.body.mode, "hybrid-postgres-preview");
      assert.deepEqual(health.body.volatile, ["employee-status", "topics", "conversation", "browser-continuation"]);
      assert.match(await (await fetch(baseUrl + "/app.js")).text(), /PostgreSQL clinical chain is durable/);
      const registered = await json(baseUrl, "/api/employee/registration-trigger", registration());
      assert.equal(registered.response.status, 201);
      assert.equal(registered.body.expectationState, "OPEN");
      assert.equal(registered.body.verificationStatus, "PENDING");
      expectationId = registered.body.expectationId;
      assert.deepEqual(Object.keys(registered.body).sort(), ["expectationId", "expectationState", "status", "verificationStatus"]);
      const beforePrescription = await json(baseUrl, "/api/employee/open-expectations?limit=25");
      assert.deepEqual(beforePrescription.body.items, []);
      const prescribed = await json(baseUrl, "/api/employee/prescription-trigger", prescription());
      assert.equal(prescribed.response.status, 201);
      assert.equal(prescribed.body.expectationState, "OPEN");
      assert.equal(prescribed.body.verificationStatus, "PENDING");
      assert.notEqual(prescribed.body.expectationId, expectationId);
      const list = await json(baseUrl, "/api/employee/open-expectations?limit=25");
      assert.equal(list.body.items[0].expectationId, prescribed.body.expectationId);
      assert.doesNotMatch(JSON.stringify(registered.body), /DEMO|artifact|workflow/i);
    });

    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl) => {
      const list = await json(baseUrl, "/api/employee/open-expectations?limit=25");
      assert.equal(list.body.items.length, 1);
    }, () => "2026-08-30T09:11:00.000Z");
  } finally { await pool.close(); }
});

test("registration replay is stable and changed identity under one key conflicts", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    const backend = new PostgresClinicalPreviewBackend(pool);
    let first;
    await server(backend, async (baseUrl) => {
      first = (await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-001", "2026-08-30T09:00:00.000Z", "stable-clock-key"))).body;
      const audit = await pool.db.query<{ created_at: string }>(
        "SELECT created_at::text FROM artifact",
      );
      assert.equal(new Date(audit.rows[0].created_at).toISOString(), NOW);
    });
    await server(backend, async (baseUrl) => {
      const replay = await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-001", "2026-08-30T09:00:00.000Z", "stable-clock-key"));
      assert.deepEqual(replay.body, first);
      assert.equal(new Date((await pool.db.query<{ created_at: string }>(
        "SELECT created_at::text FROM artifact",
      )).rows[0].created_at).toISOString(), NOW);
      const changed = await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-002", "2026-08-30T09:00:00.000Z", "stable-clock-key"));
      assert.equal(changed.response.status, 409);
      assert.equal(changed.body.error, "REGISTRATION_CONFLICT");
    }, () => "2026-08-30T09:11:00.000Z");
  } finally { await pool.close(); }
});

test("prescription consumes only its employee's current stage, replays exactly, and rejects caller selection", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    const backend = new PostgresClinicalPreviewBackend(pool);
    await server(backend, async (baseUrl) => {
      await json(baseUrl, "/api/employee/registration-trigger", registration());
      const before = pool.acquisitions;
      const injected = await json(baseUrl, "/api/employee/prescription-trigger", {
        method: "POST",
        headers: { "idempotency-key": "prescription-injected-0001" },
        body: JSON.stringify({ identityAnchor: "DEMO-001", occurredAt: "2026-08-30T09:05:00.000Z", expectationId: "injected" }),
      });
      assert.equal(injected.response.status, 400);
      assert.equal(pool.acquisitions, before);

      const outOfOrder = await json(baseUrl, "/api/employee/prescription-trigger", prescription("DEMO-001", "2026-08-30T08:59:00.000Z", "prescription-too-early-0001"));
      assert.equal(outOfOrder.response.status, 409);
      assert.equal(outOfOrder.body.error, "PRESCRIPTION_NOT_CURRENT");
      assert.equal((await pool.db.query<{ count: string }>("SELECT count(*)::text AS count FROM artifact")).rows[0].count, "1");

      const first = await json(baseUrl, "/api/employee/prescription-trigger", prescription());
      const replay = await json(baseUrl, "/api/employee/prescription-trigger", prescription());
      assert.equal(first.response.status, 201);
      assert.deepEqual(replay.body, first.body);
      assert.deepEqual(Object.keys(first.body).sort(), ["expectationId", "expectationState", "status", "verificationStatus"]);
      assert.doesNotMatch(JSON.stringify(first.body), /DEMO|artifact|workflow/i);

      for (const changed of [
        prescription("DEMO-002", "2026-08-30T09:05:00.000Z"),
        prescription("DEMO-001", "2026-08-30T09:06:00.000Z"),
      ]) {
        const conflict = await json(baseUrl, "/api/employee/prescription-trigger", changed);
        assert.equal(conflict.response.status, 409);
      }
    });
    await assert.rejects(
      backend.createPrescriptionTrigger(OTHER_EMPLOYEE, {
        identityAnchor: "DEMO-001", occurredAt: "2026-08-30T09:05:00.000Z", receivedAt: NOW,
        idempotencyKey: "other-employee-prescription-0001",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EXPECTATION_SELECTION_REQUIRED",
    );
  } finally { await pool.close(); }
});

test("prescription fails closed when its stage is expired and returns review for ambiguity", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    const backend = new PostgresClinicalPreviewBackend(pool);
    await server(backend, async (baseUrl) => {
      await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-001", "2026-08-30T09:00:00.000Z", "expired-registration-0001"));
      const expired = await json(baseUrl, "/api/employee/prescription-trigger", prescription("DEMO-001", "2026-08-30T09:05:00.000Z", "expired-prescription-0001"));
      assert.equal(expired.response.status, 409);
      assert.equal(expired.body.error, "PRESCRIPTION_NOT_CURRENT");
    }, () => "2026-08-30T09:16:00.000Z");

    await server(backend, async (baseUrl) => {
      await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-002", "2026-08-30T09:00:00.000Z", "ambiguous-registration-0001"));
      await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-002", "2026-08-30T09:01:00.000Z", "ambiguous-registration-0002"));
      const before = (await pool.db.query<{ count: string }>("SELECT count(*)::text AS count FROM artifact")).rows[0].count;
      const ambiguous = await json(baseUrl, "/api/employee/prescription-trigger", prescription("DEMO-002", "2026-08-30T09:05:00.000Z", "ambiguous-prescription-0001"));
      assert.equal(ambiguous.response.status, 201);
      assert.deepEqual(ambiguous.body, { status: "REVIEW_REQUIRED" });
      assert.equal((await pool.db.query<{ count: string }>("SELECT count(*)::text AS count FROM artifact")).rows[0].count, before);
    });
  } finally { await pool.close(); }
});

test("registration snapshots caller authority and input before the first database await", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let delayed = false;
    const delayedPool: DatabasePool = {
      async connect() {
        const connection = await pool.connect();
        return {
          release: () => connection.release(),
          async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            if (!delayed && text.includes("FROM artifact WHERE clinic_id")) {
              delayed = true;
              entered();
              await gate;
            }
            return connection.query<Row>(text, values);
          },
        };
      },
    };
    const backend = new PostgresClinicalPreviewBackend(delayedPool);
    const context: ActorContext = { ...EMPLOYEE };
    const input = {
      identityAnchor: "DEMO-001",
      occurredAt: "2026-08-30T09:00:00.000Z",
      receivedAt: NOW,
      idempotencyKey: "snapshot-registration-0001",
    };
    const originalArtifactId = previewStableId("artifact", EMPLOYEE, input.idempotencyKey);
    const originalFactCardId = previewStableId("fact", EMPLOYEE, input.idempotencyKey);
    const originalExpectationId = previewStableId("expectation", EMPLOYEE, input.idempotencyKey);
    const pending = backend.createRegistrationTrigger(context, input);
    await started;
    context.clinicId = "other-clinic";
    context.actorId = "other-employee";
    context.role = "MANAGER";
    input.identityAnchor = "DEMO-002";
    input.idempotencyKey = "mutated-registration-0002";
    release();

    const result = await pending;
    assert.deepEqual(result, {
      status: "COMPLETED",
      expectationId: originalExpectationId,
      expectationState: "OPEN",
      verificationStatus: "PENDING",
    });
    assert.deepEqual((await pool.db.query<{
      id: string; clinic_id: string; source_employee_id: string; identity_anchor: string;
    }>("SELECT id, clinic_id, source_employee_id, identity_anchor FROM artifact")).rows, [{
      id: originalArtifactId,
      clinic_id: EMPLOYEE.clinicId,
      source_employee_id: EMPLOYEE.actorId,
      identity_anchor: "DEMO-001",
    }]);
    assert.deepEqual((await pool.db.query<{ id: string; clinic_id: string }>(
      "SELECT id, clinic_id FROM evidence_fact_card",
    )).rows, [{ id: originalFactCardId, clinic_id: EMPLOYEE.clinicId }]);
    assert.equal((await pool.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM artifact WHERE clinic_id = 'other-clinic'",
    )).rows[0].count, "0");
  } finally { await pool.close(); }
});

test("closure GET is read-only and ordinary chat never acquires PostgreSQL", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl) => {
      const before = pool.acquisitions;
      const topicId = await prepare(baseUrl);
      await json(baseUrl, "/api/employee/messages", {
        method: "POST", body: JSON.stringify({ topicId, text: "ordinary private sentinel" }),
      });
      assert.equal(pool.acquisitions, before);

      const registered = await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-001", "2026-08-30T09:00:00.000Z", "registration-0002"));
      const first = (await json(baseUrl, "/api/manager/closures")).body[0];
      const second = (await json(baseUrl, "/api/manager/closures")).body[0];
      assert.equal(first.expectationState, "OPEN");
      assert.deepEqual(second, first);
      assert.doesNotMatch(JSON.stringify(second), /ordinary private sentinel/);
      assert.equal(registered.body.expectationState, "OPEN");
    });
  } finally { await pool.close(); }
});

test("employee open-expectations endpoint is server-scoped, safe, and synthetic-empty", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl) => {
      await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-001", "2026-08-30T09:00:00.000Z", "open-expectation-registration"));
      await json(baseUrl, "/api/employee/prescription-trigger", prescription("DEMO-001", "2026-08-30T09:05:00.000Z", "open-expectation-prescription"));
      const listed = await json(baseUrl, "/api/employee/open-expectations?limit=1");
      assert.equal(listed.response.status, 200);
      assert.equal(listed.body.items.length, 1);
      assert.deepEqual(Object.keys(listed.body.items[0]).sort(), ["consequenceKind", "dueAt", "expectationId", "state", "workflowFamily"]);
      assert.doesNotMatch(JSON.stringify(listed.body), /DEMO-001|demo-employee|workflowId|artifact/i);
      const invalid = await json(baseUrl, "/api/employee/open-expectations?clinicId=other");
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.body.error, "INVALID_EXPECTATION_QUERY");
    });
    const synthetic = createPreviewServer();
    await new Promise<void>((resolve) => synthetic.listen(0, "127.0.0.1", resolve));
    try {
      const result = await json(`http://127.0.0.1:${(synthetic.address() as AddressInfo).port}`, "/api/employee/open-expectations");
      assert.deepEqual(result.body, { items: [], nextCursor: null });
    } finally { await new Promise<void>((resolve) => synthetic.close(() => resolve())); }
  } finally { await pool.close(); }
});

test("registration validation fails before acquisition; durable failures append no message", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl, store) => {
      const before = pool.acquisitions;
      const missingKey = await json(baseUrl, "/api/employee/registration-trigger", {
        method: "POST", body: JSON.stringify({ identityAnchor: "DEMO-001", occurredAt: "2026-08-30T09:00:00.000Z" }),
      });
      assert.equal(missingKey.body.error, "INVALID_IDEMPOTENCY_KEY");
      assert.equal(pool.acquisitions, before);
      assert.equal(store.bootstrap(EMPLOYEE).messages.length, 0);

      for (const body of [
        { identityAnchor: "DEMO-001", occurredAt: "2026-08-30T09:00:00.000Z", expectationId: "injected" },
        { identityAnchor: "DEMO-001 ", occurredAt: "2026-08-30T09:00:00.000Z" },
        { identityAnchor: "DEMO-001", occurredAt: "2026-08-30T10:00:00.000Z" },
      ]) {
        const rejected = await json(baseUrl, "/api/employee/registration-trigger", {
          method: "POST", headers: { "idempotency-key": `preflight-${body.occurredAt}` },
          body: JSON.stringify(body),
        });
        assert.equal(rejected.response.status, 400);
        assert.equal(pool.acquisitions, before);
      }

      const badManagerKey = await json(baseUrl, "/api/manager/decisions", {
        method: "POST", headers: { "idempotency-key": "short" },
        body: JSON.stringify({ expectationId: "unknown", action: "VOID", reasonCode: "PATIENT_CANCELLED", note: null }),
      });
      assert.equal(badManagerKey.body.error, "INVALID_IDEMPOTENCY_KEY");
      assert.equal(pool.acquisitions, before);
    });
  } finally { await pool.close(); }

  const failing: ClinicalPreviewBackend = {
    async createRegistrationTrigger() { throw new Error("database unavailable"); },
    async listManagerClosures() { return []; },
    async submitManagerDecision() { throw new Error("unused"); },
  };
  await server(failing, async (baseUrl, store) => {
    const failed = await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-001", "2026-08-30T09:00:00.000Z", "registration-0004"));
    assert.equal(failed.response.status, 500);
    assert.equal(store.bootstrap(EMPLOYEE).messages.length, 0);
  });
});

test("registration route is exact-body, query-free, and unavailable in synthetic preview", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl) => {
      const before = pool.acquisitions;
      for (const [path, options] of [
        ["/api/employee/registration-trigger?clinicId=other", registration()] as const,
        ["/api/employee/registration-trigger", { method: "POST", headers: { "idempotency-key": "duplicate-0001" }, body: '{"identityAnchor":"DEMO-001","identityAnchor":"DEMO-002","occurredAt":"2026-08-30T09:00:00.000Z"}' }] as const,
        ["/api/employee/registration-trigger", { method: "POST", headers: { "idempotency-key": "content-type-0001", "content-type": "text/plain" }, body: "not json" }] as const,
      ]) {
        const result = await json(baseUrl, path, options);
        assert.ok(result.response.status >= 400);
        assert.deepEqual(Object.keys(result.body).sort(), ["error", "message"]);
        assert.equal(pool.acquisitions, before);
      }
    });
    const synthetic = createPreviewServer();
    await new Promise<void>((resolve) => synthetic.listen(0, "127.0.0.1", resolve));
    try {
      const result = await json(`http://127.0.0.1:${(synthetic.address() as AddressInfo).port}`, "/api/employee/registration-trigger", registration());
      assert.equal(result.response.status, 503);
      assert.equal(result.body.error, "PERSISTED_REGISTRATION_UNAVAILABLE");
      assert.deepEqual((await json(`http://127.0.0.1:${(synthetic.address() as AddressInfo).port}`, "/api/employee/open-expectations")).body, { items: [], nextCursor: null });
    } finally { await new Promise<void>((resolve) => synthetic.close(() => resolve())); }
  } finally { await pool.close(); }
});

test("payment route rejects injected authority before the backend and is unavailable in synthetic preview", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl) => {
      const before = pool.acquisitions;
      const injected = await json(baseUrl, "/api/employee/payment-trigger", {
        method: "POST", headers: { "idempotency-key": "payment-injected-0001" },
        body: JSON.stringify({ identityAnchor: "DEMO-001", occurredAt: "2026-08-30T09:15:00.000Z", expectationId: "injected" }),
      });
      assert.equal(injected.response.status, 400);
      assert.equal(injected.body.error, "INVALID_REGISTRATION_REQUEST");
      assert.equal(pool.acquisitions, before);
    });
    const synthetic = createPreviewServer();
    await new Promise<void>((resolve) => synthetic.listen(0, "127.0.0.1", resolve));
    try {
      const result = await json(`http://127.0.0.1:${(synthetic.address() as AddressInfo).port}`, "/api/employee/payment-trigger", registration());
      assert.equal(result.response.status, 503);
      assert.equal(result.body.error, "PERSISTED_REGISTRATION_UNAVAILABLE");
    } finally { await new Promise<void>((resolve) => synthetic.close(() => resolve())); }
  } finally { await pool.close(); }
});

test("legacy postgres preview and root aliases are rejected without fallback", () => {
  assert.throws(
    () => createConfiguredPreviewServer({ PREVIEW_MODE: "postgres" }),
    /LEGACY_CONFIGURATION_NAME/,
  );
  assert.throws(
    () => createConfiguredPreviewServer({ PREVIEW_MODE: "postgres", DATABASE_URL: "postgresql://localhost/clinic" }),
    /LEGACY_CONFIGURATION_NAME/,
  );
  assert.throws(
    () => createConfiguredPreviewServer({
      PREVIEW_OBJECT_STORE_ROOT: "/var/lib/clinic-os/objects",
    }), /LEGACY_CONFIGURATION_NAME/,
  );
  assert.throws(
    () => createConfiguredPreviewServer({ PREVIEW_MODE: "unknown" }),
    /INVALID_PREVIEW_MODE/,
  );
});

test("configured startup validates all frozen OCR assets before creating the pool", async (t) => {
  const env = {
    CLINIC_OS_PROFILE: "ON_PREM_STRICT",
    DATABASE_URL: "postgresql://localhost/clinic",
    CLINIC_OS_DATABASE_PROVIDER: "LOCAL_POSTGRES",
    CLINIC_OS_FILE_PROVIDER: "LOCAL_OBJECT_STORE",
    CLINIC_OS_INFERENCE_PROVIDER: "LOCAL_MODEL",
    CLINIC_OS_BACKUP_PROVIDER: "LOCAL_ENCRYPTED_BACKUP",
    CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "false",
    CLINIC_OS_MANIFEST_VERSION: "test-v1",
    CLINIC_OS_OBJECT_STORE_ROOT: "/var/lib/clinic-os/objects",
    CLINIC_OS_INFERENCE_CAPABILITIES: "EXTRACT_EYE_EXAM_REPORT",
    WO021_TESSERACT_PATH: "/var/lib/clinic-os/tesseract",
    WO021_TESSDATA_DIR: "/var/lib/clinic-os/tessdata",
  };
  assert.throws(
    () => createConfiguredPreviewServer(env),
    (error) => error instanceof Error && ["OCR_MODEL_UNAVAILABLE", "OCR_MODEL_INTEGRITY_FAILED"].includes(
      (error as Error & { code?: string }).code ?? "",
    ),
  );

  const sourceExecutable = process.env.WO021_TESSERACT_PATH ?? "/usr/bin/tesseract";
  const sourceTessdata = process.env.WO021_TESSDATA_DIR ?? "/usr/share/tesseract-ocr/5/tessdata";
  const root = await mkdtemp(join(tmpdir(), "clinic-os-preview-ocr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tessdata = join(root, "tessdata");
  const configs = join(tessdata, "configs");
  const executable = join(root, "tesseract");
  await mkdir(configs, { recursive: true });
  try {
    await copyFile(sourceExecutable, executable);
    await copyFile(join(sourceTessdata, "eng.traineddata"), join(tessdata, "eng.traineddata"));
    await copyFile(join(sourceTessdata, "configs", "tsv"), join(configs, "tsv"));
  } catch {
    t.skip("real frozen Tesseract assets are not installed in this environment");
    return;
  }
  await writeFile(join(configs, "tsv"), "changed", { flag: "w" });
  assert.throws(
    () => createConfiguredPreviewServer({
      ...env,
      WO021_TESSERACT_PATH: executable,
      WO021_TESSDATA_DIR: tessdata,
    }),
    (error) => error instanceof Error && (error as Error & { code?: string }).code === "OCR_MODEL_INTEGRITY_FAILED",
  );
});

test("registration replay, spoofed authority, and legacy persistent writes fail closed", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl, store) => {
      const request = registration("DEMO-001", "2026-08-30T09:00:00.000Z", "registration-0005");
      const first = await json(baseUrl, "/api/employee/registration-trigger", request);
      const replay = await json(baseUrl, "/api/employee/registration-trigger", request);
      assert.deepEqual(replay.body, first.body);
      assert.equal(store.bootstrap(EMPLOYEE).messages.length, 0);

      const conflict = await json(baseUrl, "/api/employee/registration-trigger", registration("DEMO-002", "2026-08-30T09:00:00.000Z", "registration-0005"));
      assert.equal(conflict.response.status, 409);
      assert.equal(conflict.body.error, "REGISTRATION_CONFLICT");

      const injected = await json(baseUrl, "/api/employee/registration-trigger", {
        method: "POST", headers: { "idempotency-key": "registration-0006" },
        body: JSON.stringify({ identityAnchor: "DEMO-001", occurredAt: "2026-08-30T09:00:00.000Z", clinicId: "other-clinic" }),
      });
      assert.equal(injected.body.error, "INVALID_REGISTRATION_REQUEST");

      const legacy = await json(baseUrl, "/api/employee/work-updates", request);
      assert.equal(legacy.response.status, 409);
      assert.equal(legacy.body.error, "LEGACY_CLINICAL_COMMAND_DISABLED");

      const workflowOnly = await json(baseUrl, "/api/manager/decisions", {
        method: "POST", headers: { "idempotency-key": "manager-close-0002" },
        body: JSON.stringify({ workflowId: "workflow:forbidden", action: "CLOSE_STANDARD", reasonCode: null, note: null }),
      });
      assert.equal(workflowOnly.body.error, "FORBIDDEN_MANAGER_FIELDS");
    });
  } finally { await pool.close(); }
});

test("browser retains pending keys until success, clears them on edit, and gates standard close", async () => {
  const source = await readFile(new URL("../src/preview/public/app.js", import.meta.url), "utf8");
  assert.match(source, /form\.dataset\.idempotencyKey \|\|= crypto\.randomUUID\(\)/);
  assert.match(source, /addEventListener\("input", \(\) => \{ delete form\.dataset\.idempotencyKey; \}\)/);
  assert.match(source, /pendingDecisionKeys\.get\(resourceId\) \|\| crypto\.randomUUID\(\)/);
  assert.match(source, /form\.addEventListener\("input", clear\)/);
  assert.match(source, /item\.verificationStatus === "VERIFIED" \? \["CLOSE_STANDARD", "VOID"\] : \["VOID"\]/);
  assert.match(source, /<option value="PRESCRIPTION"/);
  assert.match(source, /<option value="PAYMENT"/);
  assert.match(source, /kind === "PAYMENT" \? "\/api\/employee\/payment-trigger"/);
  assert.match(source, /validateStageProjection\(result\)/);
  assert.match(source, /composerKind = kind === "PRESCRIPTION" \? "EXAM_REPORT" : kind === "PAYMENT" \? "REGISTRATION" : "PRESCRIPTION"/);
  assert.match(source, /prescriptionStep/);
  assert.match(source, /prescriptionRecorded/);
  assert.match(source, /if \(report && postgresClinical\) void loadOpenExpectations\(form\)/);
  assert.match(source, /employeeIntro/);
  assert.match(source, /managerIntro/);
  assert.match(source, /operational-composer/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*(?:expectation|registration|identity)/i);
  assert.doesNotMatch(source, /prescription-trigger[^\n]*expectationId/);
});
