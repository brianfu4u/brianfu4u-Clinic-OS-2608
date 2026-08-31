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
    phases: ["REGISTRATION", "PRESCRIPTION", "SELECTION", "UPLOAD", "EXTRACTION", "VERIFICATION", "PAYMENT", "CLOSE", "REPLAY"],
    registration: "OPEN",
    extraction: "READY",
    verification: "VERIFIED",
    payment: "VERIFIED",
    reviewRequired: false,
    inferenceCalls: 1,
    counts: {
      artifacts: 4, factCards: 4, workflows: 1, links: 4, expectations: 3,
      storedObjects: 1, extractionAttempts: 1, verifications: 6, decisions: 1,
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
    await harness.prescribe();
    const selected = await harness.selectOpenExpectation();
    const object = await harness.upload();
    const result = await harness.submit(selected.expectationId, object) as { status: string; reviewStage: string; goldenPath: unknown };
    assert.deepEqual({ status: result.status, reviewStage: result.reviewStage, goldenPath: result.goldenPath }, {
      status: "REVIEW_REQUIRED", reviewStage: "EXTRACTION", goldenPath: null,
    });
    assert.deepEqual(await harness.counts(), {
      artifacts: 3, factCards: 2, workflows: 1, links: 2, expectations: 2,
      storedObjects: 1, extractionAttempts: 1, verifications: 3, decisions: 0,
    });
    await assert.rejects(
      harness.submit(selected.expectationId, object, { factCardId: "closure-review-fact-conflict" }),
      code("EXTRACTION_REQUEST_CONFLICT"),
    );
    await assert.rejects(harness.close(selected.expectationId), code("DECISION_NOT_ALLOWED"));
  } finally { await harness.dispose(); }
});

test("only a verified report creates one employee-safe pending payment expectation", async () => {
  const harness = await createPersistedClosureHarness();
  try {
    await harness.register();
    await harness.prescribe();
    const report = await harness.selectOpenExpectation();
    const object = await harness.upload();
    const first = await harness.submit(report.expectationId, object) as {
      status: string; goldenPath: { expectation: { expectation: { state: string } }; verification: { result: { status: string } } };
    };
    assert.equal(first.status, "COMPLETED");
    assert.equal(first.goldenPath.expectation.expectation.state, "MET");
    assert.equal(first.goldenPath.verification.result.status, "VERIFIED");
    const payment = await harness.selectOpenPaymentExpectation();
    assert.equal(payment.dueAt, "2026-08-30T09:30:00.000Z");
    const beforeReplay = await harness.counts();
    await harness.submit(report.expectationId, object);
    assert.deepEqual(await harness.counts(), beforeReplay);
    const replayPayment = await harness.selectOpenPaymentExpectation();
    assert.deepEqual(replayPayment, payment);
    await assert.rejects(harness.selectOpenPaymentExpectation(harness.otherEmployee), code("CLOSURE_DEMO_PAYMENT_SELECTION_FAILED"));
    await assert.rejects(harness.selectOpenPaymentExpectation(harness.otherClinicEmployee), code("CLOSURE_DEMO_PAYMENT_SELECTION_FAILED"));
  } finally { await harness.dispose(); }
});

test("payment completion is server-selected, exact-replayable, and enables only the final standard close", async () => {
  const harness = await createPersistedClosureHarness();
  try {
    await harness.register(); await harness.prescribe();
    const report = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await harness.submit(report.expectationId, object);
    const payment = await harness.selectOpenPaymentExpectation();
    await assert.rejects(harness.close(payment.expectationId), code("DECISION_NOT_ALLOWED"));
    const before = await harness.counts();
    const first = await harness.pay() as { status: string; expectationId: string; expectationState: string; verificationStatus: string };
    assert.deepEqual({ status: first.status, expectationId: first.expectationId === payment.expectationId, expectationState: first.expectationState, verificationStatus: first.verificationStatus }, {
      status: "COMPLETED", expectationId: true, expectationState: "MET", verificationStatus: "VERIFIED",
    });
    const replay = await harness.pay();
    assert.deepEqual(replay, first);
    assert.deepEqual(await harness.counts(), { ...before, artifacts: before.artifacts + 1, factCards: before.factCards + 1, links: before.links + 1, verifications: before.verifications + 1 });
    await assert.rejects(harness.pay(harness.otherEmployee), code("EXPECTATION_SELECTION_REQUIRED"));
    await assert.rejects(harness.pay(harness.employee, "DEMO-CLOSURE-002", "2026-08-30T09:15:00.000Z", "closure-payment-other-0001"), code("EXPECTATION_SELECTION_REQUIRED"));
    await assert.rejects(harness.pay(harness.employee, "DEMO-CLOSURE-001", "2026-08-30T09:31:00.000Z", "closure-payment-expired-0001", "2026-08-30T09:31:00.000Z"), code("EXPECTATION_SELECTION_REQUIRED"));
    const closed = await harness.close(payment.expectationId);
    assert.equal((closed as { workflow: { status: string } }).workflow.status, "CLOSED");
  } finally { await harness.dispose(); }
});

test("conflicting report evidence cannot create a payment expectation", async () => {
  const harness = await createPersistedClosureHarness();
  try {
    await harness.register();
    await harness.prescribe();
    const report = await harness.selectOpenExpectation();
    const object = await harness.upload();
    const result = await harness.submit(report.expectationId, object, {
      occurredAt: "2026-08-30T09:04:00.000Z",
    }) as { status: string; goldenPath: { expectation: { expectation: { state: string } }; verification: { result: { status: string } } } };
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.goldenPath.expectation.expectation.state, "OPEN");
    assert.equal(result.goldenPath.verification.result.status, "CONFLICT");
    await assert.rejects(harness.selectOpenPaymentExpectation(), code("CLOSURE_DEMO_PAYMENT_SELECTION_FAILED"));
    assert.equal((await harness.counts()).expectations, 2);
  } finally { await harness.dispose(); }
});

test("employee selection, storage, extraction and manager operations remain role and tenant scoped", async () => {
  const harness = await createPersistedClosureHarness();
  try {
    await harness.register();
    await harness.prescribe();
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
    await harness.prescribe();
    const selected = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await harness.submit(selected.expectationId, object);
    const before = await harness.counts();
    await assert.rejects(harness.upload(new Uint8Array([1, 2, 3])), code("OBJECT_ID_CONFLICT"));
    await assert.rejects(harness.close(selected.expectationId), code("WORKFLOW_EXPECTATIONS_OPEN"));
    assert.deepEqual(await harness.counts(), before);
    const payment = await harness.selectOpenPaymentExpectation();
    assert.notEqual(payment.expectationId, selected.expectationId);
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
    await harness.prescribe();
    const selected = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await assert.rejects(harness.submit(selected.expectationId, object, {
      occurredAt: selected.dueAt, createdAt: selected.dueAt, attachedAt: selected.dueAt, evaluatedAt: selected.dueAt,
    }), code("EXPECTATION_SELECTION_REQUIRED"));
    assert.deepEqual(await harness.counts(), {
      artifacts: 2, factCards: 2, workflows: 1, links: 2, expectations: 2,
      storedObjects: 0, extractionAttempts: 0, verifications: 3, decisions: 0,
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
