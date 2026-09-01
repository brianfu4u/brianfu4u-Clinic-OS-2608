import assert from "node:assert/strict";
import test from "node:test";

import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { InferenceRequest } from "../src/runtime/contracts.ts";
import {
  OllamaLocalRecommendationProvider,
  validateOllamaLoopbackEndpoint,
} from "../src/runtime/ollama-local-recommendation-provider.ts";

const CONTEXT: ActorContext = { clinicId: "clinic-1", actorId: "manager-1", role: "MANAGER" };
const REQUEST: InferenceRequest = {
  requestId: "request-1", clinicId: "clinic-1", capability: "MANAGER_ATTENTION_GUIDANCE",
  schemaVersion: "clinic-os/manager-attention-recommendation/v1",
  input: { schemaVersion: "clinic-os/manager-attention-recommendation/v1", stage: "STRUCTURED_ALIGNMENT", alignmentStatus: "MISSING", reasonCodes: ["MISSING_EXAM_REPORT"] },
};

test("Ollama provider sends one bounded non-streaming loopback JSON request", async () => {
  let call: { url: string; init: RequestInit } | undefined;
  const provider = new OllamaLocalRecommendationProvider({
    endpoint: "http://127.0.0.1:11434",
    modelId: "clinic-guidance-v1",
    fetcher: async (url, init) => {
      call = { url, init };
      return Response.json({
        model: "clinic-guidance-v1", done: true,
        response: JSON.stringify({
          schemaVersion: "clinic-os/manager-attention-guidance/v1",
          suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
          reasonCodes: ["MISSING_EXAM_REPORT"],
        }),
      });
    },
  });
  const result = await provider.infer(CONTEXT, REQUEST);
  assert.equal(call?.url, "http://127.0.0.1:11434/api/generate");
  assert.equal(call?.init.method, "POST");
  assert.equal(call?.init.redirect, "error");
  assert.equal(JSON.parse(String(call?.init.body)).stream, false);
  assert.equal(JSON.parse(String(call?.init.body)).model, "clinic-guidance-v1");
  assert.deepEqual(result.output, {
    schemaVersion: "clinic-os/manager-attention-guidance/v1",
    suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
    reasonCodes: ["MISSING_EXAM_REPORT"],
  });
});

test("Ollama endpoint is loopback-only and never permits a proxy, path, credentials or cloud fallback", () => {
  assert.equal(validateOllamaLoopbackEndpoint("http://localhost:11434/"), "http://localhost:11434/api/generate");
  for (const endpoint of [
    "https://localhost:11434", "http://127.0.0.2:11434", "http://host.docker.internal:11434",
    "http://127.0.0.1:11434/proxy", "http://user:secret@127.0.0.1:11434", "https://cloud.example",
  ]) {
    assert.throws(() => validateOllamaLoopbackEndpoint(endpoint),
      (error) => error instanceof DomainError && error.code === "LOCAL_RECOMMENDATION_CONFIGURATION_INVALID");
  }
});

test("Ollama provider fails closed on foreign model, redirect, timeout and oversized response", async () => {
  const make = (fetcher: Parameters<typeof OllamaLocalRecommendationProvider>[0]["fetcher"]) =>
    new OllamaLocalRecommendationProvider({ endpoint: "http://localhost:11434", modelId: "approved-model", timeoutMs: 100, fetcher });
  const unavailable = (error: unknown) => error instanceof DomainError && error.code === "LOCAL_RECOMMENDATION_UNAVAILABLE";
  await assert.rejects(make(async () => Response.json({ model: "foreign-model", done: true, response: "{}" })).infer(CONTEXT, REQUEST), unavailable);
  await assert.rejects(make(async () => ({ ok: true, redirected: true, type: "default", headers: new Headers(), body: null } as Response)).infer(CONTEXT, REQUEST), unavailable);
  await assert.rejects(make(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("timeout")));
  })).infer(CONTEXT, REQUEST), unavailable);
  await assert.rejects(make(async () => new Response("x".repeat(64 * 1024 + 1), { headers: { "content-length": String(64 * 1024 + 1) } })).infer(CONTEXT, REQUEST), unavailable);
});

test("Ollama provider rejects an unserializable request before local transport", async () => {
  let calls = 0;
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const provider = new OllamaLocalRecommendationProvider({
    endpoint: "http://localhost:11434", modelId: "approved-model",
    fetcher: async () => { calls += 1; return Response.json({}); },
  });
  await assert.rejects(provider.infer(CONTEXT, { ...REQUEST, input: cyclic }),
    (error) => error instanceof DomainError && error.code === "LOCAL_RECOMMENDATION_REQUEST_INVALID");
  assert.equal(calls, 0);
});
