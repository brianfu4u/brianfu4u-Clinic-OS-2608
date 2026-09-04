import assert from "node:assert/strict";
import test from "node:test";

import { runExternalVolumeLocalModelTrial } from "../src/runtime/external-volume-local-model-trial.ts";

const CONFIG = Object.freeze({
  CLINIC_OS_EXTERNAL_MODEL_VOLUME_ROOT: "/Volumes/ClinicModels",
  CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT: "http://127.0.0.1:11434",
  CLINIC_OS_LOCAL_RECOMMENDATION_MODEL_ID: "approved-local-model",
  LOCAL_MODEL_TRIAL_APPROVED_MODEL_ID: "approved-local-model",
});
const READY = Object.freeze({
  status: "READY" as const,
  schemaVersion: "clinic-os/manager-attention-guidance/v1" as const,
  suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW" as const,
  reasonCodes: Object.freeze(["MISSING_EXAM_REPORT"]),
});
const UNAVAILABLE = Object.freeze({ status: "UNAVAILABLE" as const, code: "LOCAL_MODEL_TRIAL_UNAVAILABLE" as const });

test("external-volume trial refuses an unsafe volume before preflight transport", async () => {
  let calls = 0;
  const result = await runExternalVolumeLocalModelTrial(CONFIG, undefined, {
    inspectVolume: () => false,
    preflight: async () => { calls += 1; return READY; },
  });
  assert.deepEqual(result, UNAVAILABLE);
  assert.equal(calls, 0);
});

test("external-volume trial requires exact approved canonical loopback model configuration", async () => {
  let calls = 0;
  const preflight = async () => { calls += 1; return READY; };
  const deps = { inspectVolume: () => true, preflight };
  assert.deepEqual(await runExternalVolumeLocalModelTrial({}, undefined, deps), UNAVAILABLE);
  assert.deepEqual(await runExternalVolumeLocalModelTrial({ ...CONFIG, LOCAL_MODEL_TRIAL_APPROVED_MODEL_ID: "other" }, undefined, deps), UNAVAILABLE);
  assert.deepEqual(await runExternalVolumeLocalModelTrial({ ...CONFIG, CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT: "https://example.com" }, undefined, deps), UNAVAILABLE);
  assert.equal(calls, 0);
});

test("external-volume trial returns only the existing bounded preflight contract", async () => {
  let received: Record<string, unknown> | undefined;
  const result = await runExternalVolumeLocalModelTrial(CONFIG, undefined, {
    inspectVolume: () => true,
    preflight: async (values) => { received = values; return READY; },
  });
  assert.deepEqual(result, READY);
  assert.equal(received, CONFIG);
  assert.equal(JSON.stringify(result).includes("ClinicModels"), false);
  assert.equal(JSON.stringify(result).includes("approved-local-model"), false);
});
