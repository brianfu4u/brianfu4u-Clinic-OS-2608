import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { ClinicalPreviewBackend } from "../src/preview/clinical-preview-backend.ts";
import { createPreviewServer } from "../src/preview/server.ts";

const EMPLOYEE: ActorContext = { clinicId: "clinic-a", actorId: "employee-a", role: "EMPLOYEE" };

function backendFor(
  result: unknown,
  calls: Array<{ context: ActorContext; command: unknown }>,
): ClinicalPreviewBackend {
  return {
    async submitExamReportConsequence(context, command) {
      calls.push({ context: structuredClone(context), command: structuredClone(command) });
      return structuredClone(result) as never;
    },
    async submitWorkUpdate() { throw new Error("not used"); },
    async listManagerClosures() { return []; },
    async submitManagerDecision() { throw new Error("not used"); },
  };
}

function completedResult() {
  return {
    status: "COMPLETED",
    reviewStage: null,
    extraction: {
      status: "READY",
      artifact: { id: "artifact:report-0001" },
      factCard: {}, candidate: {}, reasonCodes: [], lineage: {},
    },
    goldenPath: {
      status: "COMPLETED",
      attachment: { workflow: { id: "workflow:exam-0001" } },
      expectation: { expectation: { id: "expectation:registration-0001", state: "MET" } },
      verification: { result: { status: "VERIFIED" } },
    },
  };
}

function reviewResult(stage: "EXTRACTION" | "COMPOSITION") {
  return {
    status: "REVIEW_REQUIRED",
    reviewStage: stage,
    extraction: {
      status: stage === "EXTRACTION" ? "REVIEW_REQUIRED" : "READY",
      artifact: { id: "artifact:report-0001" },
      factCard: null, candidate: {},
      reasonCodes: stage === "EXTRACTION" ? ["LOW_CONFIDENCE"] : [], lineage: {},
    },
    goldenPath: stage === "EXTRACTION" ? null : {
      status: "REVIEW_REQUIRED",
      attachment: { resolution: { kind: "REVIEW_REQUIRED", candidateWorkflowIds: ["secret-id"] } },
      expectation: null, verification: null,
    },
  };
}

const body = {
  requestId: "extract:report-0001",
  artifactId: "artifact:report-0001",
  factCardId: "fact:report-0001",
  objectRef: {
    objectId: "object-0001",
    contentSha256: "a".repeat(64),
    sizeBytes: 1234,
    mediaType: "image/png",
  },
  occurredAt: "2026-08-30T09:10:00.000Z",
  occurredAtSource: "employee_confirmed",
  identityAnchor: "DEMO-001",
  createdAt: "2026-08-30T09:10:01.000Z",
  expectationId: "expectation:registration-0001",
  attachedAt: "2026-08-30T09:10:02.000Z",
  evaluatedAt: "2026-08-30T09:10:03.000Z",
};

async function withServer(backend: ClinicalPreviewBackend, run: (url: string) => Promise<void>) {
  const server = createPreviewServer({ employeeContext: EMPLOYEE, managerContext: {
    clinicId: "clinic-a", actorId: "manager-a", role: "MANAGER",
  }, clinicalBackend: backend });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(url); } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withConfiguredServer(
  backend: ClinicalPreviewBackend,
  options: { extractionBodyTimeoutMs?: number; extractionOperationTimeoutMs?: number },
  run: (url: string) => Promise<void>,
) {
  const server = createPreviewServer({ employeeContext: EMPLOYEE, managerContext: {
    clinicId: "clinic-a", actorId: "manager-a", role: "MANAGER",
  }, clinicalBackend: backend, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(url); } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function request(url: string, value: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}/api/employee/extraction/exam-report`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": body.requestId, ...headers },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  return { response, body: await response.json() };
}

test("local extraction transport injects authority and returns bounded completed projection", async () => {
  const calls: Array<{ context: ActorContext; command: unknown }> = [];
  await withServer(backendFor(completedResult(), calls), async (url) => {
    const result = await request(url, body);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      status: "COMPLETED", reviewStage: null, artifactId: "artifact:report-0001",
      workflowId: "workflow:exam-0001", expectationId: "expectation:registration-0001",
      expectationState: "MET", verificationStatus: "VERIFIED", reasonCodes: [],
    });
    assert.doesNotMatch(JSON.stringify(result.body), /DEMO-001|object-0001|a{64}|path|lineage|provider/i);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].context, EMPLOYEE);
    assert.equal((calls[0].command as any).extraction.kind, "EXAM_REPORT");
    assert.equal((calls[0].command as any).operation.kind, "CONSEQUENCE");
    assert.equal((calls[0].command as any).extraction.objectRef.clinicId, EMPLOYEE.clinicId);
    assert.equal((calls[0].command as any).clinicId, undefined);
  });
});

test("extraction and composition review are distinct safe HTTP outcomes", async () => {
  for (const stage of ["EXTRACTION", "COMPOSITION"] as const) {
    const calls: Array<{ context: ActorContext; command: unknown }> = [];
    await withServer(backendFor(reviewResult(stage), calls), async (url) => {
      const result = await request(url, body);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.status, "REVIEW_REQUIRED");
      assert.equal(result.body.reviewStage, stage);
      assert.equal(result.body.artifactId, body.artifactId);
      assert.equal(result.body.workflowId, null);
      assert.deepEqual(result.body.reasonCodes, stage === "EXTRACTION" ? ["LOW_CONFIDENCE"] : ["MATCHING_AMBIGUITY"]);
      assert.doesNotMatch(JSON.stringify(result.body), /secret-id|DEMO-001|object-0001/);
      assert.equal(calls.length, 1);
    });
  }
});

test("invalid content, duplicate keys, oversized and authority-shaped bodies fail before backend", async () => {
  const calls: Array<{ context: ActorContext; command: unknown }> = [];
  await withServer(backendFor(completedResult(), calls), async (url) => {
    const wrongType = await request(url, body, { "content-type": "text/plain" });
    assert.equal(wrongType.response.status, 415);
    const duplicate = await request(url, `{"requestId":"${body.requestId}","requestId":"other"}`);
    assert.equal(duplicate.response.status, 400);
    const injected = await request(url, { ...body, clinicId: "clinic-b" });
    assert.equal(injected.response.status, 400);
    const huge = await request(url, JSON.stringify({ ...body, identityAnchor: "x".repeat(70_000) }));
    assert.equal(huge.response.status, 413);
    const mismatch = await request(url, body, { "idempotency-key": "different-key-0001" });
    assert.equal(mismatch.response.status, 400);
    assert.equal(calls.length, 0);
  });
});

test("synthetic preview never falls back to in-memory extraction transport", async () => {
  const server = createPreviewServer({ employeeContext: EMPLOYEE });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await request(url, body);
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, {
      error: "PERSISTED_TRANSPORT_UNAVAILABLE",
      message: "Persisted extraction transport is unavailable.",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("application timeout and backend failures use one safe public vocabulary", async () => {
  let calls = 0;
  const delayed: ClinicalPreviewBackend = {
    async submitExamReportConsequence() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return completedResult() as never;
    },
    async submitWorkUpdate() { throw new Error("not used"); },
    async listManagerClosures() { return []; },
    async submitManagerDecision() { throw new Error("not used"); },
  };
  await withConfiguredServer(delayed, { extractionOperationTimeoutMs: 5 }, async (url) => {
    const result = await request(url, body);
    assert.equal(result.response.status, 504);
    assert.deepEqual(result.body, {
      error: "REQUEST_TIMEOUT",
      message: "Request timed out; retry the exact command.",
    });
  });
  assert.equal(calls, 1);

  const failing: ClinicalPreviewBackend = {
    async submitExamReportConsequence() {
      throw new DomainError("OBJECT_STORE_IO_FAILED", "secret /tmp/phi/provider stderr");
    },
    async submitWorkUpdate() { throw new Error("not used"); },
    async listManagerClosures() { return []; },
    async submitManagerDecision() { throw new Error("not used"); },
  };
  await withServer(failing, async (url) => {
    const result = await request(url, body);
    assert.equal(result.response.status, 500);
    assert.deepEqual(result.body, {
      error: "INTERNAL_ERROR", message: "Unexpected extraction error.",
    });
    assert.doesNotMatch(JSON.stringify(result.body), /secret|phi|provider|tmp/);
  });
});
