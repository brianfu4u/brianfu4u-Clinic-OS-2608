import { assertActorContext } from "../domain/access-context.ts";
import type {
  ActorContext,
  Artifact,
  EvidenceFactCard,
  Workflow,
  WorkflowArtifactLink,
  WorkflowResolution,
} from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { assertAttachIdentity, assertFactCardIdentitySource } from "../domain/identity-gate.ts";
import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

export type WorkflowAttachResult =
  | {
      resolution: Exclude<WorkflowResolution, { kind: "REVIEW_REQUIRED" }>;
      workflow: Workflow;
      link: WorkflowArtifactLink;
    }
  | {
      resolution: Extract<WorkflowResolution, { kind: "REVIEW_REQUIRED" }>;
      workflow: null;
      link: null;
    };

type ArtifactRow = {
  id: string;
  clinic_id: string;
  kind: string;
  occurred_at: Date | string | null;
  occurred_at_source: Artifact["occurredAtSource"];
  source_employee_id: string;
  identity_anchor: string | null;
  payload: unknown;
  created_at: Date | string;
};

type FactCardRow = {
  id: string;
  clinic_id: string;
  artifact_id: string;
  subject_type: string;
  identity_anchor: string | null;
  workflow_family: string;
  occurred_at: Date | string | null;
  fields: Record<string, unknown>;
  missing_fields: string[];
  confidence: number;
  parser_version: string;
  lineage_artifact_ids: string[];
};

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

type LinkRow = {
  id: string;
  clinic_id: string;
  workflow_id: string;
  artifact_id: string;
  attached_at: Date | string;
  decision_source: WorkflowArtifactLink["decisionSource"];
  reasoning_chain: string[];
};

const REASONING_CHAIN = [
  "exact_clinic",
  "exact_subject",
  "exact_identity",
  "exact_workflow_family",
];

export class WorkflowAttachRepository {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async attachCapture(
    context: ActorContext,
    artifactId: string,
    factCardId: string,
    attachedAt: string,
  ): Promise<WorkflowAttachResult> {
    const captured = structuredClone({ context, artifactId, factCardId, attachedAt });
    validateInput(captured.context, captured.artifactId, captured.factCardId, captured.attachedAt);

    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) => {
      const artifact = await findArtifact(client, captured.context.clinicId, captured.artifactId);
      if (!artifact) throw new DomainError("ARTIFACT_NOT_FOUND", "Artifact is not readable in this clinic.");
      const factCard = await findFactCard(client, captured.context.clinicId, captured.factCardId);
      if (!factCard) throw new DomainError("FACT_CARD_NOT_FOUND", "FactCard is not readable in this clinic.");
      validateCapture(artifact, factCard);

      const existingLinks = await findLinksForArtifact(client, captured.context.clinicId, artifact.id);
      if (existingLinks.length > 1) {
        throw new DomainError("ARTIFACT_ALREADY_LINKED", "Artifact has conflicting authoritative links.");
      }
      if (existingLinks.length === 1) {
        return replayExistingLink(
          client,
          captured.context.clinicId,
          artifact,
          factCard,
          existingLinks[0],
          captured.attachedAt,
        );
      }

      const candidates = await findExactCandidates(client, captured.context.clinicId, factCard);
      if (candidates.length > 1) {
        return {
          resolution: {
            kind: "REVIEW_REQUIRED",
            candidateWorkflowIds: candidates.map(({ id }) => id),
          },
          workflow: null,
          link: null,
        };
      }

      const resolution: "ATTACH_EXISTING" | "CREATE_NEW" =
        candidates.length === 0 || candidates[0].id === workflowIdFor(artifact)
          ? "CREATE_NEW"
          : "ATTACH_EXISTING";
      let workflow = candidates[0] ?? makeWorkflow(
        captured.context.clinicId,
        artifact,
        factCard,
        captured.attachedAt,
      );
      assertAttachIdentity(factCard, workflow, artifact);

      if (resolution === "CREATE_NEW") {
        await insertWorkflow(client, workflow);
        const stored = await findWorkflow(client, captured.context.clinicId, workflow.id);
        if (!stored || !workflowEqual(stored, workflow)) {
          throw new DomainError("WORKFLOW_ID_CONFLICT", "Generated Workflow ID has different content.");
        }
        workflow = stored;
      }

      const link = makeLink(workflow, artifact, captured.attachedAt);
      await insertLink(client, link);
      const storedLink = await findLink(client, captured.context.clinicId, link.id);
      if (!storedLink || !linkEqual(storedLink, link)) {
        throw new DomainError("LINK_ID_CONFLICT", "Generated Link ID has different content.");
      }

      return structuredClone({
        resolution: resolution === "CREATE_NEW"
          ? { kind: "CREATE_NEW" as const }
          : { kind: "ATTACH_EXISTING" as const, workflowId: workflow.id },
        workflow,
        link: storedLink,
      });
    });
  }
}

function validateInput(
  context: ActorContext,
  artifactId: string,
  factCardId: string,
  attachedAt: string,
): void {
  assertActorContext(context);
  if (typeof artifactId !== "string" || artifactId.trim() === "") {
    throw new DomainError("ARTIFACT_ID_REQUIRED", "Artifact ID is required.");
  }
  if (typeof factCardId !== "string" || factCardId.trim() === "") {
    throw new DomainError("FACT_CARD_ID_REQUIRED", "FactCard ID is required.");
  }
  if (typeof attachedAt !== "string" || !isExplicitIsoTimestamp(attachedAt)) {
    throw new DomainError("INVALID_ATTACHED_AT", "An explicit valid attachedAt timestamp is required.");
  }
}

function isExplicitIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59
  ) return false;
  if (zone !== "Z") {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validateCapture(artifact: Artifact, factCard: EvidenceFactCard): void {
  if (factCard.clinicId !== artifact.clinicId || factCard.artifactId !== artifact.id) {
    throw new DomainError("FACT_CARD_ARTIFACT_MISMATCH", "FactCard must reference its supplied Artifact.");
  }
  if (!factCard.lineageArtifactIds.includes(artifact.id)) {
    throw new DomainError("FACT_CARD_LINEAGE_INVALID", "FactCard lineage must contain its Artifact.");
  }
  assertFactCardIdentitySource(factCard, artifact);
}

async function findArtifact(
  client: TenantQueryClient,
  clinicId: string,
  artifactId: string,
): Promise<Artifact | null> {
  const result = await client.query<ArtifactRow>(
    `SELECT id, clinic_id, kind, occurred_at, occurred_at_source, source_employee_id,
            identity_anchor, payload, created_at
       FROM artifact WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
    [clinicId, artifactId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    clinicId: row.clinic_id,
    kind: row.kind,
    occurredAt: timestamp(row.occurred_at),
    occurredAtSource: row.occurred_at_source,
    sourceEmployeeId: row.source_employee_id,
    identityAnchor: row.identity_anchor,
    payload: structuredClone(row.payload),
    createdAt: timestamp(row.created_at) as string,
  } : null;
}

async function findFactCard(
  client: TenantQueryClient,
  clinicId: string,
  factCardId: string,
): Promise<EvidenceFactCard | null> {
  const result = await client.query<FactCardRow>(
    `SELECT id, clinic_id, artifact_id, subject_type, identity_anchor, workflow_family,
            occurred_at, fields, missing_fields, confidence, parser_version, lineage_artifact_ids
       FROM evidence_fact_card WHERE clinic_id = $1 AND id = $2`,
    [clinicId, factCardId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    clinicId: row.clinic_id,
    artifactId: row.artifact_id,
    subjectType: row.subject_type,
    identityAnchor: row.identity_anchor,
    workflowFamily: row.workflow_family,
    occurredAt: timestamp(row.occurred_at),
    fields: structuredClone(row.fields),
    missingFields: [...row.missing_fields],
    confidence: row.confidence,
    parserVersion: row.parser_version,
    lineageArtifactIds: [...row.lineage_artifact_ids],
  } : null;
}

async function findExactCandidates(
  client: TenantQueryClient,
  clinicId: string,
  factCard: EvidenceFactCard,
): Promise<Workflow[]> {
  const result = await client.query<WorkflowRow>(
    `SELECT id, clinic_id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at
       FROM workflow
      WHERE clinic_id = $1 AND subject_type = $2 AND identity_anchor IS NOT DISTINCT FROM $3
        AND workflow_family = $4 AND status = 'OPEN'
      ORDER BY id
      FOR UPDATE`,
    [clinicId, factCard.subjectType, factCard.identityAnchor, factCard.workflowFamily],
  );
  return result.rows.map(workflowFromRow);
}

async function findWorkflow(
  client: TenantQueryClient,
  clinicId: string,
  workflowId: string,
): Promise<Workflow | null> {
  const result = await client.query<WorkflowRow>(
    `SELECT id, clinic_id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at
       FROM workflow WHERE clinic_id = $1 AND id = $2`,
    [clinicId, workflowId],
  );
  return result.rows[0] ? workflowFromRow(result.rows[0]) : null;
}

async function findLinksForArtifact(
  client: TenantQueryClient,
  clinicId: string,
  artifactId: string,
): Promise<WorkflowArtifactLink[]> {
  const result = await client.query<LinkRow>(
    `SELECT id, clinic_id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain
       FROM workflow_artifact_link WHERE clinic_id = $1 AND artifact_id = $2 ORDER BY id`,
    [clinicId, artifactId],
  );
  return result.rows.map(linkFromRow);
}

async function findLink(
  client: TenantQueryClient,
  clinicId: string,
  linkId: string,
): Promise<WorkflowArtifactLink | null> {
  const result = await client.query<LinkRow>(
    `SELECT id, clinic_id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain
       FROM workflow_artifact_link WHERE clinic_id = $1 AND id = $2`,
    [clinicId, linkId],
  );
  return result.rows[0] ? linkFromRow(result.rows[0]) : null;
}

async function replayExistingLink(
  client: TenantQueryClient,
  clinicId: string,
  artifact: Artifact,
  factCard: EvidenceFactCard,
  link: WorkflowArtifactLink,
  attachedAt: string,
): Promise<WorkflowAttachResult> {
  const workflow = await findWorkflow(client, clinicId, link.workflowId);
  if (!workflow) throw new DomainError("ARTIFACT_ALREADY_LINKED", "Artifact Link has no readable Workflow.");
  try {
    assertAttachIdentity(factCard, workflow, artifact);
  } catch {
    throw new DomainError("ARTIFACT_ALREADY_LINKED", "Artifact is linked to a different Workflow.");
  }
  const expected = makeLink(workflow, artifact, attachedAt);
  if (!linkEqual(link, expected)) {
    throw new DomainError("LINK_ID_CONFLICT", "Existing authoritative Link has different content.");
  }
  return structuredClone({
    resolution: workflow.id === workflowIdFor(artifact)
      ? { kind: "CREATE_NEW" as const }
      : { kind: "ATTACH_EXISTING" as const, workflowId: workflow.id },
    workflow,
    link,
  });
}

function makeWorkflow(
  clinicId: string,
  artifact: Artifact,
  factCard: EvidenceFactCard,
  attachedAt: string,
): Workflow {
  return {
    id: workflowIdFor(artifact),
    clinicId,
    subjectType: factCard.subjectType,
    identityAnchor: factCard.identityAnchor,
    workflowFamily: factCard.workflowFamily,
    status: "OPEN",
    createdAt: attachedAt,
    updatedAt: attachedAt,
  };
}

function makeLink(workflow: Workflow, artifact: Artifact, attachedAt: string): WorkflowArtifactLink {
  return {
    id: `link:${workflow.id}:${artifact.id}`,
    clinicId: artifact.clinicId,
    workflowId: workflow.id,
    artifactId: artifact.id,
    attachedAt,
    decisionSource: "DETERMINISTIC",
    reasoningChain: [...REASONING_CHAIN],
  };
}

function workflowIdFor(artifact: Artifact): string {
  return `wf:${artifact.clinicId}:${artifact.id}`;
}

async function insertWorkflow(client: TenantQueryClient, workflow: Workflow): Promise<void> {
  await client.query(
    `INSERT INTO workflow
       (id, clinic_id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [
      workflow.id,
      workflow.clinicId,
      workflow.subjectType,
      workflow.identityAnchor,
      workflow.workflowFamily,
      workflow.status,
      workflow.createdAt,
      workflow.updatedAt,
    ],
  );
}

async function insertLink(client: TenantQueryClient, link: WorkflowArtifactLink): Promise<void> {
  await client.query(
    `INSERT INTO workflow_artifact_link
       (id, clinic_id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      link.id,
      link.clinicId,
      link.workflowId,
      link.artifactId,
      link.attachedAt,
      link.decisionSource,
      link.reasoningChain,
    ],
  );
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

function linkFromRow(row: LinkRow): WorkflowArtifactLink {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    workflowId: row.workflow_id,
    artifactId: row.artifact_id,
    attachedAt: timestamp(row.attached_at) as string,
    decisionSource: row.decision_source,
    reasoningChain: [...row.reasoning_chain],
  };
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function workflowEqual(left: Workflow, right: Workflow): boolean {
  return JSON.stringify({ ...left, createdAt: instant(left.createdAt), updatedAt: instant(left.updatedAt) }) ===
    JSON.stringify({ ...right, createdAt: instant(right.createdAt), updatedAt: instant(right.updatedAt) });
}

function linkEqual(left: WorkflowArtifactLink, right: WorkflowArtifactLink): boolean {
  return JSON.stringify({ ...left, attachedAt: instant(left.attachedAt) }) ===
    JSON.stringify({ ...right, attachedAt: instant(right.attachedAt) });
}

function instant(value: string): number | string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : parsed;
}
