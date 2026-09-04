import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordLocalOcrLanguageRelease } from "../src/runtime/local-ocr-language-release-record.ts";

const NOW = "2026-09-01T12:00:00.000Z";

test("records an explicitly confirmed exact ready evaluator aggregate without sensitive inputs", async (t) => {
  const root = await setup(t);
  const resultPath = join(root, "evaluation.json");
  const records = join(root, "records");
  await writeFile(resultPath, JSON.stringify(ready("chi_sim")), { mode: 0o600 });
  const result = recordLocalOcrLanguageRelease({ language: "chi_sim", evaluationResultPath: resultPath, confirmation: "APPROVE_LOCAL_OCR_LANGUAGE_RELEASE", recordDirectory: records }, () => NOW);
  assert.deepEqual(result, { status: "RECORDED", record: { language: "chi_sim", totalCases: 1, passedCases: 1, failedCases: 0, averageCerBasisPoints: 0, decision: "APPROVED", decidedAt: NOW } });
  const stored = await readFile(join(records, "chi_sim.json"), "utf8");
  assert.equal(stored.includes("reasonCodes"), false);
  assert.equal(stored.includes(resultPath), false);
  assert.equal(stored.includes("OCR text"), false);
});

test("refuses malformed, failed, mismatched and unconfirmed evaluator inputs before writing", async (t) => {
  const root = await setup(t); const records = join(root, "records"); const resultPath = join(root, "evaluation.json");
  for (const value of [
    { language: "eng", status: "READY" },
    { ...ready("eng"), status: "FAILED", reasonCodes: ["OCR_EVALUATION_FAILED"] },
    ready("jpn"),
    { ...ready("eng"), extra: true },
  ]) {
    await writeFile(resultPath, JSON.stringify(value), { mode: 0o600 });
    assert.deepEqual(recordLocalOcrLanguageRelease({ language: "eng", evaluationResultPath: resultPath, confirmation: "NO", recordDirectory: records }, () => NOW), { status: "REFUSED", code: "LOCAL_OCR_LANGUAGE_RELEASE_INPUT_REFUSED" });
    assert.deepEqual(recordLocalOcrLanguageRelease({ language: "eng", evaluationResultPath: resultPath, confirmation: "APPROVE_LOCAL_OCR_LANGUAGE_RELEASE", recordDirectory: records }, () => NOW), { status: "REFUSED", code: "LOCAL_OCR_LANGUAGE_RELEASE_INPUT_REFUSED" });
  }
  await assert.rejects(readFile(join(records, "eng.json")));
});

test("is exact-idempotent and refuses conflicting retry", async (t) => {
  const root = await setup(t); const records = join(root, "records"); const resultPath = join(root, "evaluation.json");
  await writeFile(resultPath, JSON.stringify(ready("eng")), { mode: 0o600 });
  const input = { language: "eng", evaluationResultPath: resultPath, confirmation: "APPROVE_LOCAL_OCR_LANGUAGE_RELEASE", recordDirectory: records };
  const first = recordLocalOcrLanguageRelease(input, () => NOW);
  const replay = recordLocalOcrLanguageRelease(input, () => "2026-09-01T12:01:00.000Z");
  assert.deepEqual(replay, first);
  assert.deepEqual(recordLocalOcrLanguageRelease({ ...input, confirmation: "REJECT_LOCAL_OCR_LANGUAGE_RELEASE" }, () => NOW), { status: "REFUSED", code: "LOCAL_OCR_LANGUAGE_RELEASE_CONFLICT" });
});

async function setup(t: test.TestContext): Promise<string> { const root = await mkdtemp(join(homedir(), "clinic-os-ocr-release-")); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function ready(language: "eng" | "chi_sim" | "jpn"): Record<string, unknown> { const totalCases = language === "eng" ? 2 : 1; return { language, status: "READY", totalCases, passedCases: totalCases, failedCases: 0, averageCerBasisPoints: 0, reasonCodes: [] }; }
