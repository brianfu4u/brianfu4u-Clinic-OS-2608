import assert from "node:assert/strict";
import test from "node:test";

import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type {
  InferenceProvider,
  InferenceProviderKind,
  InferenceRequest,
  InferenceResponse,
  RuntimeManifest,
} from "../src/runtime/contracts.ts";
import {
  DisabledInferenceProvider,
  InferenceGateway,
} from "../src/runtime/inference-gateway.ts";
import { validateRuntimeManifest } from "../src/runtime/manifest-validator.ts";

const CONTEXT: ActorContext = {
  clinicId: "clinic-1",
  actorId: "employee-1",
  role: "EMPLOYEE",
};
const REQUEST: InferenceRequest = {
  requestId: "request-1",
  clinicId: CONTEXT.clinicId,
  capability: "SYNTHETIC_TEST",
  schemaVersion: "schema-1",
  input: { private: "must-not-enter-receipt" },
};

function strict(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    profile: "ON_PREM_STRICT",
    databaseProvider: "LOCAL_POSTGRES",
    fileProvider: "LOCAL_OBJECT_STORE",
    inferenceProvider: "LOCAL_MODEL",
    backupProvider: "LOCAL_ENCRYPTED_BACKUP",
    externalInferenceAuthorized: false,
    manifestVersion: "manifest-1",
    ...overrides,
  };
}

function hybrid(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    ...strict(),
    profile: "ON_PREM_HYBRID",
    ...overrides,
  };
}

function cloud(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    profile: "CLOUD",
    databaseProvider: "CLOUD_SQL_POSTGRES",
    fileProvider: "CLOUD_OBJECT_STORE",
    inferenceProvider: "PRIVATE_CLOUD_MODEL",
    backupProvider: "CLOUD_MANAGED_BACKUP",
    externalInferenceAuthorized: false,
    manifestVersion: "manifest-1",
    ...overrides,
  };
}

class DeterministicInferenceFixture implements InferenceProvider {
  readonly kind: InferenceProviderKind;
  readonly mutate: (response: InferenceResponse) => InferenceResponse;
  readonly modelId: string;
  invocations = 0;

  constructor(
    kind: InferenceProviderKind,
    mutate: (response: InferenceResponse) => InferenceResponse = (response) => response,
  ) {
    this.kind = kind;
    this.mutate = mutate;
    this.modelId = `fixture-${kind.toLowerCase()}`;
  }

  async infer(_context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    this.invocations += 1;
    return this.mutate({
      requestId: request.requestId,
      providerKind: this.kind,
      modelId: this.modelId,
      schemaVersion: request.schemaVersion,
      output: { synthetic: true },
      completedAt: "2026-08-29T12:00:00.000Z",
    });
  }
}

test("every deployment profile accepts its valid manifest", () => {
  const manifests = [
    strict(),
    strict({ inferenceProvider: "DISABLED" }),
    hybrid(),
    hybrid({
      inferenceProvider: "PRIVATE_CLOUD_MODEL",
      externalInferenceAuthorized: true,
      backupProvider: "LOCAL_PLUS_ENCRYPTED_REMOTE_BACKUP",
    }),
    cloud(),
    cloud({ inferenceProvider: "DISABLED" }),
  ];
  for (const manifest of manifests) {
    assert.deepEqual(validateRuntimeManifest(manifest), manifest);
  }
});

test("Strict rejects every remote or cloud provider and authorization permutation", () => {
  const invalid = [
    strict({ databaseProvider: "CLOUD_SQL_POSTGRES" }),
    strict({ fileProvider: "CLOUD_OBJECT_STORE" }),
    strict({ inferenceProvider: "PRIVATE_CLOUD_MODEL" }),
    strict({ backupProvider: "CLOUD_MANAGED_BACKUP" }),
    strict({ backupProvider: "LOCAL_PLUS_ENCRYPTED_REMOTE_BACKUP" }),
    strict({ externalInferenceAuthorized: true }),
  ];
  for (const manifest of invalid) {
    assert.throws(
      () => validateRuntimeManifest(manifest),
      (error) => error instanceof DomainError && error.code === "STRICT_REMOTE_PROVIDER_FORBIDDEN",
    );
  }
});

test("Hybrid private-cloud inference requires explicit authorization", () => {
  assert.throws(
    () => validateRuntimeManifest(hybrid({ inferenceProvider: "PRIVATE_CLOUD_MODEL" })),
    (error) =>
      error instanceof DomainError &&
      error.code === "HYBRID_EXTERNAL_INFERENCE_NOT_AUTHORIZED",
  );
  assert.equal(validateRuntimeManifest(hybrid({
    inferenceProvider: "PRIVATE_CLOUD_MODEL",
    externalInferenceAuthorized: true,
  })).profile, "ON_PREM_HYBRID");
});

test("Cloud rejects every local-only provider kind", () => {
  for (const manifest of [
    cloud({ databaseProvider: "LOCAL_POSTGRES" }),
    cloud({ fileProvider: "LOCAL_OBJECT_STORE" }),
    cloud({ inferenceProvider: "LOCAL_MODEL" }),
    cloud({ backupProvider: "LOCAL_ENCRYPTED_BACKUP" }),
    cloud({ backupProvider: "LOCAL_PLUS_ENCRYPTED_REMOTE_BACKUP" }),
  ]) {
    assert.throws(
      () => validateRuntimeManifest(manifest),
      (error) => error instanceof DomainError && error.code === "PROFILE_PROVIDER_INCOMPATIBLE",
    );
  }
});

test("invalid provider enum or missing manifest field fails closed", () => {
  const missing = { ...strict() } as Record<string, unknown>;
  delete missing.fileProvider;
  for (const manifest of [missing, { ...strict(), inferenceProvider: "AUTO" }]) {
    assert.throws(
      () => validateRuntimeManifest(manifest),
      (error) => error instanceof DomainError && error.code === "INVALID_RUNTIME_MANIFEST",
    );
  }
});

test("provider kind mismatch fails before invocation", () => {
  const provider = new DeterministicInferenceFixture("LOCAL_MODEL");
  assert.throws(
    () => new InferenceGateway(strict({ inferenceProvider: "DISABLED" }), provider),
    (error) =>
      error instanceof DomainError && error.code === "INFERENCE_PROVIDER_KIND_MISMATCH",
  );
  assert.equal(provider.invocations, 0);
});

test("cross-clinic inference fails before provider invocation", async () => {
  const provider = new DeterministicInferenceFixture("LOCAL_MODEL");
  const gateway = new InferenceGateway(strict(), provider);
  await assert.rejects(
    gateway.infer({ ...CONTEXT, clinicId: "clinic-2" }, REQUEST),
    (error) => error instanceof DomainError && error.code === "TENANT_SCOPE_VIOLATION",
  );
  assert.equal(provider.invocations, 0);
});

test("Disabled provider returns explicit unavailable error and no receipt", async () => {
  const gateway = new InferenceGateway(
    strict({ inferenceProvider: "DISABLED" }),
    new DisabledInferenceProvider(),
  );
  await assert.rejects(
    gateway.infer(CONTEXT, REQUEST),
    (error) => error instanceof DomainError && error.code === "INFERENCE_UNAVAILABLE",
  );
  assert.deepEqual(gateway.listReceipts(CONTEXT), []);
});

test("Strict rejects a manually constructed private-cloud provider before invocation", () => {
  const provider = new DeterministicInferenceFixture("PRIVATE_CLOUD_MODEL");
  assert.throws(
    () => new InferenceGateway(strict(), provider),
    (error) => error instanceof DomainError && error.code === "STRICT_REMOTE_PROVIDER_FORBIDDEN",
  );
  assert.equal(provider.invocations, 0);
});

test("malformed provider response identity and schema fail closed", async () => {
  const mutations = [
    (response: InferenceResponse) => ({ ...response, requestId: "other-request" }),
    (response: InferenceResponse) => ({ ...response, schemaVersion: "other-schema" }),
    (response: InferenceResponse) => ({ ...response, providerKind: "DISABLED" as const }),
    (response: InferenceResponse) => ({ ...response, modelId: "other-model" }),
    (response: InferenceResponse) => ({ ...response, completedAt: "not-a-time" }),
  ];
  for (const mutate of mutations) {
    const gateway = new InferenceGateway(
      strict(),
      new DeterministicInferenceFixture("LOCAL_MODEL", mutate),
    );
    await assert.rejects(
      gateway.infer(CONTEXT, REQUEST),
      (error) => error instanceof DomainError && error.code === "INVALID_INFERENCE_RESPONSE",
    );
    assert.deepEqual(gateway.listReceipts(CONTEXT), []);
  }
});

test("local and private-cloud fixtures satisfy the same inference contract", async () => {
  const configurations: Array<[RuntimeManifest, InferenceProviderKind]> = [
    [strict(), "LOCAL_MODEL"],
    [hybrid({
      inferenceProvider: "PRIVATE_CLOUD_MODEL",
      externalInferenceAuthorized: true,
    }), "PRIVATE_CLOUD_MODEL"],
  ];
  for (const [manifest, kind] of configurations) {
    const gateway = new InferenceGateway(manifest, new DeterministicInferenceFixture(kind));
    const response = await gateway.infer(CONTEXT, REQUEST);
    assert.equal(response.requestId, REQUEST.requestId);
    assert.equal(response.schemaVersion, REQUEST.schemaVersion);
    assert.equal(response.providerKind, kind);
    assert.deepEqual(response.output, { synthetic: true });
  }
});

test("gateway receipt excludes inference input and output", async () => {
  const gateway = new InferenceGateway(
    strict(),
    new DeterministicInferenceFixture("LOCAL_MODEL"),
  );
  await gateway.infer(CONTEXT, REQUEST);
  const [receipt] = gateway.listReceipts(CONTEXT);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "capability",
    "clinicId",
    "completedAt",
    "providerKind",
    "requestId",
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /must-not-enter-receipt|synthetic/);
});

test("provider contract exposes no domain repository or write capability", () => {
  for (const provider of [
    new DisabledInferenceProvider(),
    new DeterministicInferenceFixture("LOCAL_MODEL"),
  ]) {
    for (const forbidden of ["repositories", "artifactStore", "workflowStore", "writeDomain"]) {
      assert.equal(forbidden in provider, false);
    }
  }
});
