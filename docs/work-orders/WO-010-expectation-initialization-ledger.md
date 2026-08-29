# WO-010 — Expectation Initialization Ledger

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-009 accepted through `8070bfa`  

## 1. Outcome

Initialize one durable Expectation from an open Workflow's already-linked, exact trigger evidence and append one immutable initialization transition in the same tenant transaction.

The current Expectation row is a projection. The transition row preserves how its first state became `OPEN`, `MET` or `UNMET`; initialization must never create a triggerless expectation or silently overwrite history.

This ticket does not re-evaluate an existing Expectation after later evidence. That is WO-011.

## 2. Minimal files

```text
src/persistence/migrations/0002_expectation_transition.sql
src/persistence/expectation-repository.ts
test/postgres-expectation-repository.test.ts
```

Small edits to schema tests, README and a shared strict timestamp helper are allowed when required. Do not change `0001_trusted_core.sql`, add a dependency, ORM or generic event framework.

## 3. Schema addition

Add `expectation_transition` with:

- `clinic_id`, `id`, `expectation_id`, `workflow_id`;
- `from_state`, nullable only for initialization;
- `to_state` in `OPEN | MET | UNMET | VOIDED`;
- `evaluated_at`;
- `trigger_artifact_id`;
- `satisfied_by_artifact_id`, required only when `to_state = MET`;
- non-empty `evidence_artifact_ids` containing the trigger and, for MET, the satisfying Artifact;
- composite tenant foreign keys to Expectation, Workflow, trigger Artifact and optional satisfying Artifact;
- append-only UPDATE/DELETE refusal;
- `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and tenant `USING + WITH CHECK` policy identical in authority to existing business tables.

Initialization rows require `from_state IS NULL`; later transition shapes may be added by WO-011 without weakening this migration's constraints.

## 4. Operation

Expose one operation equivalent to:

```ts
initializeExpectation(context, workflowId, spec, evaluatedAt)
```

where `spec` uses the existing `ExpectationSpec` fields except `voided` is prohibited in this ticket.

Before acquisition:

- synchronously snapshot inputs;
- validate ActorContext, IDs and strict ISO timestamps with explicit zone;
- require `triggeredAt <= dueAt` and `triggeredAt <= evaluatedAt`;
- reject `voided` and caller-supplied state, satisfying evidence, transition ID, evidence IDs or Workflow authority fields.

Within one tenant transaction:

1. lock and read the Workflow; require it exists and is `OPEN`;
2. read its append-only Links and linked Artifacts in deterministic `occurred_at, id` order;
3. require an exact trigger Artifact whose kind equals `triggerKind`, identity equals the Workflow identity, and occurrence instant equals `triggeredAt`;
4. build the baseline Expectation and call the existing deterministic `evaluateExpectation` with linked Artifacts and explicit `evaluatedAt`;
5. insert the Expectation projection and one initialization transition atomically;
6. return detached Expectation and transition values.

No model, client verdict or database trigger may calculate the state.

## 5. Idempotency and conflicts

- IDs are deterministic from clinic and Expectation ID; never random or database-generated.
- Exact replay returns the existing current Expectation and initialization transition without duplicates.
- Reuse of the Expectation or transition ID with different workflow, rule, time, state or evidence fails with a stable DomainError and no writes.
- If an exact initialization is replayed after WO-011 later changes the current projection, it must not recreate or roll back history; this forward-compatible case may return the current row only when immutable initialization identity/rule fields still match.
- Transition insertion failure rolls back a newly inserted Expectation.

## 6. Required tests

1. valid trigger initializes `OPEN` before due time;
2. already-linked in-window consequence initializes `MET` with exact evidence lineage;
3. due boundary without consequence initializes `UNMET`;
4. consequence before trigger or in the future cannot initialize `MET`;
5. missing, wrong-kind, near-identity or unlinked trigger fails without writes;
6. missing/terminal/cross-clinic Workflow fails closed;
7. invalid/reversed/non-zoned/impossible timestamps fail before acquisition;
8. caller authority/verdict fields are inert or rejected;
9. exact replay is idempotent;
10. Expectation and transition ID conflicts roll back atomically;
11. forced transition failure leaves no Expectation;
12. transition UPDATE and DELETE fail;
13. transition cross-tenant foreign keys and RLS policy shape fail closed;
14. caller mutation during acquisition cannot alter persisted values;
15. returned nested arrays are detached;
16. migration rerun/checksum behavior and all earlier tests remain green;
17. both demos remain green.

## 7. Honest boundary

This ticket does not claim:

- later evidence re-evaluation or `UNMET -> MET` history;
- VOID or manager-decision transitions;
- persisted S2 Verification;
- preview/API persistence parity;
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

- No edits to migration 0001.
- No generic event store, ORM, retry framework, worker or UI wiring.
- No update of an existing Expectation state in this ticket.
- No model/provider call, conversation persistence, real PHI, destructive reset or remote push.

## 10. Builder handoff

The Builder must read the Constitution and WO-007 through WO-010, implement only this slice, run all acceptance commands, commit as `feat(persistence): add expectation initialization ledger`, report exact files/tests/deviations, and not push before Architecture Review.
