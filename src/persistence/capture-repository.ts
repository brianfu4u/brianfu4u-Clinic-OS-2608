import type { ActorContext, Artifact, EvidenceFactCard } from "../domain/contracts.ts";
import { assertActorContext } from "../domain/access-context.ts";
import { DomainError } from "../domain/errors.ts";
import { assertFactCardIdentitySource } from "../domain/identity-gate.ts";
import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

export interface SavedCapture {
  artifact: Artifact;
  factCard: EvidenceFactCard;
}

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

const ARTIFACT_COLUMNS = `
  id, clinic_id, kind, occurred_at, occurred_at_source, source_employee_id,
  identity_anchor, payload, created_at
`;

const FACT_CARD_COLUMNS = `
  id, clinic_id, artifact_id, subject_type, identity_anchor, workflow_family,
  occurred_at, fields, missing_fields, confidence, parser_version, lineage_artifact_ids
`;

export class CaptureRepository {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async saveCapture(
    context: ActorContext,
    artifact: Artifact,
    factCard: EvidenceFactCard,
  ): Promise<SavedCapture> {
    const captured = structuredClone({ context, artifact, factCard });
    validateCapture(captured.context, captured.artifact, captured.factCard);
    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) => {
      await insertArtifact(client, captured.context.clinicId, captured.artifact);
      const storedArtifact = await findArtifact(
        client,
        captured.context.clinicId,
        captured.artifact.id,
      );
      if (!storedArtifact || !artifactEqual(storedArtifact, captured.artifact)) {
        throw new DomainError("ARTIFACT_ID_CONFLICT", "Artifact ID is already used by different content.");
      }

      await insertFactCard(client, captured.context.clinicId, captured.factCard);
      const storedFactCard = await findFactCard(
        client,
        captured.context.clinicId,
        captured.factCard.id,
      );
      if (!storedFactCard || !factCardEqual(storedFactCard, captured.factCard)) {
        throw new DomainError("FACT_CARD_ID_CONFLICT", "FactCard ID is already used by different content.");
      }

      return {
        artifact: structuredClone(captured.artifact),
        factCard: structuredClone(captured.factCard),
      };
    });
  }

  async getArtifact(context: ActorContext, artifactId: string): Promise<Artifact | null> {
    const captured = structuredClone({ context, artifactId });
    assertActorContext(captured.context);
    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) =>
      structuredClone(await findArtifact(client, captured.context.clinicId, captured.artifactId)));
  }

  async getFactCard(context: ActorContext, factCardId: string): Promise<EvidenceFactCard | null> {
    const captured = structuredClone({ context, factCardId });
    assertActorContext(captured.context);
    return withTenantTransaction(this.#pool, captured.context.clinicId, async (client) =>
      structuredClone(await findFactCard(client, captured.context.clinicId, captured.factCardId)));
  }
}

export function validateCapture(
  context: ActorContext,
  artifact: Artifact,
  factCard: EvidenceFactCard,
): void {
  assertActorContext(context);
  if (artifact.clinicId !== context.clinicId || factCard.clinicId !== context.clinicId) {
    throw new DomainError("TENANT_SCOPE_VIOLATION", "Capture is outside this clinic scope.");
  }
  if (factCard.artifactId !== artifact.id) {
    throw new DomainError("FACT_CARD_ARTIFACT_MISMATCH", "FactCard must reference its supplied Artifact.");
  }
  if (!factCard.lineageArtifactIds.includes(artifact.id)) {
    throw new DomainError("FACT_CARD_LINEAGE_INVALID", "FactCard lineage must contain its supplied Artifact.");
  }
  assertFactCardIdentitySource(factCard, artifact);
}

export async function findArtifact(
  client: TenantQueryClient,
  clinicId: string,
  artifactId: string,
): Promise<Artifact | null> {
  const result = await client.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifact WHERE clinic_id = $1 AND id = $2`,
    [clinicId, artifactId],
  );
  return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
}

export async function findFactCard(
  client: TenantQueryClient,
  clinicId: string,
  factCardId: string,
): Promise<EvidenceFactCard | null> {
  const result = await client.query<FactCardRow>(
    `SELECT ${FACT_CARD_COLUMNS} FROM evidence_fact_card WHERE clinic_id = $1 AND id = $2`,
    [clinicId, factCardId],
  );
  return result.rows[0] ? factCardFromRow(result.rows[0]) : null;
}

export async function insertArtifact(
  client: TenantQueryClient,
  clinicId: string,
  artifact: Artifact,
): Promise<void> {
  await client.query(
    `INSERT INTO artifact (${ARTIFACT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [
      artifact.id,
      clinicId,
      artifact.kind,
      artifact.occurredAt,
      artifact.occurredAtSource,
      artifact.sourceEmployeeId,
      artifact.identityAnchor,
      artifact.payload,
      artifact.createdAt,
    ],
  );
}

export async function insertFactCard(
  client: TenantQueryClient,
  clinicId: string,
  factCard: EvidenceFactCard,
): Promise<void> {
  await client.query(
    `INSERT INTO evidence_fact_card (${FACT_CARD_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (clinic_id, id) DO NOTHING`,
    [
      factCard.id,
      clinicId,
      factCard.artifactId,
      factCard.subjectType,
      factCard.identityAnchor,
      factCard.workflowFamily,
      factCard.occurredAt,
      factCard.fields,
      factCard.missingFields,
      factCard.confidence,
      factCard.parserVersion,
      factCard.lineageArtifactIds,
    ],
  );
}

function artifactFromRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    kind: row.kind,
    occurredAt: timestamp(row.occurred_at),
    occurredAtSource: row.occurred_at_source,
    sourceEmployeeId: row.source_employee_id,
    identityAnchor: row.identity_anchor,
    payload: structuredClone(row.payload),
    createdAt: timestamp(row.created_at) as string,
  };
}

function factCardFromRow(row: FactCardRow): EvidenceFactCard {
  return {
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
  };
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

export function artifactEqual(left: Artifact, right: Artifact): boolean {
  return semanticEqual(
    { ...left, occurredAt: instant(left.occurredAt), createdAt: instant(left.createdAt) },
    { ...right, occurredAt: instant(right.occurredAt), createdAt: instant(right.createdAt) },
  );
}

export function factCardEqual(left: EvidenceFactCard, right: EvidenceFactCard): boolean {
  return semanticEqual(
    { ...left, occurredAt: instant(left.occurredAt) },
    { ...right, occurredAt: instant(right.occurredAt) },
  );
}

function instant(value: string | null): number | string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : parsed;
}

export function semanticEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}
