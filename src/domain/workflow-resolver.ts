import type {
  EvidenceFactCard,
  Workflow,
  WorkflowResolution,
} from "./contracts.ts";

export function resolveWorkflow(
  factCard: EvidenceFactCard,
  candidates: readonly Workflow[],
): WorkflowResolution {
  const exactMatches = candidates.filter(
    (workflow) =>
      workflow.clinicId === factCard.clinicId &&
      workflow.status === "OPEN" &&
      workflow.workflowFamily === factCard.workflowFamily &&
      workflow.subjectType === factCard.subjectType &&
      workflow.identityAnchor === factCard.identityAnchor,
  );

  if (exactMatches.length === 0) return { kind: "CREATE_NEW" };
  if (exactMatches.length === 1) {
    return { kind: "ATTACH_EXISTING", workflowId: exactMatches[0].id };
  }
  return {
    kind: "REVIEW_REQUIRED",
    candidateWorkflowIds: exactMatches.map(({ id }) => id),
  };
}
