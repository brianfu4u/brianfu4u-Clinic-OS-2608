import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";

import type { ActorContext } from "../src/domain/contracts.ts";
import type { DatabaseConnection, DatabasePool, DatabaseQueryResult } from "../src/persistence/database-contracts.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import type { ManagerAttentionGapItem, ManagerClosureReadItem } from "../src/persistence/manager-closure-read-repository.ts";
import {
  PostgresClinicalPreviewBackend,
  projectManagerDemoScenarios,
} from "../src/preview/clinical-preview-backend.ts";
import { createPreviewServer } from "../src/preview/server.ts";

const MANAGER: ActorContext = { clinicId: "clinic-a", actorId: "manager-a", role: "MANAGER" };

class Pool implements DatabasePool {
  readonly db = new PGlite();
  async migrate() { await applyMigrations(this.db, await loadRepositoryMigrations()); }
  async connect(): Promise<DatabaseConnection> {
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

function closure(anchor: string, workflowId: string, overrides: Partial<ManagerClosureReadItem> = {}): ManagerClosureReadItem {
  return {
    workflowId, workflowStatus: "OPEN", identityAnchor: anchor, workflowFamily: "EYE_EXAM",
    expectationId: "safe-expectation", expectationState: "OPEN", verificationStatus: "PENDING",
    verificationReasonCodes: [], evidenceArtifactIds: [], needsReview: false, reasonCodes: [], latestDecision: null,
    ...overrides,
  };
}

test("manager demo scenarios project exactly five bounded synthetic walkthrough states", () => {
  const scenarios = projectManagerDemoScenarios([
    closure("DEMO-FIVE-01", "one", { workflowStatus: "CLOSED", expectationState: "MET", verificationStatus: "VERIFIED", latestDecision: { action: "CLOSE_STANDARD", reasonCode: null, decidedAt: "2026-09-01T09:00:00.000Z" } }),
    closure("DEMO-FIVE-02", "two"),
    closure("DEMO-FIVE-03", "three", { expectationState: "UNMET" }),
    closure("DEMO-FIVE-04", "four"),
    closure("DEMO-FIVE-05", "five", { workflowStatus: "CLOSED", expectationState: "MET", verificationStatus: "VERIFIED", latestDecision: { action: "CLOSE_STANDARD", reasonCode: null, decidedAt: "2026-09-01T09:00:00.000Z" } }),
  ], [{ workflowId: "four", workflowFamily: "EYE_EXAM", workflowStatus: "OPEN", stage: "STRUCTURED_ALIGNMENT", alignmentStatus: "MISSING", reasonCodes: ["MISSING_EXAM_REPORT"] } satisfies ManagerAttentionGapItem]);

  assert.deepEqual(scenarios, [
    { scenario: "NORMAL_COMPLETION", status: "READY" }, { scenario: "OPEN_WORK", status: "READY" },
    { scenario: "OVERDUE_WORK", status: "READY" }, { scenario: "ATTENTION_REVIEW", status: "READY" },
    { scenario: "IDEMPOTENT_REPLAY", status: "READY" },
  ]);
  assert.equal(scenarios.every(Object.isFrozen), true);
  assert.doesNotMatch(JSON.stringify(scenarios), /DEMO-|one|expectation|workflow|artifact|note|path|model|error/i);

  assert.deepEqual(projectManagerDemoScenarios([
    closure("DEMO-FIVE-03", "three"),
  ], []), [
    { scenario: "NORMAL_COMPLETION", status: "NOT_PREPARED" }, { scenario: "OPEN_WORK", status: "NOT_PREPARED" },
    { scenario: "OVERDUE_WORK", status: "NOT_PREPARED" }, { scenario: "ATTENTION_REVIEW", status: "NOT_PREPARED" },
    { scenario: "IDEMPOTENT_REPLAY", status: "NOT_PREPARED" },
  ]);
});

test("manager walkthrough checks authorization and performs no write", async () => {
  const pool = new Pool();
  await pool.migrate();
  const backend = new PostgresClinicalPreviewBackend(pool);
  try {
    await assert.rejects(backend.listManagerDemoScenarios({ ...MANAGER, role: "EMPLOYEE" }), /MANAGER/);
    const before = await countRows(pool);
    assert.deepEqual(await backend.listManagerDemoScenarios(MANAGER), [
      { scenario: "NORMAL_COMPLETION", status: "NOT_PREPARED" }, { scenario: "OPEN_WORK", status: "NOT_PREPARED" },
      { scenario: "OVERDUE_WORK", status: "NOT_PREPARED" }, { scenario: "ATTENTION_REVIEW", status: "NOT_PREPARED" },
      { scenario: "IDEMPOTENT_REPLAY", status: "NOT_PREPARED" },
    ]);
    assert.deepEqual(await countRows(pool), before);
  } finally { await pool.close(); }
});

test("manager walkthrough is read-only and uses only server-injected manager authority", async () => {
  const pool = new Pool();
  await pool.migrate();
  const server = createPreviewServer({ managerContext: MANAGER, clinicalBackend: new PostgresClinicalPreviewBackend(pool) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const read = await fetch(`${baseUrl}/api/manager/demo-scenarios`);
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.equal(Array.isArray(body) && body.length, 5);
    assert.doesNotMatch(JSON.stringify(body), /clinicId|actorId|workflowId|expectationId|artifactId|DEMO-|path|model|error/i);
    assert.equal((await fetch(`${baseUrl}/api/manager/demo-scenarios`, { method: "POST" })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.close();
  }
});

async function countRows(pool: Pool): Promise<Record<string, number>> {
  const connection = await pool.connect();
  try {
    const result = await connection.query<{ artifacts: number; workflows: number; expectations: number }>(
      "SELECT (SELECT count(*)::int FROM artifact) AS artifacts, (SELECT count(*)::int FROM workflow) AS workflows, (SELECT count(*)::int FROM expectation) AS expectations",
    );
    return result.rows[0] ?? { artifacts: -1, workflows: -1, expectations: -1 };
  } finally { connection.release(); }
}
