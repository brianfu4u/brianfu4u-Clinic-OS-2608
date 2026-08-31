# WO-040 — Five-Patient UI Acceptance

**Status:** Accepted locally — 2026-08-31
**Depends on:** WO-037; WO-038; WO-039

## Goal

Provide a repeatable local acceptance run through the employee and manager
preview for five strictly synthetic patient flows. It proves the final visible
prototype routes normal work, attention cases and manager decisions through
the same bounded server APIs used by the pages.

## Fixed cases

1. normal verified chain, then payment and standard close;
2. missing report remains an attention item;
3. late report remains deterministic unmet/review;
4. conflicting report remains review and creates no payment;
5. a valid chain replayed exactly creates no duplicate state.

## Boundaries

- Synthetic anchors only; no PHI, real files, credentials or external service.
- Exercise employee workspace and manager HTTP/page projections; do not insert
  business state by raw SQL or bypass existing services.
- Fixed clock, deterministic output and no IDs, paths, raw OCR/model output or
  notes in command-line summary.
- This is acceptance coverage, not a new production feature. No migration,
  dependency, authentication change or browser automation framework.

## Acceptance

Run the five flows, prove expected safe UI/API states and exact replay, then
run focused/full tests locally. No push, merge or PR.

## Acceptance record

- Five synthetic cases passed through the durable services and real local
  employee/manager HTTP page projections.
- Exact report, payment and manager-decision replay created no duplicate state
  and invoked inference once.
- Focused acceptance: 2/2; related closure/workspace/dashboard tests: 13/13.
- Full regression: 382/382; persisted closure demo passed.
- Command-line output contains only bounded case/status vocabulary.
