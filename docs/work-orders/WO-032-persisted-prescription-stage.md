# WO-032 — Persisted Prescription Stage

**Status:** Accepted — Architecture Review passed 2026-08-31  
**Architect:** Codex Architecture Designer  
**Depends on:** Constitution; WO-005, WO-015, WO-023, WO-028 through WO-031

## 1. Goal

Extend the accepted persisted tracer by one explicit stage:

```text
REGISTRATION
  -> PRESCRIPTION Expectation
  -> PRESCRIPTION evidence
  -> EXAM_REPORT Expectation
```

This work order does not add payment, a new OCR provider, an LLM, authentication,
Cloud deployment, a migration or a new dependency.

## 2. Authority boundary

- The server injects `ActorContext`; the browser cannot send clinic, actor or role.
- The employee sends only a bounded synthetic identity anchor and occurrence time.
- An opaque Expectation ID is not authority.
- The server selects exactly one current `OPEN` PRESCRIPTION Expectation owned by
  the same employee, clinic and exact identity anchor, inside its time window.
- Zero candidates fail closed. Multiple candidates return controlled review and
  are never guessed or ranked.
- Only the persisted golden path may attach evidence, change an Expectation or
  create S2 verification.

## 3. Required behavior

1. A registration initializes one PRESCRIPTION Expectation using the frozen
   eye-exam flow policy.
2. A valid prescription satisfies that Expectation as `MET` with `S2_V1=VERIFIED`.
3. The same immutable prescription Artifact and FactCard then trigger one
   EXAM_REPORT Expectation in the same Workflow.
4. The new Expectation is `OPEN/PENDING` and is exposed only through the existing
   employee-safe read model.
5. Exact replay returns the durable result without duplicate Artifact, FactCard,
   link, Expectation, transition or S2 rows.
6. Changed identity, time, clinic, employee or request content under one operation
   identity fails closed.
7. A crash between the consequence and next-trigger stages is recoverable by an
   exact retry; committed immutable evidence is never deleted.

## 4. Transport

`POST /api/employee/prescription-trigger`

Request body has exactly:

```json
{"identityAnchor":"DEMO-001","occurredAt":"2026-08-31T09:05:00.000Z"}
```

The request requires the existing bounded `Idempotency-Key`. Responses use the
same bounded registration projection and never expose clinic, actor, Workflow,
Artifact, FactCard, filesystem path or private database values.

## 5. Acceptance

Focused acceptance:

```bash
node --test \
  test/eye-exam-flow-policy.test.ts \
  test/employee-open-expectation-read-repository.test.ts \
  test/postgres-preview.test.ts
```

Then run the complete repository test suite and `git diff --check`.

Required negative proofs include cross-clinic, cross-employee, changed anchor,
expired expectation, ambiguous candidate, malformed/duplicate-key input and
idempotency conflict. No push is permitted before independent Architecture Review.

## 6. Acceptance result

The independent acceptance run passed on 2026-08-31:

- `npm test`: 360/360 passing;
- persisted closure demo: registration -> prescription -> exam report ->
  extraction -> S2 verification -> manager close -> replay;
- base domain and runtime demos: passing;
- `git diff --check`: passing.

The review also corrected the manager read model for a multi-stage Workflow:
after a valid terminal decision, earlier completed stages remain visible as
history but do not become false `TERMINAL_DECISION_MISSING` review items.
