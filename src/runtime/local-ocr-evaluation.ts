import { createHash } from "node:crypto";
import { constants, lstatSync, openSync, readSync, closeSync, readdirSync, fstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { types } from "node:util";

import type { ActorContext } from "../domain/contracts.ts";
import { inspectOptionalTesseractLanguageAssetsSync, TESSERACT_OCR_SCHEMA_VERSION, TesseractOcrProvider } from "./tesseract-ocr-provider.ts";

const MANIFESTS = Object.freeze({
  eng: Object.freeze({
    path: fileURLToPath(new URL("../../models/local-ocr-evaluation-fixtures-v1.manifest.json", import.meta.url)),
    sha256: "145f6a9a4f1e627eae1d61ca7333b36596040d230f6db862d6e03142966b6f5a",
    version: "clinic-os-local-ocr-evaluation-fixtures-v1",
    cases: 2,
  }),
  chi_sim: Object.freeze({
    path: fileURLToPath(new URL("../../models/local-ocr-evaluation-chi-sim-fixtures-v1.manifest.json", import.meta.url)),
    sha256: "03d43a739ccd994e3501ae9303ddf27b8ac3e547cbb5aa3375770b5ec2b5f74d",
    version: "clinic-os-local-ocr-evaluation-chi-sim-fixtures-v1",
    cases: 1,
  }),
  jpn: Object.freeze({
    path: fileURLToPath(new URL("../../models/local-ocr-evaluation-jpn-fixtures-v1.manifest.json", import.meta.url)),
    sha256: "17f3abb7d73c657000a9db1bea792161f5b55d6836fbdef087feda3308336e9d",
    version: "clinic-os-local-ocr-evaluation-jpn-fixtures-v1",
    cases: 1,
  }),
});
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const CONTEXT: ActorContext = Object.freeze({ clinicId: "local-ocr-evaluation", actorId: "local-ocr-evaluation", role: "EMPLOYEE" });

interface Fixture {
  file: string;
  mediaType: "image/png" | "image/jpeg";
  sha256: string;
  expectedText: string;
  reportType: "EYE_EXAM" | "FUNDUS";
}

interface FixtureManifest {
  manifestVersion: string;
  maximumCharacterErrorRate: number;
  fixtures: readonly Fixture[];
}

export type LocalOcrEvaluationResult =
  | Readonly<{ language: LocalOcrEvaluationLanguage; status: "READY"; totalCases: number; passedCases: number; failedCases: number; averageCerBasisPoints: number; reasonCodes: readonly [] }>
  | Readonly<{ language: LocalOcrEvaluationLanguage; status: "FAILED"; totalCases: number; passedCases: number; failedCases: number; averageCerBasisPoints: number; reasonCodes: readonly ["OCR_EVALUATION_FAILED" | "OCR_QUALITY_THRESHOLD_NOT_MET"] }>
  | Readonly<{ language: LocalOcrEvaluationLanguage; status: "REFUSED"; code: "LOCAL_OCR_EVALUATION_CORPUS_REFUSED" | "LOCAL_OCR_EVALUATION_LANGUAGE_UNAVAILABLE" }>;

export type LocalOcrEvaluationLanguage = "eng" | "chi_sim" | "jpn";

export async function runLocalOcrEvaluation(
  corpusDir: string,
  config: { executablePath: string; tessdataDir: string },
  language: unknown = "eng",
): Promise<LocalOcrEvaluationResult> {
  let manifest: FixtureManifest;
  let corpus: readonly { fixture: Fixture; bytes: Uint8Array }[];
  try {
    if (!isLanguage(language)) throw new Error();
    manifest = readFrozenManifest(language);
    corpus = readCorpus(corpusDir, manifest);
  } catch {
    return Object.freeze({ language: isLanguage(language) ? language : "eng", status: "REFUSED", code: "LOCAL_OCR_EVALUATION_CORPUS_REFUSED" });
  }
  if (language !== "eng" && !languageAssetAvailable(language, config.tessdataDir)) {
    return Object.freeze({ language, status: "REFUSED", code: "LOCAL_OCR_EVALUATION_LANGUAGE_UNAVAILABLE" });
  }

  let provider: TesseractOcrProvider;
  try {
    provider = new TesseractOcrProvider({ ...config, language });
  } catch {
    return failed(language, manifest.fixtures.length, 0, 0, "OCR_EVALUATION_FAILED");
  }
  let passed = 0;
  let totalCer = 0;
  for (const [index, item] of corpus.entries()) {
    try {
      const response = await provider.infer(CONTEXT, {
        capability: "EXTRACT_EYE_EXAM_REPORT",
        clinicId: CONTEXT.clinicId,
        requestId: `local-ocr-evaluation-${index}`,
        schemaVersion: TESSERACT_OCR_SCHEMA_VERSION,
        input: {
          bytes: item.bytes,
          contentSha256: item.fixture.sha256,
          kind: "EXAM_REPORT",
          mediaType: item.fixture.mediaType,
        },
      });
      const fields = response.output.fields;
      const cer = characterErrorRate(normalize(item.fixture.expectedText), normalize(String(fields.ocrText)));
      totalCer += cer;
      if (cer <= manifest.maximumCharacterErrorRate) passed += 1;
    } catch {
      return failed(language, manifest.fixtures.length, passed, totalCer, "OCR_EVALUATION_FAILED");
    }
  }
  const averageCerBasisPoints = Math.round(totalCer / manifest.fixtures.length * 10_000);
  if (passed !== manifest.fixtures.length) return failed(language, manifest.fixtures.length, passed, totalCer, "OCR_QUALITY_THRESHOLD_NOT_MET");
  return Object.freeze({ language, status: "READY", totalCases: passed, passedCases: passed, failedCases: 0, averageCerBasisPoints, reasonCodes: Object.freeze([]) });
}

function failed(language: LocalOcrEvaluationLanguage, totalCases: number, passedCases: number, totalCer: number, reason: "OCR_EVALUATION_FAILED" | "OCR_QUALITY_THRESHOLD_NOT_MET"): LocalOcrEvaluationResult {
  return Object.freeze({
    language,
    status: "FAILED",
    totalCases,
    passedCases,
    failedCases: totalCases - passedCases,
    averageCerBasisPoints: Math.round(totalCer / totalCases * 10_000),
    reasonCodes: Object.freeze([reason]),
  });
}

function readFrozenManifest(language: LocalOcrEvaluationLanguage): FixtureManifest {
  const fixed = MANIFESTS[language];
  const bytes = readRegularFile(fixed.path, 16 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== fixed.sha256) throw new Error();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(); }
  if (!plainDataObject(value) || !exactKeys(value, ["fixtures", "manifestVersion", "maximumCharacterErrorRate"]) ||
    value.manifestVersion !== fixed.version || value.maximumCharacterErrorRate !== 0.02 ||
    !Array.isArray(value.fixtures) || value.fixtures.length !== fixed.cases) throw new Error();
  const fixtures = value.fixtures.map((fixture) => {
    if (!plainDataObject(fixture) || !exactKeys(fixture, ["expectedText", "file", "mediaType", "reportType", "sha256"]) ||
      !/^[a-f0-9]{64}$/.test(String(fixture.sha256)) || !/^[a-z0-9-]+\.png$/.test(String(fixture.file)) ||
      fixture.mediaType !== "image/png" || !nonblank(fixture.expectedText) ||
      !["EYE_EXAM", "FUNDUS"].includes(String(fixture.reportType))) throw new Error();
    return Object.freeze({ ...fixture }) as Fixture;
  });
  if (new Set(fixtures.map(({ file }) => file)).size !== fixtures.length) throw new Error();
  return Object.freeze({ manifestVersion: fixed.version, maximumCharacterErrorRate: value.maximumCharacterErrorRate, fixtures: Object.freeze(fixtures) });
}

function languageAssetAvailable(language: Exclude<LocalOcrEvaluationLanguage, "eng">, tessdataDir: string): boolean {
  const assets = inspectOptionalTesseractLanguageAssetsSync(tessdataDir);
  return language === "chi_sim" ? assets.chiSim : assets.jpn;
}

function isLanguage(value: unknown): value is LocalOcrEvaluationLanguage {
  return value === "eng" || value === "chi_sim" || value === "jpn";
}

function readCorpus(corpusDir: string, manifest: FixtureManifest): readonly { fixture: Fixture; bytes: Uint8Array }[] {
  if (typeof corpusDir !== "string" || !isAbsolute(corpusDir) || resolve(corpusDir) !== corpusDir || corpusDir === "/") throw new Error();
  assertSafeDirectoryAncestry(corpusDir);
  const expected = new Set(manifest.fixtures.map(({ file }) => file));
  const actual = readdirSync(corpusDir);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) throw new Error();
  return Object.freeze(manifest.fixtures.map((fixture) => {
    const path = `${corpusDir}/${fixture.file}`;
    const bytes = readRegularFile(path, MAX_IMAGE_BYTES);
    if (!validMagic(bytes, fixture.mediaType) || createHash("sha256").update(bytes).digest("hex") !== fixture.sha256) throw new Error();
    return Object.freeze({ fixture, bytes });
  }));
}

function assertSafeDirectoryAncestry(path: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !trustedOwner(stat.uid, stat.mode)) throw new Error();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function readRegularFile(path: string, maxBytes: number): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const pathname = lstatSync(path);
    if (!stat.isFile() || pathname.isSymbolicLink() || stat.dev !== pathname.dev || stat.ino !== pathname.ino ||
      !trustedOwner(stat.uid, stat.mode) || stat.size <= 0 || stat.size > maxBytes) throw new Error();
    const bytes = Buffer.allocUnsafe(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error();
      offset += count;
    }
    const after = lstatSync(path);
    if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error();
    return new Uint8Array(bytes);
  } finally { closeSync(fd); }
}

function trustedOwner(uid: number, mode: number): boolean {
  const currentUid = process.geteuid?.();
  return currentUid !== undefined && (uid === 0 || uid === currentUid) && (mode & 0o022) === 0;
}

function normalize(value: string): string { return value.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

function characterErrorRate(expected: string, actual: string): number {
  const previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let left = 1; left <= expected.length; left += 1) {
    let diagonal = previous[0]; previous[0] = left;
    for (let right = 1; right <= actual.length; right += 1) {
      const up = previous[right];
      previous[right] = Math.min(previous[right] + 1, previous[right - 1] + 1, diagonal + (expected[left - 1] === actual[right - 1] ? 0 : 1));
      diagonal = up;
    }
  }
  return previous[actual.length] / Math.max(1, expected.length);
}

function validMagic(bytes: Uint8Array, mediaType: string): boolean {
  return mediaType === "image/png" && bytes.byteLength >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}

function plainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.hasOwn(descriptors[key], "value"));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
