# WO-036 — Manager Attention and Gap Read Model

**Status:** Architecture frozen / Builder active  
**Depends on:** Constitution; WO-035

## Goal

Expose a bounded manager-only read model which combines existing closure state
with the WO-035 structured-document alignment result. It answers: what is
missing, what conflicts, and which operational chain needs a human look.

## Rules

- Read-only: no Artifact, FactCard, Workflow, Expectation, S2 or decision write.
- Tenant/manager authority is enforced before reads; returned items are detached.
- Only safe identifiers, workflow family, stage/status and controlled reason
  codes may leave the repository. No payload, bytes, path, raw OCR/model output,
  note, employee-monitoring data or database detail.
- `ALIGNED` normal chains remain quiet. `MISSING` and `CONFLICT` become ordered
  attention items; deterministic S2 reasons remain preserved, not overwritten.
- It recommends no clinical or autonomous operational action.

## Acceptance

Prove manager-only and tenant isolation, exact safe projection, deterministic
ordering, missing/conflict visibility, quiet aligned chains, malformed stored
rows fail closed and no reads mutate state. Run focused/full tests and demos;
stay local with no push, merge or PR.
