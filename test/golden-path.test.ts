import assert from "node:assert/strict";
import test from "node:test";

import type {
  Artifact,
  EvidenceFactCard,
  Expectation,
  Workflow,
} from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { evaluateExpectation } from "../src/domain/expectation.ts";
import {
  createInMemoryRepositories,
  runGoldenPath,
} from "../src/domain/golden-path.ts";
import { projectManagerClosure } from "../src/domain/manager-projection.ts";

const NOW = "2026-08-29T09:10:00.000Z";
const DUE = "2026-08-29T09:15:00.000Z";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    clinicId: "clinic-1",
    kind: "REGISTRATION",
    occurredAt: "2026-08-29T09:00:00.000Z",
    occurredAtSource: "employee_confirmed",
    sourceEmployeeId: "employee-1",
    identityAnchor: "P-001",
    payload: { note: "synthetic" },
    createdAt: "2026-08-29T09:01:00.000Z",
    ...overrides,
  };
}

function factCard(
  source: Artifact,
  overrides: Partial<EvidenceFactCard> = {},
): EvidenceFactCard & Record<string, unknown> {
  return {
    id: `fact:${source.id}`,
    clinicId: source.clinicId,
    artifactId: source.id,
    subjectType: "PATIENT",
    identityAnchor: source.identityAnchor,
    workflowFamily: "EYE_EXAM",
    occurredAt: source.occurredAt,
    fields: {},
    missingFields: [],
    confidence: 0.9,
    parserVersion: "test-1",
    lineageArtifactIds: [source.id],
    ...overrides,
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    clinicId: "clinic-1",
    subjectType: "PATIENT",
    identityAnchor: "P-001",
    workflowFamily: "EYE_EXAM",
    status: "OPEN",
    createdAt: "2026-08-29T08:50:00.000Z",
    updatedAt: "2026-08-29T08:50:00.000Z",
    ...overrides,
  };
}

function expectation(overrides: Partial<Expectation> = {}): Expectation {
  return {
    id: "expectation-1",
    clinicId: "clinic-1",
    workflowId: "workflow-1",
    triggerKind: "REGISTRATION",
    consequenceKind: "EXAM_REPORT",
    triggeredAt: "2026-08-29T09:00:00.000Z",
    dueAt: DUE,
    state: "OPEN",
    satisfiedByArtifactId: null,
    evaluatedAt: NOW,
    ...overrides,
  };
}

function input(source = artifact()) {
  return {
    artifact: source,
    parser: (item: Artifact) => factCard(item),
    expectation: {
      id: "expectation-1",
      triggerKind: "REGISTRATION",
      consequenceKind: "EXAM_REPORT",
      triggeredAt: "2026-08-29T09:00:00.000Z",
      dueAt: DUE,
    },
    now: NOW,
  };
}

test("existing Workflow exact match attaches idempotently", () => {
  const repositories = createInMemoryRepositories({
    workflowSaga: { initialWorkflows: [workflow()] },
  });
  const first = runGoldenPath(input(), repositories);
  const second = runGoldenPath(input(), repositories);

  assert.equal(first.resolution.kind, "ATTACH_EXISTING");
  assert.equal(first.workflow?.id, "workflow-1");
  assert.equal(second.link?.id, first.link?.id);
  assert.equal(repositories.workflows.listLinks("clinic-1", "workflow-1").length, 1);
});

test("zero exact matches creates and attaches a new Workflow", () => {
  const repositories = createInMemoryRepositories();
  const result = runGoldenPath(input(), repositories);

  assert.equal(result.resolution.kind, "CREATE_NEW");
  assert.equal(result.link?.workflowId, result.workflow?.id);
  assert.equal(repositories.workflows.listOpenWorkflows("clinic-1").length, 1);
});

test("missing clinical anchor is blocked before resolution", () => {
  const source = artifact({ identityAnchor: null });
  const repositories = createInMemoryRepositories();

  assert.throws(
    () => runGoldenPath(input(source), repositories),
    (error) => error instanceof DomainError && error.code === "IDENTITY_ANCHOR_REQUIRED",
  );
  assert.equal(repositories.workflows.listOpenWorkflows("clinic-1").length, 0);
});

test("parser cannot replace the source Artifact identity anchor", () => {
  const source = artifact({ identityAnchor: "P-001" });
  const repositories = createInMemoryRepositories();

  assert.throws(
    () => runGoldenPath(
      {
        ...input(source),
        parser: (item) => factCard(item, { identityAnchor: "P-999" }),
      },
      repositories,
    ),
    (error) => error instanceof DomainError && error.code === "IDENTITY_ANCHOR_MISMATCH",
  );
  assert.equal(repositories.workflows.listOpenWorkflows("clinic-1").length, 0);
  assert.deepEqual(
    repositories.workflows.listLinks("clinic-1", "wf:clinic-1:artifact-1"),
    [],
  );
});

test("near-miss identity P-001 never matches P-OO1", () => {
  const repositories = createInMemoryRepositories({
    workflowSaga: {
      initialWorkflows: [workflow({ identityAnchor: "P-OO1" })],
    },
  });
  const result = runGoldenPath(input(), repositories);

  assert.equal(result.resolution.kind, "CREATE_NEW");
  assert.notEqual(result.workflow?.id, "workflow-1");
  assert.equal(repositories.workflows.listLinks("clinic-1", "workflow-1").length, 0);
});

test("cross-tenant Workflow cannot be read or attached", () => {
  const other = workflow({ id: "workflow-other", clinicId: "clinic-other" });
  const repositories = createInMemoryRepositories({
    workflowSaga: { initialWorkflows: [other] },
  });
  const source = artifact();
  const parsed = factCard(source);

  assert.equal(repositories.workflows.getWorkflow("clinic-1", other.id), null);
  assert.throws(
    () => repositories.workflows.attachExisting(other.id, source, parsed, NOW),
    (error) => error instanceof DomainError && error.code === "WORKFLOW_NOT_FOUND",
  );
  assert.equal(runGoldenPath(input(source), repositories).resolution.kind, "CREATE_NEW");
});

test("two exact open Workflows require review and create no link", () => {
  const repositories = createInMemoryRepositories({
    workflowSaga: {
      initialWorkflows: [workflow(), workflow({ id: "workflow-2" })],
    },
  });
  const result = runGoldenPath(input(), repositories);

  assert.equal(result.resolution.kind, "REVIEW_REQUIRED");
  assert.equal(result.link, null);
  assert.equal(result.managerView.needsReview, true);
  assert.deepEqual(result.managerView.reasonCodes, ["MATCHING_AMBIGUITY"]);
});

test("consequence occurring exactly at dueAt is MET", () => {
  const report = artifact({ id: "report", kind: "EXAM_REPORT", occurredAt: DUE });
  const result = evaluateExpectation(expectation(), [report], DUE);

  assert.equal(result.state, "MET");
  assert.equal(result.satisfiedByArtifactId, "report");
});

test("consequence before triggeredAt cannot satisfy an Expectation", () => {
  const oldReport = artifact({
    id: "old-report",
    kind: "EXAM_REPORT",
    occurredAt: "2026-08-29T08:59:59.999Z",
  });
  const result = evaluateExpectation(expectation(), [oldReport], DUE);

  assert.equal(result.state, "UNMET");
  assert.equal(result.satisfiedByArtifactId, null);
});

test("invalid or reversed Expectation time fails closed", () => {
  assert.throws(
    () => evaluateExpectation(expectation({ triggeredAt: "not-a-time" }), [], NOW),
    (error) => error instanceof DomainError && error.code === "INVALID_EXPECTATION_TIME",
  );
  assert.throws(
    () => evaluateExpectation(
      expectation({
        triggeredAt: "2026-08-29T09:16:00.000Z",
        dueAt: "2026-08-29T09:15:00.000Z",
      }),
      [],
      NOW,
    ),
    (error) => error instanceof DomainError && error.code === "INVALID_EXPECTATION_TIME",
  );
});

test("invalid consequence occurredAt fails closed", () => {
  const invalidReport = artifact({
    id: "invalid-report",
    kind: "EXAM_REPORT",
    occurredAt: "not-a-time",
  });

  assert.throws(
    () => evaluateExpectation(expectation(), [invalidReport], NOW),
    (error) => error instanceof DomainError && error.code === "INVALID_ARTIFACT_TIME",
  );
});

test("no consequence at dueAt is UNMET", () => {
  const result = evaluateExpectation(expectation(), [], DUE);
  assert.equal(result.state, "UNMET");
});

test("no consequence before dueAt remains quiet OPEN", () => {
  const result = evaluateExpectation(expectation(), [], NOW);
  const view = projectManagerClosure({
    workflow: workflow(),
    expectation: result,
    evidenceArtifactIds: [],
  });

  assert.equal(result.state, "OPEN");
  assert.equal(view.needsReview, false);
});

test("explicit void becomes VOIDED rather than UNMET", () => {
  const result = evaluateExpectation(expectation(), [], DUE, true);
  assert.equal(result.state, "VOIDED");
});

test("parser extras cannot set Workflow, Link, Expectation, or manager verdict", () => {
  const source = artifact();
  const repositories = createInMemoryRepositories();
  const result = runGoldenPath(
    {
      ...input(source),
      parser: (item) => ({
        ...factCard(item),
        workflowId: "model-workflow",
        link: { modelOwned: true },
        expectationState: "MET",
        managerVerdict: "CLOSE",
      }),
    },
    repositories,
  );

  assert.equal(Object.hasOwn(result.factCard, "workflowId"), false);
  assert.equal(Object.hasOwn(result.factCard, "link"), false);
  assert.notEqual(result.workflow?.id, "model-workflow");
  assert.equal(result.expectation?.state, "OPEN");
  assert.equal(result.managerView.needsReview, false);
});

test("stored Artifact is deeply immutable", () => {
  const repositories = createInMemoryRepositories();
  const source = artifact({ payload: { nested: { value: 1 } } });
  const stored = repositories.artifacts.save(source);

  assert.throws(() => {
    (stored.payload as { nested: { value: number } }).nested.value = 2;
  }, TypeError);
  assert.equal(
    (repositories.artifacts.get("clinic-1", source.id)?.payload as {
      nested: { value: number };
    }).nested.value,
    1,
  );
  assert.throws(
    () => repositories.artifacts.save({ ...source, kind: "CHANGED" }),
    (error) => error instanceof DomainError && error.code === "ARTIFACT_IMMUTABLE",
  );
});

test("link failure rolls back a newly staged Workflow", () => {
  const repositories = createInMemoryRepositories({
    workflowSaga: {
      beforeLinkCommit: () => {
        throw new Error("synthetic link failure");
      },
    },
  });

  assert.throws(() => runGoldenPath(input(), repositories), /synthetic link failure/);
  assert.equal(repositories.workflows.listOpenWorkflows("clinic-1").length, 0);
});

test("manager projection requires review only for UNMET or ambiguity", () => {
  const open = projectManagerClosure({
    workflow: workflow(),
    expectation: expectation({ state: "OPEN" }),
    evidenceArtifactIds: ["artifact-1"],
  });
  const met = projectManagerClosure({
    workflow: workflow(),
    expectation: expectation({ state: "MET" }),
    evidenceArtifactIds: ["artifact-1"],
  });
  const unmet = projectManagerClosure({
    workflow: workflow(),
    expectation: expectation({ state: "UNMET" }),
    evidenceArtifactIds: ["artifact-1"],
  });
  const ambiguous = projectManagerClosure({
    workflow: null,
    expectation: null,
    evidenceArtifactIds: ["artifact-1"],
    matchingAmbiguity: true,
  });

  assert.equal(open.needsReview, false);
  assert.equal(met.needsReview, false);
  assert.deepEqual(unmet.reasonCodes, ["EXPECTATION_UNMET"]);
  assert.deepEqual(ambiguous.reasonCodes, ["MATCHING_AMBIGUITY"]);
});
