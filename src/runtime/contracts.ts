import type { ActorContext } from "../domain/contracts.ts";

export type DeploymentProfile = "ON_PREM_STRICT" | "ON_PREM_HYBRID" | "CLOUD";
export type DatabaseProviderKind = "LOCAL_POSTGRES" | "CLOUD_SQL_POSTGRES";
export type FileProviderKind = "LOCAL_OBJECT_STORE" | "CLOUD_OBJECT_STORE";
export type InferenceProviderKind = "LOCAL_MODEL" | "PRIVATE_CLOUD_MODEL" | "DISABLED";
export type BackupProviderKind =
  | "LOCAL_ENCRYPTED_BACKUP"
  | "CLOUD_MANAGED_BACKUP"
  | "LOCAL_PLUS_ENCRYPTED_REMOTE_BACKUP";

export interface RuntimeManifest {
  profile: DeploymentProfile;
  databaseProvider: DatabaseProviderKind;
  fileProvider: FileProviderKind;
  inferenceProvider: InferenceProviderKind;
  backupProvider: BackupProviderKind;
  externalInferenceAuthorized: boolean;
  manifestVersion: string;
}

export interface InferenceRequest {
  requestId: string;
  clinicId: string;
  capability: string;
  schemaVersion: string;
  input: unknown;
}

export interface InferenceResponse {
  requestId: string;
  providerKind: InferenceProviderKind;
  modelId: string;
  schemaVersion: string;
  output: unknown;
  completedAt: string;
}

export interface InferenceProvider {
  readonly kind: InferenceProviderKind;
  readonly modelId: string;
  infer(context: ActorContext, request: InferenceRequest): Promise<InferenceResponse>;
}

export interface InferenceCallReceipt {
  requestId: string;
  clinicId: string;
  providerKind: InferenceProviderKind;
  capability: string;
  completedAt: string;
}
