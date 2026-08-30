import type { StartupConfig, StartupSnapshot } from "./startup-config.ts";

export type ReadinessCheckStatus = "ok" | "not_ready";
export interface ReadinessCheck {
  readonly name: string;
  readonly status: ReadinessCheckStatus;
  readonly code?: string;
}

export interface ReadinessProjection {
  readonly status: "ready" | "not_ready";
  readonly profile: StartupSnapshot["profile"];
  readonly checks: readonly ReadinessCheck[];
}

export interface ReadinessProbes {
  database?: () => Promise<boolean>;
  objectStore?: () => Promise<boolean>;
  ocrManifest?: () => Promise<boolean>;
  inferenceCapability?: () => Promise<boolean>;
}

/**
 * Bounded, detached readiness evaluator. It has no domain repository access and
 * never returns dependency exceptions, URLs, paths, credentials or provider output.
 */
export class StartupReadiness {
  readonly #config: StartupConfig;
  readonly #probes: ReadinessProbes;

  constructor(config: StartupConfig, probes: ReadinessProbes = {}) {
    if (!config || typeof config !== "object") throw new Error("INVALID_STARTUP_CONFIG");
    this.#config = config;
    this.#probes = Object.freeze({ ...probes });
  }

  async evaluate(): Promise<ReadinessProjection> {
    const snapshot = this.#config.snapshot;
    if (this.#config.mode === "SYNTHETIC_PREVIEW") {
      return detach({
        status: "not_ready",
        profile: "SYNTHETIC_PREVIEW",
        checks: [{ name: "clinical_runtime", status: "not_ready", code: "SYNTHETIC_PREVIEW" }],
      });
    }

    if (snapshot.profile === "CLOUD") {
      return detach({
        status: "not_ready",
        profile: snapshot.profile,
        checks: [{ name: "cloud_provider", status: "not_ready", code: "CLOUD_PROVIDER_UNAVAILABLE" }],
      });
    }

    const checks: ReadinessCheck[] = [];
    checks.push(await check("database", snapshot.databaseConfigured, this.#probes.database, "DATABASE_UNAVAILABLE"));
    checks.push(await check("object_store", snapshot.objectStoreConfigured, this.#probes.objectStore, "OBJECT_STORE_UNAVAILABLE"));
    if (snapshot.profile === "ON_PREM_STRICT" || snapshot.inferenceProvider === "LOCAL_MODEL") {
      checks.push(await check("ocr_manifest", snapshot.ocrManifestConfigured, this.#probes.ocrManifest, "OCR_MANIFEST_UNAVAILABLE"));
    }
    if (snapshot.inferenceProvider === "DISABLED") {
      checks.push({ name: "inference_capability", status: "not_ready", code: "INFERENCE_UNAVAILABLE" });
    } else {
      checks.push(await check("inference_capability", snapshot.inferenceCapabilityConfigured, this.#probes.inferenceCapability, "INFERENCE_CAPABILITY_UNAVAILABLE"));
    }
    const ready = checks.every((item) => item.status === "ok");
    return detach({ status: ready ? "ready" : "not_ready", profile: snapshot.profile, checks });
  }
}

async function check(
  name: string,
  configured: boolean,
  probe: (() => Promise<boolean>) | undefined,
  code: string,
): Promise<ReadinessCheck> {
  if (!configured) return { name, status: "not_ready", code };
  if (!probe) return { name, status: "not_ready", code };
  try {
    const result = await Promise.race([
      probe(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    return result === true ? { name, status: "ok" } : { name, status: "not_ready", code };
  } catch {
    return { name, status: "not_ready", code };
  }
}

function detach(value: ReadinessProjection): ReadinessProjection {
  return Object.freeze({
    status: value.status,
    profile: value.profile,
    checks: Object.freeze(value.checks.map((check) => Object.freeze({ ...check }))),
  });
}
