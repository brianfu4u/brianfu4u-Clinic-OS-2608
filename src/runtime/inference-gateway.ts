import { types } from "node:util";

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
    assertInertResponseData(response);
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

  get providerKind(): InferenceProvider["kind"] {
    return this.#expectedProviderKind;
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

const RESPONSE_LIMITS = {
  arrayLength: 256,
  depth: 16,
  nodes: 4096,
  stringBytes: 256 * 1024,
};

function assertInertResponseData(value: unknown): void {
  const budget = { nodes: 0, stringBytes: 0 };
  try {
    visit(value, 0, budget);
  } catch {
    throw new DomainError(
      "INVALID_INFERENCE_RESPONSE",
      "Inference response must be bounded inert data.",
    );
  }
}

function visit(
  value: unknown,
  depth: number,
  budget: { nodes: number; stringBytes: number },
): void {
  budget.nodes += 1;
  if (budget.nodes > RESPONSE_LIMITS.nodes || depth > RESPONSE_LIMITS.depth) throw new Error();
  if (typeof value === "string") {
    budget.stringBytes += Buffer.byteLength(value);
    if (budget.stringBytes > RESPONSE_LIMITS.stringBytes) throw new Error();
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error();
    return;
  }
  if (typeof value !== "object" || types.isProxy(value)) throw new Error();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error();
  if (array && value.length > RESPONSE_LIMITS.arrayLength) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol") || keys.length > RESPONSE_LIMITS.nodes) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array) {
    if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) throw new Error();
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) throw new Error();
    }
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" && array) continue;
    if (!Object.hasOwn(descriptor, "value")) throw new Error();
    budget.stringBytes += Buffer.byteLength(key);
    if (budget.stringBytes > RESPONSE_LIMITS.stringBytes) throw new Error();
    visit(descriptor.value, depth + 1, budget);
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
