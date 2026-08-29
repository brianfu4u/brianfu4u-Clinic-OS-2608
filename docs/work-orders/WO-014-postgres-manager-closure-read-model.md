# WO-014 — PostgreSQL Manager Closure Read Model

**Status:** READY FOR BUILD
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`
**Depends on:** WO-001 through WO-013 accepted locally through `400124f`

## 1. Outcome

Read the durable tenant state as a manager-safe closure list without exposing Artifact payloads, employee conversations or caller-controlled authority.

The read model combines, but does not conflate:

- Workflow status;
- current Expectation projection;
- current persisted S2 Verification;
- evidence Artifact IDs;
- latest human decision summary;
- deterministic surfacing/review reasons.

Incomplete durable chains must remain visible as review items rather than disappearing or causing the whole dashboard to fail.

## 2. Minimal files

```text
src/persistence/manager-closure-read-repository.ts
test/postgres-manager-closure-read-repository.test.ts
README.md
```

Small shared type or pure projection edits are allowed only when needed. No migration, dependency, ORM, caching layer, API route or generic query framework.

## 3. Manager item

Return one detached item per current Expectation, plus one explicit incomplete item for an open Workflow that has no Expectation:

- `workflowId`, `workflowStatus`, `identityAnchor`, `workflowFamily`;
- `expectationId`, `expectationState`;
- `verificationStatus`, `verificationReasonCodes`;
- ordered `evidenceArtifactIds`;
- `needsReview`, `reasonCodes`;
- latest decision summary: `action`, `reasonCode`, `decidedAt`, or `null`.

The read model must never include Artifact `payload`, FactCard `fields`, employee IDs, notes, topics, messages, model prompts or decision free-text note.

## 4. Query

Expose one operation equivalent to:

```ts
listManagerClosures(context)
```

Requirements:

1. validate and snapshot ActorContext before acquisition;
2. require `MANAGER`; an employee fails before any query;
3. execute inside the existing tenant transaction/RLS context;
4. read tenant Workflows in stable `created_at, id` order;
5. read each Workflow's current Expectations in stable `triggered_at, id` order;
6. derive ordered evidence IDs from append-only Links (`attached_at, artifact_id`);
7. select only the `S2_V1` record bound to the current Expectation transition;
8. select latest ManagerDecision deterministically by `decided_at DESC, id DESC`;
9. use the existing manager projection for normal UNMET/CONFLICT behavior;
10. add controlled fail-visible reasons for incomplete chains:
   - `EXPECTATION_MISSING` for an open Workflow without Expectation;
   - `VERIFICATION_MISSING` for a current Expectation without its current S2 record;
   - `TERMINAL_DECISION_MISSING` for a CLOSED/VOIDED Workflow without a decision.

For terminal Workflows, display the latest decision's immutable Verification snapshot when present. For open Workflows, display the current S2 record.

## 5. Isolation and consistency

- Clinic comes only from ActorContext and bound parameters.
- Same IDs in another clinic remain invisible.
- Unknown/malformed stored enums, timestamps, arrays or mismatched tenant/Workflow/Expectation relationships fail closed for that query; do not invent repaired values.
- Missing expected rows produce controlled review reasons, not guessed states.
- Duplicate current Verification identities fail closed rather than selecting arbitrarily.
- Output ordering is deterministic and returned arrays/objects are detached.

## 6. Required tests

1. open OPEN/PENDING chain returns no review;
2. open UNMET/PENDING returns `EXPECTATION_UNMET` review;
3. open CONFLICT returns `VERIFICATION_CONFLICT` review;
4. standard CLOSED and exception CLOSED use latest decision Verification snapshot and do not require review;
5. VOIDED projects effective Expectation `VOIDED` and no review when decision exists;
6. open Workflow without Expectation returns `EXPECTATION_MISSING`;
7. current Expectation without current S2 returns `VERIFICATION_MISSING`;
8. terminal Workflow without decision returns `TERMINAL_DECISION_MISSING`;
9. future/non-current Verification is not shown as current;
10. latest decision selection and all list ordering are deterministic;
11. employee/invalid context fails before acquisition;
12. cross-clinic rows and identical IDs remain isolated;
13. SQL injection text remains bound data;
14. output contains no payload, fields, employee identity, conversation or decision note;
15. caller and returned mutation cannot alter stored/result state;
16. malformed rows or duplicate current Verification fail closed;
17. all earlier tests and both demos remain green.

## 7. Honest boundary

This ticket does not claim:

- HTTP/UI persistence wiring;
- live polling, scheduling, push updates or pagination;
- Artifact detail retrieval;
- reopen, unvoid or correction flows;
- real PostgreSQL application-role RLS/concurrency proof;
- backup/restore, production or real-PHI readiness.

## 8. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
```

## 9. Prohibited scope

- No migration or writes.
- No UI, HTTP route, model/provider call, cache, worker or event bus.
- No raw Artifact/FactCard content or employee conversation fields.
- No real PHI, destructive reset or direct remote push by the Builder.

## 10. Builder handoff

The Builder must read the Constitution and WO-002, WO-004, WO-007 through WO-014, implement only this read slice, run all acceptance commands, commit as `feat(persistence): add manager closure read model`, report exact files/tests/deviations, and not push before Architecture Review.
