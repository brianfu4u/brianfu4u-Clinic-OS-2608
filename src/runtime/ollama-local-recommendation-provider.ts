import { types } from "node:util";

import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { InferenceProvider, InferenceRequest, InferenceResponse } from "./contracts.ts";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OllamaLocalRecommendationProviderConfig {
  readonly endpoint: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
  /** Test-only transport seam; production uses the platform fetch. */
  readonly fetcher?: FetchLike;
}

/**
 * Narrow, local-only Ollama adapter. It does not share the OCR process or
 * provider; callers still choose whether its read-only guidance is displayed.
 */
export class OllamaLocalRecommendationProvider implements InferenceProvider {
  readonly kind = "LOCAL_MODEL" as const;
  readonly modelId: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetcher: FetchLike;

  constructor(config: OllamaLocalRecommendationProviderConfig) {
    if (!config || typeof config !== "object" || types.isProxy(config)) {
      throw new DomainError("LOCAL_RECOMMENDATION_CONFIGURATION_INVALID", "Local recommendation configuration is invalid.");
    }
    this.#endpoint = validateOllamaLoopbackEndpoint(config.endpoint);
    this.modelId = validateModelId(config.modelId);
    this.#timeoutMs = validateTimeout(config.timeoutMs);
    if (config.fetcher !== undefined && typeof config.fetcher !== "function") {
      throw new DomainError("LOCAL_RECOMMENDATION_CONFIGURATION_INVALID", "Local recommendation transport is invalid.");
    }
    this.#fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async infer(_context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    let body: string;
    try {
      body = JSON.stringify({
        model: this.modelId,
        stream: false,
        format: "json",
        prompt: JSON.stringify({
          schemaVersion: request.schemaVersion,
          capability: request.capability,
          input: request.input,
        }),
      });
    } catch {
      throw new DomainError("LOCAL_RECOMMENDATION_REQUEST_INVALID", "Local recommendation request is invalid.");
    }
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new DomainError("LOCAL_RECOMMENDATION_REQUEST_TOO_LARGE", "Local recommendation request is too large.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetcher(this.#endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
      });
    } catch {
      throw new DomainError("LOCAL_RECOMMENDATION_UNAVAILABLE", "Local recommendation provider is unavailable.");
    } finally {
      clearTimeout(timer);
    }
    if (!response || response.type === "opaqueredirect" || !response.ok || response.redirected) {
      throw new DomainError("LOCAL_RECOMMENDATION_UNAVAILABLE", "Local recommendation provider is unavailable.");
    }
    const payload = parseOllamaResponse(await readBoundedBody(response), this.modelId);
    return {
      requestId: request.requestId,
      providerKind: this.kind,
      modelId: this.modelId,
      schemaVersion: request.schemaVersion,
      output: payload,
      completedAt: new Date().toISOString(),
    };
  }
}

export function validateOllamaLoopbackEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) invalidConfig();
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash ||
      !["", "/"].includes(url.pathname)
    ) invalidConfig();
    return new URL("/api/generate", url).toString();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalidConfig();
  }
}

function validateModelId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalidConfig();
  return value;
}

function validateTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) invalidConfig();
  return value;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) unavailable();
  const reader = response.body?.getReader();
  if (!reader) unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        unavailable();
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    unavailable();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseOllamaResponse(text: string, expectedModelId: string): unknown {
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { unavailable(); }
  const record = plainRecord(envelope);
  if (record.model !== expectedModelId || typeof record.response !== "string" || record.done !== true) unavailable();
  let output: unknown;
  try { output = JSON.parse(record.response); } catch { unavailable(); }
  if (!isPlainData(output, 0, { nodes: 0, bytes: 0 })) unavailable();
  return output;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !Object.hasOwn(descriptors[key], "value"))) unavailable();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function isPlainData(value: unknown, depth: number, budget: { nodes: number; bytes: number }): boolean {
  budget.nodes += 1;
  if (budget.nodes > 512 || depth > 8) return false;
  if (typeof value === "string") return (budget.bytes += Buffer.byteLength(value)) <= 16 * 1024;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || types.isProxy(value)) return false;
  if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.entries(descriptors).every(([key, descriptor]) =>
    Object.hasOwn(descriptor, "value") && (budget.bytes += Buffer.byteLength(key)) <= 16 * 1024 &&
    isPlainData(descriptor.value, depth + 1, budget),
  );
}

function invalidConfig(): never {
  throw new DomainError("LOCAL_RECOMMENDATION_CONFIGURATION_INVALID", "Local recommendation configuration is invalid.");
}

function unavailable(): never {
  throw new DomainError("LOCAL_RECOMMENDATION_UNAVAILABLE", "Local recommendation provider is unavailable.");
}
