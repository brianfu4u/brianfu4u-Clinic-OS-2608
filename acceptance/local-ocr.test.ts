import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EYE_EXAM_EXTRACTION_SPEC,
  StoredEvidenceExtractionService,
  type ExtractionSpec,
} from "../src/application/evidence-extraction.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import type { RuntimeManifest } from "../src/runtime/contracts.ts";
import { InferenceGateway } from "../src/runtime/inference-gateway.ts";
import {
  TESSERACT_OCR_MODEL_ID,
  TesseractOcrProvider,
  type TesseractModelManifest,
} from "../src/runtime/tesseract-ocr-provider.ts";
import { LocalObjectStore } from "../src/storage/local-object-store.ts";
import { ObjectStoreGateway } from "../src/storage/object-store-gateway.ts";

const CONTEXT: ActorContext = { clinicId: "synthetic-clinic", actorId: "acceptance", role: "EMPLOYEE" };
const STRICT: RuntimeManifest = {
  profile: "ON_PREM_STRICT",
  databaseProvider: "LOCAL_POSTGRES",
  fileProvider: "LOCAL_OBJECT_STORE",
  inferenceProvider: "LOCAL_MODEL",
  backupProvider: "LOCAL_ENCRYPTED_BACKUP",
  externalInferenceAuthorized: false,
  manifestVersion: "manifest-1",
};
const SPEC: ExtractionSpec = {
  ...EYE_EXAM_EXTRACTION_SPEC,
  parserVersion: "tesseract-eng-parser-v1",
  modelId: TESSERACT_OCR_MODEL_ID,
};
const SAMPLES = [
  {
    file: "fixtures/tesseract-eye-exam.png.b64",
    sha256: "b8489ed0ff777358f81abcc853eb6e8b5025d2547995008d4d9a4cfa3a204671",
    expected: "EYE EXAM REPORT VISUAL ACUITY 20 20",
    reportType: "EYE_EXAM",
  },
  {
    file: "fixtures/tesseract-fundus-exam.png.b64",
    sha256: "d5758c29984fd2676ed9b2ab5dbf8dbbe050bd6e464fe70eb2747b08094d884e",
    expected: "FUNDUS EXAM REPORT RIGHT EYE NORMAL",
    reportType: "FUNDUS",
  },
] as const;

test("real local Tesseract English smoke passes bounded CER and every report marker", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clinic-os-real-ocr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(new URL("../models/tesseract-eng-v1.manifest.json", import.meta.url), "utf8"),
  ) as TesseractModelManifest;
  const provider = new TesseractOcrProvider({
    executablePath: process.env.WO021_TESSERACT_PATH ?? "/usr/bin/tesseract",
    tessdataDir: process.env.WO021_TESSDATA_DIR ?? "/usr/share/tesseract-ocr/5/tessdata",
    manifest,
  });
  const objects = new ObjectStoreGateway(STRICT, new LocalObjectStore(root));
  const service = new StoredEvidenceExtractionService({
    objects,
    inference: new InferenceGateway(STRICT, provider),
    spec: SPEC,
  });

  for (const [index, sample] of SAMPLES.entries()) {
    const bytes = new Uint8Array(Buffer.from(
      (await readFile(new URL(sample.file, import.meta.url), "utf8")).trim(),
      "base64",
    ));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sample.sha256);
    const ref = await objects.put(CONTEXT, {
      objectId: `synthetic-english-${index}`,
      mediaType: "image/png",
      bytes,
    });
    const result = await service.extract(CONTEXT, {
      requestId: `real-ocr-${index}`,
      artifactId: `synthetic-artifact-${index}`,
      factCardId: `synthetic-fact-${index}`,
      objectRef: ref,
      kind: "EXAM_REPORT",
      occurredAt: "2026-08-30T00:00:00.000Z",
      occurredAtSource: "source",
      identityAnchor: `SYNTHETIC-${index}`,
      createdAt: "2026-08-30T00:01:00.000Z",
    });
    assert.equal(result.status, "READY");
    assert.equal(result.lineage.modelId, TESSERACT_OCR_MODEL_ID);
    assert.equal(result.candidate.fields.reportType, sample.reportType);
    const actual = normalize(String(result.candidate.fields.ocrText));
    assert.ok(characterErrorRate(normalize(sample.expected), actual) <= 0.02,
      `synthetic English CER exceeded 2% for sample ${index}`);
  }
});

function normalize(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function characterErrorRate(expected: string, actual: string): number {
  const previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let left = 1; left <= expected.length; left += 1) {
    let diagonal = previous[0];
    previous[0] = left;
    for (let right = 1; right <= actual.length; right += 1) {
      const up = previous[right];
      previous[right] = Math.min(
        previous[right] + 1,
        previous[right - 1] + 1,
        diagonal + (expected[left - 1] === actual[right - 1] ? 0 : 1),
      );
      diagonal = up;
    }
  }
  return previous[actual.length] / Math.max(1, expected.length);
}
