import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLocalPreviewReadiness } from "../src/preview/local-preview-readiness.ts";
import { StartupReadiness } from "../src/runtime/readiness.ts";

function readiness(database: boolean, ocr: boolean): StartupReadiness {
  return {
    evaluate: async () => ({
      status: database && ocr ? "ready" : "not_ready", profile: "ON_PREM_STRICT",
      checks: [
        { name: "database", status: database ? "ok" : "not_ready", ...(database ? {} : { code: "DATABASE_UNAVAILABLE" }) },
        { name: "ocr_manifest", status: ocr ? "ok" : "not_ready", ...(ocr ? {} : { code: "OCR_MANIFEST_UNAVAILABLE" }) },
      ],
    }),
  } as unknown as StartupReadiness;
}

test("local readiness is bounded, detached and links only to existing workspaces", async () => {
  const result = await evaluateLocalPreviewReadiness({
    readiness: readiness(true, true),
    modelPreflight: async () => ({ status: "READY", schemaVersion: "clinic-os/manager-attention-guidance/v1", suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW", reasonCodes: [] }),
    optionalOcrLanguageAssets: () => ({ chiSim: true, jpn: true }),
    optionalOcrLanguageReleases: () => ({ chiSim: true, jpn: false }),
    externalModelVolume: () => true,
    demoWorkspacePrepared: true,
  });
  assert.deepEqual(result, {
    status: "READY",
    checks: [
      { name: "DATABASE_SCHEMA", status: "READY" }, { name: "OCR_ASSETS", status: "READY" },
      { name: "OCR_CHI_SIM_ASSET", status: "AVAILABLE" }, { name: "OCR_JPN_ASSET", status: "AVAILABLE" },
      { name: "OCR_CHI_SIM_RELEASE", status: "AVAILABLE" }, { name: "OCR_JPN_RELEASE", status: "UNAVAILABLE" },
      { name: "EXTERNAL_MODEL_VOLUME", status: "AVAILABLE" },
      { name: "LOCAL_MODEL", status: "READY" }, { name: "DEMO_WORKSPACE", status: "READY" },
    ], links: { employee: "/employee", manager: "/manager" },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|postgres|tesseract|schemaVersion/i);
});

test("local readiness degrades safely and optional model never blocks it", async () => {
  const result = await evaluateLocalPreviewReadiness({
    readiness: readiness(false, false),
    modelPreflight: async () => new Promise(() => undefined), demoWorkspacePrepared: false,
  });
  assert.deepEqual(result, {
    status: "DEGRADED",
    checks: [
      { name: "DATABASE_SCHEMA", status: "UNAVAILABLE" }, { name: "OCR_ASSETS", status: "UNAVAILABLE" },
      { name: "OCR_CHI_SIM_ASSET", status: "UNAVAILABLE" }, { name: "OCR_JPN_ASSET", status: "UNAVAILABLE" },
      { name: "OCR_CHI_SIM_RELEASE", status: "UNAVAILABLE" }, { name: "OCR_JPN_RELEASE", status: "UNAVAILABLE" },
      { name: "EXTERNAL_MODEL_VOLUME", status: "UNAVAILABLE" },
      { name: "LOCAL_MODEL", status: "UNAVAILABLE" }, { name: "DEMO_WORKSPACE", status: "NOT_PREPARED" },
    ], links: { employee: "/employee", manager: "/manager" },
  });
});

test("optional language assets are visible but never change English preview readiness", async () => {
  const result = await evaluateLocalPreviewReadiness({
    readiness: readiness(true, true),
    optionalOcrLanguageAssets: () => ({ chiSim: true, jpn: false }),
  });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.checks.slice(2, 4), [
    { name: "OCR_CHI_SIM_ASSET", status: "AVAILABLE" },
    { name: "OCR_JPN_ASSET", status: "UNAVAILABLE" },
  ]);
  assert.deepEqual(result.checks.slice(4, 6), [
    { name: "OCR_CHI_SIM_RELEASE", status: "UNAVAILABLE" },
    { name: "OCR_JPN_RELEASE", status: "UNAVAILABLE" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /chi_sim\.traineddata|jpn\.traineddata|owner|hash/i);
});

test("external model volume remains bounded and unavailable on a failed probe", async () => {
  const result = await evaluateLocalPreviewReadiness({
    readiness: readiness(true, true),
    externalModelVolume: () => { throw new Error("/Volumes/private-model-disk"); },
  });
  assert.deepEqual(result.checks[6], { name: "EXTERNAL_MODEL_VOLUME", status: "UNAVAILABLE" });
  assert.doesNotMatch(JSON.stringify(result), /private-model|\/Volumes\/|owner|disk UUID/i);
});
