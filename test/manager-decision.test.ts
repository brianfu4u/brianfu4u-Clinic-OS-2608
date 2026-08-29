import assert from "node:assert/strict";
import test from "node:test";

import type {
  Expectation,
  ManagerDecisionAction,
  Workflow,
  WorkflowArtifactLink,
} from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { projectManagerClosure } from "../src/domain/manager-projection.ts";
import {
  WorkflowSaga,
  type ManagerDecisionInput,
  type WorkflowSagaOptions,
} from "../src/domain/workflow-saga.ts";

const CLINIC_ID = "clinic-1";
const WORKFLOW_ID = "workflow-1";
const NOW = "2026-08-29T09:15:00.000Z";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: WORKFLOW_ID,
    clinicId: CLINIC_ID,
    subjectType: "PATIENT",
    identityAnchor: "DEMO-001",
    workflowFamily: "EYE_EXAM",
    status: "OPEN",
    createdAt: "2026-08-29T09:00:00.000Z",
    updatedAt: "2026-08-29T09:00:00.000Z",
    ...overrides,
  };
}

function expectation(
  state: Expectation["state"] = "MET",
  overrides: Partial<Expectation> = {},
): Expectation {
  return {
    id: "expectation-1",
    clinicId: CLINIC_ID,
    workflowId: WORKFLOW_ID,
    triggerKind: "REGISTRATION",
    consequenceKind: "EXAM_REPORT",
    triggeredAt: "2026-08-29T09:00:00.000Z",
    dueAt: NOW,
    state,
    satisfiedByArtifactId: state === "MET" ? "artifact-report" : null,
    evaluatedAt: NOW,
    ...overrides,
  };
}

function link(artifactId: string): WorkflowArtifactLink {
  return {
    id: `link:${artifactId}`,
    clinicId: CLINIC_ID,
    workflowId: WORKFLOW_ID,
    artifactId,
    attachedAt: NOW,
    decisionSource: "DETERMINISTIC",
    reasoningChain: ["fixture"],
  };
}

function saga(options: WorkflowSagaOptions = {}): WorkflowSaga {
  return new WorkflowSaga({
    initialWorkflows: [workflow()],
    initialLinks: [link("artifact-registration"), link("artifact-report")],
    ...options,
  });
}

function decisionInput(
  state: Expectation["state"] = "MET",
  action: ManagerDecisionAction = "CLOSE_STANDARD",
  overrides: Partial<ManagerDecisionInput> = {},
): ManagerDecisionInput {
  return {
    id: "decision-1",
    clinicId: CLINIC_ID,
    workflowId: WORKFLOW_ID,
    expectation: expectation(state),
    action,
    reasonCode: null,
    note: null,
    actorId: "manager-1",
    actorRole: "MANAGER",
    decidedAt: NOW,
    ...overrides,
  };
}

test("CLOSE_STANDARD closes MET and stores an immutable decision", () => {
  const store = saga();
  const result = store.recordManagerDecision(decisionInput());

  assert.equal(result.workflow.status, "CLOSED");
  assert.equal(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID).length, 1);
  result.decision.evidenceArtifactIds.push("caller-mutation");
  result.decision.note = "caller-mutation";
  const [stored] = store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID);
  assert.deepEqual(stored.evidenceArtifactIds, ["artifact-registration", "artifact-report"]);
  assert.equal(stored.note, null);
});

test("CLOSE_STANDARD refuses OPEN and UNMET without mutation", () => {
  for (const state of ["OPEN", "UNMET"] as const) {
    const store = saga();
    assert.throws(
      () => store.recordManagerDecision(decisionInput(state)),
      (error) => error instanceof DomainError && error.code === "DECISION_NOT_ALLOWED",
    );
    assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
    assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
  }
});

test("CLOSE_EXCEPTION closes UNMET only with a controlled reason", () => {
  for (const reasonCode of [null, "free text"]) {
    const store = saga();
    assert.throws(
      () => store.recordManagerDecision(decisionInput("UNMET", "CLOSE_EXCEPTION", { reasonCode })),
      DomainError,
    );
    assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
    assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
  }
  const store = saga();
  const result = store.recordManagerDecision(decisionInput("UNMET", "CLOSE_EXCEPTION", {
    reasonCode: "LEGITIMATE_DEVIATION",
  }));
  assert.equal(result.workflow.status, "CLOSED");
  assert.equal(result.decision.reasonCode, "LEGITIMATE_DEVIATION");
});

test("KEEP_OPEN preserves an UNMET review item", () => {
  const store = saga();
  const input = decisionInput("UNMET", "KEEP_OPEN", { reasonCode: "NEEDS_MORE_EVIDENCE" });
  const result = store.recordManagerDecision(input);
  const view = projectManagerClosure({
    workflow: result.workflow,
    expectation: input.expectation,
    evidenceArtifactIds: result.decision.evidenceArtifactIds,
  });

  assert.equal(result.workflow.status, "OPEN");
  assert.equal(view.needsReview, true);
  assert.deepEqual(view.reasonCodes, ["EXPECTATION_UNMET"]);
});

test("VOID requires a reason and projects terminal VOIDED", () => {
  const refused = saga();
  assert.throws(
    () => refused.recordManagerDecision(decisionInput("OPEN", "VOID")),
    (error) => error instanceof DomainError && error.code === "DECISION_NOT_ALLOWED",
  );

  const store = saga();
  const input = decisionInput("OPEN", "VOID", { reasonCode: "PATIENT_CANCELLED" });
  const result = store.recordManagerDecision(input);
  const view = projectManagerClosure({
    workflow: result.workflow,
    expectation: input.expectation,
    evidenceArtifactIds: result.decision.evidenceArtifactIds,
  });
  assert.equal(result.workflow.status, "VOIDED");
  assert.equal(view.expectationState, "VOIDED");
  assert.equal(view.needsReview, false);
});

test("non-manager actor is refused before mutation", () => {
  const store = saga();
  const input = decisionInput() as ManagerDecisionInput & { actorRole: string };
  input.actorRole = "AGENT";
  assert.throws(
    () => store.recordManagerDecision(input as ManagerDecisionInput),
    (error) => error instanceof DomainError && error.code === "MANAGER_ROLE_REQUIRED",
  );
  assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
  assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
});

test("same decision is idempotent and conflicting ID reuse fails", () => {
  const store = saga();
  const input = decisionInput();
  const first = store.recordManagerDecision(input);
  const second = store.recordManagerDecision(input);
  assert.deepEqual(second, first);
  assert.equal(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID).length, 1);

  assert.throws(
    () => store.recordManagerDecision({ ...input, note: "different" }),
    (error) => error instanceof DomainError && error.code === "DECISION_ID_CONFLICT",
  );
  assert.equal(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID).length, 1);
});

test("terminal Workflow rejects a different later decision", () => {
  const store = saga();
  store.recordManagerDecision(decisionInput());
  assert.throws(
    () => store.recordManagerDecision(decisionInput("MET", "VOID", {
      id: "decision-2",
      reasonCode: "DUPLICATE_WORKFLOW",
    })),
    (error) => error instanceof DomainError && error.code === "WORKFLOW_TERMINAL",
  );
  assert.equal(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID).length, 1);
});

test("decision evidence is derived exactly from links visible at decision time", () => {
  const store = saga();
  const result = store.recordManagerDecision(decisionInput());
  assert.deepEqual(
    result.decision.evidenceArtifactIds,
    store.listLinks(CLINIC_ID, WORKFLOW_ID).map(({ artifactId }) => artifactId),
  );
});

test("failed decision append leaves Workflow and ledger unchanged", () => {
  const store = saga({
    beforeDecisionCommit: () => {
      throw new Error("synthetic decision append failure");
    },
  });
  assert.throws(() => store.recordManagerDecision(decisionInput()), /synthetic decision append failure/);
  assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
  assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
});

test("closed exception projection preserves UNMET history without review", () => {
  const store = saga();
  const input = decisionInput("UNMET", "CLOSE_EXCEPTION", {
    reasonCode: "LEGITIMATE_DEVIATION",
  });
  const result = store.recordManagerDecision(input);
  const view = projectManagerClosure({
    workflow: result.workflow,
    expectation: input.expectation,
    evidenceArtifactIds: result.decision.evidenceArtifactIds,
  });
  assert.equal(view.workflowStatus, "CLOSED");
  assert.equal(view.expectationState, "UNMET");
  assert.equal(view.needsReview, false);
});

test("forged MET snapshot cannot close without linked satisfying evidence", () => {
  for (const satisfiedByArtifactId of [null, "artifact-not-linked"]) {
    const store = saga();
    const input = decisionInput("MET", "CLOSE_STANDARD", {
      expectation: expectation("MET", { satisfiedByArtifactId }),
    });
    assert.throws(
      () => store.recordManagerDecision(input),
      (error) =>
        error instanceof DomainError &&
        error.code === "INVALID_DECISION_EVIDENCE_SNAPSHOT",
    );
    assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
    assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
  }
});

test("non-MET snapshot cannot claim satisfying evidence", () => {
  const store = saga();
  const input = decisionInput("UNMET", "CLOSE_EXCEPTION", {
    reasonCode: "LEGITIMATE_DEVIATION",
    expectation: expectation("UNMET", { satisfiedByArtifactId: "artifact-report" }),
  });
  assert.throws(
    () => store.recordManagerDecision(input),
    (error) =>
      error instanceof DomainError &&
      error.code === "INVALID_DECISION_EVIDENCE_SNAPSHOT",
  );
  assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
  assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
});

test("future or invalid Expectation evaluation cannot authorize a decision", () => {
  for (const evaluatedAt of ["2026-08-29T09:15:00.001Z", "not-a-time"]) {
    const store = saga();
    const input = decisionInput("MET", "CLOSE_STANDARD", {
      expectation: expectation("MET", { evaluatedAt }),
    });
    assert.throws(
      () => store.recordManagerDecision(input),
      (error) =>
        error instanceof DomainError &&
        error.code === "INVALID_DECISION_SNAPSHOT_TIME",
    );
    assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
    assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
  }
});

test("decision lineage excludes links attached after decidedAt", () => {
  const store = saga({
    initialLinks: [
      link("artifact-registration"),
      link("artifact-report"),
      { ...link("artifact-future"), attachedAt: "2026-08-29T09:15:00.001Z" },
    ],
  });
  const result = store.recordManagerDecision(decisionInput());
  assert.deepEqual(result.decision.evidenceArtifactIds, [
    "artifact-registration",
    "artifact-report",
  ]);
});

test("invalid link time fails decision snapshot closed", () => {
  const store = saga({
    initialLinks: [link("artifact-registration"), { ...link("artifact-report"), attachedAt: "bad" }],
  });
  assert.throws(
    () => store.recordManagerDecision(decisionInput()),
    (error) =>
      error instanceof DomainError &&
      error.code === "INVALID_DECISION_LINK_TIME",
  );
  assert.equal(store.getWorkflow(CLINIC_ID, WORKFLOW_ID)?.status, "OPEN");
  assert.deepEqual(store.listManagerDecisions(CLINIC_ID, WORKFLOW_ID), []);
});
