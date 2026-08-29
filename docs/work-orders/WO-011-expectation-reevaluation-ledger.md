# WO-011 — Expectation Re-evaluation Ledger

**Status:** ACCEPTED
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-010 accepted through `dd643dd`  

## 1. Outcome

Re-evaluate one durable, non-terminal Expectation from the evidence actually linked to its open Workflow at an explicit time, update the current projection, and append an immutable evaluation transition in the same tenant transaction.

The essential recovery path is:

```text
OPEN -> UNMET -> MET
```

The final `MET` is allowed only when evidence occurred inside the original trigger/due window but became visible after the earlier `UNMET` evaluation. The prior `UNMET` transition remains immutable; late evidence never rewrites history.

## 2. Minimal files

```text
src/persistence/migrations/0003_expectation_reevaluation.sql
src/persistence/expectation-repository.ts
test/postgres-expectation-repository.test.ts
```

Small edits to schema tests and README are allowed. Reuse the existing evaluator, strict timestamp parser, tenant transaction, row mappers and transition contract. Do not add a dependency, ORM, event framework, worker or new repository abstraction.

## 3. Schema hardening

Migration `0003_expectation_reevaluation.sql` must:

- preserve `0001` and `0002` unchanged;
- allow only automatic non-initialization paths `OPEN -> OPEN | UNMET | MET` and `UNMET -> UNMET | MET`;
- reject automatic regression from `MET` or `VOIDED` and reject `UNMET -> OPEN`;
- make `(clinic_id, expectation_id, evaluated_at)` unique so one Expectation cannot record two different evaluations at the same instant;
- retain the existing tenant foreign keys, RLS and append-only trigger.

No SQL trigger may calculate an Expectation verdict.

## 4. Operation

Add one operation equivalent to:

```ts
reevaluateExpectation(context, expectationId, evaluatedAt)
```

It returns the detached current Expectation and either the newly appended/replayed transition or `null` when the same current evaluation is an exact no-op.

Before acquisition:

- synchronously snapshot inputs;
- validate ActorContext, non-empty ID and strict ISO timestamp with explicit zone;
- reject caller-supplied state, evidence, Workflow, transition ID or authority fields by exposing no input object for them.

Within one tenant transaction:

1. lock and read the tenant-scoped Expectation;
2. lock and read its Workflow and require it remains `OPEN`;
3. load its unique initialization transition and exact trigger Artifact;
4. read linked Artifacts in deterministic `occurred_at NULLS LAST, id` order;
5. include only Links whose `attached_at <= evaluatedAt` and Artifacts whose identity anchor exactly equals the Workflow anchor;
6. require the immutable trigger still exists in that visible exact chain;
7. reject an evaluation earlier than the current projection; the same instant is an idempotent no-op;
8. treat `MET` and `VOIDED` as automatic terminal states and do not create a later transition;
9. call the existing deterministic `evaluateExpectation` with the stored Expectation rule and explicit evaluation time;
10. append one deterministic transition and update the current Expectation projection atomically.

The transition must record the stored trigger, selected satisfying Artifact when `MET`, and exact evidence lineage. The operation must never trust a caller verdict or caller evidence list.

## 5. State and time rules

- `OPEN -> OPEN` records a later evaluation before the deadline when no valid consequence exists.
- `OPEN -> UNMET` records deadline passage without valid consequence.
- `OPEN -> MET` records an in-window consequence visible by evaluation time.
- `UNMET -> UNMET` records a later evaluation that still lacks valid in-window consequence.
- `UNMET -> MET` records late-arriving evidence only when its `occurred_at` is inside `[triggeredAt, dueAt]` and its Link is visible by evaluation time.
- An Artifact occurring after `dueAt`, before `triggeredAt`, after `evaluatedAt`, linked after `evaluatedAt`, with a near-match identity, or from another clinic cannot satisfy.
- Evaluation time is monotonic. A past evaluation fails closed and cannot mutate history.
- Once `MET` or `VOIDED`, automatic re-evaluation cannot change state or satisfying evidence.

## 6. Idempotency and atomicity

- A transition ID is deterministic from clinic, Expectation and evaluation instant; never random or client supplied.
- Replaying the same evaluation instant creates no duplicate and returns the stored current result.
- Reuse of a deterministic transition identity with different content fails with a stable DomainError.
- Transition insertion failure leaves the projection unchanged.
- Projection update failure leaves no transition.
- The Expectation row lock serializes evaluations of the same Expectation.
- Returned arrays and values are detached from stored state.

## 7. Required tests

1. `OPEN -> OPEN` appends one evaluation transition;
2. deadline passage performs `OPEN -> UNMET`;
3. visible in-window consequence performs `OPEN -> MET`;
4. late-linked but in-window evidence performs `UNMET -> MET` while preserving the earlier `UNMET` row;
5. post-deadline, pre-trigger, future, post-evaluation-link and near-identity evidence cannot satisfy;
6. stale time fails and same-time replay is idempotent;
7. `MET` and `VOIDED` cannot regress or replace satisfying evidence;
8. missing/cross-clinic Expectation and missing/terminal/cross-clinic Workflow fail closed;
9. missing, altered, unlinked or non-visible initialization trigger fails closed;
10. invalid/non-zoned/impossible timestamps and blank IDs fail before acquisition;
11. deterministic transition conflict fails without projection mutation;
12. forced transition failure and forced projection failure are atomic;
13. database constraint rejects illegal state paths and duplicate evaluation instants;
14. append-only/RLS/composite tenant constraints remain enforced;
15. caller mutation during acquisition cannot alter persisted values;
16. returned evidence arrays are detached;
17. migration checksum/rerun behavior and all earlier tests remain green;
18. both demos remain green.

## 8. Honest boundary

This ticket does not claim:

- automatic scheduling, polling, queueing or event dispatch;
- VOID or manager-decision persistence transitions;
- persisted S2 Verification;
- preview/API persistence parity;
- workflow closure persistence;
- real PostgreSQL application-role RLS/concurrency proof;
- backup/restore, production or real-PHI readiness.

## 9. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
```

## 10. Prohibited scope

- No edits to migrations `0001` or `0002`.
- No model/provider call, UI wiring, background worker, retry framework or generic event bus.
- No manager decision, VOID, Workflow close or S2 persistence in this ticket.
- No real PHI, destructive reset or direct remote push by the Builder.

## 11. Builder handoff

The Builder must read the Constitution and WO-007 through WO-011, implement only this slice, run all acceptance commands, commit as `feat(persistence): add expectation reevaluation ledger`, report exact files/tests/deviations, and not push before Architecture Review.

## 12. Architecture acceptance

Accepted on 2026-08-29 through `225a5e7` after independent review.

- 174/174 tests and both demos pass.
- Explicit re-evaluation preserves `OPEN -> UNMET -> MET` history without rewriting the earlier `UNMET` fact.
- Only exact-identity, linked and evaluation-time-visible evidence can satisfy the stored rule.
- Evaluation time is monotonic; `MET` and `VOIDED` do not automatically regress.
- Transition append and current-projection update commit or roll back as one tenant transaction.
- Migration `0003` rejects illegal automatic paths and duplicate evaluation instants.
- Constitution and migrations `0001`/`0002` remain unchanged; no dependency was added.

Scheduling, persisted manager/VOID transitions, persisted S2 Verification, real PostgreSQL application-role RLS/concurrency, backup and restore remain later acceptance gates.
