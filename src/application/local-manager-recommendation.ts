import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { assertActorAccess } from "../domain/access-context.ts";
import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { ManagerAttentionGapItem } from "../persistence/manager-closure-read-repository.ts";
import { InferenceGateway } from "../runtime/inference-gateway.ts";

const REQUEST_SCHEMA = "clinic-os/manager-attention-recommendation/v1";
const RESPONSE_SCHEMA = "clinic-os/manager-attention-guidance/v1";
const CAPABILITY = "MANAGER_ATTENTION_GUIDANCE";
const REASONS = new Set([
  "INVALID_DOCUMENT", "KIND_CONFLICT", "MISSING_REGISTRATION", "MISSING_PRESCRIPTION",
  "MISSING_EXAM_REPORT", "MISSING_PAYMENT", "DUPLICATE_DOCUMENT", "IDENTITY_CONFLICT",
  "WORKFLOW_FAMILY_CONFLICT", "TIME_ORDER_CONFLICT", "EXPECTATION_MISSING",
  "VERIFICATION_MISSING", "TERMINAL_DECISION_MISSING", "EXPECTATION_UNMET",
  "VERIFICATION_CONFLICT", "TRIGGER_NOT_FOUND", "CONSEQUENCE_NOT_FOUND",
  "EXPECTATION_EVIDENCE_CONFLICT", "CHAIN_OPEN", "CHAIN_UNMET", "CHAIN_VOIDED",
]);
const SUGGESTIONS = new Set(["DOCUMENT_COMPLETENESS_REVIEW", "DOCUMENT_CONSISTENCY_REVIEW"]);

export interface ManagerAttentionRecommendation {
  status: "AVAILABLE";
  schemaVersion: typeof RESPONSE_SCHEMA;
  suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW" | "DOCUMENT_CONSISTENCY_REVIEW";
  reasonCodes: string[];
}

export interface ManagerAttentionRecommendationUnavailable {
  status: "UNAVAILABLE";
  code: "LOCAL_RECOMMENDATION_UNAVAILABLE";
}

export type ManagerAttentionRecommendationResult =
  | ManagerAttentionRecommendation
  | ManagerAttentionRecommendationUnavailable;

/**
 * A read-only adapter. It deliberately strips the workflow ID and every
 * patient/evidence field before an inference request is assembled.
 */
export class LocalManagerRecommendationService {
  readonly #inference: InferenceGateway;

  constructor(inference: InferenceGateway) {
    if (!(inference instanceof InferenceGateway)) {
      throw new DomainError("INVALID_LOCAL_RECOMMENDATION_DEPENDENCY", "A trusted inference gateway is required.");
    }
    this.#inference = inference;
  }

  async recommend(
    context: ActorContext,
    attention: ManagerAttentionGapItem,
  ): Promise<ManagerAttentionRecommendationResult> {
    const captured = structuredClone(context);
    assertActorAccess(captured, captured.clinicId, "MANAGER");
    const input = projectSafeInput(attention);
    if (this.#inference.providerKind !== "LOCAL_MODEL") {
      return unavailable();
    }
    try {
      const response = await this.#inference.infer(captured, {
        requestId: randomUUID(),
        clinicId: captured.clinicId,
        capability: CAPABILITY,
        schemaVersion: REQUEST_SCHEMA,
        input,
      });
      return validateGuidance(response.output, input.reasonCodes);
    } catch {
      return unavailable();
    }
  }
}

function projectSafeInput(attention: ManagerAttentionGapItem): {
  schemaVersion: typeof REQUEST_SCHEMA;
  stage: "STRUCTURED_ALIGNMENT";
  alignmentStatus: "MISSING" | "CONFLICT";
  reasonCodes: string[];
} {
  const item = plainRecord(attention, [
    "workflowId", "workflowFamily", "workflowStatus", "stage", "alignmentStatus", "reasonCodes",
  ], "INVALID_MANAGER_ATTENTION_ITEM");
  if (
    typeof item.workflowId !== "string" || item.workflowId.trim() === "" ||
    typeof item.workflowFamily !== "string" || item.workflowFamily.trim() === "" ||
    !["OPEN", "CLOSED", "VOIDED"].includes(item.workflowStatus as string) ||
    item.stage !== "STRUCTURED_ALIGNMENT" || !["MISSING", "CONFLICT"].includes(item.alignmentStatus as string) ||
    !Array.isArray(item.reasonCodes) || item.reasonCodes.length > REASONS.size ||
    item.reasonCodes.some((code) => typeof code !== "string" || !REASONS.has(code))
  ) {
    throw new DomainError("INVALID_MANAGER_ATTENTION_ITEM", "Manager attention input is invalid.");
  }
  return {
    schemaVersion: REQUEST_SCHEMA,
    stage: "STRUCTURED_ALIGNMENT",
    alignmentStatus: item.alignmentStatus as "MISSING" | "CONFLICT",
    reasonCodes: [...item.reasonCodes] as string[],
  };
}

function validateGuidance(output: unknown, inputReasons: string[]): ManagerAttentionRecommendation {
  const value = plainRecord(output, ["schemaVersion", "suggestionCode", "reasonCodes"], "INVALID_LOCAL_RECOMMENDATION_OUTPUT");
  if (
    value.schemaVersion !== RESPONSE_SCHEMA ||
    typeof value.suggestionCode !== "string" || !SUGGESTIONS.has(value.suggestionCode) ||
    !Array.isArray(value.reasonCodes) || value.reasonCodes.length > inputReasons.length ||
    value.reasonCodes.some((code) => typeof code !== "string" || !inputReasons.includes(code))
  ) {
    throw new DomainError("INVALID_LOCAL_RECOMMENDATION_OUTPUT", "Local recommendation output is invalid.");
  }
  return {
    status: "AVAILABLE",
    schemaVersion: RESPONSE_SCHEMA,
    suggestionCode: value.suggestionCode as ManagerAttentionRecommendation["suggestionCode"],
    reasonCodes: [...value.reasonCodes] as string[],
  };
}

function plainRecord(value: unknown, keys: string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new DomainError(code, "Recommendation data must be a plain record.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], "value"))) {
    throw new DomainError(code, "Recommendation data has an invalid schema.");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function unavailable(): ManagerAttentionRecommendationUnavailable {
  return { status: "UNAVAILABLE", code: "LOCAL_RECOMMENDATION_UNAVAILABLE" };
}
