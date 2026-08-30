import assert from "node:assert/strict";
import test from "node:test";

import {
  createPersistedClosureHarness,
  runPersistedClosureDemo,
} from "../scripts/persisted-closure-demo.ts";
import { DomainError } from "../src/domain/errors.ts";

function code(expected: string) {
  return (error: unknown) => error instanceof DomainError && error.code === expected;
}

test("persisted closure demo uses only durable production seams and stage replays do not duplicate rows", async () => {
  const summary = await runPersistedClosureDemo();
  assert.deepEqual(summary, {
    phases: ["REGISTRATION", "SELECTION", "UPLOAD", "EXTRACTION", "VERIFICATION", "MANAGER_CLOSE", "REPLAY"],
    registration: "OPEN",
    extraction: "READY",
    verification: "VERIFIED",
    closure: "CLOSED",
    decision: "CLOSE_STANDARD",
    reviewRequired: false,
    inferenceCalls: 1,
    counts: {
      artifacts: 2, factCards: 2, workflows: 1, links: 2, expectations: 1,
      storedObjects: 1, extractionAttempts: 1, verifications: 2, decisions: 1,
    },
  });
});

test("REVIEW_REQUIRED extraction is durable but cannot complete or standard-close a chain", async () => {
  const harness = await createPersistedClosureHarness({
    subjectTypeCandidate: "PATIENT", workflowFamilyCandidate: "EYE_EXAM",
    fields: {}, missingFields: ["reportType"], confidence: 0.5,
  });
  try {
    await harness.register();
    const selected = await harness.selectOpenExpectation();
    const object = await harness.upload();
    const result = await harness.submit(selected.expectationId, object) as { status: string; reviewStage: string; goldenPath: unknown };
    assert.deepEqual({ status: result.status, reviewStage: result.reviewStage, goldenPath: result.goldenPath }, {
      status: "REVIEW_REQUIRED", reviewStage: "EXTRACTION", goldenPath: null,
    });
    assert.deepEqual(await harness.counts(), {
      artifacts: 2, factCards: 1, workflows: 1, links: 1, expectations: 1,
      storedObjects: 1, extractionAttempts: 1, verifications: 1, decisions: 0,
    });
    await assert.rejects(
      harness.submit(selected.expectationId, object, { factCardId: "closure-review-fact-conflict" }),
      code("EXTRACTION_REQUEST_CONFLICT"),
    );
    await assert.rejects(harness.close(selected.expectationId), code("DECISION_NOT_ALLOWED"));
  } finally { await harness.dispose(); }
});

test("employee selection, storage, extraction and manager operations remain role and tenant scoped", async () => {
  const harness = await createPersistedClosureHarness();
  try {
    await harness.register();
    await assert.rejects(harness.selectOpenExpectation(harness.otherEmployee), code("CLOSURE_DEMO_SELECTION_FAILED"));
    await assert.rejects(harness.selectOpenExpectation({ ...harness.manager, role: "MANAGER" }), code("ROLE_SCOPE_VIOLATION"));
    await assert.rejects(harness.selectOpenExpectation(harness.otherClinicEmployee), code("CLOSURE_DEMO_SELECTION_FAILED"));
    await assert.rejects(harness.uploadAs(harness.manager), code("ROLE_SCOPE_VIOLATION"));
    const selected = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await assert.rejects(
      harness.backend.submitExamReportConsequence!(harness.otherEmployee, harness.command(selected.expectationId, object)),
      code("EXPECTATION_SELECTION_REQUIRED"),
    );
    await assert.rejects(harness.close(selected.expectationId, "CLOSE_STANDARD"), code("DECISION_NOT_ALLOWED"));
  } finally { await harness.dispose(); }
});

test("changed replay bindings fail visibly and do not alter the finished durable projection", async () => {
  const harness = await createPersistedClosureHarness();
  try {
    await harness.register();
    const selected = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await harness.submit(selected.expectationId, object);
    await harness.close(selected.expectationId);
    const before = await harness.counts();
    await assert.rejects(harness.upload(new Uint8Array([1, 2, 3])), code("OBJECT_ID_CONFLICT"));
    await assert.rejects(harness.close(selected.expectationId, "KEEP_OPEN"), code("DECISION_ID_CONFLICT"));
    assert.deepEqual(await harness.counts(), before);
    const projection = await harness.backend.listManagerClosures(harness.manager);
    assert.deepEqual({ workflow: projection[0].workflowStatus, action: projection[0].latestDecision?.action, review: projection[0].needsReview }, {
      workflow: "CLOSED", action: "CLOSE_STANDARD", review: false,
    });
  } finally { await harness.dispose(); }
});

test("safe selection is required and the report due boundary is exclusive", async () => {
  const empty = await createPersistedClosureHarness();
  try {
    await assert.rejects(empty.selectOpenExpectation(), code("CLOSURE_DEMO_SELECTION_FAILED"));
  } finally { await empty.dispose(); }

  const harness = await createPersistedClosureHarness();
  try {
    await harness.register();
    const selected = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await assert.rejects(harness.submit(selected.expectationId, object, {
      occurredAt: selected.dueAt, createdAt: selected.dueAt, attachedAt: selected.dueAt, evaluatedAt: selected.dueAt,
    }), code("EXPECTATION_SELECTION_REQUIRED"));
    assert.deepEqual(await harness.counts(), {
      artifacts: 1, factCards: 1, workflows: 1, links: 1, expectations: 1,
      storedObjects: 0, extractionAttempts: 0, verifications: 1, decisions: 0,
    });
    await assert.rejects(harness.close(selected.expectationId), code("DECISION_NOT_ALLOWED"));
  } finally { await harness.dispose(); }
});

test("CLI summary vocabulary contains no identifiers, paths, candidates, notes or raw exceptions", async () => {
  const summary = JSON.stringify(await runPersistedClosureDemo());
  for (const forbidden of [
    "DEMO-CLOSURE", "closure-demo", "upload-", "sha256", "synthetic", "reportType", "exception", "note", "path",
  ]) assert.doesNotMatch(summary, new RegExp(forbidden, "i"));
  assert.match(summary, /^\{"phases":/);
});
