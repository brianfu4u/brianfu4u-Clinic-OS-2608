import assert from "node:assert/strict";
import test from "node:test";
import { ExtractionGoldenPath } from "../src/application/extraction-golden-path.ts";
import { EYE_EXAM_EXTRACTION_SPEC } from "../src/application/evidence-extraction.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";

const context: ActorContext = { clinicId: "clinic-a", actorId: "employee-a", role: "EMPLOYEE" };
const objectRef = {
  clinicId: "clinic-a", objectId: "object-a", contentSha256: "a".repeat(64), sizeBytes: 3, mediaType: "image/png",
};
const command = {
  extraction: {
    requestId: "request-a", artifactId: "artifact-a", factCardId: "fact-a", objectRef,
    kind: "EXAM_REPORT", occurredAt: "2026-08-30T09:00:00.000Z", occurredAtSource: "source",
    identityAnchor: "PAT-001", createdAt: "2026-08-30T09:00:01.000Z",
  },
  operation: {
    kind: "CONSEQUENCE", expectationId: "expectation-a", attachedAt: "2026-08-30T09:00:02.000Z",
    evaluatedAt: "2026-08-30T09:01:00.000Z",
  },
};

function ready() {
  const artifact = {
    id: "artifact-a", clinicId: "clinic-a", kind: "EXAM_REPORT", occurredAt: command.extraction.occurredAt,
    occurredAtSource: "source", sourceEmployeeId: "employee-a", identityAnchor: "PAT-001",
    payload: { storedObjectRef: objectRef }, createdAt: command.extraction.createdAt,
  };
  return {
    status: "READY" as const,
    artifact,
    factCard: {
      id: "fact-a", clinicId: "clinic-a", artifactId: "artifact-a", subjectType: "PATIENT",
      identityAnchor: "PAT-001", workflowFamily: "EYE_EXAM", occurredAt: artifact.occurredAt,
      fields: { reportType: "EYE_EXAM" }, missingFields: [], confidence: 0.95,
      parserVersion: EYE_EXAM_EXTRACTION_SPEC.parserVersion, lineageArtifactIds: ["artifact-a"],
    },
    candidate: {
      subjectTypeCandidate: "PATIENT", workflowFamilyCandidate: "EYE_EXAM",
      fields: { reportType: "EYE_EXAM" }, missingFields: [], confidence: 0.95,
    },
    reasonCodes: [] as [],
    lineage: {
      requestId: "request-a", providerKind: "LOCAL_MODEL", modelId: EYE_EXAM_EXTRACTION_SPEC.modelId,
      modelManifestSha256: EYE_EXAM_EXTRACTION_SPEC.modelManifestSha256,
      capability: EYE_EXAM_EXTRACTION_SPEC.capability, schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion,
      policyVersion: EYE_EXAM_EXTRACTION_SPEC.policyVersion, parserVersion: EYE_EXAM_EXTRACTION_SPEC.parserVersion,
      completedAt: "2026-08-30T09:00:03.000Z", objectContentSha256: objectRef.contentSha256,
    },
  };
}

function review() {
  const result = ready();
  return {
    ...result,
    status: "REVIEW_REQUIRED" as const,
    factCard: null,
    candidate: { ...result.candidate, fields: {}, missingFields: ["reportType"], confidence: 0.5 },
    reasonCodes: ["LOW_CONFIDENCE", "REQUIRED_FIELDS_MISSING"] as const,
  };
}

function completed() {
  return { status: "COMPLETED", capture: {}, attachment: {}, expectation: {}, verification: {} };
}

test("valid READY extraction persists before consequence and returns completed", async () => {
  const calls: string[] = [];
  const extraction = ready();
  const app = new ExtractionGoldenPath({
    extractor: { async extract() { calls.push("extract"); return extraction; } },
    persistence: {
      async getExtraction() { calls.push("get"); return null; },
      async saveExtraction(_context, _ref, value) { calls.push("save"); return value; },
    },
    goldenPath: { async recordConsequence(_context, value) { calls.push(`golden:${value.expectationId}`); return completed(); } },
  });
  const result = await app.processGoldenPath(context, structuredClone(command));
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls, ["get", "extract", "save", "golden:expectation-a"]);
});

test("REVIEW_REQUIRED persists and stops before acquiring the golden path", async () => {
  let goldenCalls = 0;
  const extraction = review();
  const app = new ExtractionGoldenPath({
    extractor: { async extract() { return extraction; } },
    persistence: {
      async getExtraction() { return null; },
      async saveExtraction(_context, _ref, value) { return value; },
    },
    goldenPath: { async recordConsequence() { goldenCalls += 1; return completed(); } },
  });
  const result = await app.processGoldenPath(context, structuredClone(command));
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.reviewStage, "EXTRACTION");
  assert.equal(result.goldenPath, null);
  assert.equal(goldenCalls, 0);
});

test("durable replay skips object/model extraction and uses detached stored result", async () => {
  let extractCalls = 0;
  let saveCalls = 0;
  const stored = ready();
  const app = new ExtractionGoldenPath({
    extractor: { async extract() { extractCalls += 1; return stored; } },
    persistence: {
      async getExtraction() { return structuredClone(stored); },
      async saveExtraction() { saveCalls += 1; return stored; },
    },
    goldenPath: { async recordConsequence(_context, value) { return completed(); } },
  });
  const result = await app.processGoldenPath(context, structuredClone(command));
  assert.equal(result.status, "COMPLETED");
  assert.equal(extractCalls, 0);
  assert.equal(saveCalls, 0);
  if (result.status === "COMPLETED") result.extraction.artifact.payload.storedObjectRef.objectId = "mutated";
  const replay = await app.processGoldenPath(context, structuredClone(command));
  assert.equal(replay.status, "COMPLETED");
});

test("hostile and reversed commands fail before persistence lookup", async () => {
  let lookups = 0;
  const app = new ExtractionGoldenPath({
    extractor: { async extract() { throw new Error("must not acquire"); } },
    persistence: {
      async getExtraction() { lookups += 1; return null; },
      async saveExtraction() { throw new Error("must not acquire"); },
    },
    goldenPath: { async recordConsequence() { throw new Error("must not acquire"); } },
  });
  const reversed = structuredClone(command);
  reversed.operation.evaluatedAt = "2026-08-30T08:59:00.000Z";
  await assert.rejects(app.processGoldenPath(context, reversed), (error) =>
    error instanceof DomainError && error.code === "INVALID_COMMAND_TIME_ORDER");
  assert.equal(lookups, 0);
});
