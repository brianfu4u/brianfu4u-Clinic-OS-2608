import type { Artifact, Expectation } from "./contracts.ts";
import { DomainError } from "./errors.ts";

function requireTimestamp(value: string, code: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DomainError(code, `${label} must be a valid ISO-8601 timestamp.`);
  }
  return parsed;
}

export function evaluateExpectation(
  expectation: Expectation,
  linkedArtifacts: readonly Artifact[],
  now: string,
  voided = false,
): Expectation {
  const triggeredAt = requireTimestamp(
    expectation.triggeredAt,
    "INVALID_EXPECTATION_TIME",
    "Expectation triggeredAt",
  );
  const dueAt = requireTimestamp(
    expectation.dueAt,
    "INVALID_EXPECTATION_TIME",
    "Expectation dueAt",
  );
  const evaluatedAt = requireTimestamp(now, "INVALID_EXPECTATION_TIME", "Evaluation now");
  if (dueAt < triggeredAt) {
    throw new DomainError(
      "INVALID_EXPECTATION_TIME",
      "Expectation dueAt cannot precede triggeredAt.",
    );
  }

  if (voided) {
    return {
      ...expectation,
      state: "VOIDED",
      satisfiedByArtifactId: null,
      evaluatedAt: now,
    };
  }

  const matching = linkedArtifacts.find((artifact) => {
    if (
      artifact.clinicId !== expectation.clinicId ||
      artifact.kind !== expectation.consequenceKind ||
      artifact.occurredAt === null
    ) {
      return false;
    }
    const occurredAt = requireTimestamp(
      artifact.occurredAt,
      "INVALID_ARTIFACT_TIME",
      "Consequence Artifact occurredAt",
    );
    return occurredAt >= triggeredAt && occurredAt <= dueAt && occurredAt <= evaluatedAt;
  });
  if (matching) {
    return {
      ...expectation,
      state: "MET",
      satisfiedByArtifactId: matching.id,
      evaluatedAt: now,
    };
  }

  return {
    ...expectation,
    state: evaluatedAt < dueAt ? "OPEN" : "UNMET",
    satisfiedByArtifactId: null,
    evaluatedAt: now,
  };
}
