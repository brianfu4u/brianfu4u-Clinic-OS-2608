# WO-013 — Persisted Manager Decision and Workflow Closure Saga

**Status:** READY FOR BUILD
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`
**Depends on:** WO-001 through WO-012 accepted through `7d8ced2`

## 1. Outcome

Persist one authorized manager decision and its resulting Workflow/Expectation projection changes in one tenant transaction, using the current immutable S2 record as the verification snapshot.

```text
manager ActorContext + controlled action
  -> current Expectation transition + persisted S2
  -> immutable ManagerDecision
  -> authoritative Workflow/Expectation transition
```

Only a manager may close, keep open or void. No model, parser or client body may write Workflow status or fabricate the Verification snapshot.

## 2. Minimal files

```text
src/persistence/migrations/0005_manager_decision_saga.sql
src/persistence/manager-decision-repository.ts
src/domain/workflow-saga.ts
test/postgres-manager-decision-repository.test.ts
test/postgres-schema.test.ts
README.md
```

Extract and reuse one pure manager-action guard from the existing in-memory Saga rather than creating a second rule set. Reuse current persistence contracts and transaction helpers. Do not add a dependency, ORM, generic command bus or workflow framework.

## 3. Schema hardening

Migration `0005_manager_decision_saga.sql` must leave migrations `0001` through `0004` unchanged and:

- bind each new `manager_decision` to one immutable `s2_verification` record;
- store the decided Expectation state and Verification evaluation time as immutable snapshots;
- bind clinic, Workflow, Expectation, Verification status and evaluation time through composite foreign keys/unique identities;
- require `decided_at >= verification_evaluated_at`;
- reject duplicate/null evidence IDs and require non-empty evidence;
- enforce the action shape at SQL level:
  - `CLOSE_STANDARD`: `MET + VERIFIED`;
  - `CLOSE_EXCEPTION`: `UNMET + controlled reason`;
  - `KEEP_OPEN`: only `OPEN | UNMET`, with a reason for `UNMET`;
  - `VOID`: controlled reason;
- extend Expectation transitions with a controlled source so existing rows remain `DETERMINISTIC`, while a human `OPEN | UNMET | MET -> VOIDED` transition is legal;
- keep decision and transition rows append-only and tenant-RLS protected.

Migration failure on incompatible pre-existing rows is preferable to silently weakening these constraints.

## 4. Command

Expose one authoritative operation equivalent to:

```ts
recordManagerDecision(context, {
  id,
  expectationId,
  action,
  reasonCode,
  note,
  decidedAt,
})
```

The caller supplies no clinic, actor identity/role, Workflow status, Expectation state, Verification status/reasons, Verification ID or evidence lineage.

Before acquisition:

- synchronously snapshot inputs;
- require valid `ActorContext` with `role === MANAGER`;
- validate exact input keys, non-empty IDs, strict zoned ISO decision time, controlled action/reason and trimmed note up to 500 characters.

Within one tenant transaction for a new decision:

1. lock the tenant-scoped current Expectation and its Workflow in the established order;
2. require the Workflow is `OPEN`;
3. locate the current immutable Expectation transition and current persisted `S2_V1` record;
4. require decision time is no earlier than Expectation/Verification evaluation;
5. load Workflow Links visible by decision time in deterministic order and derive decision evidence IDs;
6. validate the action through the same pure guard used by the in-memory Saga;
7. append the immutable ManagerDecision;
8. apply exactly one projection result atomically:
   - standard/exception close: Workflow `CLOSED`;
   - keep open: Workflow remains `OPEN` and only `updated_at` advances;
   - void: append a human Expectation transition, set current Expectation `VOIDED`, and set Workflow `VOIDED`;
9. read back and return detached values.

No automatic close exists.

## 5. Idempotency and concurrency

- Exact decision replay returns the stored decision and current resulting projections even after terminal closure.
- Reuse of a decision ID with different expectation, actor, action, reason, note or time fails with a stable conflict.
- A terminal Workflow rejects any different later decision.
- The Workflow row lock serializes competing decisions.
- Decision append, optional VOID transition, Expectation update and Workflow update commit or roll back together.
- Projection updates use expected prior state/time and fail closed on a lost update.
- Returned arrays/objects are detached; caller mutation cannot change persisted data.

## 6. Required tests

1. `CLOSE_STANDARD` requires current persisted `MET + VERIFIED`, closes Workflow and stores exact S2 snapshot;
2. `CLOSE_STANDARD` rejects PENDING/CONFLICT or non-MET without writes;
3. `CLOSE_EXCEPTION` closes only current `UNMET` with a controlled reason and preserves `UNMET` history;
4. `KEEP_OPEN` supports OPEN and reasoned UNMET without hiding history;
5. `VOID` appends a human `-> VOIDED` Expectation transition and atomically voids both projections;
6. employee/wrong-clinic context fails before mutation;
7. absent/stale/mismatched Verification or source transition fails closed;
8. decision time before evaluation and malformed/non-zoned time fail;
9. decision evidence is derived only from Links visible at decision time;
10. exact replay is idempotent after closure; conflicting ID reuse fails;
11. competing later decision on terminal Workflow fails;
12. forced decision, VOID transition, Expectation update or Workflow update failure rolls back all effects;
13. caller authority/verdict/evidence/status fields are rejected before acquisition;
14. caller mutation and returned-array mutation cannot alter stored data;
15. SQL rejects invalid action/state/verification combinations and broken Verification lineage;
16. append-only, composite tenant foreign keys and RLS remain enforced;
17. migration rerun/checksum and every earlier test remain green;
18. both demos remain green.

## 7. Honest boundary

This ticket does not claim:

- UI/API persistence parity;
- reopen, unvoid, unlink or correction flows;
- automatic scheduling, queueing or event dispatch;
- assignment/ActionItem persistence;
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

- No edits to migrations `0001` through `0004`.
- No UI, HTTP route, model/provider call, worker, retry framework or event bus.
- No reopen/unvoid/correction or ActionItem feature.
- No real PHI, destructive reset or direct remote push by the Builder.

## 10. Builder handoff

The Builder must read the Constitution and WO-003 plus WO-007 through WO-013, implement only this slice, run all acceptance commands, commit as `feat(persistence): add manager decision saga`, report exact files/tests/deviations, and not push before Architecture Review.
