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
  const terminal = input.workflow?.status === "CLOSED" || input.workflow?.status === "VOIDED";
  if (!terminal && input.matchingAmbiguity) reasonCodes.push("MATCHING_AMBIGUITY");
  if (!terminal && input.expectation?.state === "UNMET") reasonCodes.push("EXPECTATION_UNMET");

  return {
    workflowId: input.workflow?.id ?? null,
    workflowStatus: input.workflow?.status ?? null,
    expectationState: input.workflow?.status === "VOIDED"
      ? "VOIDED"
      : input.expectation?.state ?? null,
    evidenceArtifactIds: [...input.evidenceArtifactIds],
    needsReview: reasonCodes.length > 0,
    reasonCodes,
  };
}
