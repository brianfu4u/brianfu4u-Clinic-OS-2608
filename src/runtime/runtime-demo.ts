import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
  RuntimeManifest,
} from "./contracts.ts";
import { DisabledInferenceProvider, InferenceGateway } from "./inference-gateway.ts";

const context: ActorContext = {
  clinicId: "demo-clinic",
  actorId: "demo-employee",
  role: "EMPLOYEE",
};
const request: InferenceRequest = {
  requestId: "runtime-demo-request",
  clinicId: context.clinicId,
  capability: "SYNTHETIC_CONTRACT_CHECK",
  schemaVersion: "demo-1",
  input: { synthetic: true },
};

class DemoLocalInferenceFixture implements InferenceProvider {
  readonly kind = "LOCAL_MODEL" as const;
  readonly modelId = "demo-local-fixture";

  async infer(_context: ActorContext, input: InferenceRequest): Promise<InferenceResponse> {
    return {
      requestId: input.requestId,
      providerKind: this.kind,
      modelId: this.modelId,
      schemaVersion: input.schemaVersion,
      output: { synthetic: true },
      completedAt: "2026-08-29T12:00:00.000Z",
    };
  }
}

function manifest(inferenceProvider: RuntimeManifest["inferenceProvider"]): RuntimeManifest {
  return {
    profile: "ON_PREM_STRICT",
    databaseProvider: "LOCAL_POSTGRES",
    fileProvider: "LOCAL_OBJECT_STORE",
    inferenceProvider,
    backupProvider: "LOCAL_ENCRYPTED_BACKUP",
    externalInferenceAuthorized: false,
    manifestVersion: "runtime-demo-1",
  };
}

const localGateway = new InferenceGateway(manifest("LOCAL_MODEL"), new DemoLocalInferenceFixture());
await localGateway.infer(context, request);
let disabledError = "";
try {
  const disabled = new InferenceGateway(manifest("DISABLED"), new DisabledInferenceProvider());
  await disabled.infer(context, { ...request, requestId: "runtime-demo-disabled" });
} catch (error) {
  if (error instanceof DomainError) disabledError = error.code;
  else throw error;
}

console.log(JSON.stringify({
  strictLocalReceipt: localGateway.listReceipts(context)[0],
  disabledError,
}));
