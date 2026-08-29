import { DomainError } from "../domain/errors.ts";
import type {
  BackupProviderKind,
  DatabaseProviderKind,
  DeploymentProfile,
  FileProviderKind,
  InferenceProviderKind,
  RuntimeManifest,
} from "./contracts.ts";

const PROFILES = ["ON_PREM_STRICT", "ON_PREM_HYBRID", "CLOUD"] as const;
const DATABASES = ["LOCAL_POSTGRES", "CLOUD_SQL_POSTGRES"] as const;
const FILES = ["LOCAL_OBJECT_STORE", "CLOUD_OBJECT_STORE"] as const;
const INFERENCE = ["LOCAL_MODEL", "PRIVATE_CLOUD_MODEL", "DISABLED"] as const;
const BACKUPS = [
  "LOCAL_ENCRYPTED_BACKUP",
  "CLOUD_MANAGED_BACKUP",
  "LOCAL_PLUS_ENCRYPTED_REMOTE_BACKUP",
] as const;

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

export function validateRuntimeManifest(value: unknown): Readonly<RuntimeManifest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_RUNTIME_MANIFEST", "Runtime manifest must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    !isOneOf<DeploymentProfile>(input.profile, PROFILES) ||
    !isOneOf<DatabaseProviderKind>(input.databaseProvider, DATABASES) ||
    !isOneOf<FileProviderKind>(input.fileProvider, FILES) ||
    !isOneOf<InferenceProviderKind>(input.inferenceProvider, INFERENCE) ||
    !isOneOf<BackupProviderKind>(input.backupProvider, BACKUPS) ||
    typeof input.externalInferenceAuthorized !== "boolean" ||
    typeof input.manifestVersion !== "string" ||
    input.manifestVersion.trim() === ""
  ) {
    throw new DomainError(
      "INVALID_RUNTIME_MANIFEST",
      "Runtime manifest fields and provider kinds must be explicit and valid.",
    );
  }

  const manifest: RuntimeManifest = {
    profile: input.profile,
    databaseProvider: input.databaseProvider,
    fileProvider: input.fileProvider,
    inferenceProvider: input.inferenceProvider,
    backupProvider: input.backupProvider,
    externalInferenceAuthorized: input.externalInferenceAuthorized,
    manifestVersion: input.manifestVersion,
  };
  assertCompatible(manifest);
  return Object.freeze(manifest);
}

function assertCompatible(manifest: RuntimeManifest): void {
  if (manifest.profile === "ON_PREM_STRICT") {
    if (
      manifest.databaseProvider !== "LOCAL_POSTGRES" ||
      manifest.fileProvider !== "LOCAL_OBJECT_STORE" ||
      !["LOCAL_MODEL", "DISABLED"].includes(manifest.inferenceProvider) ||
      manifest.backupProvider !== "LOCAL_ENCRYPTED_BACKUP" ||
      manifest.externalInferenceAuthorized
    ) {
      throw new DomainError(
        "STRICT_REMOTE_PROVIDER_FORBIDDEN",
        "On-Prem Strict permits only clinic-local providers and no external inference authorization.",
      );
    }
    return;
  }

  if (manifest.profile === "ON_PREM_HYBRID") {
    if (
      manifest.databaseProvider !== "LOCAL_POSTGRES" ||
      manifest.fileProvider !== "LOCAL_OBJECT_STORE" ||
      !["LOCAL_MODEL", "PRIVATE_CLOUD_MODEL", "DISABLED"].includes(manifest.inferenceProvider) ||
      !["LOCAL_ENCRYPTED_BACKUP", "LOCAL_PLUS_ENCRYPTED_REMOTE_BACKUP"].includes(
        manifest.backupProvider,
      )
    ) {
      throw new DomainError(
        "PROFILE_PROVIDER_INCOMPATIBLE",
        "On-Prem Hybrid requires local data providers and an allowed backup provider.",
      );
    }
    if (
      manifest.inferenceProvider === "PRIVATE_CLOUD_MODEL" &&
      !manifest.externalInferenceAuthorized
    ) {
      throw new DomainError(
        "HYBRID_EXTERNAL_INFERENCE_NOT_AUTHORIZED",
        "Private-cloud inference requires explicit Hybrid authorization.",
      );
    }
    return;
  }

  if (
    manifest.databaseProvider !== "CLOUD_SQL_POSTGRES" ||
    manifest.fileProvider !== "CLOUD_OBJECT_STORE" ||
    !["PRIVATE_CLOUD_MODEL", "DISABLED"].includes(manifest.inferenceProvider) ||
    manifest.backupProvider !== "CLOUD_MANAGED_BACKUP"
  ) {
    throw new DomainError(
      "PROFILE_PROVIDER_INCOMPATIBLE",
      "Cloud profile requires the frozen cloud provider set.",
    );
  }
}
