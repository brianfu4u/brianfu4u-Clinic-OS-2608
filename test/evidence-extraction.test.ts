import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EYE_EXAM_EXTRACTION_SPEC,
  StoredEvidenceExtractionService,
  type ExtractionCandidate,
  type StoredEvidenceExtractionCommand,
} from "../src/application/evidence-extraction.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type {
  InferenceProvider,
  InferenceProviderKind,
  InferenceRequest,
  InferenceResponse,
  RuntimeManifest,
} from "../src/runtime/contracts.ts";
import { InferenceGateway } from "../src/runtime/inference-gateway.ts";
import type { StoredObjectRef } from "../src/storage/contracts.ts";
import { LocalObjectStore } from "../src/storage/local-object-store.ts";
import { ObjectStoreGateway } from "../src/storage/object-store-gateway.ts";

const CONTEXT: ActorContext = { clinicId: "clinic-1", actorId: "employee-1", role: "EMPLOYEE" };
const BYTES = new TextEncoder().encode("synthetic eye report");
const READY: ExtractionCandidate = {
  subjectTypeCandidate: "PATIENT",
  workflowFamilyCandidate: "EYE_EXAM",
  fields: { reportType: "fundus", reportId: "report-7", deviceId: "device-2" },
  missingFields: [],
  confidence: 0.95,
};

function strict(): RuntimeManifest {
  return {
    profile: "ON_PREM_STRICT",
    databaseProvider: "LOCAL_POSTGRES",
    fileProvider: "LOCAL_OBJECT_STORE",
    inferenceProvider: "LOCAL_MODEL",
    backupProvider: "LOCAL_ENCRYPTED_BACKUP",
    externalInferenceAuthorized: false,
    manifestVersion: "manifest-1",
  };
}

class FixtureProvider implements InferenceProvider {
  kind: InferenceProviderKind = "LOCAL_MODEL";
  modelId = "deterministic-local-fixture";
  invocations = 0;
  requests: InferenceRequest[] = [];
  contexts: ActorContext[] = [];
  output: unknown = READY;
  responseMutation: (response: InferenceResponse) => InferenceResponse = (value) => value;
  wait: Promise<void> | null = null;

  async infer(context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    this.invocations += 1;
    this.contexts.push(structuredClone(context));
    this.requests.push(structuredClone(request));
    if (this.wait) await this.wait;
    return this.responseMutation({
      requestId: request.requestId,
      providerKind: this.kind,
      modelId: this.modelId,
      schemaVersion: request.schemaVersion,
      output: structuredClone(this.output),
      completedAt: "2026-08-30T12:00:00.000Z",
    });
  }
}

class RawProvider implements InferenceProvider {
  readonly kind = "LOCAL_MODEL" as const;
  readonly modelId = "deterministic-local-fixture";
  response!: InferenceResponse;

  async infer(): Promise<InferenceResponse> {
    return this.response;
  }
}

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "clinic-os-extraction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new ObjectStoreGateway(strict(), new LocalObjectStore(root));
  const ref = await objects.put(CONTEXT, { objectId: "eye-report-1", mediaType: "image/png", bytes: BYTES });
  const provider = new FixtureProvider();
  const inference = new InferenceGateway(strict(), provider);
  const service = new StoredEvidenceExtractionService({ objects, inference });
  return { root, objects, ref, provider, inference, service };
}

function command(ref: StoredObjectRef): StoredEvidenceExtractionCommand {
  return {
    requestId: "extract-1",
    artifactId: "artifact-1",
    factCardId: "fact-1",
    objectRef: structuredClone(ref),
    kind: "EXAM_REPORT",
    occurredAt: "2026-08-30T11:00:00.000Z",
    occurredAtSource: "source",
    identityAnchor: "PATIENT-007",
    createdAt: "2026-08-30T11:01:00.000Z",
  };
}

function code(expected: string) {
  return (error: unknown) => error instanceof DomainError && error.code === expected;
}

test("stored object round trip returns exact inherited Artifact, FactCard and lineage", async (t) => {
  const { ref, provider, inference, service } = await setup(t);
  const result = await service.extract(CONTEXT, command(ref));
  assert.equal(result.status, "READY");
  assert.equal(result.artifact.clinicId, CONTEXT.clinicId);
  assert.equal(result.artifact.sourceEmployeeId, CONTEXT.actorId);
  assert.equal(result.artifact.identityAnchor, "PATIENT-007");
  assert.deepEqual(result.artifact.payload, { storedObjectRef: ref });
  assert.equal(result.factCard?.identityAnchor, result.artifact.identityAnchor);
  assert.equal(result.factCard?.artifactId, result.artifact.id);
  assert.deepEqual(result.factCard?.lineageArtifactIds, [result.artifact.id]);
  assert.equal(result.factCard?.parserVersion, EYE_EXAM_EXTRACTION_SPEC.parserVersion);
  assert.deepEqual(result.lineage, {
    requestId: "extract-1",
    providerKind: "LOCAL_MODEL",
    modelId: provider.modelId,
    modelManifestSha256: EYE_EXAM_EXTRACTION_SPEC.modelManifestSha256,
    capability: EYE_EXAM_EXTRACTION_SPEC.capability,
    schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion,
    policyVersion: EYE_EXAM_EXTRACTION_SPEC.policyVersion,
    parserVersion: EYE_EXAM_EXTRACTION_SPEC.parserVersion,
    completedAt: "2026-08-30T12:00:00.000Z",
    objectContentSha256: ref.contentSha256,
  });
  assert.equal(inference.listReceipts(CONTEXT).length, 1);
});

test("identity and authority never enter inference input or receipts", async (t) => {
  const { ref, provider, inference, service } = await setup(t);
  await service.extract(CONTEXT, command(ref));
  const requestText = JSON.stringify(provider.requests[0]);
  assert.doesNotMatch(requestText, /PATIENT-007|employee-1/);
  assert.deepEqual(Object.keys((provider.requests[0].input as Record<string, unknown>)).sort(), [
    "bytes", "contentSha256", "kind", "mediaType",
  ]);
  assert.deepEqual(provider.contexts[0], CONTEXT);
  assert.deepEqual(Object.keys(provider.contexts[0]).sort(), ["actorId", "clinicId", "role"]);
  const auditText = JSON.stringify({ receipt: inference.listReceipts(CONTEXT) });
  assert.doesNotMatch(auditText, /PATIENT-007|synthetic eye report|report-7/);
});

test("top-level and nested authority or verdict injection fails closed", async (t) => {
  const cases: unknown[] = [
    { ...READY, clinicId: "clinic-1" },
    { ...READY, fields: { reportType: "fundus", nested: { identityAnchor: "guessed" } } },
    { ...READY, fields: { reportType: "fundus", verdict: { status: "VERIFIED" } } },
    { ...READY, fields: { reportType: "fundus", decision: [{ action: "CLOSE_STANDARD" }] } },
  ];
  for (const output of cases) {
    const { ref, provider, service } = await setup(t);
    provider.output = output;
    await assert.rejects(service.extract(CONTEXT, command(ref)));
  }
});

test("cross-clinic and mismatched references fail before inference", async (t) => {
  const { ref, provider, service } = await setup(t);
  await assert.rejects(
    service.extract({ ...CONTEXT, clinicId: "clinic-2" }, command(ref)),
    code("TENANT_SCOPE_VIOLATION"),
  );
  await assert.rejects(
    service.extract(CONTEXT, command({ ...ref, contentSha256: "0".repeat(64) })),
  );
  assert.equal(provider.invocations, 0);
});

test("missing or damaged objects never invoke inference", async (t) => {
  const { root, ref, provider, service } = await setup(t);
  await assert.rejects(service.extract(CONTEXT, command({ ...ref, objectId: "missing" })), code("OBJECT_NOT_FOUND"));
  await rm(root, { recursive: true, force: true });
  await assert.rejects(service.extract(CONTEXT, command(ref)));
  assert.equal(provider.invocations, 0);
});

test("provider identity mutation is blocked without fallback", async (t) => {
  const { ref, provider, service } = await setup(t);
  provider.modelId = "mutated";
  await assert.rejects(service.extract(CONTEXT, command(ref)), code("INFERENCE_PROVIDER_IDENTITY_CHANGED"));
  assert.equal(provider.invocations, 0);
});

test("response request, schema and model mismatches fail without FactCard", async (t) => {
  const mutations = [
    (response: InferenceResponse) => ({ ...response, requestId: "other" }),
    (response: InferenceResponse) => ({ ...response, schemaVersion: "other" }),
    (response: InferenceResponse) => ({ ...response, modelId: "other" }),
  ];
  for (const mutation of mutations) {
    const { ref, provider, service } = await setup(t);
    provider.responseMutation = mutation;
    await assert.rejects(service.extract(CONTEXT, command(ref)), code("INVALID_INFERENCE_RESPONSE"));
  }
});

test("service validates inference envelopes returned through the real gateway", async (t) => {
  const { ref, objects } = await setup(t);
  const invalid = [
    { requestId: "other", providerKind: "LOCAL_MODEL", modelId: EYE_EXAM_EXTRACTION_SPEC.modelId, schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion, output: READY, completedAt: "2026-08-30T12:00:00.000Z" },
    { requestId: "extract-1", providerKind: "PRIVATE_CLOUD_MODEL", modelId: EYE_EXAM_EXTRACTION_SPEC.modelId, schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion, output: READY, completedAt: "2026-08-30T12:00:00.000Z" },
    { requestId: "extract-1", providerKind: "LOCAL_MODEL", modelId: "wrong-model", schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion, output: READY, completedAt: "2026-08-30T12:00:00.000Z" },
    { requestId: "extract-1", providerKind: "LOCAL_MODEL", modelId: EYE_EXAM_EXTRACTION_SPEC.modelId, schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion, output: READY, completedAt: "2026-08-30 12:00:00" },
    { requestId: "extract-1", providerKind: "LOCAL_MODEL", modelId: EYE_EXAM_EXTRACTION_SPEC.modelId, schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion, output: READY, completedAt: "2026-08-30T12:00:00.000Z", authority: true },
  ];
  for (const response of invalid) {
    const provider = new RawProvider();
    provider.response = response as InferenceResponse;
    const service = new StoredEvidenceExtractionService({
      objects,
      inference: new InferenceGateway(strict(), provider),
    });
    await assert.rejects(service.extract(CONTEXT, command(ref)), code("INVALID_INFERENCE_RESPONSE"));
  }
});

test("candidate accessors, symbols, custom prototypes and hostile proxies fail without getter execution", async (t) => {
  const { ref, objects } = await setup(t);
  let getterCalls = 0;
  const accessor = { ...READY, fields: {} } as Record<string, unknown>;
  Object.defineProperty(accessor.fields, "reportType", {
    enumerable: true,
    get() { getterCalls += 1; return "fundus"; },
  });
  const symbol = { ...READY, fields: { reportType: "fundus", [Symbol("hidden")]: true } };
  const custom = { ...READY, fields: Object.assign(Object.create({ inherited: true }), { reportType: "fundus" }) };
  const proxy = new Proxy(READY, { ownKeys() { throw new Error("hostile"); } });
  for (const output of [accessor, symbol, custom, proxy]) {
    const response = {
      requestId: "extract-1",
      providerKind: "LOCAL_MODEL" as const,
      modelId: EYE_EXAM_EXTRACTION_SPEC.modelId,
      schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion,
      output,
      completedAt: "2026-08-30T12:00:00.000Z",
    };
    const provider = new RawProvider();
    provider.response = response;
    const service = new StoredEvidenceExtractionService({ objects, inference: new InferenceGateway(strict(), provider) });
    await assert.rejects(service.extract(CONTEXT, command(ref)), code("INVALID_INFERENCE_RESPONSE"));
  }
  assert.equal(getterCalls, 0);
});

test("huge sparse candidate arrays fail quickly at the shared response boundary", async (t) => {
  const { ref, objects } = await setup(t);
  const sparse: unknown[] = [];
  sparse.length = 1_000_000_000;
  const provider = new RawProvider();
  provider.response = {
    requestId: "extract-1",
    providerKind: "LOCAL_MODEL",
    modelId: EYE_EXAM_EXTRACTION_SPEC.modelId,
    schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion,
    output: { ...READY, fields: { reportType: "fundus", values: sparse } },
    completedAt: "2026-08-30T12:00:00.000Z",
  };
  const service = new StoredEvidenceExtractionService({
    objects,
    inference: new InferenceGateway(strict(), provider),
  });
  await assert.rejects(service.extract(CONTEXT, command(ref)), code("INVALID_INFERENCE_RESPONSE"));
});

test("taxonomy escape, non-JSON values, oversized fields and invalid confidence fail", async (t) => {
  const outputs: unknown[] = [
    { ...READY, subjectTypeCandidate: "DEVICE" },
    { ...READY, workflowFamilyCandidate: "OTHER" },
    { ...READY, fields: { reportType: "fundus", takenAt: new Date() } },
    { ...READY, fields: { reportType: "x".repeat(65 * 1024) } },
    { ...READY, confidence: Number.NaN },
    { ...READY, missingFields: ["unknown"] },
    { ...READY, missingFields: ["reportType", "reportType"], fields: {} },
  ];
  for (const output of outputs) {
    const { ref, provider, service } = await setup(t);
    provider.output = output;
    await assert.rejects(
      service.extract(CONTEXT, command(ref)),
      (error: unknown) => error instanceof DomainError &&
        ["INVALID_EXTRACTION_CANDIDATE", "INVALID_INFERENCE_RESPONSE"].includes(error.code),
    );
  }
});

test("low confidence or declared missing required fields returns review only", async (t) => {
  for (const output of [
    { ...READY, confidence: 0.79 },
    { ...READY, fields: {}, missingFields: ["reportType"] },
    { ...READY, fields: { reportType: null }, missingFields: [] },
    { ...READY, fields: { reportType: "  " }, missingFields: [] },
  ]) {
    const { ref, provider, service } = await setup(t);
    provider.output = output;
    const result = await service.extract(CONTEXT, command(ref));
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.factCard, null);
    assert.equal(result.reasonCodes.length, 1);
  }
});

test("missing patient anchor and extra caller authority fail before reads or inference", async (t) => {
  const { ref, provider, objects, service } = await setup(t);
  const before = objects.listReceipts(CONTEXT).length;
  await assert.rejects(service.extract(CONTEXT, { ...command(ref), identityAnchor: null }), code("IDENTITY_ANCHOR_REQUIRED"));
  await assert.rejects(service.extract(CONTEXT, { ...command(ref), clinicId: "clinic-2" } as never), code("INVALID_EXTRACTION_COMMAND"));
  await assert.rejects(service.extract({ ...CONTEXT, identityAnchor: "PATIENT-007" } as never, command(ref)), code("INVALID_ACTOR_CONTEXT"));
  assert.equal(objects.listReceipts(CONTEXT).length, before);
  assert.equal(provider.invocations, 0);
});

test("Artifact occurrence provenance combinations fail closed before object read", async (t) => {
  const { ref, provider, objects, service } = await setup(t);
  const before = objects.listReceipts(CONTEXT).length;
  for (const invalid of [
    { ...command(ref), occurredAt: null, occurredAtSource: "source" as const },
    { ...command(ref), occurredAt: "2026-08-30T11:00:00.000Z", occurredAtSource: "unknown" as const },
  ]) {
    await assert.rejects(service.extract(CONTEXT, invalid), code("INVALID_EXTRACTION_COMMAND"));
  }
  assert.equal(objects.listReceipts(CONTEXT).length, before);
  assert.equal(provider.invocations, 0);
});

test("caller mutation during await and returned mutation cannot alter the projection", async (t) => {
  const { ref, provider, service } = await setup(t);
  let release!: () => void;
  provider.wait = new Promise<void>((resolve) => { release = resolve; });
  const input = command(ref);
  const pending = service.extract(CONTEXT, input);
  input.identityAnchor = "MUTATED";
  input.objectRef.contentSha256 = "0".repeat(64);
  release();
  const result = await pending;
  assert.equal(result.artifact.identityAnchor, "PATIENT-007");
  if (result.factCard) result.factCard.fields.reportType = "mutated";
  const again = await service.extract(CONTEXT, command(ref));
  assert.equal(again.factCard?.fields.reportType, "fundus");
});

test("same input and deterministic fixture produce the same domain projection", async (t) => {
  const { ref, service } = await setup(t);
  const first = await service.extract(CONTEXT, command(ref));
  const second = await service.extract(CONTEXT, command(ref));
  assert.deepEqual(first, second);
});

test("lineage exposes no bytes, path, model output or identity", async (t) => {
  const { ref, service } = await setup(t);
  const result = await service.extract(CONTEXT, command(ref));
  assert.deepEqual(Object.keys(result.lineage).sort(), [
    "capability", "completedAt", "modelId", "modelManifestSha256", "objectContentSha256",
    "parserVersion", "policyVersion", "providerKind", "requestId", "schemaVersion",
  ]);
  assert.doesNotMatch(JSON.stringify(result.lineage), /PATIENT|report-7|bytes|path/i);
});

test("service dependencies expose no persistence or domain write authority", async (t) => {
  const { service, objects, inference } = await setup(t);
  for (const forbidden of ["repository", "saveCapture", "workflow", "expectation", "decision"]) {
    assert.equal(forbidden in service, false);
  }
  assert.throws(
    () => new StoredEvidenceExtractionService({ objects: { get: objects.get.bind(objects) } as never, inference }),
    code("INVALID_EXTRACTION_DEPENDENCY"),
  );
});
