import assert from "node:assert/strict";
import test from "node:test";

import { runLocalModelPreflight } from "../src/runtime/local-model-preflight.ts";

const CONFIG = {
  CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT: "http://127.0.0.1:11434",
  CLINIC_OS_LOCAL_RECOMMENDATION_MODEL_ID: "approved-local-model",
};

test("local model preflight accepts only the synthetic guidance contract over loopback", async () => {
  let endpoint = "";
  let request: Record<string, unknown> | undefined;
  const result = await runLocalModelPreflight(CONFIG, async (input, init) => {
    endpoint = input;
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      model: "approved-local-model",
      done: true,
      response: JSON.stringify({
        schemaVersion: "clinic-os/manager-attention-guidance/v1",
        suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
        reasonCodes: ["MISSING_EXAM_REPORT"],
      }),
    }), { status: 200 });
  });

  assert.deepEqual(result, {
    status: "READY",
    schemaVersion: "clinic-os/manager-attention-guidance/v1",
    suggestionCode: "DOCUMENT_COMPLETENESS_REVIEW",
    reasonCodes: ["MISSING_EXAM_REPORT"],
  });
  assert.equal(endpoint, "http://127.0.0.1:11434/api/generate");
  const audit = JSON.stringify(request);
  assert.equal(audit.includes("preflight-workflow"), false);
  assert.equal(audit.includes("preflight-clinic"), false);
  assert.equal(audit.includes("patient"), false);
  assert.deepEqual(JSON.parse(String(request?.prompt)), {
    schemaVersion: "clinic-os/manager-attention-recommendation/v1",
    capability: "MANAGER_ATTENTION_GUIDANCE",
    input: {
      schemaVersion: "clinic-os/manager-attention-recommendation/v1",
      stage: "STRUCTURED_ALIGNMENT",
      alignmentStatus: "MISSING",
      reasonCodes: ["MISSING_EXAM_REPORT"],
    },
  });
});

test("local model preflight has one bounded unavailable result for absent, malformed, unavailable and foreign-model settings", async () => {
  const unavailable = { status: "UNAVAILABLE", code: "LOCAL_MODEL_PREFLIGHT_UNAVAILABLE" };
  assert.deepEqual(await runLocalModelPreflight({}), unavailable);
  assert.deepEqual(await runLocalModelPreflight({ ...CONFIG, CLINIC_OS_LOCAL_RECOMMENDATION_ENDPOINT: "https://example.com" }), unavailable);
  assert.deepEqual(await runLocalModelPreflight(CONFIG, async () => { throw new Error("offline"); }), unavailable);
  assert.deepEqual(await runLocalModelPreflight(CONFIG, async () => new Response(JSON.stringify({
    model: "other-model", done: true, response: "{}",
  }), { status: 200 })), unavailable);
});
