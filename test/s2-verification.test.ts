import assert from "node:assert/strict";
import test from "node:test";

import type { Artifact, Expectation, Workflow } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { projectManagerClosure } from "../src/domain/manager-projection.ts";
import { verifyS2 } from "../src/domain/s2-verification.ts";

const TRIGGERED_AT = "2026-08-29T09:00:00.000Z";
const CONSEQUENCE_AT = "2026-08-29T09:10:00.000Z";
const DUE_AT = "2026-08-29T09:15:00.000Z";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    clinicId: "clinic-1",
    subjectType: "PATIENT",
    identityAnchor: "DEMO-001",
    workflowFamily: "EYE_EXAM",
    status: "OPEN",
    createdAt: TRIGGERED_AT,
    updatedAt: TRIGGERED_AT,
    ...overrides,
  };
}

function expectation(
  state: Expectation["state"] = "MET",
  overrides: Partial<Expectation> = {},
): Expectation {
  return {
    id: "expectation-1",
    clinicId: "clinic-1",
    workflowId: "workflow-1",
    triggerKind: "REGISTRATION",
    consequenceKind: "EXAM_REPORT",
    triggeredAt: TRIGGERED_AT,
    dueAt: DUE_AT,
    state,
    satisfiedByArtifactId: state === "MET" ? "report" : null,
    evaluatedAt: CONSEQUENCE_AT,
    ...overrides,
  };
}

function artifact(id: string, kind: string, occurredAt: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    clinicId: "clinic-1",
    kind,
    occurredAt,
    occurredAtSource: "employee_confirmed",
    sourceEmployeeId: "employee-1",
    identityAnchor: "DEMO-001",
    payload: { synthetic: true },
    createdAt: occurredAt,
    ...overrides,
  };
}

const registration = () => artifact("registration", "REGISTRATION", TRIGGERED_AT);
const report = (overrides: Partial<Artifact> = {}) =>
  artifact("report", "EXAM_REPORT", CONSEQUENCE_AT, overrides);

test("exact trigger and exact in-window consequence are VERIFIED", () => {
  const result = verifyS2({
    workflow: workflow(),
    expectation: expectation(),
    linkedArtifacts: [registration(), report()],
    now: CONSEQUENCE_AT,
  });
  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(result.reasonCodes, []);
  assert.deepEqual(result.evidenceArtifactIds, ["registration", "report"]);
});

test("MET without linked trigger is CONFLICT/TRIGGER_NOT_FOUND", () => {
  const result = verifyS2({
    workflow: workflow(), expectation: expectation(), linkedArtifacts: [report()], now: CONSEQUENCE_AT,
  });
  assert.equal(result.status, "CONFLICT");
  assert.ok(result.reasonCodes.includes("TRIGGER_NOT_FOUND"));
  assert.equal(result.triggerArtifactId, null);
});

test("MET with absent referenced consequence is CONFLICT/CONSEQUENCE_NOT_FOUND", () => {
  const result = verifyS2({
    workflow: workflow(), expectation: expectation(), linkedArtifacts: [registration()], now: CONSEQUENCE_AT,
  });
  assert.equal(result.status, "CONFLICT");
  assert.ok(result.reasonCodes.includes("CONSEQUENCE_NOT_FOUND"));
});

test("near-miss identity is CONFLICT and never VERIFIED", () => {
  const result = verifyS2({
    workflow: workflow(),
    expectation: expectation(),
    linkedArtifacts: [registration(), report({ identityAnchor: "DEMO-OO1" })],
    now: CONSEQUENCE_AT,
  });
  assert.equal(result.status, "CONFLICT");
  assert.ok(result.reasonCodes.includes("IDENTITY_CONFLICT"));
});

test("wrong trigger or consequence kind produces KIND_CONFLICT", () => {
  const wrongTrigger = verifyS2({
    workflow: workflow(),
    expectation: expectation(),
    linkedArtifacts: [artifact("registration", "OTHER", TRIGGERED_AT), report()],
    now: CONSEQUENCE_AT,
  });
  const wrongConsequence = verifyS2({
    workflow: workflow(),
    expectation: expectation(),
    linkedArtifacts: [registration(), artifact("report", "OTHER", CONSEQUENCE_AT)],
    now: CONSEQUENCE_AT,
  });
  assert.ok(wrongTrigger.reasonCodes.includes("KIND_CONFLICT"));
  assert.ok(wrongConsequence.reasonCodes.includes("KIND_CONFLICT"));
});

test("trigger or consequence outside the chain window produces TIME_CONFLICT", () => {
  const wrongTrigger = verifyS2({
    workflow: workflow(),
    expectation: expectation(),
    linkedArtifacts: [artifact("registration", "REGISTRATION", "2026-08-29T08:59:59.999Z"), report()],
    now: CONSEQUENCE_AT,
  });
  const wrongConsequence = verifyS2({
    workflow: workflow(),
    expectation: expectation(),
    linkedArtifacts: [registration(), artifact("report", "EXAM_REPORT", "2026-08-29T09:15:00.001Z")],
    now: CONSEQUENCE_AT,
  });
  assert.ok(wrongTrigger.reasonCodes.includes("TIME_CONFLICT"));
  assert.ok(wrongConsequence.reasonCodes.includes("TIME_CONFLICT"));
});

test("OPEN and UNMET with trusted trigger remain deterministic PENDING", () => {
  for (const state of ["OPEN", "UNMET"] as const) {
    const result = verifyS2({
      workflow: workflow(),
      expectation: expectation(state),
      linkedArtifacts: [registration()],
      now: state === "OPEN" ? CONSEQUENCE_AT : DUE_AT,
    });
    assert.equal(result.status, "PENDING");
    assert.deepEqual(result.reasonCodes, [state === "OPEN" ? "CHAIN_OPEN" : "CHAIN_UNMET"]);
    const view = projectManagerClosure({
      workflow: workflow(),
      expectation: expectation(state),
      verification: result,
      evidenceArtifactIds: ["registration"],
    });
    assert.equal(view.needsReview, state === "UNMET");
  }
});

test("Artifact input order does not change S2 output", () => {
  const first = verifyS2({
    workflow: workflow(), expectation: expectation(), linkedArtifacts: [registration(), report()], now: CONSEQUENCE_AT,
  });
  const second = verifyS2({
    workflow: workflow(), expectation: expectation(), linkedArtifacts: [report(), registration()], now: CONSEQUENCE_AT,
  });
  assert.deepEqual(second, first);
});

test("S2 does not mutate Workflow, Expectation or Artifact inputs", () => {
  const sourceWorkflow = workflow();
  const sourceExpectation = expectation();
  const artifacts = [registration(), report()];
  const before = JSON.stringify({ sourceWorkflow, sourceExpectation, artifacts });
  verifyS2({
    workflow: sourceWorkflow,
    expectation: sourceExpectation,
    linkedArtifacts: artifacts,
    now: CONSEQUENCE_AT,
  });
  assert.equal(JSON.stringify({ sourceWorkflow, sourceExpectation, artifacts }), before);
});

test("malformed top-level verification contract fails closed", () => {
  for (const input of [
    { workflow: workflow(), expectation: expectation("MET", { dueAt: "not-a-time" }) },
    { workflow: workflow({ identityAnchor: null }), expectation: expectation() },
    { workflow: workflow(), expectation: expectation("GREEN" as Expectation["state"]) },
  ]) {
    assert.throws(
      () => verifyS2({ ...input, linkedArtifacts: [registration(), report()], now: CONSEQUENCE_AT }),
      (error) => error instanceof DomainError && error.code === "INVALID_VERIFICATION_CONTRACT",
    );
  }
});

test("VOIDED chain is PENDING/CHAIN_VOIDED and never VERIFIED", () => {
  const result = verifyS2({
    workflow: workflow({ status: "VOIDED" }),
    expectation: expectation("VOIDED"),
    linkedArtifacts: [registration()],
    now: DUE_AT,
  });
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.reasonCodes, ["CHAIN_VOIDED"]);
});
