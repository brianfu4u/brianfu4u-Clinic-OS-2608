import { LocalManagerRecommendationService } from "../application/local-manager-recommendation.ts";
import type { ActorContext } from "../domain/contracts.ts";
import type { ManagerAttentionGapItem } from "../persistence/manager-closure-read-repository.ts";
import type { RuntimeManifest } from "./contracts.ts";
import { InferenceGateway } from "./inference-gateway.ts";
import { OllamaLocalRecommendationProvider } from "./ollama-local-recommendation-provider.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MANIFEST: RuntimeManifest = Object.freeze({
  profile: "ON_PREM_STRICT",
  databaseProvider: "LOCAL_POSTGRES",
  fileProvider: "LOCAL_OBJECT_STORE",
  inferenceProvider: "LOCAL_MODEL",
  backupProvider: "LOCAL_ENCRYPTED_BACKUP",
  externalInferenceAuthorized: false,
  manifestVersion: "local-model-preflight-v1",
});
const MANAGER: ActorContext = Object.freeze({ clinicId: "preflight-clinic", actorId: "preflight-manager", role: "MANAGER" });
const ATTENTION: ManagerAttentionGapItem = Object.freeze({
  workflowId: "preflight-workflow",
  workflowFamily: "PREFLIGHT",
  workflowStatus: "OPEN",
  stage: "STRUCTURED_ALIGNMENT",
  alignmentStatus: "MISSING",
  reasonCodes: ["MISSING_EXAM_REPORT"],
});

export type LocalModelPreflightResult =
  | Readonly<{
      status: "READY";
      schemaVersion: "clinic-os/manager-attention-guidance/v1";
      suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW" | "DOCUMENT_CONSISTENCY_REVIEW";
      reasonCodes: readonly string[];
    }>
  | Readonly<{ status: "UNAVAILABLE"; code: "LOCAL_MODEL_PREFLIGHT_UNAVAILABLE" }>;

/**
 * A deliberately isolated, no-storage check for the optional manager-guidance
 * model. It reads only the two WO-041 recommendation settings.
 */
export async function runLocalModelPreflight(
  values: Record<string, unknown> = process.env,
  fetcher?: FetchLike,
): Promise<LocalModelPreflightResult> {
  try {
    const endpoint = values.CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT;
    const modelId = values.CLINIC_OS_LOCAL_RECOMMENDATION_MODEL_ID;
    if (typeof endpoint !== "string" || typeof modelId !== "string") return unavailable();
    const provider = new OllamaLocalRecommendationProvider({ endpoint, modelId, fetcher });
    const result = await new LocalManagerRecommendationService(
      new InferenceGateway(MANIFEST, provider),
    ).recommend(MANAGER, ATTENTION);
    if (result.status !== "AVAILABLE") return unavailable();
    return Object.freeze({
      status: "READY",
      schemaVersion: result.schemaVersion,
      suggestionCode: result.suggestionCode,
      reasonCodes: Object.freeze([...result.reasonCodes]),
    });
  } catch {
    return unavailable();
  }
}

function unavailable(): LocalModelPreflightResult {
  return Object.freeze({ status: "UNAVAILABLE", code: "LOCAL_MODEL_PREFLIGHT_UNAVAILABLE" });
}
