import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { DomainError } from "../domain/errors.ts";
import {
  TESSERACT_MODEL_MANIFEST_SHA256,
  TESSERACT_MODEL_MANIFEST_FILE,
  type TesseractLanguage,
  TESSERACT_OCR_MODEL_ID,
  inspectOptionalTesseractLanguageAssetsSync,
  validateTesseractAssetPathChainSync,
  validateTesseractCheckedInManifestSync,
} from "./tesseract-ocr-provider.ts";
import type { RuntimeManifest } from "./contracts.ts";
import { validateRuntimeManifest } from "./manifest-validator.ts";
import { createNodePgPool, type NodePgPool } from "../persistence/node-pg-pool.ts";
import { isRepositorySchemaCompatible } from "../persistence/migration-runner.ts";
import { InferenceGateway } from "./inference-gateway.ts";
import { TesseractOcrProvider } from "./tesseract-ocr-provider.ts";
import { OllamaLocalRecommendationProvider, validateOllamaLoopbackEndpoint } from "./ollama-local-recommendation-provider.ts";
import { LocalManagerRecommendationService } from "../application/local-manager-recommendation.ts";
import { LocalObjectStore } from "../storage/local-object-store.ts";
import { ObjectStoreGateway } from "../storage/object-store-gateway.ts";
import { inspectExternalModelVolumeRootSync } from "./external-model-volume.ts";

export const CLINICAL_CAPABILITY = "EXTRACT_EYE_EXAM_REPORT" as const;
const MANIFEST_FILE = fileURLToPath(new URL(`../../models/${TESSERACT_MODEL_MANIFEST_FILE}`, import.meta.url));

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
  localRecommendationEndpoint?: string;
  localRecommendationModelId?: string;
  externalModelVolumeRoot?: string;
  ocrLanguage?: TesseractLanguage;
}

const privateValues = new WeakMap<object, PrivateStartupValues>();

const ENV_NAMES = new Set([
  "CLINIC_OS_PROFILE", "DATABASE_URL", "CLINIC_OS_DATABASE_PROVIDER", "CLINIC_OS_FILE_PROVIDER",
  "CLINIC_OS_INFERENCE_PROVIDER", "CLINIC_OS_BACKUP_PROVIDER", "CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED",
  "CLINIC_OS_MANIFEST_VERSION", "CLINIC_OS_OBJECT_STORE_ROOT", "WO021_TESSERACT_PATH",
  "WO021_TESSDATA_DIR", "CLINIC_OS_PRIVATE_INFERENCE_ENDPOINT", "CLINIC_OS_PRIVATE_INFERENCE_MODEL_ID",
  "CLINIC_OS_PRIVATE_INFERENCE_MANIFEST_SHA256", "CLINIC_OS_INFERENCE_CAPABILITIES", "PORT",
  "CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT", "CLINIC_OS_LOCAL_RECOMMENDATION_MODEL_ID",
  "CLINIC_OS_EXTERNAL_MODEL_VOLUME_ROOT",
  "CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP",
  "CLINIC_OS_OCR_LANGUAGE",
  "CLINIC_OS_PREVIEW_WORKSPACE", "CLINIC_OS_LAN_DEMO", "CLINIC_OS_LAN_ADDRESS", "PREVIEW_HOST",
  "PREVIEW_MODE", "PREVIEW_OBJECT_STORE_ROOT", "LOCAL_OBJECT_STORE_ROOT", "OBJECT_STORE_ROOT",
]);
const LEGACY_NAMES = new Set(["PREVIEW_OBJECT_STORE_ROOT", "LOCAL_OBJECT_STORE_ROOT", "OBJECT_STORE_ROOT", "PREVIEW_PORT"]);

/** Opaque, server-ready local adapters. No raw startup secret is returned. */
export interface ConfiguredLocalRuntime {
  readonly pool: NodePgPool;
  readonly objects: ObjectStoreGateway;
  readonly inference: InferenceGateway;
  /** Optional, separately configured, read-only local-model guidance adapter. */
  readonly localRecommendations: LocalManagerRecommendationService | null;
  readonly readinessProbes: Readonly<{
    database: () => Promise<boolean>;
    objectStore: () => Promise<boolean>;
    ocrManifest: () => Promise<boolean>;
    inferenceCapability: () => Promise<boolean>;
  }>;
  /** Bounded optional-asset observation for the local preview only. */
  readonly optionalOcrLanguageAssets: () => Readonly<{ chiSim: boolean; jpn: boolean }>;
  /** Read-only external-volume observation for the local preview only. */
  readonly externalModelVolume: () => boolean;
}

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
  if (previewMode !== undefined) {
    if (previewMode === "postgres") throw startupError("LEGACY_CONFIGURATION_NAME");
    throw startupError("INVALID_PREVIEW_MODE");
  }
  const profile = required(env.CLINIC_OS_PROFILE, "PROFILE_REQUIRED");
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL_REQUIRED");
  validateDatabaseUrl(databaseUrl);
  const databaseProvider = required(env.CLINIC_OS_DATABASE_PROVIDER, "DATABASE_PROVIDER_REQUIRED");
  const fileProvider = required(env.CLINIC_OS_FILE_PROVIDER, "FILE_PROVIDER_REQUIRED");
  const inferenceProvider = required(env.CLINIC_OS_INFERENCE_PROVIDER, "INFERENCE_PROVIDER_REQUIRED");
  const backupProvider = required(env.CLINIC_OS_BACKUP_PROVIDER, "BACKUP_PROVIDER_REQUIRED");
  const externalInferenceAuthorized = exactBoolean(
    env.CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED,
    "EXTERNAL_INFERENCE_AUTHORIZATION_REQUIRED",
    undefined,
  );
  const manifestVersion = boundedToken(
    env.CLINIC_OS_MANIFEST_VERSION,
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
  const rootValue = env.CLINIC_OS_OBJECT_STORE_ROOT;
  const objectStoreRoot = isLocalFileProvider(manifest.fileProvider)
    ? requiredAbsolutePath(rootValue, "OBJECT_STORE_ROOT_REQUIRED")
    : undefined;
  if (!isLocalFileProvider(manifest.fileProvider) && rootValue !== undefined) {
    throw startupError("LOCAL_PATH_FORBIDDEN");
  }

  const capabilities = parseCapabilities(env.CLINIC_OS_INFERENCE_CAPABILITIES, manifest.inferenceProvider);
  let tesseractPath: string | undefined;
  let tessdataDir: string | undefined;
  let ocrLanguage: TesseractLanguage | undefined;
  const needsLocalOcr = manifest.inferenceProvider === "LOCAL_MODEL";
  if (needsLocalOcr) {
    tesseractPath = requiredAbsolutePath(env.WO021_TESSERACT_PATH, "TESSERACT_PATH_REQUIRED");
    tessdataDir = requiredAbsolutePath(env.WO021_TESSDATA_DIR, "TESSDATA_PATH_REQUIRED");
    // These validators intentionally retain their stable, non-secret DomainError codes.
    validateTesseractCheckedInManifestSync(MANIFEST_FILE);
    validateTesseractAssetPathChainSync({ executablePath: tesseractPath, tessdataDir });
    ocrLanguage = localOcrLanguage(env.CLINIC_OS_OCR_LANGUAGE);
    const optional = inspectOptionalTesseractLanguageAssetsSync(tessdataDir);
    if ((ocrLanguage === "chi_sim+eng" && !optional.chiSim) || (ocrLanguage === "jpn+eng" && !optional.jpn)) {
      throw startupError("OCR_LANGUAGE_ASSET_REQUIRED");
    }
  } else if (env.WO021_TESSERACT_PATH !== undefined || env.WO021_TESSDATA_DIR !== undefined) {
    throw startupError("OCR_CONFIGURATION_FORBIDDEN");
  }
  if (!needsLocalOcr && env.CLINIC_OS_OCR_LANGUAGE !== undefined) {
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

  const recommendationValuesPresent = [
    env.CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT,
    env.CLINIC_OS_LOCAL_RECOMMENDATION_MODEL_ID,
  ].some((value) => value !== undefined);
  if (recommendationValuesPresent && manifest.inferenceProvider !== "LOCAL_MODEL") {
    throw startupError("LOCAL_RECOMMENDATION_CONFIGURATION_FORBIDDEN");
  }
  const localRecommendationEndpoint = recommendationValuesPresent
    ? validateLocalRecommendationEndpoint(env.CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT)
    : undefined;
  const localRecommendationModelId = recommendationValuesPresent
    ? boundedToken(env.CLINIC_OS_LOCAL_RECOMMENDATION_MODEL_ID, "LOCAL_RECOMMENDATION_MODEL_REQUIRED")
    : undefined;
  if (env.CLINIC_OS_EXTERNAL_MODEL_VOLUME_ROOT !== undefined && manifest.inferenceProvider !== "LOCAL_MODEL") {
    throw startupError("EXTERNAL_MODEL_VOLUME_CONFIGURATION_FORBIDDEN");
  }
  const externalModelVolumeRoot = env.CLINIC_OS_EXTERNAL_MODEL_VOLUME_ROOT === undefined
    ? undefined
    : requiredMountedVolumeRoot(env.CLINIC_OS_EXTERNAL_MODEL_VOLUME_ROOT);

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
    localRecommendationEndpoint,
    localRecommendationModelId,
    externalModelVolumeRoot,
    ocrLanguage,
  }));
  return config;
}

/**
 * Builds only the supported local runtime assembly. Values stay in this module's
 * private WeakMap; callers receive usable adapters, never URLs, paths or endpoints.
 */
export function createConfiguredLocalRuntime(config: StartupConfig): ConfiguredLocalRuntime | null {
  const values = privateValues.get(config);
  if (!values || config.mode !== "CONFIGURED" || !config.manifest) throw startupError("INVALID_STARTUP_CONFIG");
  const manifest = config.manifest;
  if (manifest.profile === "CLOUD" || manifest.inferenceProvider !== "LOCAL_MODEL") return null;
  if (!values.databaseUrl || !values.objectStoreRoot || !values.tesseractPath || !values.tessdataDir) {
    throw startupError("INVALID_STARTUP_CONFIG");
  }
  const pool = createNodePgPool(values.databaseUrl);
  const objects = new ObjectStoreGateway(manifest, new LocalObjectStore(values.objectStoreRoot));
  const inference = new InferenceGateway(manifest, new TesseractOcrProvider({
    executablePath: values.tesseractPath,
    tessdataDir: values.tessdataDir,
    language: values.ocrLanguage,
  }));
  const localRecommendations = values.localRecommendationEndpoint && values.localRecommendationModelId
    ? new LocalManagerRecommendationService(new InferenceGateway(manifest, new OllamaLocalRecommendationProvider({
        endpoint: values.localRecommendationEndpoint,
        modelId: values.localRecommendationModelId,
      })))
    : null;
  return Object.freeze({
    pool,
    objects,
    inference,
    localRecommendations,
    readinessProbes: Object.freeze({
      database: async () => {
        const connection = await pool.connect();
        try { return await isRepositorySchemaCompatible(connection); } finally { connection.release(); }
      },
      objectStore: async () => {
        const { access } = await import("node:fs/promises");
        await access(values.objectStoreRoot!);
        return true;
      },
      ocrManifest: async () => {
        validateTesseractCheckedInManifestSync(MANIFEST_FILE);
        validateTesseractAssetPathChainSync({ executablePath: values.tesseractPath!, tessdataDir: values.tessdataDir! });
        return true;
      },
      inferenceCapability: async () => true,
    }),
    optionalOcrLanguageAssets: () => inspectOptionalTesseractLanguageAssetsSync(values.tessdataDir!),
    externalModelVolume: () => inspectExternalModelVolumeRootSync(values.externalModelVolumeRoot),
  });
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
  if (aliases.length > 0) throw startupError("LEGACY_CONFIGURATION_NAME");
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

function parseCapabilities(value: string | undefined, provider: RuntimeManifest["inferenceProvider"]): string[] {
  if (provider === "DISABLED" && value === undefined) return [];
  const raw = required(value, "INFERENCE_CAPABILITIES_REQUIRED");
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

function requiredMountedVolumeRoot(value: string | undefined): string {
  const result = required(value, "EXTERNAL_MODEL_VOLUME_ROOT_REQUIRED");
  if (!/^\/Volumes\/[^/\0]+$/.test(result) || new URL(`file://${result}`).pathname !== result) {
    throw startupError("EXTERNAL_MODEL_VOLUME_ROOT_INVALID");
  }
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

function validateLocalRecommendationEndpoint(value: string | undefined): string {
  const endpoint = required(value, "LOCAL_RECOMMENDATION_ENDPOINT_REQUIRED");
  try {
    return validateOllamaLoopbackEndpoint(endpoint);
  } catch {
    throw startupError("LOCAL_RECOMMENDATION_ENDPOINT_INVALID");
  }
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

function localOcrLanguage(value: string | undefined): TesseractLanguage {
  if (value === undefined) return "eng";
  if (value === "chi_sim+eng" || value === "jpn+eng" || value === "eng") return value;
  throw startupError("OCR_LANGUAGE_INVALID");
}

function startupError(code: string): DomainError {
  return new DomainError(code, `Startup configuration rejected: ${code}.`);
}
