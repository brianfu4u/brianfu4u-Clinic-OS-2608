import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLocalOcrEvaluation } from "../src/runtime/local-ocr-evaluation.ts";

const CONFIG = { executablePath: "/usr/bin/tesseract", tessdataDir: "/usr/share/tesseract-ocr/5/tessdata" };

test("local OCR evaluation returns only aggregate success for the exact checked-in synthetic corpus", { timeout: 120_000 }, async (t) => {
  const corpus = await mkdtemp(join(homedir(), "clinic-os-ocr-evaluation-"));
  t.after(() => rm(corpus, { recursive: true, force: true }));
  await chmod(corpus, 0o700);
  await writeFixtures(corpus);

  const result = await runLocalOcrEvaluation(corpus, CONFIG);
  assert.deepEqual(result, {
    language: "eng",
    status: "READY",
    totalCases: 2,
    passedCases: 2,
    failedCases: 0,
    averageCerBasisPoints: 0,
    reasonCodes: [],
  });
  const audit = JSON.stringify(result);
  assert.equal(audit.includes("EYE EXAM REPORT"), false);
  assert.equal(audit.includes("tesseract-eye-exam"), false);
  assert.equal(audit.includes(corpus), false);
});

test("local OCR evaluation refuses unsafe, incomplete, symlinked and unknown corpora before OCR", async (t) => {
  const root = await mkdtemp(join(homedir(), "clinic-os-ocr-evaluation-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const refused = { language: "eng", status: "REFUSED", code: "LOCAL_OCR_EVALUATION_CORPUS_REFUSED" };
  assert.deepEqual(await runLocalOcrEvaluation(root, CONFIG), refused);

  await writeFixtures(root);
  await writeFile(join(root, "unknown.png"), "unexpected");
  assert.deepEqual(await runLocalOcrEvaluation(root, CONFIG), refused);
  await rm(join(root, "unknown.png"));

  await rm(join(root, "tesseract-eye-exam.png"));
  await symlink(join(root, "tesseract-fundus-exam.png"), join(root, "tesseract-eye-exam.png"));
  assert.deepEqual(await runLocalOcrEvaluation(root, CONFIG), refused);
  await rm(join(root, "tesseract-eye-exam.png"));
  await writeFixtures(root, true);
  await chmod(root, 0o777);
  assert.deepEqual(await runLocalOcrEvaluation(root, CONFIG), refused);
});

test("local OCR evaluation exposes one bounded failed result when pinned OCR assets are unavailable", async (t) => {
  const corpus = await mkdtemp(join(homedir(), "clinic-os-ocr-evaluation-unavailable-"));
  t.after(() => rm(corpus, { recursive: true, force: true }));
  await chmod(corpus, 0o700);
  await writeFixtures(corpus);
  assert.deepEqual(await runLocalOcrEvaluation(corpus, { ...CONFIG, executablePath: "/not-an-ocr-engine" }), {
    language: "eng",
    status: "FAILED",
    totalCases: 2,
    passedCases: 0,
    failedCases: 2,
    averageCerBasisPoints: 0,
    reasonCodes: ["OCR_EVALUATION_FAILED"],
  });
});

test("language-specific evaluation chooses only its pinned synthetic corpus and refuses unavailable optional assets before OCR", async (t) => {
  const root = await mkdtemp(join(homedir(), "clinic-os-ocr-language-evaluation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const corpus = join(root, "corpus");
  const tessdata = join(root, "tessdata");
  await mkdir(corpus);
  await mkdir(tessdata);
  await chmod(corpus, 0o700);
  await chmod(tessdata, 0o700);
  await writeLanguageFixture(corpus, "chi_sim");

  const unavailable = await runLocalOcrEvaluation(corpus, { executablePath: "/missing/tesseract", tessdataDir: tessdata }, "chi_sim");
  assert.deepEqual(unavailable, { language: "chi_sim", status: "REFUSED", code: "LOCAL_OCR_EVALUATION_LANGUAGE_UNAVAILABLE" });
  assert.equal(JSON.stringify(unavailable).includes(corpus), false);

  await writeFile(join(tessdata, "chi_sim.traineddata"), "synthetic", { mode: 0o600 });
  assert.deepEqual(await runLocalOcrEvaluation(corpus, { executablePath: "/missing/tesseract", tessdataDir: tessdata }, "chi_sim"), {
    language: "chi_sim",
    status: "FAILED", totalCases: 1, passedCases: 0, failedCases: 1, averageCerBasisPoints: 0,
    reasonCodes: ["OCR_EVALUATION_FAILED"],
  });

  await rm(join(corpus, "tesseract-chi-sim-synthetic.png"));
  await writeLanguageFixture(corpus, "jpn");
  assert.deepEqual(await runLocalOcrEvaluation(corpus, { executablePath: "/missing/tesseract", tessdataDir: tessdata }, "jpn"), {
    language: "jpn", status: "REFUSED", code: "LOCAL_OCR_EVALUATION_LANGUAGE_UNAVAILABLE",
  });
  await writeFile(join(tessdata, "jpn.traineddata"), "synthetic", { mode: 0o600 });
  assert.deepEqual(await runLocalOcrEvaluation(corpus, { executablePath: "/missing/tesseract", tessdataDir: tessdata }, "jpn"), {
    language: "jpn",
    status: "FAILED", totalCases: 1, passedCases: 0, failedCases: 1, averageCerBasisPoints: 0,
    reasonCodes: ["OCR_EVALUATION_FAILED"],
  });
  assert.deepEqual(await runLocalOcrEvaluation(corpus, CONFIG, "unexpected"), {
    language: "eng", status: "REFUSED", code: "LOCAL_OCR_EVALUATION_CORPUS_REFUSED",
  });

  await writeFixtures(corpus, true);
  assert.deepEqual(await runLocalOcrEvaluation(corpus, { executablePath: "/missing/tesseract", tessdataDir: tessdata }, "jpn"), {
    language: "jpn", status: "REFUSED", code: "LOCAL_OCR_EVALUATION_CORPUS_REFUSED",
  });
});

async function writeFixtures(corpus: string, onlyEye = false): Promise<void> {
  const fixtures = ["tesseract-eye-exam", ...(onlyEye ? [] : ["tesseract-fundus-exam"])] as const;
  for (const fixture of fixtures) {
    const base64 = (await readFile(new URL(`../acceptance/fixtures/${fixture}.png.b64`, import.meta.url), "utf8")).trim();
    await writeFile(join(corpus, `${fixture}.png`), Buffer.from(base64, "base64"), { mode: 0o600 });
  }
}

async function writeLanguageFixture(corpus: string, language: "chi_sim" | "jpn"): Promise<void> {
  const name = language === "chi_sim" ? "tesseract-chi-sim-synthetic" : "tesseract-jpn-synthetic";
  const base64 = (await readFile(new URL(`../acceptance/fixtures/${name}.png.b64`, import.meta.url), "utf8")).trim();
  await writeFile(join(corpus, `${name}.png`), Buffer.from(base64, "base64"), { mode: 0o600 });
}
