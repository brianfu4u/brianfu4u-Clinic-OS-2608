import type {
  Expectation,
  ManagerClosureView,
  Workflow,
} from "./contracts.ts";

export function projectManagerClosure(input: {
  workflow: Workflow | null;
  expectation: Expectation | null;
  evidenceArtifactIds: readonly string[];
  matchingAmbiguity?: boolean;
}): ManagerClosureView {
  const reasonCodes: string[] = [];
  if (input.matchingAmbiguity) reasonCodes.push("MATCHING_AMBIGUITY");
  if (input.expectation?.state === "UNMET") reasonCodes.push("EXPECTATION_UNMET");

  return {
    workflowId: input.workflow?.id ?? null,
    workflowStatus: input.workflow?.status ?? null,
    expectationState: input.expectation?.state ?? null,
    evidenceArtifactIds: [...input.evidenceArtifactIds],
    needsReview: reasonCodes.length > 0,
    reasonCodes,
  };
}
