# WO-048 — Local OCR Language Asset Gate

**Status:** Accepted
**Depends on:** WO-021; WO-045; WO-047

## Goal

Make the local preview explicitly show whether approved Chinese and Japanese
Tesseract language assets are available for a future controlled validation.
Their absence must remain safe and visible; this work does not claim language
accuracy or enable the languages for clinical extraction.

## Boundaries

- Read only the local Tesseract data directory already accepted by startup.
  No language download/install, Homebrew invocation, process execution,
  network request, model change or OCR invocation.
- Require exact expected local `chi_sim` and `jpn` traineddata filenames and
  trusted path/ownership/permission checks. Never emit their absolute paths,
  hashes, owners or error details.
- Expose only fixed available/unavailable status in the existing local
  readiness surface. It must not affect English preview startup, S2, stored
  extraction, uploads, database or workflow behavior.
- Do not treat installed assets as an accuracy certification. Corpus and
  language release evaluation remain separate future work.

## Acceptance

Test absent, malformed, unsafe and available asset states; redaction; no OCR
or side effect; and unchanged English startup. Run focused and full regressions
then independently review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 12/12 and the full suite
passed 406/406. The readiness page shows only bounded presence/absence for the
two protected language filenames. It does not execute them, install them, or
claim either language is clinically accurate.
