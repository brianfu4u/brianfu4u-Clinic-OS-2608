import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/domain/errors.ts";
import { isEyeExamFlowKind, nextEyeExamExpectation } from "../src/domain/eye-exam-flow-policy.ts";

test("eye-exam policy freezes the clinical event sequence and bounded due windows", () => {
  const at = "2026-08-31T09:00:00.000Z";
  assert.deepEqual(nextEyeExamExpectation("REGISTRATION", at), {
    triggerKind: "REGISTRATION", consequenceKind: "PRESCRIPTION", dueAt: "2026-08-31T09:15:00.000Z",
  });
  assert.deepEqual(nextEyeExamExpectation("PRESCRIPTION", at), {
    triggerKind: "PRESCRIPTION", consequenceKind: "EXAM_REPORT", dueAt: "2026-08-31T09:30:00.000Z",
  });
  assert.deepEqual(nextEyeExamExpectation("EXAM_REPORT", at), {
    triggerKind: "EXAM_REPORT", consequenceKind: "PAYMENT", dueAt: "2026-08-31T09:20:00.000Z",
  });
  assert.equal(nextEyeExamExpectation("PAYMENT", at), null);
});

test("eye-exam policy rejects an unbounded time and unknown event kind", () => {
  assert.throws(() => nextEyeExamExpectation("REGISTRATION", "not-a-time"),
    (error) => error instanceof DomainError && error.code === "INVALID_FLOW_EVENT_TIME");
  assert.equal(isEyeExamFlowKind("PRESCRIPTION"), true);
  assert.equal(isEyeExamFlowKind("OTHER"), false);
});
