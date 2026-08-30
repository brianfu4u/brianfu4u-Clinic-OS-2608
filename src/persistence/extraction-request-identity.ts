import type { StoredEvidenceExtractionResult } from "../application/evidence-extraction.ts";

/** Durable request identity that binds extraction to its downstream operation. */
export interface ExtractionRequestIdentity {
  consequenceExpectationId: string;
  requestedFactCardId: string;
}

export interface PersistedExtractionRecord {
  extraction: StoredEvidenceExtractionResult;
  identity: ExtractionRequestIdentity;
}
