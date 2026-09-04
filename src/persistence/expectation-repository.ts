import { assertActorContext } from "../domain/access-context.ts";
import type {
  ActorContext,
  Artifact,
  Expectation,
  ExpectationSpec,
  Workflow,
} from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { evaluateExpectation } from "../domain/expectation.ts";
import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";
import { parseStrictIsoInstant } from "./strict-timestamp.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

export interface ExpectationTransition {
  id: string;
  clinicId: string;
  expectationId: string;
  workflowId: string;
  fromState: Expectation["state"] | null;
  toState: Expectation["state"];
  evaluatedAt: string;
  triggerArtifactId: string;
  satisfiedByArtifactId: string | null;
  evidenceArtifactIds: string[];
}

export interface InitializedExpectation {
  expectation: Expectation;
  transition: ExpectationTransition;
}

export interface ReevaluatedExpectation {
  expectation: Expectation;
  transition: ExpectationTransition | null;
}

type WorkflowRow = {
  id: string;
  clinic_id: string;
  subject_type: string;
  identity_anchor: string | null;
  workflow_family: string;
  status: Workflow["status"];
  created_at: Date | string;
  updated_at: Date | string;
};

type LinkedArtifactRow = {
  id: string;
  clinic_id: string;
  kind: string;
  occurred_at: Date | string | null;
  occurred_at_source: Artifact["occurredAtSource"];
  source_employee_id: string;
  identity_anchor: string | null;
  payload: unknown;
  created_at: Date | string;
  attached_at: Date | string;
};

type ExpectationRow = {
  id: string;
  clinic_id: string;
  workflow_id: string;
  trigger_kind: string;
  consequence_kind: string;
  triggered_at: Date | string;
  due_at: Date | string;
  state: Expectation["state"];
  satisfied_by_artifact_id: string | null;
  evaluated_at: Date | string;
};

type TransitionRow = {
  id: string;
  clinic_id: string;
  expectation_id: string;
  workflow_id: string;
  from_state: Expectation["state"] | null;
  to_state: Expectation["state"];
  evaluated_at: Date | string;
  trigger_artifact_id: string;
  satisfied_by_artifact_id: string | null;
  evidence_artifact_ids: string[];
};

export type ExpectationWorkspace = "DOCTOR" | "EXAM" | "CASHIER";
type AssignmentRow = { workspace: ExpectationWorkspace };

type LinkedArtifact = { artifact: Artifact; attachedAt: string };

const SPEC_KEYS = ["consequenceKind", "dueAt", "id", "triggerKind", "triggeredAt"];

export class ExpectationRepository {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async getExpectation(
    context: ActorContext,
    expectationId: string,
  ): Promise<Expectation | null> {
    const captured = structuredClone({ context, expectationId });
    assertActorContext(captured.context);
    if (typeof captured.expectationId !== "string" || captured.expectationId.trim() === "") {
      throw new DomainError("EXPECTATION_ID_REQUIRED", "Expectation ID is required.");
    }
    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) =>
      structuredClone(await findExpectation(
        client,
        captured.context.clinicId,
        captured.expectationId,
      )));
  }

  async initializeExpectation(
    context: ActorContext,
    workflowId: string,
    spec: Omit<ExpectationSpec, "voided">,
    evaluatedAt: string,
  ): Promise<InitializedExpectation> {
    const captured = structuredClone({ context, workflowId, spec, evaluatedAt });
    validateInput(
      captured.context,
      captured.workflowId,
      captured.spec as unknown as Record<string, unknown>,
      captured.evaluatedAt,
    );

    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) => {
      const workflow = await findWorkflow(client, captured.context.clinicId, captured.workflowId);
      if (!workflow) throw new DomainError("WORKFLOW_NOT_FOUND", "Workflow is not readable in this clinic.");
      if (workflow.status !== "OPEN") {
        throw new DomainError("WORKFLOW_TERMINAL", "Expectation initialization requires an open Workflow.");
      }

      const linked = await findLinkedArtifacts(client, captured.context.clinicId, workflow.id);
      const evaluationInstant = parseStrictIsoInstant(captured.evaluatedAt) as number;
      const visible = linked.filter(({ attachedAt }) => {
        const attachedInstant = parseStrictIsoInstant(attachedAt);
        if (attachedInstant === null) {
          throw new DomainError("INVALID_LINK_TIME", "Linked evidence has an invalid attachedAt time.");
        }
        return attachedInstant <= evaluationInstant;
      });
      const triggerInstant = parseStrictIsoInstant(captured.spec.triggeredAt) as number;
      const trigger = visible.find(({ artifact }) =>
        artifact.kind === captured.spec.triggerKind &&
        artifact.identityAnchor === workflow.identityAnchor &&
        artifact.occurredAt !== null &&
        parseStrictIsoInstant(artifact.occurredAt) === triggerInstant)?.artifact;
      if (!trigger) {
        throw new DomainError(
          "EXPECTATION_TRIGGER_NOT_FOUND",
          "An exact linked trigger Artifact is required for initialization.",
        );
      }

      const baseline: Expectation = {
        id: captured.spec.id,
        clinicId: captured.context.clinicId,
        workflowId: workflow.id,
        triggerKind: captured.spec.triggerKind,
        consequenceKind: captured.spec.consequenceKind,
        triggeredAt: captured.spec.triggeredAt,
        dueAt: captured.spec.dueAt,
        state: "OPEN",
        satisfiedByArtifactId: null,
        evaluatedAt: captured.evaluatedAt,
      };
      const exactIdentityArtifacts = visible
        .map(({ artifact }) => artifact)
        .filter(({ identityAnchor }) => identityAnchor === workflow.identityAnchor);
      const evaluated = evaluateExpectation(
        baseline,
        exactIdentityArtifacts,
        captured.evaluatedAt,
      );
      const transition = makeTransition(evaluated, trigger.id);

      const existing = await findExpectation(
        client,
        captured.context.clinicId,
        captured.spec.id,
      );
      if (existing) {
        if (!sameExpectationRule(existing, evaluated)) {
          throw new DomainError("EXPECTATION_ID_CONFLICT", "Expectation ID has different rule content.");
        }
        const existingTransition = await findTransition(
          client,
          captured.context.clinicId,
          transition.id,
        );
        if (!existingTransition || !transitionEqual(existingTransition, transition)) {
          throw new DomainError(
            "EXPECTATION_TRANSITION_ID_CONFLICT",
            "Initialization transition is missing or has different content.",
          );
        }
        await ensureWorkspaceAssignment(client, existing);
        return structuredClone({ expectation: existing, transition: existingTransition });
      }

      await insertExpectation(client, evaluated);
      await ensureWorkspaceAssignment(client, evaluated);
      const storedExpectation = await findExpectation(
        client,
        captured.context.clinicId,
        captured.spec.id,
      );
      if (!storedExpectation || !expectationEqual(storedExpectation, evaluated)) {
        throw new DomainError("EXPECTATION_ID_CONFLICT", "Expectation ID has different content.");
      }

      await insertTransition(client, transition);
      const storedTransition = await findTransition(
        client,
        captured.context.clinicId,
        transition.id,
      );
      if (!storedTransition || !transitionEqual(storedTransition, transition)) {
        throw new DomainError(
          "EXPECTATION_TRANSITION_ID_CONFLICT",
          "Initialization transition ID has different content.",
        );
      }
      return structuredClone({ expectation: storedExpectation, transition: storedTransition });
    });
  }

  async reevaluateExpectation(
    context: ActorContext,
    expectationId: string,
    evaluatedAt: string,
  ): Promise<ReevaluatedExpectation> {
    const captured = structuredClone({ context, expectationId, evaluatedAt });
    assertActorContext(captured.context);
    if (typeof captured.expectationId !== "string" || captured.expectationId.trim() === "") {
      throw new DomainError("EXPECTATION_ID_REQUIRED", "Expectation ID is required.");
    }
    const evaluationInstant = parseStrictIsoInstant(captured.evaluatedAt);
    if (evaluationInstant === null) {
      throw new DomainError(
        "INVALID_EXPECTATION_TIME",
        "Evaluation time requires an explicit valid ISO-8601 timestamp.",
      );
    }
    const canonicalEvaluatedAt = new Date(evaluationInstant).toISOString();

    return withTenantTransaction(this.#pool, captured.context.clinicId, (client) =>
      reevaluateExpectationInTransaction(
        client,
        captured.context.clinicId,
        captured.expectationId,
        canonicalEvaluatedAt,
      ));
  }
}

/** Trusted internal core: caller must already hold a tenant-scoped transaction. */
export async function reevaluateExpectationInTransaction(
  client: TenantQueryClient,
  clinicId: string,
  expectationId: string,
  canonicalEvaluatedAt: string,
): Promise<ReevaluatedExpectation> {
      const evaluationInstant = parseStrictIsoInstant(canonicalEvaluatedAt) as number;
      const expectation = await findExpectation(
        client,
        clinicId,
        expectationId,
      );
      if (!expectation) {
        throw new DomainError(
          "EXPECTATION_NOT_FOUND",
          "Expectation is not readable in this clinic.",
        );
      }

      const workflow = await findWorkflow(
        client,
        clinicId,
        expectation.workflowId,
      );
      if (!workflow) {
        throw new DomainError("WORKFLOW_NOT_FOUND", "Workflow is not readable in this clinic.");
      }
      if (workflow.status !== "OPEN") {
        throw new DomainError("WORKFLOW_TERMINAL", "Expectation re-evaluation requires an open Workflow.");
      }

      const initialization = await findInitializationTransition(
        client,
        clinicId,
        expectation.id,
      );
      if (!initialization || initialization.workflowId !== workflow.id) {
        throw new DomainError(
          "EXPECTATION_INITIALIZATION_NOT_FOUND",
          "A unique initialization transition is required for re-evaluation.",
        );
      }

      const linked = await findLinkedArtifacts(client, clinicId, workflow.id);
      const visible = linked.filter(({ artifact, attachedAt }) => {
        const attachedInstant = parseStrictIsoInstant(attachedAt);
        if (attachedInstant === null) {
          throw new DomainError("INVALID_LINK_TIME", "Linked evidence has an invalid attachedAt time.");
        }
        return attachedInstant <= evaluationInstant &&
          artifact.identityAnchor === workflow.identityAnchor;
      });
      const triggeredInstant = parseStrictIsoInstant(expectation.triggeredAt);
      const trigger = visible.find(({ artifact }) =>
        artifact.id === initialization.triggerArtifactId &&
        artifact.kind === expectation.triggerKind &&
        artifact.occurredAt !== null &&
        parseStrictIsoInstant(artifact.occurredAt) === triggeredInstant)?.artifact;
      if (!trigger) {
        throw new DomainError(
          "EXPECTATION_TRIGGER_NOT_FOUND",
          "The exact visible initialization trigger is required for re-evaluation.",
        );
      }

      const currentEvaluationInstant = parseStrictIsoInstant(expectation.evaluatedAt);
      if (currentEvaluationInstant === null) {
        throw new DomainError(
          "INVALID_EXPECTATION_TIME",
          "Stored Expectation evaluation time is invalid.",
        );
      }
      if (evaluationInstant < currentEvaluationInstant) {
        throw new DomainError(
          "EXPECTATION_EVALUATION_STALE",
          "Expectation evaluation time cannot move backwards.",
        );
      }
      if (evaluationInstant === currentEvaluationInstant ||
          expectation.state === "MET" || expectation.state === "VOIDED") {
        return structuredClone({ expectation, transition: null });
      }

      const evaluated = evaluateExpectation(
        expectation,
        visible.map(({ artifact }) => artifact),
        canonicalEvaluatedAt,
      );
      const transition = makeReevaluationTransition(evaluated, expectation.state, trigger.id);
      const existingById = await findTransition(
        client,
        clinicId,
        transition.id,
      );
      const existingAtInstant = await findTransitionAtEvaluation(
        client,
        clinicId,
        expectation.id,
        canonicalEvaluatedAt,
      );
      if (existingById || existingAtInstant) {
        throw new DomainError(
          "EXPECTATION_TRANSITION_ID_CONFLICT",
          "Evaluation transition identity has different or inconsistent content.",
        );
      }

      await insertTransition(client, transition);
      const storedTransition = await findTransition(
        client,
        clinicId,
        transition.id,
      );
      if (!storedTransition || !transitionEqual(storedTransition, transition)) {
        throw new DomainError(
          "EXPECTATION_TRANSITION_ID_CONFLICT",
          "Evaluation transition ID has different content.",
        );
      }

      const storedExpectation = await updateExpectation(
        client,
        evaluated,
        expectation.evaluatedAt,
      );
      if (!storedExpectation || !expectationEqual(storedExpectation, evaluated)) {
        throw new DomainError(
          "EXPECTATION_PROJECTION_CONFLICT",
          "Expectation projection could not be updated atomically.",
        );
      }
      return structuredClone({ expectation: storedExpectation, transition: storedTransition });
}

function validateInput(
  context: ActorContext,
  workflowId: string,
  spec: Record<string, unknown>,
  evaluatedAt: string,
): void {
  assertActorContext(context);
  if (typeof workflowId !== "string" || workflowId.trim() === "") {
    throw new DomainError("WORKFLOW_ID_REQUIRED", "Workflow ID is required.");
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new DomainError("INVALID_EXPECTATION_SPEC", "Expectation specification is required.");
  }
  if (Object.keys(spec).sort().join("|") !== SPEC_KEYS.join("|")) {
    throw new DomainError(
      "INVALID_EXPECTATION_SPEC",
      "Expectation specification contains missing or caller-controlled fields.",
    );
  }
  for (const key of ["id", "triggerKind", "consequenceKind"] as const) {
    if (typeof spec[key] !== "string" || spec[key].trim() === "") {
      throw new DomainError("INVALID_EXPECTATION_SPEC", `${key} is required.`);
    }
  }
  const triggeredAt = parseStrictIsoInstant(spec.triggeredAt);
  const dueAt = parseStrictIsoInstant(spec.dueAt);
  const evaluated = parseStrictIsoInstant(evaluatedAt);
  if (triggeredAt === null || dueAt === null || evaluated === null) {
    throw new DomainError(
      "INVALID_EXPECTATION_TIME",
      "Expectation times require explicit valid ISO-8601 timestamps.",
    );
  }
  if (triggeredAt > dueAt || triggeredAt > evaluated) {
    throw new DomainError(
      "INVALID_EXPECTATION_TIME",
      "Expectation trigger must not follow its due or evaluation time.",
    );
  }
}

async function findWorkflow(
  client: TenantQueryClient,
  clinicId: string,
  workflowId: string,
): Promise<Workflow | null> {
  const result = await client.query<WorkflowRow>(
    `SELECT id, clinic_id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at
       FROM workflow WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
    [clinicId, workflowId],
  );
  return result.rows[0] ? workflowFromRow(result.rows[0]) : null;
}

async function findLinkedArtifacts(
  client: TenantQueryClient,
  clinicId: string,
  workflowId: string,
): Promise<LinkedArtifact[]> {
  const result = await client.query<LinkedArtifactRow>(
    `SELECT a.id, a.clinic_id, a.kind, a.occurred_at, a.occurred_at_source,
            a.source_employee_id, a.identity_anchor, a.payload, a.created_at, l.attached_at
       FROM workflow_artifact_link l
       JOIN artifact a ON a.clinic_id = l.clinic_id AND a.id = l.artifact_id
      WHERE l.clinic_id = $1 AND l.workflow_id = $2
      ORDER BY a.occurred_at NULLS LAST, a.id`,
    [clinicId, workflowId],
  );
  return result.rows.map((row) => ({
    artifact: {
      id: row.id,
      clinicId: row.clinic_id,
      kind: row.kind,
      occurredAt: timestamp(row.occurred_at),
      occurredAtSource: row.occurred_at_source,
      sourceEmployeeId: row.source_employee_id,
      identityAnchor: row.identity_anchor,
      payload: structuredClone(row.payload),
      createdAt: timestamp(row.created_at) as string,
    },
    attachedAt: timestamp(row.attached_at) as string,
  }));
}

async function findExpectation(
  client: TenantQueryClient,
  clinicId: string,
  expectationId: string,
): Promise<Expectation | null> {
  const result = await client.query<ExpectationRow>(
    `SELECT id, clinic_id, workflow_id, trigger_kind, consequence_kind, triggered_at,
            due_at, state, satisfied_by_artifact_id, evaluated_at
       FROM expectation WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
    [clinicId, expectationId],
  );
  return result.rows[0] ? expectationFromRow(result.rows[0]) : null;
}

async function findTransition(
  client: TenantQueryClient,
  clinicId: string,
  transitionId: string,
): Promise<ExpectationTransition | null> {
  const result = await client.query<TransitionRow>(
    `SELECT id, clinic_id, expectation_id, workflow_id, from_state, to_state,
            evaluated_at, trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids
       FROM expectation_transition WHERE clinic_id = $1 AND id = $2`,
    [clinicId, transitionId],
  );
  return result.rows[0] ? transitionFromRow(result.rows[0]) : null;
}

async function findInitializationTransition(
  client: TenantQueryClient,
  clinicId: string,
  expectationId: string,
): Promise<ExpectationTransition | null> {
  const result = await client.query<TransitionRow>(
    `SELECT id, clinic_id, expectation_id, workflow_id, from_state, to_state,
            evaluated_at, trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids
       FROM expectation_transition
      WHERE clinic_id = $1 AND expectation_id = $2 AND from_state IS NULL`,
    [clinicId, expectationId],
  );
  return result.rows[0] ? transitionFromRow(result.rows[0]) : null;
}

async function findTransitionAtEvaluation(
  client: TenantQueryClient,
  clinicId: string,
  expectationId: string,
  evaluatedAt: string,
): Promise<ExpectationTransition | null> {
  const result = await client.query<TransitionRow>(
    `SELECT id, clinic_id, expectation_id, workflow_id, from_state, to_state,
            evaluated_at, trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids
       FROM expectation_transition
      WHERE clinic_id = $1 AND expectation_id = $2 AND evaluated_at = $3`,
    [clinicId, expectationId, evaluatedAt],
  );
  return result.rows[0] ? transitionFromRow(result.rows[0]) : null;
}

async function insertExpectation(client: TenantQueryClient, expectation: Expectation): Promise<void> {
  await client.query(
    `INSERT INTO expectation
       (id, clinic_id, workflow_id, trigger_kind, consequence_kind, triggered_at,
        due_at, state, satisfied_by_artifact_id, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [
      expectation.id,
      expectation.clinicId,
      expectation.workflowId,
      expectation.triggerKind,
      expectation.consequenceKind,
      expectation.triggeredAt,
      expectation.dueAt,
      expectation.state,
      expectation.satisfiedByArtifactId,
      expectation.evaluatedAt,
    ],
  );
}

export function workspaceForExpectationConsequence(kind: string): ExpectationWorkspace {
  if (kind === "PRESCRIPTION") return "DOCTOR";
  if (kind === "EXAM_REPORT") return "EXAM";
  if (kind === "PAYMENT") return "CASHIER";
  throw new DomainError("EXPECTATION_WORKSPACE_REQUIRED", "Expectation consequence is not assignable to a preview workspace.");
}

async function ensureWorkspaceAssignment(client: TenantQueryClient, expectation: Expectation): Promise<void> {
  const workspace = workspaceForExpectationConsequence(expectation.consequenceKind);
  await client.query(
    `INSERT INTO expectation_workspace_assignment (clinic_id, expectation_id, workspace)
     VALUES ($1, $2, $3)
     ON CONFLICT (clinic_id, expectation_id) DO NOTHING`,
    [expectation.clinicId, expectation.id, workspace],
  );
  const result = await client.query<AssignmentRow>(
    `SELECT workspace FROM expectation_workspace_assignment
      WHERE clinic_id = $1 AND expectation_id = $2`,
    [expectation.clinicId, expectation.id],
  );
  if (result.rows.length !== 1 || result.rows[0].workspace !== workspace) {
    throw new DomainError("EXPECTATION_WORKSPACE_CONFLICT", "Expectation workspace assignment conflicts with the rule.");
  }
}

async function insertTransition(
  client: TenantQueryClient,
  transition: ExpectationTransition,
): Promise<void> {
  await client.query(
    `INSERT INTO expectation_transition
       (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
        trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [
      transition.id,
      transition.clinicId,
      transition.expectationId,
      transition.workflowId,
      transition.fromState,
      transition.toState,
      transition.evaluatedAt,
      transition.triggerArtifactId,
      transition.satisfiedByArtifactId,
      transition.evidenceArtifactIds,
    ],
  );
}

async function updateExpectation(
  client: TenantQueryClient,
  expectation: Expectation,
  previousEvaluatedAt: string,
): Promise<Expectation | null> {
  const result = await client.query<ExpectationRow>(
    `UPDATE expectation
        SET state = $1, satisfied_by_artifact_id = $2, evaluated_at = $3
      WHERE clinic_id = $4 AND id = $5 AND evaluated_at = $6
      RETURNING id, clinic_id, workflow_id, trigger_kind, consequence_kind, triggered_at,
                due_at, state, satisfied_by_artifact_id, evaluated_at`,
    [
      expectation.state,
      expectation.satisfiedByArtifactId,
      expectation.evaluatedAt,
      expectation.clinicId,
      expectation.id,
      previousEvaluatedAt,
    ],
  );
  return result.rows[0] ? expectationFromRow(result.rows[0]) : null;
}

function makeTransition(expectation: Expectation, triggerArtifactId: string): ExpectationTransition {
  const evidenceArtifactIds = expectation.satisfiedByArtifactId === null ||
      expectation.satisfiedByArtifactId === triggerArtifactId
    ? [triggerArtifactId]
    : [triggerArtifactId, expectation.satisfiedByArtifactId];
  return {
    id: `transition:init:${expectation.clinicId}:${expectation.id}`,
    clinicId: expectation.clinicId,
    expectationId: expectation.id,
    workflowId: expectation.workflowId,
    fromState: null,
    toState: expectation.state,
    evaluatedAt: expectation.evaluatedAt,
    triggerArtifactId,
    satisfiedByArtifactId: expectation.satisfiedByArtifactId,
    evidenceArtifactIds,
  };
}

function makeReevaluationTransition(
  expectation: Expectation,
  fromState: Expectation["state"],
  triggerArtifactId: string,
): ExpectationTransition {
  const transition = makeTransition(expectation, triggerArtifactId);
  return {
    ...transition,
    id: `transition:eval:${expectation.clinicId}:${expectation.id}:${expectation.evaluatedAt}`,
    fromState,
  };
}

function workflowFromRow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    subjectType: row.subject_type,
    identityAnchor: row.identity_anchor,
    workflowFamily: row.workflow_family,
    status: row.status,
    createdAt: timestamp(row.created_at) as string,
    updatedAt: timestamp(row.updated_at) as string,
  };
}

function expectationFromRow(row: ExpectationRow): Expectation {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    workflowId: row.workflow_id,
    triggerKind: row.trigger_kind,
    consequenceKind: row.consequence_kind,
    triggeredAt: timestamp(row.triggered_at) as string,
    dueAt: timestamp(row.due_at) as string,
    state: row.state,
    satisfiedByArtifactId: row.satisfied_by_artifact_id,
    evaluatedAt: timestamp(row.evaluated_at) as string,
  };
}

function transitionFromRow(row: TransitionRow): ExpectationTransition {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    expectationId: row.expectation_id,
    workflowId: row.workflow_id,
    fromState: row.from_state,
    toState: row.to_state,
    evaluatedAt: timestamp(row.evaluated_at) as string,
    triggerArtifactId: row.trigger_artifact_id,
    satisfiedByArtifactId: row.satisfied_by_artifact_id,
    evidenceArtifactIds: [...row.evidence_artifact_ids],
  };
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function sameExpectationRule(left: Expectation, right: Expectation): boolean {
  return left.id === right.id && left.clinicId === right.clinicId &&
    left.workflowId === right.workflowId && left.triggerKind === right.triggerKind &&
    left.consequenceKind === right.consequenceKind &&
    sameInstant(left.triggeredAt, right.triggeredAt) && sameInstant(left.dueAt, right.dueAt);
}

function expectationEqual(left: Expectation, right: Expectation): boolean {
  return sameExpectationRule(left, right) && left.state === right.state &&
    left.satisfiedByArtifactId === right.satisfiedByArtifactId &&
    sameInstant(left.evaluatedAt, right.evaluatedAt);
}

function transitionEqual(left: ExpectationTransition, right: ExpectationTransition): boolean {
  return left.id === right.id && left.clinicId === right.clinicId &&
    left.expectationId === right.expectationId && left.workflowId === right.workflowId &&
    left.fromState === right.fromState && left.toState === right.toState &&
    sameInstant(left.evaluatedAt, right.evaluatedAt) &&
    left.triggerArtifactId === right.triggerArtifactId &&
    left.satisfiedByArtifactId === right.satisfiedByArtifactId &&
    JSON.stringify(left.evidenceArtifactIds) === JSON.stringify(right.evidenceArtifactIds);
}

function sameInstant(left: string, right: string): boolean {
  return parseStrictIsoInstant(left) === parseStrictIsoInstant(right);
}
