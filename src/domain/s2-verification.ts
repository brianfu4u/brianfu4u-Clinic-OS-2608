import type {
  Artifact,
  Expectation,
  VerificationResult,
  Workflow,
} from "./contracts.ts";
import { DomainError } from "./errors.ts";

const REASON_ORDER = [
  "TRIGGER_NOT_FOUND",
  "CONSEQUENCE_NOT_FOUND",
  "IDENTITY_CONFLICT",
  "TIME_CONFLICT",
  "KIND_CONFLICT",
  "EXPECTATION_EVIDENCE_CONFLICT",
  "CHAIN_OPEN",
  "CHAIN_UNMET",
  "CHAIN_VOIDED",
] as const;

type ReasonCode = typeof REASON_ORDER[number];

function timestamp(value: string): number {
  return Date.parse(value);
}

function artifactOrder(left: Artifact, right: Artifact): number {
  const leftTime = left.occurredAt === null ? Number.POSITIVE_INFINITY : timestamp(left.occurredAt);
  const rightTime = right.occurredAt === null ? Number.POSITIVE_INFINITY : timestamp(right.occurredAt);
  const timeOrder = (Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY) -
    (Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY);
  return timeOrder || left.id.localeCompare(right.id);
}

export function verifyS2(input: {
  workflow: Workflow;
  expectation: Expectation;
  linkedArtifacts: readonly Artifact[];
  now: string;
}): VerificationResult {
  const { workflow, expectation } = input;
  const now = timestamp(input.now);
  const triggeredAt = timestamp(expectation.triggeredAt);
  const dueAt = timestamp(expectation.dueAt);
  if (
    !workflow.id ||
    !workflow.clinicId ||
    !workflow.identityAnchor ||
    !expectation.id ||
    expectation.workflowId !== workflow.id ||
    expectation.clinicId !== workflow.clinicId ||
    !["OPEN", "MET", "UNMET", "VOIDED"].includes(expectation.state) ||
    !Number.isFinite(now) ||
    !Number.isFinite(triggeredAt) ||
    !Number.isFinite(dueAt) ||
    dueAt < triggeredAt
  ) {
    throw new DomainError(
      "INVALID_VERIFICATION_CONTRACT",
      "Verification identity, IDs, state and time bounds must form a valid Workflow expectation contract.",
    );
  }

  const artifacts = [...input.linkedArtifacts].sort(artifactOrder);
  const reasons = new Set<ReasonCode>();
  const triggerKindCandidates = artifacts.filter(({ kind }) => kind === expectation.triggerKind);
  const trigger = triggerKindCandidates.find((artifact) =>
    artifact.clinicId === workflow.clinicId &&
    artifact.identityAnchor === workflow.identityAnchor &&
    artifact.occurredAt !== null &&
    Number.isFinite(timestamp(artifact.occurredAt)) &&
    timestamp(artifact.occurredAt) === triggeredAt
  ) ?? null;

  if (!trigger && expectation.state !== "VOIDED") {
    reasons.add("TRIGGER_NOT_FOUND");
    if (triggerKindCandidates.some((artifact) =>
      artifact.clinicId !== workflow.clinicId ||
      artifact.identityAnchor !== workflow.identityAnchor
    )) reasons.add("IDENTITY_CONFLICT");
    if (triggerKindCandidates.some((artifact) =>
      artifact.occurredAt === null ||
      !Number.isFinite(timestamp(artifact.occurredAt)) ||
      timestamp(artifact.occurredAt) !== triggeredAt
    )) reasons.add("TIME_CONFLICT");
    if (artifacts.some((artifact) =>
      artifact.clinicId === workflow.clinicId &&
      artifact.identityAnchor === workflow.identityAnchor &&
      artifact.occurredAt !== null &&
      timestamp(artifact.occurredAt) === triggeredAt &&
      artifact.kind !== expectation.triggerKind
    )) reasons.add("KIND_CONFLICT");
  }

  let consequence: Artifact | null = null;
  if (expectation.satisfiedByArtifactId !== null) {
    consequence = artifacts.find(({ id }) => id === expectation.satisfiedByArtifactId) ?? null;
    if (expectation.state !== "MET") reasons.add("EXPECTATION_EVIDENCE_CONFLICT");
    if (!consequence) {
      reasons.add("CONSEQUENCE_NOT_FOUND");
    } else {
      if (
        consequence.clinicId !== workflow.clinicId ||
        consequence.identityAnchor !== workflow.identityAnchor
      ) reasons.add("IDENTITY_CONFLICT");
      if (consequence.kind !== expectation.consequenceKind) reasons.add("KIND_CONFLICT");
      const consequenceTime = consequence.occurredAt === null
        ? Number.NaN
        : timestamp(consequence.occurredAt);
      if (
        !Number.isFinite(consequenceTime) ||
        consequenceTime < triggeredAt ||
        consequenceTime > dueAt
      ) reasons.add("TIME_CONFLICT");
    }
  } else if (expectation.state === "MET") {
    reasons.add("EXPECTATION_EVIDENCE_CONFLICT");
    reasons.add("CONSEQUENCE_NOT_FOUND");
  }

  let status: VerificationResult["status"];
  if (expectation.state === "VOIDED" && expectation.satisfiedByArtifactId === null) {
    status = "PENDING";
    reasons.clear();
    reasons.add("CHAIN_VOIDED");
  } else if (expectation.state === "MET" && trigger && consequence && reasons.size === 0) {
    status = "VERIFIED";
  } else if (
    (expectation.state === "OPEN" || expectation.state === "UNMET") &&
    trigger &&
    expectation.satisfiedByArtifactId === null &&
    reasons.size === 0
  ) {
    status = "PENDING";
    reasons.add(expectation.state === "OPEN" ? "CHAIN_OPEN" : "CHAIN_UNMET");
  } else {
    status = "CONFLICT";
  }

  const selectedEvidence = [trigger, consequence]
    .filter((artifact): artifact is Artifact => artifact !== null)
    .map(({ id }) => id);
  return {
    workflowId: workflow.id,
    expectationId: expectation.id,
    status,
    reasonCodes: REASON_ORDER.filter((reason) => reasons.has(reason)),
    triggerArtifactId: trigger?.id ?? null,
    consequenceArtifactId: consequence?.id ?? null,
    evidenceArtifactIds: selectedEvidence,
    evaluatedAt: input.now,
  };
}
