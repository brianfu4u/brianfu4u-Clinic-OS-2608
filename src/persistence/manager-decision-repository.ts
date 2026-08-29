import { assertActorContext } from "../domain/access-context.ts";
import type {
  ActorContext,
  Expectation,
  ManagerDecision,
  ManagerDecisionAction,
  VerificationResult,
  Workflow,
} from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import {
  assertManagerActionAllowed,
  MANAGER_REASON_CODES,
} from "../domain/workflow-saga.ts";
import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";
import { parseStrictIsoInstant } from "./strict-timestamp.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

const INPUT_KEYS = ["action", "decidedAt", "expectationId", "id", "note", "reasonCode"];
const ACTIONS: readonly ManagerDecisionAction[] = [
  "CLOSE_STANDARD",
  "CLOSE_EXCEPTION",
  "KEEP_OPEN",
  "VOID",
];

export interface PersistedManagerDecision extends ManagerDecision {
  verificationId: string;
  verificationSourceTransitionId: string;
  expectationState: Exclude<Expectation["state"], "VOIDED">;
  verificationEvaluatedAt: string;
}

export interface ManagerDecisionCommand {
  id: string;
  expectationId: string;
  action: ManagerDecisionAction;
  reasonCode: string | null;
  note: string | null;
  decidedAt: string;
}

export interface PersistedManagerDecisionResult {
  decision: PersistedManagerDecision;
  workflow: Workflow;
  expectation: Expectation;
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
  to_state: Expectation["state"];
  evaluated_at: Date | string;
  trigger_artifact_id: string;
  satisfied_by_artifact_id: string | null;
};

type VerificationRow = {
  id: string;
  clinic_id: string;
  workflow_id: string;
  expectation_id: string;
  source_transition_id: string;
  verifier_version: string;
  status: VerificationResult["status"];
  reason_codes: string[];
  trigger_artifact_id: string | null;
  consequence_artifact_id: string | null;
  evidence_artifact_ids: string[];
  evaluated_at: Date | string;
};

type DecisionRow = {
  clinic_id: string;
  id: string;
  workflow_id: string;
  expectation_id: string;
  action: ManagerDecisionAction;
  reason_code: string | null;
  note: string | null;
  actor_id: string;
  actor_role: "MANAGER";
  decided_at: Date | string;
  evidence_artifact_ids: string[];
  verification_status: VerificationResult["status"];
  verification_reason_codes: string[];
  verification_id: string;
  verification_source_transition_id: string;
  expectation_state: Exclude<Expectation["state"], "VOIDED">;
  verification_evaluated_at: Date | string;
};

export class ManagerDecisionRepository {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async recordManagerDecision(
    context: ActorContext,
    input: ManagerDecisionCommand,
  ): Promise<PersistedManagerDecisionResult> {
    const captured = structuredClone({ context, input });
    const command = validateInput(captured.context, captured.input as unknown as Record<string, unknown>);

    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) => {
      let expectation = await findExpectation(client, captured.context.clinicId, command.expectationId);
      if (!expectation) {
        throw new DomainError("EXPECTATION_NOT_FOUND", "Expectation is not readable in this clinic.");
      }
      let workflow = await findWorkflow(client, captured.context.clinicId, expectation.workflowId);
      if (!workflow) {
        throw new DomainError("WORKFLOW_NOT_FOUND", "Workflow is not readable in this clinic.");
      }

      const existing = await findDecision(client, captured.context.clinicId, command.id);
      if (existing) {
        if (!sameCommand(existing, captured.context.actorId, command)) {
          throw new DomainError("DECISION_ID_CONFLICT", "Decision ID is already used by different content.");
        }
        return structuredClone({ decision: existing, workflow, expectation });
      }
      if (workflow.status !== "OPEN") {
        throw new DomainError("WORKFLOW_TERMINAL", "Closed and voided Workflows are terminal.");
      }
      if (expectation.state === "VOIDED") {
        throw new DomainError("EXPECTATION_TERMINAL", "A voided Expectation is terminal.");
      }

      const transition = await findCurrentTransition(client, captured.context.clinicId, expectation);
      if (!transition) {
        throw new DomainError(
          "DECISION_SOURCE_TRANSITION_NOT_FOUND",
          "Exactly one current Expectation transition is required.",
        );
      }
      const verification = await findCurrentVerification(
        client,
        captured.context.clinicId,
        expectation,
        transition,
      );
      if (!verification) {
        throw new DomainError(
          "DECISION_VERIFICATION_NOT_FOUND",
          "Exactly one current S2_V1 Verification is required.",
        );
      }
      if (
        verification.status === "VERIFIED" &&
        (
          expectation.state !== "MET" ||
          verification.triggerArtifactId !== transition.trigger_artifact_id ||
          verification.consequenceArtifactId !== expectation.satisfiedByArtifactId ||
          verification.reasonCodes.length !== 0 ||
          verification.evidenceArtifactIds.length !== 2 ||
          verification.evidenceArtifactIds[0] !== verification.triggerArtifactId ||
          verification.evidenceArtifactIds[1] !== verification.consequenceArtifactId
        )
      ) {
        throw new DomainError(
          "DECISION_VERIFICATION_MISMATCH",
          "The persisted VERIFIED snapshot does not match the current evidence projection.",
        );
      }

      const decidedAt = requireTimestamp(command.decidedAt, "INVALID_MANAGER_DECISION_TIME");
      const evaluatedAt = requireTimestamp(verification.evaluatedAt, "INVALID_VERIFICATION_TIME");
      const workflowUpdatedAt = requireTimestamp(workflow.updatedAt, "INVALID_WORKFLOW_TIME");
      if (decidedAt < evaluatedAt || decidedAt < workflowUpdatedAt) {
        throw new DomainError(
          "INVALID_DECISION_SNAPSHOT_TIME",
          "Decision time cannot precede its Verification or Workflow projection.",
        );
      }

      const evidenceArtifactIds = await findVisibleEvidenceIds(
        client,
        captured.context.clinicId,
        workflow.id,
        decidedAt,
      );
      assertManagerActionAllowed(
        command.action,
        expectation.state,
        verification.status,
        command.reasonCode,
      );

      const decision: PersistedManagerDecision = {
        id: command.id,
        clinicId: captured.context.clinicId,
        workflowId: workflow.id,
        expectationId: expectation.id,
        action: command.action,
        reasonCode: command.reasonCode,
        note: command.note,
        actorId: captured.context.actorId,
        actorRole: "MANAGER",
        decidedAt: command.decidedAt,
        evidenceArtifactIds,
        verificationStatus: verification.status,
        verificationReasonCodes: [...verification.reasonCodes],
        verificationId: verification.id,
        verificationSourceTransitionId: verification.sourceTransitionId,
        expectationState: expectation.state,
        verificationEvaluatedAt: verification.evaluatedAt,
      };

      await insertDecision(client, decision);
      const storedDecision = await findDecision(client, captured.context.clinicId, command.id);
      if (!storedDecision || !decisionEqual(storedDecision, decision)) {
        throw new DomainError("DECISION_ID_CONFLICT", "Decision ID has different persisted content.");
      }

      if (command.action === "VOID") {
        await insertVoidTransition(client, decision, transition.trigger_artifact_id);
        expectation = await voidExpectation(client, expectation, command.decidedAt);
        workflow = await updateWorkflow(client, workflow, "VOIDED", command.decidedAt);
      } else {
        const status = command.action.startsWith("CLOSE_") ? "CLOSED" : "OPEN";
        workflow = await updateWorkflow(client, workflow, status, command.decidedAt);
      }
      return structuredClone({ decision: storedDecision, workflow, expectation });
    });
  }
}

function validateInput(
  context: ActorContext,
  value: Record<string, unknown>,
): ManagerDecisionCommand {
  assertActorContext(context);
  if (context.role !== "MANAGER") {
    throw new DomainError("ROLE_SCOPE_VIOLATION", "This operation requires the MANAGER role.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== INPUT_KEYS.join("|")) {
    throw new DomainError("INVALID_MANAGER_DECISION", "Decision contains missing or unauthorized fields.");
  }
  if (isBlank(value.id) || isBlank(value.expectationId)) {
    throw new DomainError("INVALID_MANAGER_DECISION", "Decision and Expectation IDs are required.");
  }
  if (typeof value.action !== "string" || !ACTIONS.includes(value.action as ManagerDecisionAction)) {
    throw new DomainError("INVALID_MANAGER_ACTION", "Unknown manager action.");
  }
  const decidedAt = parseStrictIsoInstant(value.decidedAt);
  if (decidedAt === null) {
    throw new DomainError(
      "INVALID_MANAGER_DECISION_TIME",
      "Decision time requires an explicit valid ISO-8601 timestamp.",
    );
  }
  const reasonCode = nullableText(value.reasonCode, 100, "INVALID_REASON_CODE");
  if (reasonCode !== null && !(MANAGER_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new DomainError("INVALID_REASON_CODE", "Reason code is not controlled.");
  }
  return {
    id: value.id as string,
    expectationId: value.expectationId as string,
    action: value.action as ManagerDecisionAction,
    reasonCode,
    note: nullableText(value.note, 500, "INVALID_DECISION_NOTE"),
    decidedAt: new Date(decidedAt).toISOString(),
  };
}

function nullableText(value: unknown, maxLength: number, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new DomainError(code, "Value must be text or null.");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new DomainError(code, `Value cannot exceed ${maxLength} characters.`);
  }
  return trimmed;
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
  return result.rows.length === 1 ? expectationFromRow(result.rows[0]) : null;
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
  return result.rows.length === 1 ? workflowFromRow(result.rows[0]) : null;
}

async function findCurrentTransition(
  client: TenantQueryClient,
  clinicId: string,
  expectation: Expectation,
): Promise<TransitionRow | null> {
  const result = await client.query<TransitionRow>(
    `SELECT id, clinic_id, expectation_id, workflow_id, to_state, evaluated_at,
            trigger_artifact_id, satisfied_by_artifact_id
       FROM expectation_transition
      WHERE clinic_id = $1 AND expectation_id = $2 AND workflow_id = $3
        AND evaluated_at = $4 AND to_state = $5 AND source = 'DETERMINISTIC'`,
    [clinicId, expectation.id, expectation.workflowId, expectation.evaluatedAt, expectation.state],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  if (row.satisfied_by_artifact_id !== expectation.satisfiedByArtifactId) return null;
  return row;
}

async function findCurrentVerification(
  client: TenantQueryClient,
  clinicId: string,
  expectation: Expectation,
  transition: TransitionRow,
): Promise<null | {
  id: string;
  sourceTransitionId: string;
  status: VerificationResult["status"];
  reasonCodes: string[];
  triggerArtifactId: string | null;
  consequenceArtifactId: string | null;
  evidenceArtifactIds: string[];
  evaluatedAt: string;
}> {
  const result = await client.query<VerificationRow>(
    `SELECT id, clinic_id, workflow_id, expectation_id, source_transition_id,
            verifier_version, status, reason_codes, trigger_artifact_id,
            consequence_artifact_id, evidence_artifact_ids, evaluated_at
       FROM s2_verification
      WHERE clinic_id = $1 AND expectation_id = $2 AND workflow_id = $3
        AND source_transition_id = $4 AND verifier_version = 'S2_V1'`,
    [clinicId, expectation.id, expectation.workflowId, transition.id],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  const evaluatedAt = timestamp(row.evaluated_at);
  if (
    row.clinic_id !== clinicId || row.expectation_id !== expectation.id ||
    row.workflow_id !== expectation.workflowId || row.source_transition_id !== transition.id ||
    row.verifier_version !== "S2_V1" || !sameInstant(evaluatedAt, expectation.evaluatedAt) ||
    !sameInstant(evaluatedAt, timestamp(transition.evaluated_at))
  ) return null;
  return {
    id: row.id,
    sourceTransitionId: row.source_transition_id,
    status: row.status,
    reasonCodes: [...row.reason_codes],
    triggerArtifactId: row.trigger_artifact_id,
    consequenceArtifactId: row.consequence_artifact_id,
    evidenceArtifactIds: [...row.evidence_artifact_ids],
    evaluatedAt,
  };
}

async function findVisibleEvidenceIds(
  client: TenantQueryClient,
  clinicId: string,
  workflowId: string,
  decidedAt: number,
): Promise<string[]> {
  const result = await client.query<{ artifact_id: string; attached_at: Date | string }>(
    `SELECT artifact_id, attached_at FROM workflow_artifact_link
      WHERE clinic_id = $1 AND workflow_id = $2
      ORDER BY attached_at, artifact_id`,
    [clinicId, workflowId],
  );
  const ids: string[] = [];
  for (const row of result.rows) {
    const attachedAt = requireTimestamp(timestamp(row.attached_at), "INVALID_DECISION_LINK_TIME");
    if (attachedAt <= decidedAt) ids.push(row.artifact_id);
  }
  if (ids.length === 0 || ids.some(isBlank) || new Set(ids).size !== ids.length) {
    throw new DomainError("INVALID_DECISION_EVIDENCE", "Decision evidence lineage is malformed or empty.");
  }
  return ids;
}

async function findDecision(
  client: TenantQueryClient,
  clinicId: string,
  decisionId: string,
): Promise<PersistedManagerDecision | null> {
  const result = await client.query<DecisionRow>(
    `SELECT clinic_id, id, workflow_id, expectation_id, action, reason_code, note,
            actor_id, actor_role, decided_at, evidence_artifact_ids, verification_status,
            verification_reason_codes, verification_id, verification_source_transition_id,
            expectation_state, verification_evaluated_at
       FROM manager_decision WHERE clinic_id = $1 AND id = $2`,
    [clinicId, decisionId],
  );
  return result.rows.length === 1 ? decisionFromRow(result.rows[0]) : null;
}

async function insertDecision(
  client: TenantQueryClient,
  decision: PersistedManagerDecision,
): Promise<void> {
  await client.query(
    `INSERT INTO manager_decision
       (clinic_id, id, workflow_id, expectation_id, action, reason_code, note,
        actor_id, actor_role, decided_at, evidence_artifact_ids, verification_status,
        verification_reason_codes, verification_id, verification_source_transition_id,
        expectation_state, verification_evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [decision.clinicId, decision.id, decision.workflowId, decision.expectationId,
      decision.action, decision.reasonCode, decision.note, decision.actorId,
      decision.actorRole, decision.decidedAt, decision.evidenceArtifactIds,
      decision.verificationStatus, decision.verificationReasonCodes, decision.verificationId,
      decision.verificationSourceTransitionId, decision.expectationState,
      decision.verificationEvaluatedAt],
  );
}

async function insertVoidTransition(
  client: TenantQueryClient,
  decision: PersistedManagerDecision,
  triggerArtifactId: string,
): Promise<void> {
  const transitionId = `transition:void:${decision.clinicId}:${decision.id}`;
  await client.query(
    `INSERT INTO expectation_transition
       (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
        trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids, source)
     VALUES ($1, $2, $3, $4, $5, 'VOIDED', $6, $7, NULL, $8, 'HUMAN')
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [decision.clinicId, transitionId, decision.expectationId, decision.workflowId,
      decision.expectationState, decision.decidedAt, triggerArtifactId,
      decision.evidenceArtifactIds],
  );
  const result = await client.query<{
    expectation_id: string;
    workflow_id: string;
    from_state: Expectation["state"];
    to_state: Expectation["state"];
    evaluated_at: Date | string;
    trigger_artifact_id: string;
    evidence_artifact_ids: string[];
    source: string;
  }>(
    `SELECT expectation_id, workflow_id, from_state, to_state, evaluated_at,
            trigger_artifact_id, evidence_artifact_ids, source
       FROM expectation_transition WHERE clinic_id = $1 AND id = $2`,
    [decision.clinicId, transitionId],
  );
  const row = result.rows[0];
  if (!row || row.expectation_id !== decision.expectationId ||
      row.workflow_id !== decision.workflowId || row.from_state !== decision.expectationState ||
      row.to_state !== "VOIDED" || !sameInstant(timestamp(row.evaluated_at), decision.decidedAt) ||
      row.trigger_artifact_id !== triggerArtifactId || row.source !== "HUMAN" ||
      JSON.stringify(row.evidence_artifact_ids) !== JSON.stringify(decision.evidenceArtifactIds)) {
    throw new DomainError("VOID_TRANSITION_CONFLICT", "VOID transition has different persisted content.");
  }
}

async function voidExpectation(
  client: TenantQueryClient,
  expectation: Expectation,
  decidedAt: string,
): Promise<Expectation> {
  const result = await client.query<ExpectationRow>(
    `UPDATE expectation SET state = 'VOIDED', satisfied_by_artifact_id = NULL, evaluated_at = $1
      WHERE clinic_id = $2 AND id = $3 AND state = $4 AND evaluated_at = $5
      RETURNING id, clinic_id, workflow_id, trigger_kind, consequence_kind, triggered_at,
                due_at, state, satisfied_by_artifact_id, evaluated_at`,
    [decidedAt, expectation.clinicId, expectation.id, expectation.state, expectation.evaluatedAt],
  );
  if (result.rows.length !== 1) {
    throw new DomainError("EXPECTATION_PROJECTION_CONFLICT", "Expectation projection was concurrently changed.");
  }
  return expectationFromRow(result.rows[0]);
}

async function updateWorkflow(
  client: TenantQueryClient,
  workflow: Workflow,
  status: Workflow["status"],
  decidedAt: string,
): Promise<Workflow> {
  const result = await client.query<WorkflowRow>(
    `UPDATE workflow SET status = $1, updated_at = $2
      WHERE clinic_id = $3 AND id = $4 AND status = 'OPEN' AND updated_at = $5
      RETURNING id, clinic_id, subject_type, identity_anchor, workflow_family,
                status, created_at, updated_at`,
    [status, decidedAt, workflow.clinicId, workflow.id, workflow.updatedAt],
  );
  if (result.rows.length !== 1) {
    throw new DomainError("WORKFLOW_PROJECTION_CONFLICT", "Workflow projection was concurrently changed.");
  }
  return workflowFromRow(result.rows[0]);
}

function expectationFromRow(row: ExpectationRow): Expectation {
  return {
    id: row.id, clinicId: row.clinic_id, workflowId: row.workflow_id,
    triggerKind: row.trigger_kind, consequenceKind: row.consequence_kind,
    triggeredAt: timestamp(row.triggered_at), dueAt: timestamp(row.due_at), state: row.state,
    satisfiedByArtifactId: row.satisfied_by_artifact_id, evaluatedAt: timestamp(row.evaluated_at),
  };
}

function workflowFromRow(row: WorkflowRow): Workflow {
  return {
    id: row.id, clinicId: row.clinic_id, subjectType: row.subject_type,
    identityAnchor: row.identity_anchor, workflowFamily: row.workflow_family, status: row.status,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

function decisionFromRow(row: DecisionRow): PersistedManagerDecision {
  return {
    id: row.id, clinicId: row.clinic_id, workflowId: row.workflow_id,
    expectationId: row.expectation_id, action: row.action, reasonCode: row.reason_code,
    note: row.note, actorId: row.actor_id, actorRole: row.actor_role,
    decidedAt: timestamp(row.decided_at), evidenceArtifactIds: [...row.evidence_artifact_ids],
    verificationStatus: row.verification_status,
    verificationReasonCodes: [...row.verification_reason_codes],
    verificationId: row.verification_id,
    verificationSourceTransitionId: row.verification_source_transition_id,
    expectationState: row.expectation_state,
    verificationEvaluatedAt: timestamp(row.verification_evaluated_at),
  };
}

function sameCommand(
  decision: PersistedManagerDecision,
  actorId: string,
  command: ManagerDecisionCommand,
): boolean {
  return decision.id === command.id && decision.expectationId === command.expectationId &&
    decision.actorId === actorId && decision.action === command.action &&
    decision.reasonCode === command.reasonCode && decision.note === command.note &&
    sameInstant(decision.decidedAt, command.decidedAt);
}

function decisionEqual(left: PersistedManagerDecision, right: PersistedManagerDecision): boolean {
  return sameCommand(left, right.actorId, right) && left.clinicId === right.clinicId &&
    left.workflowId === right.workflowId && left.actorRole === right.actorRole &&
    JSON.stringify(left.evidenceArtifactIds) === JSON.stringify(right.evidenceArtifactIds) &&
    left.verificationStatus === right.verificationStatus &&
    JSON.stringify(left.verificationReasonCodes) === JSON.stringify(right.verificationReasonCodes) &&
    left.verificationId === right.verificationId &&
    left.verificationSourceTransitionId === right.verificationSourceTransitionId &&
    left.expectationState === right.expectationState &&
    sameInstant(left.verificationEvaluatedAt, right.verificationEvaluatedAt);
}

function requireTimestamp(value: string, code: string): number {
  const parsed = parseStrictIsoInstant(value);
  if (parsed === null) throw new DomainError(code, "Stored timestamp is invalid.");
  return parsed;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function sameInstant(left: string, right: string): boolean {
  const leftInstant = parseStrictIsoInstant(left);
  return leftInstant !== null && leftInstant === parseStrictIsoInstant(right);
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}
