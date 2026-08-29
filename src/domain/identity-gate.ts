import type { EvidenceFactCard, Workflow } from "./contracts.ts";
import { DomainError } from "./errors.ts";

const PATIENT_SUBJECT = "PATIENT";

export function requireClinicalIdentity(factCard: EvidenceFactCard): void {
  if (
    factCard.subjectType === PATIENT_SUBJECT &&
    (factCard.identityAnchor === null || factCard.identityAnchor.trim() === "")
  ) {
    throw new DomainError(
      "IDENTITY_ANCHOR_REQUIRED",
      "A patient FactCard requires an exact, non-empty identity anchor.",
    );
  }
}

export function assertAttachIdentity(
  factCard: EvidenceFactCard,
  workflow: Workflow,
): void {
  requireClinicalIdentity(factCard);
  if (
    factCard.clinicId !== workflow.clinicId ||
    factCard.subjectType !== workflow.subjectType ||
    factCard.identityAnchor !== workflow.identityAnchor
  ) {
    throw new DomainError(
      "IDENTITY_MISMATCH",
      "FactCard and Workflow identity must match exactly within one clinic.",
    );
  }
}
