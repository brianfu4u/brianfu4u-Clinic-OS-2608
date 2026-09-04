# WO-049 — Language-Specific OCR Evaluation

**Status:** Accepted
**Depends on:** WO-047; WO-048

## Goal

Extend the accepted local OCR evaluator so a separately approved, checked-in
synthetic corpus can be evaluated for exactly one requested language (`eng`,
`chi_sim`, or `jpn`). This creates a measurement gate for Chinese/Japanese
asset releases without treating an installed language file as a clinical
accuracy claim.

## Boundaries

- Each language requires an exact, checked-in fixture manifest and pinned hash;
  caller-selected language, manifest shape, corpus contents, file types and
  hashes must all be validated before the OCR provider is created.
- No language download/install, process beyond the existing accepted local OCR
  runner, network, database, object storage, workflow, model recommendation or
  browser change.
- The output remains aggregate counts/CER basis points/fixed reason codes only.
  It must never emit language corpus filenames, paths, expected/OCR text,
  hashes, bytes, raw errors or patient data.
- Evaluation is read-only and does not enable Chinese/Japanese clinical
  extraction. A separate release decision needs real non-PHI validation data
  and human approval.

## Acceptance

Test exact per-language acceptance, unavailable optional asset rejection,
manifest/corpus mismatch before OCR, aggregate redaction, and unchanged English
evaluation. Run focused and full regression, then independently review before
acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 4/4 and the full suite
passed 407/407. `eng`, `chi_sim` and `jpn` can only select their separately
pinned synthetic corpus; Chinese/Japanese still require a protected installed
asset. This remains a synthetic baseline, not a clinical accuracy release.
