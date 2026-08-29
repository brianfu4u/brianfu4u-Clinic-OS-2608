import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { PreviewStore } from "../src/preview/preview-store.ts";
import { createPreviewServer } from "../src/preview/server.ts";

const REGISTRATION_AT = "2026-08-29T09:00:00.000Z";
const REPORT_AT = "2026-08-29T09:10:00.000Z";
const NOW = "2026-08-29T09:10:00.000Z";

async function withServer(run: (baseUrl: string, store: PreviewStore) => Promise<void>) {
  const store = new PreviewStore();
  const server = createPreviewServer({ store, clock: () => NOW });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function json(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  return { response, body: await response.json() };
}

async function topic(baseUrl: string): Promise<string> {
  const { body } = await json(baseUrl, "/api/employee/topics", {
    method: "POST",
    body: JSON.stringify({ title: "Synthetic tracer" }),
  });
  return body.id;
}

async function setOnDuty(baseUrl: string): Promise<void> {
  const { response } = await json(baseUrl, "/api/employee/status", {
    method: "PUT",
    body: JSON.stringify({ status: "ON_DUTY" }),
  });
  assert.equal(response.status, 200);
}

function update(topicId: string, overrides: Record<string, unknown> = {}) {
  return {
    topicId,
    kind: "REGISTRATION",
    identityAnchor: "DEMO-001",
    workflowFamily: "EYE_EXAM",
    occurredAt: REGISTRATION_AT,
    text: "synthetic registration",
    ...overrides,
  };
}

test("employee, manager and health endpoints respond", async () => {
  await withServer(async (baseUrl) => {
    for (const path of ["/employee", "/manager"]) {
      const response = await fetch(baseUrl + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    }
    const { response, body } = await json(baseUrl, "/api/health");
    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: "ok", mode: "synthetic-local-preview" });
  });
});

test("employee starts OFF_DUTY and status changes only on employee route", async () => {
  await withServer(async (baseUrl) => {
    const initial = await json(baseUrl, "/api/employee/bootstrap");
    assert.equal(initial.body.status, "OFF_DUTY");
    await setOnDuty(baseUrl);
    assert.equal((await json(baseUrl, "/api/employee/bootstrap")).body.status, "ON_DUTY");

    const managerMutation = await json(baseUrl, "/api/manager/status", {
      method: "PUT",
      body: JSON.stringify({ status: "OFF_DUTY" }),
    });
    assert.equal(managerMutation.response.status, 404);
    assert.equal((await json(baseUrl, "/api/employee/bootstrap")).body.status, "ON_DUTY");
  });
});

test("ordinary conversation creates messages and no domain state", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    const sent = await json(baseUrl, "/api/employee/messages", {
      method: "POST",
      body: JSON.stringify({ topicId, text: "ordinary private note" }),
    });
    assert.equal(sent.response.status, 201);
    assert.equal(sent.body.length, 2);
    assert.deepEqual(store.debugCounts(), { artifacts: 0, workflows: 0, expectations: 0 });
    assert.deepEqual((await json(baseUrl, "/api/manager/closures")).body, []);
  });
});

test("formal update while OFF_DUTY is rejected without mutation", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    const result = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST",
      body: JSON.stringify(update(topicId)),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "EMPLOYEE_NOT_ON_DUTY");
    assert.deepEqual(store.debugCounts(), { artifacts: 0, workflows: 0, expectations: 0 });
  });
});

test("valid registration creates OPEN quiet manager projection", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    await setOnDuty(baseUrl);
    const result = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST",
      body: JSON.stringify(update(topicId)),
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.expectationState, "OPEN");
    assert.deepEqual(store.debugCounts(), { artifacts: 1, workflows: 1, expectations: 1 });
    const closures = (await json(baseUrl, "/api/manager/closures")).body;
    assert.equal(closures.length, 1);
    assert.equal(closures[0].expectationState, "OPEN");
    assert.equal(closures[0].needsReview, false);
  });
});

test("registration becomes UNMET exactly at its due boundary", () => {
  const store = new PreviewStore();
  store.setStatus("ON_DUTY");
  const topic = store.createTopic("Synthetic tracer", REGISTRATION_AT);
  store.submitWorkUpdate(update(topic.id, { now: REGISTRATION_AT }));

  const [closure] = store.managerClosures("2026-08-29T09:15:00.000Z");
  assert.equal(closure.expectationState, "UNMET");
  assert.equal(closure.needsReview, true);
  assert.deepEqual(closure.reasonCodes, ["EXPECTATION_UNMET"]);
});

test("same-anchor EXAM_REPORT attaches to the same Workflow and becomes MET", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    await setOnDuty(baseUrl);
    const registration = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST", body: JSON.stringify(update(topicId)),
    });
    const report = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST",
      body: JSON.stringify(update(topicId, {
        kind: "EXAM_REPORT",
        occurredAt: REPORT_AT,
        text: "synthetic report",
      })),
    });
    assert.equal(report.response.status, 201);
    assert.equal(report.body.workflowId, registration.body.workflowId);
    assert.equal(report.body.expectationState, "MET");
    assert.deepEqual(store.debugCounts(), { artifacts: 2, workflows: 1, expectations: 1 });
  });
});

test("near-miss anchor cannot attach to the existing Workflow", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    await setOnDuty(baseUrl);
    await json(baseUrl, "/api/employee/work-updates", {
      method: "POST", body: JSON.stringify(update(topicId)),
    });
    const report = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST",
      body: JSON.stringify(update(topicId, {
        kind: "EXAM_REPORT",
        identityAnchor: "DEMO-OO1",
        occurredAt: REPORT_AT,
      })),
    });
    assert.equal(report.response.status, 400);
    assert.equal(report.body.error, "UNSUPPORTED_PREVIEW_SEQUENCE");
    assert.deepEqual(store.debugCounts(), { artifacts: 1, workflows: 1, expectations: 1 });
  });
});

test("report without registration is rejected rather than guessed", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    await setOnDuty(baseUrl);
    const report = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST",
      body: JSON.stringify(update(topicId, { kind: "EXAM_REPORT", occurredAt: REPORT_AT })),
    });
    assert.equal(report.response.status, 400);
    assert.equal(report.body.error, "UNSUPPORTED_PREVIEW_SEQUENCE");
    assert.deepEqual(store.debugCounts(), { artifacts: 0, workflows: 0, expectations: 0 });
  });
});

test("report dated before its exact-anchor registration is rejected", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    await setOnDuty(baseUrl);
    await json(baseUrl, "/api/employee/work-updates", {
      method: "POST", body: JSON.stringify(update(topicId)),
    });
    const report = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST",
      body: JSON.stringify(update(topicId, {
        kind: "EXAM_REPORT",
        occurredAt: "2026-08-29T08:59:59.999Z",
      })),
    });
    assert.equal(report.response.status, 400);
    assert.equal(report.body.error, "UNSUPPORTED_PREVIEW_SEQUENCE");
    assert.deepEqual(store.debugCounts(), { artifacts: 1, workflows: 1, expectations: 1 });
  });
});

test("manager payload excludes conversation and employee monitoring fields", async () => {
  await withServer(async (baseUrl) => {
    const topicId = await topic(baseUrl);
    await json(baseUrl, "/api/employee/messages", {
      method: "POST",
      body: JSON.stringify({ topicId, text: "ordinary private note sentinel" }),
    });
    await setOnDuty(baseUrl);
    await json(baseUrl, "/api/employee/work-updates", {
      method: "POST", body: JSON.stringify(update(topicId)),
    });
    const closures = await json(baseUrl, "/api/manager/closures");
    const serialized = JSON.stringify(closures.body);
    assert.doesNotMatch(serialized, /ordinary private note sentinel/);
    assert.doesNotMatch(serialized, /employeeId|score|ranking|elapsed|duration/i);
  });
});

test("malformed JSON and invalid enums return 4xx without mutation", async () => {
  await withServer(async (baseUrl, store) => {
    const malformed = await fetch(baseUrl + "/api/employee/topics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, "MALFORMED_JSON");
    const invalid = await json(baseUrl, "/api/employee/status", {
      method: "PUT",
      body: JSON.stringify({ status: "WATCHING" }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error, "INVALID_EMPLOYEE_STATUS");
    assert.equal((await json(baseUrl, "/api/employee/bootstrap")).body.status, "OFF_DUTY");
    assert.deepEqual(store.debugCounts(), { artifacts: 0, workflows: 0, expectations: 0 });
  });
});

test("static route whitelist blocks path traversal", async () => {
  await withServer(async (baseUrl) => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/public/%2e%2e/server.ts"]) {
      const response = await fetch(baseUrl + path);
      assert.equal(response.status, 404);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    }
  });
});

test("synthetic anchor boundary rejects non-DEMO identities", async () => {
  await withServer(async (baseUrl, store) => {
    const topicId = await topic(baseUrl);
    await setOnDuty(baseUrl);
    const result = await json(baseUrl, "/api/employee/work-updates", {
      method: "POST",
      body: JSON.stringify(update(topicId, { identityAnchor: "P-REAL-001" })),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "SYNTHETIC_ANCHOR_REQUIRED");
    assert.deepEqual(store.debugCounts(), { artifacts: 0, workflows: 0, expectations: 0 });
  });
});
