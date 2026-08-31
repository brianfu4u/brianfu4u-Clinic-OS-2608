# WO-034 — Persisted Payment Completion

**Status:** Architecture frozen / Builder active  
**Depends on:** Constitution; WO-033

## Goal

Complete only the final evidence stage of the existing synthetic eye-exam
trace:

```text
REGISTRATION -> PRESCRIPTION -> EXAM_REPORT -> PAYMENT evidence -> CLOSED
```

An employee may submit a bounded payment-completion event. The server selects
the sole current `PAYMENT` expectation for the same employee, clinic and exact
identity anchor, records immutable `PAYMENT` Artifact/FactCard evidence through
the persisted golden path, and permits the existing manager close only after
the result is `MET/VERIFIED`.

## Out of scope

No payment amount, currency, payer detail, receipt OCR, LLM, new dependency,
new migration, client-supplied expectation/workflow/artifact/fact-card ID or
browser authority. Structured payment fields belong to WO-035.

## Invariants

- The request contains only exact synthetic identity anchor, occurrence time
  and the existing idempotency key; server context derives all IDs and scope.
- Exactly one current in-window payment expectation is required; zero fails
  closed and multiple returns controlled review without a write.
- Exact replay returns the persisted completion without duplicate rows.
- Changed anchor, time, employee, clinic or operation content under the same
  key conflicts without mutation.
- A completed payment becomes `MET/VERIFIED`; only then can a manager use the
  existing standard close.
- REVIEW_REQUIRED, conflict, expired or out-of-order input creates no final
  manager decision and never silently closes a Workflow.

## Acceptance

Add a narrow employee transport path and UI wiring only if the existing preview
already has a current stage control. Prove positive completion, exact replay,
all negative scope/time/ambiguity paths, and close-before/close-after behavior.
Run focused tests, `npm test`, closure/runtime demos and `git diff --check`.
Keep work local: no push, merge or PR.
