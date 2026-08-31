# WO-033 — Persisted Exam Report to Payment Stage

**Status:** Accepted — Architecture Review passed 2026-08-31  
**Depends on:** Constitution; WO-032

## Goal

Extend the accepted eye-exam chain by one server-derived stage:

```text
REGISTRATION -> PRESCRIPTION -> EXAM_REPORT -> PAYMENT Expectation
```

This work order creates the next persisted `PAYMENT` expectation only after a
valid, verified `EXAM_REPORT` consequence. It does not accept payment input,
amounts, payer identity, OCR/LLM output, a new migration, a new dependency or
a browser-authority field.

## Authority and state rules

- The existing employee-safe selector remains the only source of the current
  open `EXAM_REPORT` expectation.
- The existing extraction golden path remains the only writer of Artifact,
  FactCard, Workflow attachment, Expectation transition and S2 verification.
- A READY report that deterministically verifies as `MET/VERIFIED` creates one
  `PAYMENT` expectation in the same Workflow using the frozen flow policy.
- `REVIEW_REQUIRED`, `CONFLICT`, `UNMET`, cross-clinic, cross-employee,
  expired, changed-replay and ambiguous paths create no payment expectation.
- Exact replay returns the existing durable result without another inference,
  Artifact, FactCard, link, transition, verification or expectation.
- The payment expectation is server-derived, `OPEN/PENDING`, employee-safe and
  cannot be selected or satisfied by an opaque ID supplied by the browser.

## Required acceptance

- Extend the persisted closure harness from `EXAM_REPORT` through creation of
  one `PAYMENT` expectation and exact replay.
- Prove every negative path above leaves no payment expectation.
- Run focused flow/preview/closure tests, `npm test`, demos and `git diff --check`.
- Keep all work local: no push, merge or PR.

## Acceptance result

Independent acceptance passed on 2026-08-31:

- `npm test`: 362/362 passing;
- persisted closure demo: passing, including exact report replay and one
  employee-safe `PAYMENT OPEN/PENDING` expectation;
- cross-employee, cross-clinic and conflicting-report negative paths: passing;
- manager close is rejected while any other Workflow expectation remains
  `OPEN` or `UNMET`;
- no push, merge or PR was performed.
