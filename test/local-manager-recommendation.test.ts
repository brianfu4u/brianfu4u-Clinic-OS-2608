import assert from "node:assert/strict";
import test from "node:test";

import { LocalManagerRecommendationService } from "../src/application/local-manager-recommendation.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { ManagerAttentionGapItem } from "../src/persistence/manager-closure-read-repository.ts";
import type { InferenceProvider, InferenceProviderKind, InferenceRequest, InferenceResponse, RuntimeManifest } from "../src/runtime/contracts.ts";
import { DisabledInferenceProvider, InferenceGateway } from "../src/runtime/inference-gateway.ts";

const MANAGER: ActorContext = { clinicId: "clinic-1", actorId: "manager-1", role: "MANAGER" };
const GAP: ManagerAttentionGapItem = {
  workflowId: "workflow-private-id",
  workflowFamily: "EYE_EXAM",
  workflowStatus: "OPEN",
  stage: "STRUCTURED_ALIGNMENT",
  alignmentStatus: "MISSING",
  reasonCodes: ["MISSING_EXAM_REPORT"],
};

class LocalFixture implements InferenceProvider {
  readonly kind: InferenceProviderKind = "LOCAL_MODEL";
  readonly modelId = "local-fixture";
  calls: InferenceRequest[] = [];
  output: unknown = {
    schemaVersion: "clinic-os/manager-attention-guidance/v1",
    suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
    reasonCodes: ["MISSING_EXAM_REPORT"],
  };

  async infer(_context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    this.calls.push(structuredClone(request));
    return {
      requestId: request.requestId,
      providerKind: this.kind,
      modelId: this.modelId,
      schemaVersion: request.schemaVersion,
      output: this.output,
      completedAt: "2026-08-31T00:00:00.000Z",
    };
  }
}

function manifest(kind: InferenceProviderKind = "LOCAL_MODEL"): RuntimeManifest {
  if (kind === "PRIVATE_CLOUD_MODEL") {
    return {
      profile: "ON_PREM_HYBRID", databaseProvider: "LOCAL_POSTGRES", fileProvider: "LOCAL_OBJECT_STORE",
      inferenceProvider: kind, backupProvider: "LOCAL_ENCRYPTED_BACKUP", externalInferenceAuthorized: true,
      manifestVersion: "test",
    };
  }
  return {
    profile: "ON_PREM_STRICT", databaseProvider: "LOCAL_POSTGRES", fileProvider: "LOCAL_OBJECT_STORE",
    inferenceProvider: kind, backupProvider: "LOCAL_ENCRYPTED_BACKUP", externalInferenceAuthorized: false,
    manifestVersion: "test",
  };
}

test("local recommendation sends only bounded attention state and returns inert guidance", async () => {
  const provider = new LocalFixture();
  const gateway = new InferenceGateway(manifest(), provider);
  const result = await new LocalManagerRecommendationService(gateway).recommend(MANAGER, GAP);

  assert.deepEqual(result, {
    status: "AVAILABLE",
    schemaVersion: "clinic-os/manager-attention-guidance/v1",
    suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
    reasonCodes: ["MISSING_EXAM_REPORT"],
  });
  assert.deepEqual(provider.calls[0]?.input, {
    schemaVersion: "clinic-os/manager-attention-recommendation/v1",
    stage: "STRUCTURED_ALIGNMENT",
    alignmentStatus: "MISSING",
    reasonCodes: ["MISSING_EXAM_REPORT"],
  });
  const audit = JSON.stringify({ input: provider.calls[0]?.input, receipt: gateway.listReceipts(MANAGER) });
  assert.equal(audit.includes(GAP.workflowId), false);
  assert.equal(audit.includes(GAP.workflowFamily), false);
  assert.equal(audit.includes("patient"), false);
});

test("recommendation fails closed for disabled or nonlocal inference without a fallback call", async () => {
  const disabled = new InferenceGateway(
    manifest("DISABLED"), new DisabledInferenceProvider(),
  );
  assert.deepEqual(
    await new LocalManagerRecommendationService(disabled).recommend(MANAGER, GAP),
    { status: "UNAVAILABLE", code: "LOCAL_RECOMMENDATION_UNAVAILABLE" },
  );

  const remote = new LocalFixture();
  (remote as { kind: InferenceProviderKind }).kind = "PRIVATE_CLOUD_MODEL";
  const privateGateway = new InferenceGateway(manifest("PRIVATE_CLOUD_MODEL"), remote);
  assert.deepEqual(
    await new LocalManagerRecommendationService(privateGateway).recommend(MANAGER, GAP),
    { status: "UNAVAILABLE", code: "LOCAL_RECOMMENDATION_UNAVAILABLE" },
  );
  assert.equal(remote.calls.length, 0);
});

test("closed attention and output schemas reject identity, authority and arbitrary model fields", async () => {
  const provider = new LocalFixture();
  const service = new LocalManagerRecommendationService(new InferenceGateway(manifest(), provider));
  await assert.rejects(
    service.recommend({ ...MANAGER, role: "EMPLOYEE" }, GAP),
    (error) => error instanceof DomainError && error.code === "ROLE_SCOPE_VIOLATION",
  );
  await assert.rejects(
    service.recommend(MANAGER, { ...GAP, identityAnchor: "patient-private" } as ManagerAttentionGapItem),
    (error) => error instanceof DomainError && error.code === "INVALID_MANAGER_ATTENTION_ITEM",
  );
  provider.output = {
    schemaVersion: "clinic-os/manager-attention-guidance/v1",
    suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
    reasonCodes: ["MISSING_EXAM_REPORT"],
    action: "CLOSE_STANDARD",
  };
  assert.deepEqual(
    await service.recommend(MANAGER, GAP),
    { status: "UNAVAILABLE", code: "LOCAL_RECOMMENDATION_UNAVAILABLE" },
  );
});
