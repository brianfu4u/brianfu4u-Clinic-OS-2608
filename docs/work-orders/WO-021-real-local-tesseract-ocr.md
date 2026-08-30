# WO-021 — Real Local Tesseract OCR Provider and Strict Environment Gate

**Status:** Architecture frozen / Builder ready  
**Depends on:** Constitution, WO-006, WO-019, WO-020

## 1. Goal and honest acceptance boundary

Implement the first real local OCR adapter through the accepted `InferenceGateway` and
`StoredEvidenceExtractionService`. The current executor has Tesseract 5.3.4 and English/OSD model
assets, so this ticket must execute a real English synthetic OCR smoke test.

It does **not** claim Japanese/Chinese clinical OCR or physically isolated networking. After local
implementation review its maximum status is:

`IMPLEMENTED / STRICT_OFFLINE + CLINICAL_LANGUAGE GATES OPEN`

It becomes fully accepted only after the same gate passes in a network-disabled deployment and an
approved de-identified clinical-language validation set passes its frozen thresholds.

## 2. Frozen local asset baseline

- engine: Tesseract 5.3.4 / Leptonica 1.82;
- provider kind: `LOCAL_MODEL`;
- languages present: `eng`, `osd` only;
- Tesseract license: Apache-2.0;
- current executable SHA-256:
  `9f831cab7525c3dab04af41bda35182af7ea1df9dceeaaa2f3bf207ac45c06a5`;
- `eng.traineddata` SHA-256:
  `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`;
- `osd.traineddata` SHA-256:
  `9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff`.

Repository metadata records hashes/licenses but never commits system model weights.

## 3. Minimal file surface

- `src/runtime/tesseract-ocr-provider.ts`
- `test/tesseract-ocr-provider.test.ts`
- `acceptance/local-ocr.test.ts`
- `models/tesseract-eng-v1.manifest.json`
- `docs/runbooks/local-ocr-acceptance.md`
- package/README edits for `npm run accept:ocr-local`

No npm dependency, database, UI, upload route, queue or model download.

## 4. Provider contract

`TesseractOcrProvider implements InferenceProvider` with immutable kind/model identity. It accepts
only the frozen `EXTRACT_EYE_EXAM_REPORT` capability and matching schema, PNG/JPEG bytes whose
magic matches media type, and a caller-computed content hash that the Provider independently
recomputes.

The Provider:

1. sends bytes to a fixed absolute executable through stdin;
2. invokes with an argument array, `shell: false`, a fixed English language and fixed page mode;
3. never accepts executable, language, arguments, path, environment or URL from a request;
4. never creates an input file or network request;
5. applies bounded timeout, TERM/KILL cancellation and bounded stdout/stderr;
6. revalidates executable/model hashes and engine identity before each inference;
7. emits only the WO-020 candidate schema;
8. extracts bounded `ocrText` plus deterministic `reportType` markers; missing marker becomes
   `missingFields: ["reportType"]` and therefore review, never invented data;
9. never returns identity, formal IDs, Workflow, Expectation, Verification, decision or status;
10. returns stable sanitized errors without image bytes, OCR text, paths, stderr or PHI.

The first real spec receives a new explicit Tesseract model ID. It must not reuse the deterministic
fixture identity accepted by WO-020.

## 5. Manifest and fail-closed startup

Use an exact-shape checked-in manifest containing engine/model identity, purpose, executable and
traineddata hashes, language, license SPDX, schema version, minimum hardware note, rollback model
identity and offline package reference. Unknown fields or mismatched version/hash/language/license
fail before Tesseract invocation with a controlled model-integrity/unavailable error.

Model paths are deployment configuration checked against the manifest; request bodies cannot set
them. Do not print configured paths in errors or receipts.

## 6. Tests

Ordinary unit tests use an injected process runner only to attack the Provider boundary; they do not
claim OCR execution. At minimum prove:

1. exact request/capability/schema/input and image magic gates;
2. content hash is recomputed;
3. executable/language/args/path/env injection is impossible;
4. fixed argument-array spawn uses `shell:false` and stdin only;
5. timeout, abort, TERM/KILL, nonzero exit and output limits fail closed;
6. malformed/hostile process output and confidence fail closed;
7. binary/model/manifest mutation is rechecked before every call;
8. Provider/Gateway identity mutation and fallback remain blocked;
9. missing report marker yields review; a recognized marker yields a bounded candidate;
10. errors and receipts contain no bytes, OCR text, paths or stderr;
11. Provider has no repository/domain write authority;
12. regressions and both demos remain green.

The separate real acceptance test must call the installed binary and model on committed or embedded
non-PHI synthetic English image samples, verify sample hashes, require normalized CER <= 2% and
`reportType` recall for every sample, and exit nonzero when the binary/model/environment is absent.
It may not skip and print success.

## 7. Open external gates

- `STRICT_OFFLINE`: rerun the real acceptance command inside a deployment/CI network namespace with
  no external network. The current executor cannot create that namespace; code inspection is not a
  substitute because the binary dynamically links networking-capable libraries.
- `CLINICAL_LANGUAGE`: install approved hashed Japanese/Chinese assets and validate on an approved,
  de-identified report corpus with frozen CER, field precision/recall and failure thresholds.

## 8. Non-goals

PaddleOCR/Qwen, language/model downloads, PDF/layout/handwriting, multiple-model fallback, clinical
diagnosis, persistence, HTTP/UI, queues/retries, cloud inference and automatic Workflow/closure are
out of scope. Synthetic English smoke results must never be described as clinical OCR accuracy.

## 9. Builder handoff

Read the Constitution and dependency work orders. Implement the smallest real adapter and separate
gate, run unit/full tests, demos and `accept:ocr-local`, commit as
`feat(runtime): add local tesseract OCR provider`, report unit versus real-gate results separately,
and do not push before independent Architecture Review.
