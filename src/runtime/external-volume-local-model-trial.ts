import { inspectExternalModelVolumeRootSync } from "./external-model-volume.ts";
import {
  runLocalModelPreflight,
  type LocalModelPreflightResult,
} from "./local-model-preflight.ts";
import { validateOllamaLoopbackEndpoint } from "./ollama-local-recommendation-provider.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ExternalVolumeLocalModelTrialResult =
  | LocalModelPreflightResult & Readonly<{ status: "READY" }>
  | Readonly<{ status: "UNAVAILABLE"; code: "LOCAL_MODEL_TRIAL_UNAVAILABLE" }>;

export type ExternalVolumeLocalModelTrialDependencies = Readonly<{
  inspectVolume?: (value: unknown) => boolean;
  preflight?: (values: Record<string, unknown>, fetcher?: FetchLike) => Promise<LocalModelPreflightResult>;
}>;

/**
 * Proves only that an operator-approved model can answer the existing safe
 * guidance probe. The volume is observed before any loopback transport.
 */
export async function runExternalVolumeLocalModelTrial(
  values: Record<string, unknown> = process.env,
  fetcher?: FetchLike,
  dependencies: ExternalVolumeLocalModelTrialDependencies = {},
): Promise<ExternalVolumeLocalModelTrialResult> {
  const endpoint = values.CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT;
  const modelId = values.CLINIC_OS_LOCAL_RECOMMENDATION_MODEL_ID;
  const approvedModelId = values.LOCAL_MODEL_TRIAL_APPROVED_MODEL_ID;
  const inspectVolume = dependencies.inspectVolume ?? inspectExternalModelVolumeRootSync;
  try {
    if (typeof endpoint !== "string" || typeof modelId !== "string" ||
      typeof approvedModelId !== "string" || approvedModelId !== modelId ||
      !inspectVolume(values.CLINIC_OS_EXTERNAL_MODEL_VOLUME_ROOT)) return unavailable();
    validateOllamaLoopbackEndpoint(endpoint);
  } catch {
    return unavailable();
  }
  const result = await (dependencies.preflight ?? runLocalModelPreflight)(values, fetcher);
  return result.status === "READY" ? result : unavailable();
}

function unavailable(): ExternalVolumeLocalModelTrialResult {
  return Object.freeze({ status: "UNAVAILABLE", code: "LOCAL_MODEL_TRIAL_UNAVAILABLE" });
}
