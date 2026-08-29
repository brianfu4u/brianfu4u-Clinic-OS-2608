import type { Artifact, Expectation } from "./contracts.ts";

export function evaluateExpectation(
  expectation: Expectation,
  linkedArtifacts: readonly Artifact[],
  now: string,
  voided = false,
): Expectation {
  if (voided) {
    return {
      ...expectation,
      state: "VOIDED",
      satisfiedByArtifactId: null,
      evaluatedAt: now,
    };
  }

  const dueAt = Date.parse(expectation.dueAt);
  const matching = linkedArtifacts.find(
    (artifact) =>
      artifact.clinicId === expectation.clinicId &&
      artifact.kind === expectation.consequenceKind &&
      artifact.occurredAt !== null &&
      Date.parse(artifact.occurredAt) <= dueAt,
  );
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
    state: Date.parse(now) < dueAt ? "OPEN" : "UNMET",
    satisfiedByArtifactId: null,
    evaluatedAt: now,
  };
}
