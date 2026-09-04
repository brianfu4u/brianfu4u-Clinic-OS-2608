import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";

import type { ActorContext } from "../src/domain/contracts.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import type { DatabaseConnection, DatabasePool, DatabaseQueryResult } from "../src/persistence/database-contracts.ts";
import {
  PostgresClinicalPreviewBackend,
  type ManagerAttentionGuidanceItem,
} from "../src/preview/clinical-preview-backend.ts";
import { createPreviewServer } from "../src/preview/server.ts";

const EMPLOYEE: ActorContext = { clinicId: "clinic-a", actorId: "employee-a", role: "EMPLOYEE" };
const MANAGER: ActorContext = { clinicId: "clinic-a", actorId: "manager-a", role: "MANAGER" };
const NOW = "2026-09-01T09:10:00.000Z";

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

class RecommendationFixture {
  calls: Array<{ context: ActorContext; workflowId: string }> = [];
  result: unknown = {
    status: "AVAILABLE",
    schemaVersion: "clinic-os/manager-attention-guidance/v1",
    suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
    reasonCodes: ["MISSING_PRESCRIPTION"],
  };

  async recommend(context: ActorContext, attention: { workflowId: string }): Promise<never> {
    this.calls.push({ context: structuredClone(context), workflowId: attention.workflowId });
    return this.result as never;
  }
}

async function withBackend(
  configured: RecommendationFixture | null,
  run: (backend: PostgresClinicalPreviewBackend, fixture: RecommendationFixture | null) => Promise<void>,
) {
  const pool = new Pool();
  await pool.migrate();
  const backend = new PostgresClinicalPreviewBackend(pool, {
    localRecommendations: configured as never,
  });
  try {
    await backend.createRegistrationTrigger(EMPLOYEE, {
      identityAnchor: "DEMO-001", occurredAt: "2026-09-01T09:00:00.000Z",
      receivedAt: NOW, idempotencyKey: "registration-0001",
    });
    await run(backend, configured);
  } finally { await pool.close(); }
}

test("manager guidance validates authority and tenant before optional model work, then redacts the projection", async () => {
  const fixture = new RecommendationFixture();
  await withBackend(fixture, async (backend) => {
    await assert.rejects(backend.listManagerAttentionGuidance({ ...MANAGER, role: "EMPLOYEE" }));
    assert.equal(fixture.calls.length, 0);
    assert.deepEqual(await backend.listManagerAttentionGuidance({ ...MANAGER, clinicId: "clinic-b" }), []);
    assert.equal(fixture.calls.length, 0);

    const guidance = await backend.listManagerAttentionGuidance(MANAGER);
    assert.deepEqual(guidance, [{
      status: "AVAILABLE", suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW", reasonCodes: ["MISSING_PRESCRIPTION"],
    } satisfies ManagerAttentionGuidanceItem]);
    assert.equal(fixture.calls.length, 1);
    const serialized = JSON.stringify(guidance);
    for (const privateValue of [fixture.calls[0].workflowId, "DEMO-001", "EYE_EXAM", "model", "endpoint"]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });
});

test("missing, failed or malformed local guidance stays bounded and does not block the manager projection", async () => {
  await withBackend(null, async (backend) => {
    assert.deepEqual(await backend.listManagerAttentionGuidance(MANAGER), [
      { status: "UNAVAILABLE", code: "LOCAL_RECOMMENDATION_UNAVAILABLE" },
    ]);
  });

  const fixture = new RecommendationFixture();
  fixture.result = { status: "AVAILABLE", schemaVersion: "clinic-os/manager-attention-guidance/v1", suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW", reasonCodes: ["MISSING_PRESCRIPTION"], modelId: "private-model" };
  await withBackend(fixture, async (backend) => {
    assert.deepEqual(await backend.listManagerAttentionGuidance(MANAGER), [
      { status: "UNAVAILABLE", code: "LOCAL_RECOMMENDATION_UNAVAILABLE" },
    ]);
  });
});

test("guidance is a read-only manager route with no unsafe correlation fields", async () => {
  await withBackend(null, async (backend) => {
    const server = createPreviewServer({ employeeContext: EMPLOYEE, managerContext: MANAGER, clinicalBackend: backend });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${baseUrl}/api/manager/attention-guidance`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, [{ status: "UNAVAILABLE", code: "LOCAL_RECOMMENDATION_UNAVAILABLE" }]);
      const write = await fetch(`${baseUrl}/api/manager/attention-guidance`, { method: "POST" });
      assert.equal(write.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
