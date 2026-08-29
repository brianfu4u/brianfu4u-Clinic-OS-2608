import type {
  Artifact,
  EvidenceFactCard,
  Expectation,
  GoldenPathInput,
  GoldenPathResult,
} from "./contracts.ts";
import { DomainError } from "./errors.ts";
import { evaluateExpectation } from "./expectation.ts";
import { requireClinicalIdentity } from "./identity-gate.ts";
import { projectManagerClosure } from "./manager-projection.ts";
import { resolveWorkflow } from "./workflow-resolver.ts";
import { WorkflowSaga, type WorkflowSagaOptions } from "./workflow-saga.ts";

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export class InMemoryArtifactRepository {
  readonly #artifacts = new Map<string, Artifact>();

  constructor(initialArtifacts: readonly Artifact[] = []) {
    for (const artifact of initialArtifacts) this.save(artifact);
  }

  save(artifact: Artifact): Artifact {
    if (!artifact.id || !artifact.clinicId) {
      throw new DomainError("INVALID_ARTIFACT", "Artifact ID and clinic ID are required.");
    }
    if (artifact.occurredAt === null && artifact.occurredAtSource !== "unknown") {
      throw new DomainError(
        "INVALID_ARTIFACT_TIME",
        "A missing occurredAt must retain the unknown source state.",
      );
    }
    const existing = this.#artifacts.get(artifact.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(artifact)) {
        throw new DomainError("ARTIFACT_IMMUTABLE", "An Artifact cannot be overwritten.");
      }
      return existing;
    }
    const stored = freezeDeep(structuredClone(artifact));
    this.#artifacts.set(stored.id, stored);
    return stored;
  }

  get(clinicId: string, artifactId: string): Artifact | null {
    const artifact = this.#artifacts.get(artifactId);
    return artifact?.clinicId === clinicId ? artifact : null;
  }
}

export interface GoldenPathRepositories {
  artifacts: InMemoryArtifactRepository;
  workflows: WorkflowSaga;
}

export function createInMemoryRepositories(input: {
  artifacts?: readonly Artifact[];
  workflowSaga?: WorkflowSagaOptions;
} = {}): GoldenPathRepositories {
  return {
    artifacts: new InMemoryArtifactRepository(input.artifacts),
    workflows: new WorkflowSaga(input.workflowSaga),
  };
}

function validateFactCard(
  raw: EvidenceFactCard & Record<string, unknown>,
  artifact: Artifact,
): EvidenceFactCard {
  if (raw.clinicId !== artifact.clinicId || raw.artifactId !== artifact.id) {
    throw new DomainError(
      "INVALID_FACT_CARD_LINEAGE",
      "FactCard clinic and Artifact lineage must match the source Artifact.",
    );
  }
  if (
    !raw.id ||
    !raw.subjectType ||
    !raw.workflowFamily ||
    !raw.parserVersion ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1 ||
    !Array.isArray(raw.missingFields) ||
    !Array.isArray(raw.lineageArtifactIds) ||
    !raw.lineageArtifactIds.includes(artifact.id)
  ) {
    throw new DomainError("INVALID_FACT_CARD", "Parser output failed the FactCard contract.");
  }

  return freezeDeep({
    id: raw.id,
    clinicId: raw.clinicId,
    artifactId: raw.artifactId,
    subjectType: raw.subjectType,
    identityAnchor: raw.identityAnchor,
    workflowFamily: raw.workflowFamily,
    occurredAt: raw.occurredAt,
    fields: structuredClone(raw.fields),
    missingFields: [...raw.missingFields],
    confidence: raw.confidence,
    parserVersion: raw.parserVersion,
    lineageArtifactIds: [...raw.lineageArtifactIds],
  });
}

export function runGoldenPath(
  input: GoldenPathInput,
  repositories: GoldenPathRepositories,
): GoldenPathResult {
  const artifact = repositories.artifacts.save(input.artifact);
  const factCard = validateFactCard(input.parser(artifact), artifact);
  requireClinicalIdentity(factCard);

  const resolution = resolveWorkflow(
    factCard,
    repositories.workflows.listOpenWorkflows(factCard.clinicId),
  );
  if (resolution.kind === "REVIEW_REQUIRED") {
    return {
      artifact,
      factCard,
      resolution,
      workflow: null,
      link: null,
      expectation: null,
      managerView: projectManagerClosure({
        workflow: null,
        expectation: null,
        evidenceArtifactIds: [artifact.id],
        matchingAmbiguity: true,
      }),
    };
  }

  const sagaResult = resolution.kind === "ATTACH_EXISTING"
    ? repositories.workflows.attachExisting(
        resolution.workflowId,
        artifact,
        factCard,
        input.now,
      )
    : repositories.workflows.createAndAttach(artifact, factCard, input.now);

  const linkedArtifacts = repositories.workflows
    .listLinks(artifact.clinicId, sagaResult.workflow.id)
    .map((link) => repositories.artifacts.get(artifact.clinicId, link.artifactId))
    .filter((candidate): candidate is Artifact => candidate !== null);
  const expectation = evaluateExpectation(
    {
      id: input.expectation.id,
      clinicId: artifact.clinicId,
      workflowId: sagaResult.workflow.id,
      triggerKind: input.expectation.triggerKind,
      consequenceKind: input.expectation.consequenceKind,
      triggeredAt: input.expectation.triggeredAt,
      dueAt: input.expectation.dueAt,
      state: "OPEN",
      satisfiedByArtifactId: null,
      evaluatedAt: input.now,
    } satisfies Expectation,
    linkedArtifacts,
    input.now,
    input.expectation.voided,
  );

  return {
    artifact,
    factCard,
    resolution,
    workflow: sagaResult.workflow,
    link: sagaResult.link,
    expectation,
    managerView: projectManagerClosure({
      workflow: sagaResult.workflow,
      expectation,
      evidenceArtifactIds: linkedArtifacts.map(({ id }) => id),
    }),
  };
}

function syntheticArtifact(id: string, kind: string, occurredAt: string): Artifact {
  return {
    id,
    clinicId: "demo-clinic",
    kind,
    occurredAt,
    occurredAtSource: "employee_confirmed",
    sourceEmployeeId: "demo-employee",
    identityAnchor: "P-DEMO-001",
    payload: { synthetic: true },
    createdAt: occurredAt,
  };
}

function syntheticParser(artifact: Artifact): EvidenceFactCard & Record<string, unknown> {
  return {
    id: `fact:${artifact.id}`,
    clinicId: artifact.clinicId,
    artifactId: artifact.id,
    subjectType: "PATIENT",
    identityAnchor: artifact.identityAnchor,
    workflowFamily: "EYE_EXAM",
    occurredAt: artifact.occurredAt,
    fields: { synthetic: true },
    missingFields: [],
    confidence: 1,
    parserVersion: "demo-1",
    lineageArtifactIds: [artifact.id],
  };
}

if (import.meta.main) {
  const met = runGoldenPath(
    {
      artifact: syntheticArtifact("a-met", "EXAM_REPORT", "2026-08-29T09:10:00.000Z"),
      parser: syntheticParser,
      expectation: {
        id: "e-met",
        triggerKind: "REGISTRATION",
        consequenceKind: "EXAM_REPORT",
        triggeredAt: "2026-08-29T09:00:00.000Z",
        dueAt: "2026-08-29T09:15:00.000Z",
      },
      now: "2026-08-29T09:10:00.000Z",
    },
    createInMemoryRepositories(),
  );
  const unmet = runGoldenPath(
    {
      artifact: syntheticArtifact("a-unmet", "REGISTRATION", "2026-08-29T10:00:00.000Z"),
      parser: syntheticParser,
      expectation: {
        id: "e-unmet",
        triggerKind: "REGISTRATION",
        consequenceKind: "EXAM_REPORT",
        triggeredAt: "2026-08-29T10:00:00.000Z",
        dueAt: "2026-08-29T10:15:00.000Z",
      },
      now: "2026-08-29T10:15:00.000Z",
    },
    createInMemoryRepositories(),
  );

  console.log(JSON.stringify({
    createNew: {
      resolution: met.resolution.kind,
      workflowId: met.workflow?.id,
      expectation: met.expectation?.state,
      needsReview: met.managerView.needsReview,
    },
    unmetReview: {
      resolution: unmet.resolution.kind,
      workflowId: unmet.workflow?.id,
      expectation: unmet.expectation?.state,
      needsReview: unmet.managerView.needsReview,
      reasonCodes: unmet.managerView.reasonCodes,
    },
  }));
}
