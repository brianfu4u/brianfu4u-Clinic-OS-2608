import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
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

test("hybrid PostgreSQL HTTP tracer persists through standard close and server restart", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    const backend = new PostgresClinicalPreviewBackend(pool);
    let expectationId = "";
    await server(backend, async (baseUrl) => {
      const health = await json(baseUrl, "/api/health");
      assert.equal(health.body.mode, "hybrid-postgres-preview");
      assert.deepEqual(health.body.volatile, ["employee-status", "topics", "conversation", "browser-continuation"]);
      assert.match(await (await fetch(baseUrl + "/app.js")).text(), /PostgreSQL clinical chain is durable/);
      const topicId = await prepare(baseUrl);
      const registration = await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", headers: { "idempotency-key": "registration-0001" },
        body: JSON.stringify(update(topicId, "REGISTRATION")),
      });
      assert.equal(registration.response.status, 201);
      assert.equal(registration.body.expectationState, "OPEN");
      assert.equal(registration.body.verificationStatus, "PENDING");
      expectationId = registration.body.expectationId;

      const report = await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", headers: { "idempotency-key": "exam-report-0001" },
        body: JSON.stringify(update(topicId, "EXAM_REPORT", expectationId)),
      });
      assert.equal(report.response.status, 201, JSON.stringify(report.body));
      assert.equal(report.body.workflowId, registration.body.workflowId);
      assert.equal(report.body.expectationState, "MET");
      assert.equal(report.body.verificationStatus, "VERIFIED");

      const closed = await json(baseUrl, "/api/manager/decisions", {
        method: "POST", headers: { "idempotency-key": "manager-close-0001" },
        body: JSON.stringify({ expectationId, action: "CLOSE_STANDARD", reasonCode: null, note: "private note" }),
      });
      assert.equal(closed.response.status, 201);
      assert.equal(closed.body.workflowStatus, "CLOSED");
      assert.doesNotMatch(JSON.stringify(closed.body), /private note|payload|sourceEmployeeId|fields/);

      const changedAction = await json(baseUrl, "/api/manager/decisions", {
        method: "POST", headers: { "idempotency-key": "manager-close-0001" },
        body: JSON.stringify({ expectationId, action: "VOID", reasonCode: "PATIENT_CANCELLED", note: null }),
      });
      assert.equal(changedAction.body.error, "DECISION_ID_CONFLICT");
      const audit = await pool.db.query<{ decided_at: string }>(
        "SELECT decided_at::text FROM manager_decision WHERE expectation_id = $1",
        [expectationId],
      );
      assert.equal(new Date(audit.rows[0].decided_at).toISOString(), NOW);
    });

    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl) => {
      const list = await json(baseUrl, "/api/manager/closures");
      assert.equal(list.body.length, 1);
      assert.equal(list.body[0].expectationId, expectationId);
      assert.equal(list.body[0].workflowStatus, "CLOSED");
      assert.equal(list.body[0].latestDecision.action, "CLOSE_STANDARD");
      const replay = await json(baseUrl, "/api/manager/decisions", {
        method: "POST", headers: { "idempotency-key": "manager-close-0001" },
        body: JSON.stringify({ expectationId, action: "CLOSE_STANDARD", reasonCode: null, note: "private note" }),
      });
      assert.equal(replay.body.workflowStatus, "CLOSED");
      assert.equal(new Date((await pool.db.query<{ decided_at: string }>(
        "SELECT decided_at::text FROM manager_decision WHERE expectation_id = $1",
        [expectationId],
      )).rows[0].decided_at).toISOString(), NOW);
    }, () => "2026-08-30T12:00:00.000Z");
  } finally { await pool.close(); }
});

test("work-update replay is stable across clocks and changed kind with one key conflicts", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    const backend = new PostgresClinicalPreviewBackend(pool);
    let first;
    await server(backend, async (baseUrl) => {
      const topicId = await prepare(baseUrl);
      first = (await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", headers: { "idempotency-key": "stable-clock-key" },
        body: JSON.stringify(update(topicId, "REGISTRATION")),
      })).body;
      const audit = await pool.db.query<{ created_at: string }>(
        "SELECT created_at::text FROM artifact WHERE id = $1",
        [first.artifactId],
      );
      assert.equal(new Date(audit.rows[0].created_at).toISOString(), NOW);
    });
    await server(backend, async (baseUrl) => {
      const topicId = await prepare(baseUrl);
      const replay = await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", headers: { "idempotency-key": "stable-clock-key" },
        body: JSON.stringify(update(topicId, "REGISTRATION")),
      });
      assert.deepEqual(replay.body, first);
      assert.equal(new Date((await pool.db.query<{ created_at: string }>(
        "SELECT created_at::text FROM artifact WHERE id = $1",
        [first.artifactId],
      )).rows[0].created_at).toISOString(), NOW);
      const changedKind = await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", headers: { "idempotency-key": "stable-clock-key" },
        body: JSON.stringify(update(topicId, "EXAM_REPORT", first.expectationId)),
      });
      assert.equal(changedKind.body.error, "ARTIFACT_ID_CONFLICT");
    }, () => "2026-08-30T12:00:00.000Z");
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

      const registration = await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", headers: { "idempotency-key": "registration-0002" },
        body: JSON.stringify(update(topicId, "REGISTRATION")),
      });
      const first = (await json(baseUrl, "/api/manager/closures")).body[0];
      const second = (await json(baseUrl, "/api/manager/closures")).body[0];
      assert.equal(first.expectationState, "OPEN");
      assert.deepEqual(second, first);
      assert.doesNotMatch(JSON.stringify(second), /ordinary private sentinel/);
      assert.equal(registration.body.expectationState, "OPEN");
    });
  } finally { await pool.close(); }
});

test("formal validation and idempotency fail before acquisition; DB failure appends no message", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl, store) => {
      const topicId = (await json(baseUrl, "/api/employee/topics", {
        method: "POST", body: JSON.stringify({ title: "still off duty" }),
      })).body.id;
      const before = pool.acquisitions;
      const offDuty = await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", headers: { "idempotency-key": "registration-0003" },
        body: JSON.stringify(update(topicId, "REGISTRATION")),
      });
      assert.equal(offDuty.body.error, "EMPLOYEE_NOT_ON_DUTY");
      assert.equal(pool.acquisitions, before);
      await json(baseUrl, "/api/employee/status", { method: "PUT", body: JSON.stringify({ status: "ON_DUTY" }) });
      const missingKey = await json(baseUrl, "/api/employee/work-updates", {
        method: "POST", body: JSON.stringify(update(topicId, "REGISTRATION")),
      });
      assert.equal(missingKey.body.error, "INVALID_IDEMPOTENCY_KEY");
      assert.equal(pool.acquisitions, before);
      assert.equal(store.bootstrap(EMPLOYEE).messages.length, 0);

      for (const body of [
        { ...update(topicId, "REGISTRATION"), expectationId: "injected" },
        update(topicId, "EXAM_REPORT"),
        { ...update(topicId, "REGISTRATION"), occurredAt: "2026-08-30T10:00:00.000Z" },
      ]) {
        const rejected = await json(baseUrl, "/api/employee/work-updates", {
          method: "POST", headers: { "idempotency-key": `preflight-${body.kind}-${body.occurredAt}` },
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
    async submitWorkUpdate() { throw new Error("database unavailable"); },
    async listManagerClosures() { return []; },
    async submitManagerDecision() { throw new Error("unused"); },
  };
  await server(failing, async (baseUrl, store) => {
    const topicId = await prepare(baseUrl);
    const failed = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST", headers: { "idempotency-key": "registration-0004" },
      body: JSON.stringify(update(topicId, "REGISTRATION")),
    });
    assert.equal(failed.response.status, 500);
    assert.equal(store.bootstrap(EMPLOYEE).messages.length, 0);
  });
});

test("explicit postgres startup profile requires configuration and never falls back", () => {
  assert.throws(
    () => createConfiguredPreviewServer({ PREVIEW_MODE: "postgres" }),
    /DATABASE_URL_REQUIRED/,
  );
  assert.throws(
    () => createConfiguredPreviewServer({ PREVIEW_MODE: "unknown" }),
    /INVALID_PREVIEW_MODE/,
  );
});

test("exact keys replay once locally, conflicting content, injected authority and workflow-only decisions fail closed", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await server(new PostgresClinicalPreviewBackend(pool), async (baseUrl, store) => {
      const topicId = await prepare(baseUrl);
      const request = {
        method: "POST", headers: { "idempotency-key": "registration-0005" },
        body: JSON.stringify(update(topicId, "REGISTRATION")),
      };
      const first = await json(baseUrl, "/api/employee/work-updates", request);
      const replay = await json(baseUrl, "/api/employee/work-updates", request);
      assert.deepEqual(replay.body, first.body);
      assert.equal(store.bootstrap(EMPLOYEE).messages.length, 2);

      const conflict = await json(baseUrl, "/api/employee/work-updates", {
        ...request, body: JSON.stringify({ ...update(topicId, "REGISTRATION"), text: "different" }),
      });
      assert.equal(conflict.response.status, 400);
      assert.equal(conflict.body.error, "ARTIFACT_ID_CONFLICT");

      const injected = await json(baseUrl, "/api/employee/work-updates", {
        ...request,
        headers: { "idempotency-key": "registration-0006" },
        body: JSON.stringify({ ...update(topicId, "REGISTRATION"), clinicId: "other-clinic" }),
      });
      assert.equal(injected.body.error, "FORBIDDEN_EMPLOYEE_FIELDS");

      const workflowOnly = await json(baseUrl, "/api/manager/decisions", {
        method: "POST", headers: { "idempotency-key": "manager-close-0002" },
        body: JSON.stringify({ workflowId: first.body.workflowId, action: "CLOSE_STANDARD", reasonCode: null, note: null }),
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
});
