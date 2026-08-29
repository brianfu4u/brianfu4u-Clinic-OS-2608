import { assertActorContext } from "../domain/access-context.ts";
import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type {
  InferenceCallReceipt,
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
  RuntimeManifest,
} from "./contracts.ts";
import { validateRuntimeManifest } from "./manifest-validator.ts";

export class DisabledInferenceProvider implements InferenceProvider {
  readonly kind = "DISABLED" as const;
  readonly modelId = "disabled";

  async infer(): Promise<never> {
    throw new DomainError("INFERENCE_UNAVAILABLE", "Inference is explicitly disabled.");
  }
}

export class InferenceGateway {
  readonly #manifest: Readonly<RuntimeManifest>;
  readonly #provider: InferenceProvider;
  readonly #expectedProviderKind: InferenceProvider["kind"];
  readonly #expectedModelId: string;
  readonly #receipts: InferenceCallReceipt[] = [];

  constructor(manifest: RuntimeManifest, provider: InferenceProvider) {
    this.#manifest = validateRuntimeManifest(manifest);
    if (
      !provider ||
      typeof provider.kind !== "string" ||
      typeof provider.modelId !== "string" ||
      typeof provider.infer !== "function"
    ) {
      throw new DomainError("INVALID_INFERENCE_PROVIDER", "Inference provider contract is invalid.");
    }
    if (
      this.#manifest.profile === "ON_PREM_STRICT" &&
      provider.kind === "PRIVATE_CLOUD_MODEL"
    ) {
      throw new DomainError(
        "STRICT_REMOTE_PROVIDER_FORBIDDEN",
        "On-Prem Strict cannot construct a private-cloud inference path.",
      );
    }
    if (
      this.#manifest.profile === "ON_PREM_HYBRID" &&
      provider.kind === "PRIVATE_CLOUD_MODEL" &&
      !this.#manifest.externalInferenceAuthorized
    ) {
      throw new DomainError(
        "HYBRID_EXTERNAL_INFERENCE_NOT_AUTHORIZED",
        "Hybrid private-cloud inference is not authorized.",
      );
    }
    if (provider.kind !== this.#manifest.inferenceProvider) {
      throw new DomainError(
        "INFERENCE_PROVIDER_KIND_MISMATCH",
        "Provider kind must exactly match the RuntimeManifest.",
      );
    }
    if (!provider.modelId || provider.modelId.trim() === "") {
      throw new DomainError("INVALID_INFERENCE_PROVIDER", "Provider model ID is required.");
    }
    this.#provider = provider;
    this.#expectedProviderKind = provider.kind;
    this.#expectedModelId = provider.modelId;
  }

  async infer(context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    assertActorContext(context);
    validateRequest(request);
    if (context.clinicId !== request.clinicId) {
      throw new DomainError(
        "TENANT_SCOPE_VIOLATION",
        "Inference request is outside the ActorContext clinic.",
      );
    }
    this.#assertProviderIdentity();
    const response = await this.#provider.infer(
      structuredClone(context),
      structuredClone(request),
    );
    this.#assertProviderIdentity();
    validateResponse(
      response,
      request,
      this.#expectedProviderKind,
      this.#expectedModelId,
    );
    let clonedResponse: InferenceResponse;
    try {
      clonedResponse = structuredClone(response);
    } catch {
      throw new DomainError(
        "INVALID_INFERENCE_RESPONSE",
        "Inference response must be safely cloneable before receipt commit.",
      );
    }
    this.#receipts.push(Object.freeze({
      requestId: request.requestId,
      clinicId: request.clinicId,
      providerKind: response.providerKind,
      capability: request.capability,
      completedAt: response.completedAt,
    }));
    return clonedResponse;
  }

  listReceipts(context: ActorContext): InferenceCallReceipt[] {
    assertActorContext(context);
    return structuredClone(this.#receipts.filter(({ clinicId }) => clinicId === context.clinicId));
  }

  #assertProviderIdentity(): void {
    if (
      this.#provider.kind !== this.#expectedProviderKind ||
      this.#provider.modelId !== this.#expectedModelId
    ) {
      throw new DomainError(
        "INFERENCE_PROVIDER_IDENTITY_CHANGED",
        "Inference provider identity changed after gateway construction.",
      );
    }
  }
}

function validateRequest(request: InferenceRequest): void {
  if (
    !request ||
    typeof request.requestId !== "string" ||
    request.requestId.trim() === "" ||
    typeof request.clinicId !== "string" ||
    request.clinicId.trim() === "" ||
    typeof request.capability !== "string" ||
    request.capability.trim() === "" ||
    typeof request.schemaVersion !== "string" ||
    request.schemaVersion.trim() === "" ||
    !Object.hasOwn(request, "input")
  ) {
    throw new DomainError("INVALID_INFERENCE_REQUEST", "Inference request contract is invalid.");
  }
}

function validateResponse(
  response: InferenceResponse,
  request: InferenceRequest,
  expectedProviderKind: InferenceProvider["kind"],
  expectedModelId: string,
): void {
  if (
    !response ||
    response.requestId !== request.requestId ||
    response.schemaVersion !== request.schemaVersion ||
    response.providerKind !== expectedProviderKind ||
    response.modelId !== expectedModelId ||
    !Number.isFinite(Date.parse(response.completedAt)) ||
    !Object.hasOwn(response, "output")
  ) {
    throw new DomainError(
      "INVALID_INFERENCE_RESPONSE",
      "Inference response does not match the request and provider contract.",
    );
  }
}
