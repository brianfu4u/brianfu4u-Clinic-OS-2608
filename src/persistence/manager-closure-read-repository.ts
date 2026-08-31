import { assertActorContext } from "../domain/access-context.ts";
import type {
  ActorContext,
  Expectation,
  ManagerDecisionAction,
  VerificationResult,
  Workflow,
} from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { projectManagerClosure } from "../domain/manager-projection.ts";
import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";
import { parseStrictIsoInstant } from "./strict-timestamp.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

const WORKFLOW_STATUSES = ["OPEN", "CLOSED", "VOIDED"] as const;
const EXPECTATION_STATES = ["OPEN", "MET", "UNMET", "VOIDED"] as const;
const VERIFICATION_STATUSES = ["PENDING", "VERIFIED", "CONFLICT"] as const;
const DECISION_ACTIONS = ["CLOSE_STANDARD", "CLOSE_EXCEPTION", "KEEP_OPEN", "VOID"] as const;
const DECISION_REASONS = [
  "LEGITIMATE_DEVIATION", "MISSING_EXTERNAL_RECORD", "DUPLICATE_WORKFLOW",
  "PATIENT_CANCELLED", "NEEDS_MORE_EVIDENCE",
] as const;
const VERIFICATION_REASONS = [
  "TRIGGER_NOT_FOUND", "CONSEQUENCE_NOT_FOUND", "IDENTITY_CONFLICT", "TIME_CONFLICT",
  "KIND_CONFLICT", "EXPECTATION_EVIDENCE_CONFLICT", "CHAIN_OPEN", "CHAIN_UNMET",
  "CHAIN_VOIDED",
] as const;

export interface ManagerClosureReadItem {
  workflowId: string;
  workflowStatus: Workflow["status"];
  identityAnchor: string | null;
  workflowFamily: string;
  expectationId: string | null;
  expectationState: Expectation["state"] | null;
  verificationStatus: VerificationResult["status"] | null;
  verificationReasonCodes: string[];
  evidenceArtifactIds: string[];
  needsReview: boolean;
  reasonCodes: string[];
  latestDecision: {
    action: ManagerDecisionAction;
    reasonCode: string | null;
    decidedAt: string;
  } | null;
}

type WorkflowRow = {
  clinic_id: string; id: string; subject_type: string; identity_anchor: string | null;
  workflow_family: string; status: Workflow["status"]; created_at: Date | string;
  updated_at: Date | string;
};
type ExpectationRow = {
  clinic_id: string; id: string; workflow_id: string; trigger_kind: string;
  consequence_kind: string; triggered_at: Date | string; due_at: Date | string;
  state: Expectation["state"]; satisfied_by_artifact_id: string | null;
  evaluated_at: Date | string;
};
type LinkRow = {
  clinic_id: string; workflow_id: string; artifact_id: string; attached_at: Date | string;
};
type TransitionRow = {
  clinic_id: string; id: string; expectation_id: string; workflow_id: string;
  to_state: Expectation["state"]; evaluated_at: Date | string; source: string;
};
type VerificationRow = {
  clinic_id: string; id: string; workflow_id: string; expectation_id: string;
  source_transition_id: string; verifier_version: string;
  status: VerificationResult["status"]; reason_codes: string[];
  trigger_artifact_id: string | null; consequence_artifact_id: string | null;
  evidence_artifact_ids: string[]; evaluated_at: Date | string;
};
type DecisionRow = {
  clinic_id: string; id: string; workflow_id: string; expectation_id: string;
  action: ManagerDecisionAction; reason_code: string | null; decided_at: Date | string;
  evidence_artifact_ids: string[]; verification_status: VerificationResult["status"];
  verification_reason_codes: string[]; verification_id: string;
  verification_source_transition_id: string; expectation_state: Exclude<Expectation["state"], "VOIDED">;
  verification_evaluated_at: Date | string;
};

export class ManagerClosureReadRepository {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async listManagerClosures(context: ActorContext): Promise<ManagerClosureReadItem[]> {
    const captured = structuredClone(context);
    assertActorContext(captured);
    if (captured.role !== "MANAGER") {
      throw new DomainError("ROLE_SCOPE_VIOLATION", "This operation requires the MANAGER role.");
    }
    return withTenantTransaction(this.#pool, captured.clinicId, async (client) =>
      structuredClone(await readClosures(client, captured.clinicId)));
  }
}

async function readClosures(
  client: TenantQueryClient,
  clinicId: string,
): Promise<ManagerClosureReadItem[]> {
  const workflows = (await client.query<WorkflowRow>(
    `SELECT clinic_id, id, subject_type, identity_anchor, workflow_family, status,
            created_at, updated_at
       FROM workflow WHERE clinic_id = $1 ORDER BY created_at, id`, [clinicId],
  )).rows;
  const expectations = (await client.query<ExpectationRow>(
    `SELECT clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
            due_at, state, satisfied_by_artifact_id, evaluated_at
       FROM expectation WHERE clinic_id = $1 ORDER BY workflow_id, triggered_at, id`, [clinicId],
  )).rows;
  const links = (await client.query<LinkRow>(
    `SELECT clinic_id, workflow_id, artifact_id, attached_at
       FROM workflow_artifact_link WHERE clinic_id = $1
      ORDER BY workflow_id, attached_at, artifact_id`, [clinicId],
  )).rows;
  const transitions = (await client.query<TransitionRow>(
    `SELECT clinic_id, id, expectation_id, workflow_id, to_state, evaluated_at, source
       FROM expectation_transition WHERE clinic_id = $1`, [clinicId],
  )).rows;
  const verifications = (await client.query<VerificationRow>(
    `SELECT clinic_id, id, workflow_id, expectation_id, source_transition_id,
            verifier_version, status, reason_codes, trigger_artifact_id,
            consequence_artifact_id, evidence_artifact_ids, evaluated_at
       FROM s2_verification WHERE clinic_id = $1`, [clinicId],
  )).rows;
  const decisions = (await client.query<DecisionRow>(
    `SELECT clinic_id, id, workflow_id, expectation_id, action, reason_code, decided_at,
            evidence_artifact_ids, verification_status, verification_reason_codes,
            verification_id, verification_source_transition_id, expectation_state,
            verification_evaluated_at
       FROM manager_decision WHERE clinic_id = $1`, [clinicId],
  )).rows;

  const workflowById = new Map<string, WorkflowRow>();
  for (const row of workflows) {
    validateWorkflow(row, clinicId);
    if (workflowById.has(row.id)) invalidStored();
    workflowById.set(row.id, row);
  }
  for (const row of expectations) validateExpectation(row, clinicId, workflowById);
  for (const row of links) validateLink(row, clinicId, workflowById);
  for (const row of transitions) validateTransition(row, clinicId, workflowById, expectations);
  for (const row of verifications) validateVerification(row, clinicId, workflowById, expectations, transitions);
  for (const row of decisions) {
    validateDecision(row, clinicId, workflowById, expectations, verifications, links);
  }

  const output: ManagerClosureReadItem[] = [];
  for (const workflowRow of workflows) {
    const workflow = workflowFromRow(workflowRow);
    const current = expectations.filter((row) => row.workflow_id === workflow.id);
    const workflowDecisions = decisions.filter((decision) => decision.workflow_id === workflow.id);
    const hasTerminalDecision = workflowDecisions.some((decision) =>
      decision.action === "CLOSE_STANDARD" || decision.action === "CLOSE_EXCEPTION" || decision.action === "VOID");
    const evidence = links.filter((row) => row.workflow_id === workflow.id).map((row) => row.artifact_id);
    if (new Set(evidence).size !== evidence.length) invalidStored();
    if (current.length === 0) {
      if (workflow.status !== "OPEN") invalidStored();
      output.push({
        workflowId: workflow.id, workflowStatus: workflow.status,
        identityAnchor: workflow.identityAnchor, workflowFamily: workflow.workflowFamily,
        expectationId: null, expectationState: null, verificationStatus: null,
        verificationReasonCodes: [], evidenceArtifactIds: evidence,
        needsReview: true, reasonCodes: ["EXPECTATION_MISSING"], latestDecision: null,
      });
      continue;
    }
    for (const row of current) {
      const expectation = expectationFromRow(row);
      const matchingTransitions = transitions.filter((candidate) =>
        candidate.expectation_id === expectation.id && candidate.workflow_id === workflow.id &&
        candidate.to_state === expectation.state && sameInstant(candidate.evaluated_at, expectation.evaluatedAt));
      if (matchingTransitions.length !== 1) invalidStored();
      const transition = matchingTransitions[0];
      const latest = latestDecision(decisions.filter((decision) =>
        decision.workflow_id === workflow.id && decision.expectation_id === expectation.id));
      if (latest && (
        (workflow.status === "OPEN" && latest.action !== "KEEP_OPEN") ||
        (workflow.status === "CLOSED" && !latest.action.startsWith("CLOSE_")) ||
        (workflow.status === "VOIDED" && latest.action !== "VOID") ||
        (workflow.status === "CLOSED" && latest.expectation_state !== expectation.state)
      )) invalidStored();

      let verification: VerificationResult | null = null;
      let itemEvidence = evidence;
      if (workflow.status === "OPEN") {
        const matches = verifications.filter((candidate) => candidate.verifier_version === "S2_V1" &&
          candidate.workflow_id === workflow.id && candidate.expectation_id === expectation.id &&
          candidate.source_transition_id === transition.id);
        if (matches.length > 1) invalidStored();
        if (matches[0]) verification = verificationFromRow(matches[0]);
      } else if (latest) {
        verification = verificationFromDecision(latest);
        itemEvidence = [...latest.evidence_artifact_ids];
      }

      const view = projectManagerClosure({ workflow, expectation, evidenceArtifactIds: itemEvidence, verification });
      const reasonCodes = [...view.reasonCodes];
      if (workflow.status === "OPEN" && !verification) reasonCodes.push("VERIFICATION_MISSING");
      if (workflow.status !== "OPEN" && !hasTerminalDecision) reasonCodes.push("TERMINAL_DECISION_MISSING");
      output.push({
        workflowId: workflow.id, workflowStatus: workflow.status,
        identityAnchor: workflow.identityAnchor, workflowFamily: workflow.workflowFamily,
        expectationId: expectation.id, expectationState: view.expectationState,
        verificationStatus: verification?.status ?? null,
        verificationReasonCodes: [...(verification?.reasonCodes ?? [])],
        evidenceArtifactIds: [...view.evidenceArtifactIds], needsReview: reasonCodes.length > 0,
        reasonCodes, latestDecision: latest ? {
          action: latest.action, reasonCode: latest.reason_code,
          decidedAt: timestamp(latest.decided_at),
        } : null,
      });
    }
  }
  return output;
}

function validateWorkflow(row: WorkflowRow, clinicId: string): void {
  if (row.clinic_id !== clinicId || blank(row.id) || blank(row.subject_type) ||
      blank(row.workflow_family) || !includes(WORKFLOW_STATUSES, row.status) ||
      (row.subject_type.trim().toUpperCase() === "PATIENT" && blank(row.identity_anchor)) ||
      !validTime(row.created_at) || !validTime(row.updated_at)) invalidStored();
}

function validateExpectation(
  row: ExpectationRow, clinicId: string, workflows: Map<string, WorkflowRow>,
): void {
  const triggered = instant(row.triggered_at); const due = instant(row.due_at);
  const evaluated = instant(row.evaluated_at);
  if (row.clinic_id !== clinicId || blank(row.id) || blank(row.workflow_id) ||
      blank(row.trigger_kind) || blank(row.consequence_kind) || !workflows.has(row.workflow_id) ||
      !includes(EXPECTATION_STATES, row.state) || triggered === null || due === null ||
      evaluated === null || due < triggered || evaluated < triggered ||
      (row.state === "MET") !== (row.satisfied_by_artifact_id !== null)) invalidStored();
}

function validateLink(row: LinkRow, clinicId: string, workflows: Map<string, WorkflowRow>): void {
  if (row.clinic_id !== clinicId || blank(row.workflow_id) || blank(row.artifact_id) ||
      !workflows.has(row.workflow_id) || !validTime(row.attached_at)) invalidStored();
}

function validateTransition(
  row: TransitionRow, clinicId: string, workflows: Map<string, WorkflowRow>,
  expectations: ExpectationRow[],
): void {
  if (row.clinic_id !== clinicId || blank(row.id) || !workflows.has(row.workflow_id) ||
      !expectations.some((item) => item.id === row.expectation_id && item.workflow_id === row.workflow_id) ||
      !includes(EXPECTATION_STATES, row.to_state) || !validTime(row.evaluated_at) ||
      !["DETERMINISTIC", "HUMAN"].includes(row.source)) invalidStored();
}

function validateVerification(
  row: VerificationRow, clinicId: string, workflows: Map<string, WorkflowRow>,
  expectations: ExpectationRow[], transitions: TransitionRow[],
): void {
  if (row.clinic_id !== clinicId || blank(row.id) || blank(row.verifier_version) ||
      !workflows.has(row.workflow_id) ||
      !expectations.some((item) => item.id === row.expectation_id && item.workflow_id === row.workflow_id) ||
      !transitions.some((item) => item.id === row.source_transition_id &&
        item.expectation_id === row.expectation_id && item.workflow_id === row.workflow_id &&
        sameInstant(item.evaluated_at, row.evaluated_at)) ||
      !includes(VERIFICATION_STATUSES, row.status) || !validReasons(row.reason_codes) ||
      !validIdArray(row.evidence_artifact_ids) || !validTime(row.evaluated_at) ||
      (row.trigger_artifact_id !== null && !row.evidence_artifact_ids.includes(row.trigger_artifact_id)) ||
      (row.consequence_artifact_id !== null && !row.evidence_artifact_ids.includes(row.consequence_artifact_id)) ||
      (row.status === "VERIFIED" && (row.reason_codes.length !== 0 ||
        row.trigger_artifact_id === null || row.consequence_artifact_id === null ||
        !sameArray(row.evidence_artifact_ids, [row.trigger_artifact_id, row.consequence_artifact_id]))) ||
      (row.status === "CONFLICT" && row.reason_codes.length === 0)) invalidStored();
}

function validateDecision(
  row: DecisionRow, clinicId: string, workflows: Map<string, WorkflowRow>,
  expectations: ExpectationRow[], verifications: VerificationRow[], links: LinkRow[],
): void {
  const verification = verifications.find((item) => item.id === row.verification_id &&
    item.workflow_id === row.workflow_id && item.expectation_id === row.expectation_id &&
    item.source_transition_id === row.verification_source_transition_id);
  const decidedAt = instant(row.decided_at);
  const verificationEvaluatedAt = instant(row.verification_evaluated_at);
  const visibleEvidence = links.filter((item) => item.workflow_id === row.workflow_id &&
    (instant(item.attached_at) as number) <= (decidedAt as number)).map((item) => item.artifact_id);
  if (row.clinic_id !== clinicId || blank(row.id) || !workflows.has(row.workflow_id) ||
      !expectations.some((item) => item.id === row.expectation_id && item.workflow_id === row.workflow_id) ||
      !includes(DECISION_ACTIONS, row.action) ||
      (row.reason_code !== null && !includes(DECISION_REASONS, row.reason_code)) ||
      !validTime(row.decided_at) || !validNonemptyIds(row.evidence_artifact_ids) ||
      !includes(VERIFICATION_STATUSES, row.verification_status) ||
      !validReasons(row.verification_reason_codes) ||
      !includes(["OPEN", "MET", "UNMET"] as const, row.expectation_state) ||
      !validTime(row.verification_evaluated_at) || !verification ||
      (decidedAt as number) < (verificationEvaluatedAt as number) ||
      (row.action === "CLOSE_STANDARD" &&
        (row.expectation_state !== "MET" || row.verification_status !== "VERIFIED")) ||
      (row.action === "CLOSE_EXCEPTION" &&
        (row.expectation_state !== "UNMET" || row.reason_code === null)) ||
      (row.action === "KEEP_OPEN" && (row.expectation_state === "MET" ||
        (row.expectation_state === "UNMET" && row.reason_code === null))) ||
      (row.action === "VOID" && row.reason_code === null) ||
      !sameArray(row.evidence_artifact_ids, visibleEvidence) ||
      verification.status !== row.verification_status ||
      !sameArray(verification.reason_codes, row.verification_reason_codes) ||
      !sameInstant(verification.evaluated_at, row.verification_evaluated_at)) invalidStored();
}

function workflowFromRow(row: WorkflowRow): Workflow {
  return { id: row.id, clinicId: row.clinic_id, subjectType: row.subject_type,
    identityAnchor: row.identity_anchor, workflowFamily: row.workflow_family, status: row.status,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
}

function expectationFromRow(row: ExpectationRow): Expectation {
  return { id: row.id, clinicId: row.clinic_id, workflowId: row.workflow_id,
    triggerKind: row.trigger_kind, consequenceKind: row.consequence_kind,
    triggeredAt: timestamp(row.triggered_at), dueAt: timestamp(row.due_at), state: row.state,
    satisfiedByArtifactId: row.satisfied_by_artifact_id, evaluatedAt: timestamp(row.evaluated_at) };
}

function verificationFromRow(row: VerificationRow): VerificationResult {
  return { workflowId: row.workflow_id, expectationId: row.expectation_id, status: row.status,
    reasonCodes: [...row.reason_codes], triggerArtifactId: null, consequenceArtifactId: null,
    evidenceArtifactIds: [...row.evidence_artifact_ids], evaluatedAt: timestamp(row.evaluated_at) };
}

function verificationFromDecision(row: DecisionRow): VerificationResult {
  return { workflowId: row.workflow_id, expectationId: row.expectation_id,
    status: row.verification_status, reasonCodes: [...row.verification_reason_codes],
    triggerArtifactId: null, consequenceArtifactId: null,
    evidenceArtifactIds: [...row.evidence_artifact_ids], evaluatedAt: timestamp(row.verification_evaluated_at) };
}

function latestDecision(rows: DecisionRow[]): DecisionRow | null {
  return rows.sort((left, right) => {
    const time = (instant(right.decided_at) as number) - (instant(left.decided_at) as number);
    return time || right.id.localeCompare(left.id);
  })[0] ?? null;
}

function timestamp(value: Date | string): string { return value instanceof Date ? value.toISOString() : value; }
function instant(value: Date | string): number | null { return parseStrictIsoInstant(timestamp(value)); }
function validTime(value: Date | string): boolean { return instant(value) !== null; }
function sameInstant(left: Date | string, right: Date | string): boolean { return instant(left) === instant(right); }
function blank(value: unknown): boolean { return typeof value !== "string" || value.trim() === ""; }
function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
function validIdArray(values: unknown): values is string[] {
  return Array.isArray(values) && values.every((value) => !blank(value)) &&
    new Set(values).size === values.length;
}
function validNonemptyIds(values: unknown): values is string[] {
  return validIdArray(values) && values.length > 0;
}
function validReasons(values: unknown): values is string[] {
  return Array.isArray(values) && values.every((value) => includes(VERIFICATION_REASONS, value)) &&
    new Set(values).size === values.length;
}
function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function invalidStored(): never {
  throw new DomainError("INVALID_STORED_MANAGER_CLOSURE", "Stored manager closure data is malformed.");
}
