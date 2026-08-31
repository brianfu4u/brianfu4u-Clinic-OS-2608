# WO-035 — Structured Document Alignment

**Status:** Architecture frozen / Builder active  
**Depends on:** Constitution; WO-034

## Goal

Introduce one bounded, versioned structured projection for the four existing
synthetic evidence kinds: `REGISTRATION`, `PRESCRIPTION`, `EXAM_REPORT` and
`PAYMENT`. It aligns exact patient anchor, occurrence time, workflow family and
document kind before a chain can be considered ready for deterministic S2.

## Boundaries

- Reuse immutable Artifact/FactCard lineage. Do not rewrite historical rows or
  migrations and do not introduce OCR/LLM, payment amounts or real PHI.
- Schema parsing is strict, bounded and inert: no accessor/proxy execution,
  no authority fields and no state/decision writes.
- Alignment yields an explainable bounded result (`ALIGNED`, `MISSING` or
  `CONFLICT`) used only as evidence/review input. S2 remains the sole verdict
  writer and manager remains the sole operational decision maker.
- Exact values must match exactly; time ordering is deterministic. Near matches
  are review, never guessed matches.

## Acceptance

Add pure schema/alignment tests covering each document, missing fields,
duplicate/reversed/inconsistent identity/time/kind and hostile shapes. Surface
only safe bounded reasons in the manager read model; preserve existing chain
behavior and run full tests/demos/checks locally with no push, merge or PR.
