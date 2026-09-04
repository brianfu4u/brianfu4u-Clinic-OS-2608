import type { LocalModelPreflightResult } from "../runtime/local-model-preflight.ts";
import type { ReadinessProjection, StartupReadiness } from "../runtime/readiness.ts";

export type LocalPreviewReadiness = Readonly<{
  status: "READY" | "DEGRADED";
  checks: readonly Readonly<{
    name: "DATABASE_SCHEMA" | "OCR_ASSETS" | "OCR_CHI_SIM_ASSET" | "OCR_JPN_ASSET" | "OCR_CHI_SIM_RELEASE" | "OCR_JPN_RELEASE" | "EXTERNAL_MODEL_VOLUME" | "LOCAL_MODEL" | "DEMO_WORKSPACE";
    status: "READY" | "AVAILABLE" | "UNAVAILABLE" | "NOT_CONFIGURED" | "NOT_PREPARED";
  }>[];
  links: Readonly<{ employee: "/employee"; manager: "/manager" }>;
}>;

type ModelPreflight = () => Promise<LocalModelPreflightResult>;
type OptionalOcrLanguageAssets = () => Readonly<{ chiSim: boolean; jpn: boolean }> | Promise<Readonly<{ chiSim: boolean; jpn: boolean }>>;
type OptionalOcrLanguageReleases = () => Readonly<{ chiSim: boolean; jpn: boolean }> | Promise<Readonly<{ chiSim: boolean; jpn: boolean }>>;

/**
 * Bounded local-operator projection.  It deliberately has no write, process,
 * storage, or domain dependency; callers supply existing read-only seams.
 */
export async function evaluateLocalPreviewReadiness(input: {
  readiness?: StartupReadiness;
  modelPreflight?: ModelPreflight;
  optionalOcrLanguageAssets?: OptionalOcrLanguageAssets;
  optionalOcrLanguageReleases?: OptionalOcrLanguageReleases;
  externalModelVolume?: () => boolean | Promise<boolean>;
  demoWorkspacePrepared?: boolean;
}): Promise<LocalPreviewReadiness> {
  const runtime = input.readiness ? await input.readiness.evaluate() : undefined;
  const databaseReady = runtimeCheck(runtime, "database");
  const ocrReady = runtimeCheck(runtime, "ocr_manifest");
  const languages = await optionalOcrLanguages(input.optionalOcrLanguageAssets);
  const releases = await optionalOcrLanguages(input.optionalOcrLanguageReleases);
  const externalModelVolume = await optionalExternalModelVolume(input.externalModelVolume);
  const model = await optionalModel(input.modelPreflight);
  const demo = input.demoWorkspacePrepared === true ? "READY" : "NOT_PREPARED";
  const checks = Object.freeze([
    Object.freeze({ name: "DATABASE_SCHEMA" as const, status: databaseReady ? "READY" as const : "UNAVAILABLE" as const }),
    Object.freeze({ name: "OCR_ASSETS" as const, status: ocrReady ? "READY" as const : "UNAVAILABLE" as const }),
    Object.freeze({ name: "OCR_CHI_SIM_ASSET" as const, status: languages.chiSim ? "AVAILABLE" as const : "UNAVAILABLE" as const }),
    Object.freeze({ name: "OCR_JPN_ASSET" as const, status: languages.jpn ? "AVAILABLE" as const : "UNAVAILABLE" as const }),
    Object.freeze({ name: "OCR_CHI_SIM_RELEASE" as const, status: releases.chiSim ? "AVAILABLE" as const : "UNAVAILABLE" as const }),
    Object.freeze({ name: "OCR_JPN_RELEASE" as const, status: releases.jpn ? "AVAILABLE" as const : "UNAVAILABLE" as const }),
    Object.freeze({ name: "EXTERNAL_MODEL_VOLUME" as const, status: externalModelVolume ? "AVAILABLE" as const : "UNAVAILABLE" as const }),
    Object.freeze({ name: "LOCAL_MODEL" as const, status: model }),
    Object.freeze({ name: "DEMO_WORKSPACE" as const, status: demo }),
  ]);
  return Object.freeze({
    status: databaseReady && ocrReady ? "READY" : "DEGRADED",
    checks,
    links: Object.freeze({ employee: "/employee", manager: "/manager" }),
  });
}

async function optionalExternalModelVolume(inspect: (() => boolean | Promise<boolean>) | undefined): Promise<boolean> {
  if (!inspect) return false;
  try { return await inspect() === true; } catch { return false; }
}

async function optionalOcrLanguages(inspect: OptionalOcrLanguageAssets | undefined): Promise<Readonly<{ chiSim: boolean; jpn: boolean }>> {
  if (!inspect) return { chiSim: false, jpn: false };
  try {
    const result = await inspect();
    return result?.chiSim === true && result?.jpn === true
      ? { chiSim: true, jpn: true }
      : { chiSim: result?.chiSim === true, jpn: result?.jpn === true };
  } catch {
    return { chiSim: false, jpn: false };
  }
}

function runtimeCheck(runtime: ReadinessProjection | undefined, name: string): boolean {
  return runtime?.checks.some((check) => check.name === name && check.status === "ok") === true;
}

async function optionalModel(preflight: ModelPreflight | undefined): Promise<"READY" | "UNAVAILABLE" | "NOT_CONFIGURED"> {
  if (!preflight) return "NOT_CONFIGURED";
  try {
    const result = await Promise.race([
      preflight(),
      new Promise<LocalModelPreflightResult>((resolve) => setTimeout(() => resolve({ status: "UNAVAILABLE", code: "LOCAL_MODEL_PREFLIGHT_UNAVAILABLE" }), 500)),
    ]);
    return result.status === "READY" ? "READY" : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}
