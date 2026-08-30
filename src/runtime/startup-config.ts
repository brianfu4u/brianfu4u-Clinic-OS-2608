import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { DomainError } from "../domain/errors.ts";
import {
  TESSERACT_MODEL_MANIFEST_SHA256,
  TESSERACT_OCR_MODEL_ID,
  validateTesseractAssetPathChainSync,
  validateTesseractCheckedInManifestSync,
} from "./tesseract-ocr-provider.ts";
import type { RuntimeManifest } from "./contracts.ts";
import { validateRuntimeManifest } from "./manifest-validator.ts";

export const CLINICAL_CAPABILITY = "EXTRACT_EYE_EXAM_REPORT" as const;
const MANIFEST_FILE = fileURLToPath(new URL("../../models/tesseract-eng-v1.manifest.json", import.meta.url));

export type StartupMode = "SYNTHETIC_PREVIEW" | "CONFIGURED";

export interface StartupSnapshot {
  readonly mode: StartupMode;
  readonly profile: RuntimeManifest["profile"] | "SYNTHETIC_PREVIEW";
  readonly databaseProvider: RuntimeManifest["databaseProvider"] | null;
  readonly fileProvider: RuntimeManifest["fileProvider"] | null;
  readonly inferenceProvider: RuntimeManifest["inferenceProvider"] | null;
  readonly backupProvider: RuntimeManifest["backupProvider"] | null;
  readonly manifestVersion: string | null;
  readonly capabilities: readonly string[];
  readonly databaseConfigured: boolean;
  readonly objectStoreConfigured: boolean;
  readonly ocrManifestConfigured: boolean;
  readonly inferenceCapabilityConfigured: boolean;
  readonly configurationFingerprint: string;
}

export interface StartupConfig {
  readonly mode: StartupMode;
  readonly manifest: Readonly<RuntimeManifest> | null;
  readonly snapshot: Readonly<StartupSnapshot>;
  readonly port: number;
}

/**
 * The configured assembly code is the only consumer of these values.  They are
 * deliberately kept out of StartupSnapshot so health/readiness can never
 * serialize a URL, filesystem path, or provider endpoint.
 */

interface PrivateStartupValues {
  databaseUrl?: string;
  objectStoreRoot?: string;
  tesseractPath?: string;
  tessdataDir?: string;
  privateInferenceEndpoint?: string;
  privateInferenceModelId?: string;
  privateInferenceManifestSha256?: string;
}

const privateValues = new WeakMap<object, PrivateStartupValues>();

const ENV_NAMES = new Set([
  "CLINIC_OS_PROFILE", "DATABASE_URL", "CLINIC_OS_DATABASE_PROVIDER", "CLINIC_OS_FILE_PROVIDER",
  "CLINIC_OS_INFERENCE_PROVIDER", "CLINIC_OS_BACKUP_PROVIDER", "CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED",
  "CLINIC_OS_MANIFEST_VERSION", "CLINIC_OS_OBJECT_STORE_ROOT", "WO021_TESSERACT_PATH",
  "WO021_TESSDATA_DIR", "CLINIC_OS_PRIVATE_INFERENCE_ENDPOINT", "CLINIC_OS_PRIVATE_INFERENCE_MODEL_ID",
  "CLINIC_OS_PRIVATE_INFERENCE_MANIFEST_SHA256", "CLINIC_OS_INFERENCE_CAPABILITIES", "PORT",
  "PREVIEW_MODE", "PREVIEW_OBJECT_STORE_ROOT", "LOCAL_OBJECT_STORE_ROOT", "OBJECT_STORE_ROOT",
]);
const LEGACY_NAMES = new Set(["PREVIEW_OBJECT_STORE_ROOT", "LOCAL_OBJECT_STORE_ROOT", "OBJECT_STORE_ROOT", "PREVIEW_PORT"]);

export function validateStartupConfig(input: Record<string, unknown> = process.env): StartupConfig {
  const env = normalizeInput(input);
  rejectUnknownConfigurationNames(env);
  const previewMode = env.PREVIEW_MODE;
  if (previewMode === "synthetic") {
    if (env.CLINIC_OS_PROFILE !== undefined || Object.keys(env).some((key) => key.startsWith("CLINIC_OS_"))) {
      throw startupError("SYNTHETIC_CONFIGURATION_CONFLICT");
    }
    return makeSynthetic(env);
  }
  if (previewMode !== undefined && previewMode !== "postgres") throw startupError("INVALID_PREVIEW_MODE");

  // PREVIEW_MODE=postgres is an explicit migration-era compatibility parser. It is
  // intentionally never the default and cannot override canonical names.
  const legacy = previewMode === "postgres" && env.CLINIC_OS_PROFILE === undefined;
  if (legacy) {
    if (!env.DATABASE_URL?.trim()) throw startupError("DATABASE_URL_REQUIRED");
    if (!legacyRoot(env)) throw startupError("OBJECT_STORE_ROOT_REQUIRED");
  }
  const profile = required(env.CLINIC_OS_PROFILE ?? (legacy ? "ON_PREM_STRICT" : undefined), "PROFILE_REQUIRED");
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL_REQUIRED");
  validateDatabaseUrl(databaseUrl);
  const databaseProvider = required(env.CLINIC_OS_DATABASE_PROVIDER ?? (legacy ? "LOCAL_POSTGRES" : undefined), "DATABASE_PROVIDER_REQUIRED");
  const fileProvider = required(env.CLINIC_OS_FILE_PROVIDER ?? (legacy ? "LOCAL_OBJECT_STORE" : undefined), "FILE_PROVIDER_REQUIRED");
  const inferenceProvider = required(env.CLINIC_OS_INFERENCE_PROVIDER ?? (legacy ? "LOCAL_MODEL" : undefined), "INFERENCE_PROVIDER_REQUIRED");
  const backupProvider = required(env.CLINIC_OS_BACKUP_PROVIDER ?? (legacy ? "LOCAL_ENCRYPTED_BACKUP" : undefined), "BACKUP_PROVIDER_REQUIRED");
  const externalInferenceAuthorized = exactBoolean(
    env.CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED,
    "EXTERNAL_INFERENCE_AUTHORIZATION_REQUIRED",
    legacy ? false : undefined,
  );
  const manifestVersion = boundedToken(
    env.CLINIC_OS_MANIFEST_VERSION ?? (legacy ? "preview-postgres-local-v1" : undefined),
    "MANIFEST_VERSION_REQUIRED",
  );
  const manifest = validateRuntimeManifest({
    profile,
    databaseProvider,
    fileProvider,
    inferenceProvider,
    backupProvider,
    externalInferenceAuthorized,
    manifestVersion,
  });
  if (manifest.profile === "ON_PREM_STRICT" && manifest.inferenceProvider !== "LOCAL_MODEL") {
    throw startupError("STRICT_LOCAL_INFERENCE_REQUIRED");
  }
  const rootValue = env.CLINIC_OS_OBJECT_STORE_ROOT ?? (legacy ? legacyRoot(env) : undefined);
  const objectStoreRoot = isLocalFileProvider(manifest.fileProvider)
    ? requiredAbsolutePath(rootValue, legacy ? "OBJECT_STORE_ROOT_REQUIRED" : "OBJECT_STORE_ROOT_REQUIRED")
    : undefined;
  if (!isLocalFileProvider(manifest.fileProvider) && rootValue !== undefined) {
    throw startupError("LOCAL_PATH_FORBIDDEN");
  }

  const capabilities = parseCapabilities(env.CLINIC_OS_INFERENCE_CAPABILITIES, manifest.inferenceProvider, legacy);
  let tesseractPath: string | undefined;
  let tessdataDir: string | undefined;
  const needsLocalOcr = manifest.inferenceProvider === "LOCAL_MODEL";
  if (needsLocalOcr) {
    tesseractPath = requiredAbsolutePath(env.WO021_TESSERACT_PATH, "TESSERACT_PATH_REQUIRED");
    tessdataDir = requiredAbsolutePath(env.WO021_TESSDATA_DIR, "TESSDATA_PATH_REQUIRED");
    // These validators intentionally retain their stable, non-secret DomainError codes.
    validateTesseractCheckedInManifestSync(MANIFEST_FILE);
    validateTesseractAssetPathChainSync({ executablePath: tesseractPath, tessdataDir });
  } else if (env.WO021_TESSERACT_PATH !== undefined || env.WO021_TESSDATA_DIR !== undefined) {
    throw startupError("OCR_CONFIGURATION_FORBIDDEN");
  }

  const privateInference = manifest.inferenceProvider === "PRIVATE_CLOUD_MODEL";
  if (privateInference && !manifest.externalInferenceAuthorized) {
    throw startupError("EXTERNAL_INFERENCE_NOT_AUTHORIZED");
  }
  const endpoint = privateInference ? validatePrivateEndpoint(env.CLINIC_OS_PRIVATE_INFERENCE_ENDPOINT) : undefined;
  const modelId = privateInference ? boundedToken(env.CLINIC_OS_PRIVATE_INFERENCE_MODEL_ID, "PRIVATE_INFERENCE_MODEL_REQUIRED") : undefined;
  const modelManifestSha256 = privateInference
    ? exactSha256(env.CLINIC_OS_PRIVATE_INFERENCE_MANIFEST_SHA256, "PRIVATE_INFERENCE_MANIFEST_REQUIRED")
    : undefined;
  if (!privateInference && [
    env.CLINIC_OS_PRIVATE_INFERENCE_ENDPOINT,
    env.CLINIC_OS_PRIVATE_INFERENCE_MODEL_ID,
    env.CLINIC_OS_PRIVATE_INFERENCE_MANIFEST_SHA256,
  ].some((value) => value !== undefined)) throw startupError("PRIVATE_INFERENCE_CONFIGURATION_FORBIDDEN");

  const port = parsePort(env.PORT);
  const snapshot = makeSnapshot(manifest, capabilities, {
    databaseConfigured: true,
    objectStoreConfigured: objectStoreRoot !== undefined || manifest.fileProvider === "CLOUD_OBJECT_STORE",
    ocrManifestConfigured: needsLocalOcr,
    inferenceCapabilityConfigured: capabilities.includes(CLINICAL_CAPABILITY),
  });
  const config = Object.freeze({ mode: "CONFIGURED" as const, manifest, snapshot, port });
  privateValues.set(config, Object.freeze({
    databaseUrl,
    objectStoreRoot,
    tesseractPath,
    tessdataDir,
    privateInferenceEndpoint: endpoint,
    privateInferenceModelId: modelId,
    privateInferenceManifestSha256: modelManifestSha256,
  }));
  return config;
}

export function getStartupPrivateValues(config: StartupConfig): Readonly<PrivateStartupValues> {
  const values = privateValues.get(config);
  if (!values) throw startupError("INVALID_STARTUP_CONFIG");
  return values;
}

function makeSynthetic(env: Record<string, string | undefined>): StartupConfig {
  const snapshotBase = {
    mode: "SYNTHETIC_PREVIEW" as const,
    profile: "SYNTHETIC_PREVIEW" as const,
    databaseProvider: null,
    fileProvider: null,
    inferenceProvider: null,
    backupProvider: null,
    manifestVersion: null,
    capabilities: Object.freeze([]) as readonly string[],
    databaseConfigured: false,
    objectStoreConfigured: false,
    ocrManifestConfigured: false,
    inferenceCapabilityConfigured: false,
  };
  const snapshot = Object.freeze({
    ...snapshotBase,
    configurationFingerprint: fingerprint(snapshotBase),
  });
  return Object.freeze({ mode: "SYNTHETIC_PREVIEW", manifest: null, snapshot, port: parsePort(env.PORT) });
}

function makeSnapshot(
  manifest: RuntimeManifest,
  capabilities: readonly string[],
  flags: Pick<StartupSnapshot, "databaseConfigured" | "objectStoreConfigured" | "ocrManifestConfigured" | "inferenceCapabilityConfigured">,
): Readonly<StartupSnapshot> {
  const base = {
    mode: "CONFIGURED" as const,
    profile: manifest.profile,
    databaseProvider: manifest.databaseProvider,
    fileProvider: manifest.fileProvider,
    inferenceProvider: manifest.inferenceProvider,
    backupProvider: manifest.backupProvider,
    manifestVersion: manifest.manifestVersion,
    capabilities: Object.freeze([...capabilities]),
    ...flags,
  };
  return Object.freeze({ ...base, configurationFingerprint: fingerprint(base) });
}

export const LOCAL_OCR_STARTUP_SPEC = Object.freeze({
  parserVersion: "tesseract-eng-parser-v1",
  modelId: TESSERACT_OCR_MODEL_ID,
  modelManifestSha256: TESSERACT_MODEL_MANIFEST_SHA256,
});

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeInput(input: Record<string, unknown>): Record<string, string | undefined> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw startupError("INVALID_CONFIGURATION_SHAPE");
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && typeof value !== "string") throw startupError("INVALID_CONFIGURATION_VALUE");
    result[key] = value as string | undefined;
  }
  return result;
}

function rejectUnknownConfigurationNames(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (ENV_NAMES.has(key)) continue;
    if (key.startsWith("CLINIC_OS_") || key.startsWith("WO021_") ||
      /(?:PROFILE|PROVIDER|OBJECT_STORE|INFERENCE|DATABASE|BACKUP)/i.test(key)) {
      throw startupError("UNKNOWN_CONFIGURATION_FIELD");
    }
  }
  const aliases = Object.keys(env).filter((key) => LEGACY_NAMES.has(key) && env[key] !== undefined);
  if (aliases.length > 0 && env.PREVIEW_MODE !== "postgres") throw startupError("LEGACY_CONFIGURATION_NAME");
  if (env.PREVIEW_PORT !== undefined) throw startupError("LEGACY_CONFIGURATION_NAME");
  if (aliases.length > 1) throw startupError("LEGACY_CONFIGURATION_NAME");
  if (aliases.length === 1 && env.CLINIC_OS_OBJECT_STORE_ROOT !== undefined) throw startupError("LEGACY_CONFIGURATION_NAME");
}

function legacyRoot(env: Record<string, string | undefined>): string | undefined {
  return env.PREVIEW_OBJECT_STORE_ROOT ?? env.LOCAL_OBJECT_STORE_ROOT ?? env.OBJECT_STORE_ROOT;
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw startupError(code);
  return value.trim();
}

function boundedToken(value: string | undefined, code: string): string {
  const result = required(value, code);
  if (result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw startupError(code);
  return result;
}

function exactBoolean(value: string | undefined, code: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value !== "true" && value !== "false") throw startupError(code);
  return value === "true";
}

function parseCapabilities(value: string | undefined, provider: RuntimeManifest["inferenceProvider"], legacy: boolean): string[] {
  if (provider === "DISABLED" && value === undefined) return [];
  const raw = required(value ?? (legacy ? CLINICAL_CAPABILITY : undefined), "INFERENCE_CAPABILITIES_REQUIRED");
  const values = raw.split(",").map((part) => part.trim());
  if (values.length === 0 || values.some((part) => part !== CLINICAL_CAPABILITY) || new Set(values).size !== values.length) {
    throw startupError("INFERENCE_CAPABILITIES_INVALID");
  }
  return values;
}

function validateDatabaseUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") || parsed.hostname === "" || parsed.hash || parsed.search) throw new Error();
  } catch {
    throw startupError("DATABASE_CONFIGURATION_INVALID");
  }
}

function requiredAbsolutePath(value: string | undefined, code: string): string {
  const result = required(value, code);
  if (!result.startsWith("/") || result.includes("\0") || result !== result.replace(/\/+/g, "/") || result === "/") throw startupError(`${code}:INVALID_ABSOLUTE_PATH`);
  const normalized = new URL(`file://${result}`).pathname;
  if (normalized !== result) throw startupError(`${code}:INVALID_ABSOLUTE_PATH`);
  return result;
}

function isLocalFileProvider(value: RuntimeManifest["fileProvider"]): boolean {
  return value === "LOCAL_OBJECT_STORE";
}

function validatePrivateEndpoint(value: string | undefined): string {
  const result = required(value, "PRIVATE_INFERENCE_ENDPOINT_REQUIRED");
  try {
    const parsed = new URL(result);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || result.length > 2048) throw new Error();
  } catch {
    throw startupError("PRIVATE_INFERENCE_ENDPOINT_INVALID");
  }
  return result;
}

function exactSha256(value: string | undefined, code: string): string {
  const result = required(value, code);
  if (!/^[a-f0-9]{64}$/.test(result)) throw startupError(code);
  return result;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3000;
  if (!/^\d{1,5}$/.test(value)) throw startupError("PORT_INVALID");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw startupError("PORT_INVALID");
  return port;
}

function startupError(code: string): DomainError {
  return new DomainError(code, `Startup configuration rejected: ${code}.`);
}
