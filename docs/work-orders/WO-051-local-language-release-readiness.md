# WO-051 — Local Language Release Readiness

**Status:** Accepted
**Depends on:** WO-045; WO-048; WO-050

## Goal

Add bounded, read-only Chinese/Japanese local language-release states to the
existing local preview readiness surface. It tells the Mac operator whether an
exact local `APPROVED` record is present for each optional language; it does
not enable that language for clinical extraction.

## Boundaries

- Read only the accepted local release-record format and expected record
  location. Reject malformed, unsafe, missing, symlinked or unapproved files
  as unavailable before exposing a status.
- Expose fixed language/status vocabulary only. Never expose timestamps,
  paths, record content, aggregate metrics, corpus labels, hashes, language
  asset details, operator identity, OCR text, database values or errors.
- No browser write, OCR run, release-record creation, model/action change,
  language installation, network, database, workflow, S2 or upload path.
- English preview startup remains unaffected; Chinese/Japanese `APPROVED`
  status remains an operator readiness indicator, not a clinical authorization.

## Acceptance

Test approved/missing/rejected/malformed/unsafe states, redaction and absence
of side effects; confirm unchanged English startup and existing local readiness
checks. Run focused and full regression, then independently review before
acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 6/6 and the full suite
passed 412/412. Missing, rejected, malformed or unsafe records map only to a
bounded unavailable state. Approval visibility changes neither OCR execution
nor clinical authorization.
