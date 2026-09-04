# WO-047 — Local OCR Evaluation Harness

**Status:** Accepted
**Depends on:** WO-021; WO-043; WO-045

## Goal

Give the local Mac operator one explicit, offline command to evaluate the
already configured pinned OCR assets on an operator-supplied, non-PHI corpus.
It must produce only aggregate, bounded quality results suitable for deciding
whether a language/model release is ready for further validation.

## Boundaries

- Require an explicit local corpus directory and a checked-in manifest of
  expected synthetic fixture labels. Refuse symlinks, unrecognised files,
  malformed manifests, missing assets and unsafe paths before OCR.
- Reuse the accepted local Tesseract provider and its manifest/integrity
  validation. Do not download language data, change the OCR model, call a
  network service or create a cloud fallback.
- Output aggregate pass/fail counts and bounded reason codes only. Never print
  document bytes, OCR text, filenames, paths, hashes, patient data, model
  internals or raw exceptions.
- Read-only evaluation: no database, object storage, Workflow, FactCard, S2,
  model recommendation or browser change.

## Acceptance

Test corpus/manifest/path refusal before OCR, exact aggregate success/failure
vocabulary, redaction and no writes/network. Run focused and full regressions,
then independently review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 3/3 and the full suite
passed 404/404. The accepted result covers only the two checked-in English
synthetic fixtures; it is explicitly not an accuracy claim for Chinese or
Japanese clinical documents.
