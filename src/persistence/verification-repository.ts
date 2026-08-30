import { assertActorContext } from "../domain/access-context.ts";
import type {
  ActorContext,
  Artifact,
  Expectation,
  VerificationResult,
  Workflow,
} from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { verifyS2 } from "../domain/s2-verification.ts";
import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";
import type { ExpectationTransition } from "./expectation-repository.ts";
import { parseStrictIsoInstant } from "./strict-timestamp.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

const VERIFIER_VERSION = "S2_V1";

export interface S2VerificationRecord extends VerificationResult {
  id: string;
  clinicId: string;
  sourceTransitionId: string;
  verifierVersion: typeof VERIFIER_VERSION;
}

export interface PersistedVerification {
  result: VerificationResult;
  record: S2VerificationRecord;
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
  from_state: Expectation["state"] | null;
  to_state: Expectation["state"];
  evaluated_at: Date | string;
  trigger_artifact_id: string;
  satisfied_by_artifact_id: string | null;
  evidence_artifact_ids: string[];
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

type VerificationRow = {
  clinic_id: string;
  id: string;
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

export class VerificationRepository {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async verifyCurrentExpectation(
    context: ActorContext,
    expectationId: string,
  ): Promise<PersistedVerification> {
    const captured = structuredClone({ context, expectationId });
    assertActorContext(captured.context);
    if (typeof captured.expectationId !== "string" || captured.expectationId.trim() === "") {
      throw new DomainError("EXPECTATION_ID_REQUIRED", "Expectation ID is required.");
    }

    return withTenantTransaction(this.#pool, captured.context.clinicId, (client) =>
      verifyCurrentExpectationInTransaction(client, captured.context.clinicId, captured.expectationId));
  }
}

/** Trusted internal core: caller must already hold a tenant-scoped transaction. */
export async function verifyCurrentExpectationInTransaction(
  client: TenantQueryClient,
  clinicId: string,
  expectationId: string,
): Promise<PersistedVerification> {
      const expectation = await findExpectation(client, clinicId, expectationId);
      if (!expectation) {
        throw new DomainError("EXPECTATION_NOT_FOUND", "Expectation is not readable in this clinic.");
      }
      validateExpectationTimes(expectation);

      const workflow = await findWorkflow(client, clinicId, expectation.workflowId);
      if (!workflow) {
        throw new DomainError("WORKFLOW_NOT_FOUND", "Workflow is not readable in this clinic.");
      }
      validateWorkflow(workflow);

      const source = await findSourceTransition(client, clinicId, expectation);
      if (!source || !sourceMatchesProjection(source, expectation)) {
        throw new DomainError(
          "VERIFICATION_SOURCE_TRANSITION_NOT_FOUND",
          "Exactly one matching Expectation transition is required.",
        );
      }
      validateSourceTransition(source);
      const evaluatedAt = requireTimestamp(source.evaluatedAt, "INVALID_VERIFICATION_TIME");
      const recordId = `verification:${VERIFIER_VERSION}:${clinicId}:${source.id}`;
      const existing = await findVerification(client, clinicId, recordId);
      if (workflow.status !== "OPEN" && !existing) {
        throw new DomainError(
          "WORKFLOW_TERMINAL",
          "A terminal Workflow only permits replay of an existing Verification.",
        );
      }

      const artifacts = await findVisibleLinkedArtifacts(
        client,
        clinicId,
        workflow.id,
        evaluatedAt,
      );
      const result = verifyS2({ workflow, expectation, linkedArtifacts: artifacts, now: source.evaluatedAt });
      if (result.status !== "CONFLICT" && result.triggerArtifactId !== source.triggerArtifactId) {
        throw new DomainError(
          "VERIFICATION_SOURCE_EVIDENCE_CONFLICT",
          "The deterministic trigger does not match the source transition.",
        );
      }
      const proposed: S2VerificationRecord = {
        ...result,
        id: recordId,
        clinicId,
        sourceTransitionId: source.id,
        verifierVersion: VERIFIER_VERSION,
      };

      if (!existing) await insertVerification(client, proposed);
      const stored = await findVerification(client, clinicId, recordId);
      if (!stored || !recordEqual(stored, proposed)) {
        throw new DomainError(
          "S2_VERIFICATION_CONFLICT",
          "The deterministic Verification identity has different content.",
        );
      }
      return structuredClone({ result: resultFromRecord(stored), record: stored });
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

async function findSourceTransition(
  client: TenantQueryClient,
  clinicId: string,
  expectation: Expectation,
): Promise<ExpectationTransition | null> {
  const result = await client.query<TransitionRow>(
    `SELECT id, clinic_id, expectation_id, workflow_id, from_state, to_state,
            evaluated_at, trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids
       FROM expectation_transition
      WHERE clinic_id = $1 AND expectation_id = $2 AND workflow_id = $3
        AND evaluated_at = $4 AND to_state = $5`,
    [clinicId, expectation.id, expectation.workflowId, expectation.evaluatedAt, expectation.state],
  );
  if (result.rows.length !== 1) return null;
  return transitionFromRow(result.rows[0]);
}

async function findVisibleLinkedArtifacts(
  client: TenantQueryClient,
  clinicId: string,
  workflowId: string,
  evaluatedAt: number,
): Promise<Artifact[]> {
  const result = await client.query<LinkedArtifactRow>(
    `SELECT a.id, a.clinic_id, a.kind, a.occurred_at, a.occurred_at_source,
            a.source_employee_id, a.identity_anchor, a.payload, a.created_at, l.attached_at
       FROM workflow_artifact_link l
       JOIN artifact a ON a.clinic_id = l.clinic_id AND a.id = l.artifact_id
      WHERE l.clinic_id = $1 AND l.workflow_id = $2
      ORDER BY a.occurred_at NULLS LAST, a.id`,
    [clinicId, workflowId],
  );
  const visible: Artifact[] = [];
  for (const row of result.rows) {
    const attachedAt = requireTimestamp(timestamp(row.attached_at), "INVALID_LINK_TIME");
    const createdAt = timestamp(row.created_at);
    requireTimestamp(createdAt, "INVALID_ARTIFACT_TIME");
    const occurredAt = timestamp(row.occurred_at);
    if (occurredAt !== null) requireTimestamp(occurredAt, "INVALID_ARTIFACT_TIME");
    if (attachedAt <= evaluatedAt) {
      if (
        isBlank(row.id) || isBlank(row.clinic_id) || isBlank(row.kind) ||
        isBlank(row.source_employee_id)
      ) {
        throw new DomainError(
          "INVALID_STORED_VERIFICATION_CONTRACT",
          "Linked Artifact identity fields are malformed.",
        );
      }
      visible.push({
        id: row.id,
        clinicId: row.clinic_id,
        kind: row.kind,
        occurredAt,
        occurredAtSource: row.occurred_at_source,
        sourceEmployeeId: row.source_employee_id,
        identityAnchor: row.identity_anchor,
        payload: structuredClone(row.payload),
        createdAt: createdAt as string,
      });
    }
  }
  return visible;
}

async function findVerification(
  client: TenantQueryClient,
  clinicId: string,
  verificationId: string,
): Promise<S2VerificationRecord | null> {
  const result = await client.query<VerificationRow>(
    `SELECT clinic_id, id, workflow_id, expectation_id, source_transition_id,
            verifier_version, status, reason_codes, trigger_artifact_id,
            consequence_artifact_id, evidence_artifact_ids, evaluated_at
       FROM s2_verification WHERE clinic_id = $1 AND id = $2`,
    [clinicId, verificationId],
  );
  return result.rows[0] ? verificationFromRow(result.rows[0]) : null;
}

async function insertVerification(
  client: TenantQueryClient,
  record: S2VerificationRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO s2_verification
       (clinic_id, id, workflow_id, expectation_id, source_transition_id,
        verifier_version, status, reason_codes, trigger_artifact_id,
        consequence_artifact_id, evidence_artifact_ids, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [
      record.clinicId,
      record.id,
      record.workflowId,
      record.expectationId,
      record.sourceTransitionId,
      record.verifierVersion,
      record.status,
      record.reasonCodes,
      record.triggerArtifactId,
      record.consequenceArtifactId,
      record.evidenceArtifactIds,
      record.evaluatedAt,
    ],
  );
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

function verificationFromRow(row: VerificationRow): S2VerificationRecord {
  if (row.verifier_version !== VERIFIER_VERSION) {
    throw new DomainError("INVALID_VERIFIER_VERSION", "Stored verifier version is unsupported.");
  }
  return {
    id: row.id,
    clinicId: row.clinic_id,
    workflowId: row.workflow_id,
    expectationId: row.expectation_id,
    sourceTransitionId: row.source_transition_id,
    verifierVersion: row.verifier_version,
    status: row.status,
    reasonCodes: [...row.reason_codes],
    triggerArtifactId: row.trigger_artifact_id,
    consequenceArtifactId: row.consequence_artifact_id,
    evidenceArtifactIds: [...row.evidence_artifact_ids],
    evaluatedAt: timestamp(row.evaluated_at) as string,
  };
}

function sourceMatchesProjection(source: ExpectationTransition, expectation: Expectation): boolean {
  return source.clinicId === expectation.clinicId &&
    source.expectationId === expectation.id &&
    source.workflowId === expectation.workflowId &&
    source.toState === expectation.state &&
    source.satisfiedByArtifactId === expectation.satisfiedByArtifactId &&
    sameInstant(source.evaluatedAt, expectation.evaluatedAt);
}

function validateExpectationTimes(expectation: Expectation): void {
  if (
    isBlank(expectation.id) || isBlank(expectation.clinicId) ||
    isBlank(expectation.workflowId) || isBlank(expectation.triggerKind) ||
    isBlank(expectation.consequenceKind)
  ) {
    throw new DomainError(
      "INVALID_STORED_VERIFICATION_CONTRACT",
      "Stored Expectation identity fields are malformed.",
    );
  }
  const triggeredAt = requireTimestamp(expectation.triggeredAt, "INVALID_EXPECTATION_TIME");
  const dueAt = requireTimestamp(expectation.dueAt, "INVALID_EXPECTATION_TIME");
  const evaluatedAt = requireTimestamp(expectation.evaluatedAt, "INVALID_EXPECTATION_TIME");
  if (triggeredAt > dueAt || triggeredAt > evaluatedAt) {
    throw new DomainError("INVALID_EXPECTATION_TIME", "Stored Expectation time bounds are invalid.");
  }
}

function validateWorkflow(workflow: Workflow): void {
  if (
    isBlank(workflow.id) || isBlank(workflow.clinicId) || isBlank(workflow.subjectType) ||
    isBlank(workflow.workflowFamily) || workflow.identityAnchor === null ||
    isBlank(workflow.identityAnchor)
  ) {
    throw new DomainError(
      "INVALID_STORED_VERIFICATION_CONTRACT",
      "Stored Workflow identity fields are malformed.",
    );
  }
  requireTimestamp(workflow.createdAt, "INVALID_WORKFLOW_TIME");
  requireTimestamp(workflow.updatedAt, "INVALID_WORKFLOW_TIME");
}

function validateSourceTransition(source: ExpectationTransition): void {
  if (
    isBlank(source.id) || isBlank(source.clinicId) || isBlank(source.expectationId) ||
    isBlank(source.workflowId) || isBlank(source.triggerArtifactId) ||
    source.evidenceArtifactIds.some(isBlank) ||
    new Set(source.evidenceArtifactIds).size !== source.evidenceArtifactIds.length ||
    !source.evidenceArtifactIds.includes(source.triggerArtifactId) ||
    (source.satisfiedByArtifactId !== null &&
      !source.evidenceArtifactIds.includes(source.satisfiedByArtifactId))
  ) {
    throw new DomainError(
      "INVALID_STORED_VERIFICATION_CONTRACT",
      "Stored source transition is malformed.",
    );
  }
}

function requireTimestamp(value: string | null, code: string): number {
  const parsed = parseStrictIsoInstant(value);
  if (parsed === null) throw new DomainError(code, "Stored timestamp is invalid.");
  return parsed;
}

function resultFromRecord(record: S2VerificationRecord): VerificationResult {
  const { workflowId, expectationId, status, reasonCodes, triggerArtifactId,
    consequenceArtifactId, evidenceArtifactIds, evaluatedAt } = record;
  return { workflowId, expectationId, status, reasonCodes: [...reasonCodes], triggerArtifactId,
    consequenceArtifactId, evidenceArtifactIds: [...evidenceArtifactIds], evaluatedAt };
}

function recordEqual(left: S2VerificationRecord, right: S2VerificationRecord): boolean {
  return left.id === right.id && left.clinicId === right.clinicId &&
    left.workflowId === right.workflowId && left.expectationId === right.expectationId &&
    left.sourceTransitionId === right.sourceTransitionId &&
    left.verifierVersion === right.verifierVersion && left.status === right.status &&
    JSON.stringify(left.reasonCodes) === JSON.stringify(right.reasonCodes) &&
    left.triggerArtifactId === right.triggerArtifactId &&
    left.consequenceArtifactId === right.consequenceArtifactId &&
    JSON.stringify(left.evidenceArtifactIds) === JSON.stringify(right.evidenceArtifactIds) &&
    sameInstant(left.evaluatedAt, right.evaluatedAt);
}

function sameInstant(left: string, right: string): boolean {
  return parseStrictIsoInstant(left) === parseStrictIsoInstant(right);
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}
