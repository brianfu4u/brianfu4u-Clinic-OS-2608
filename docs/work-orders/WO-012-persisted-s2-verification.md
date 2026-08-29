# WO-012 — Persisted S2 Verification Ledger

**Status:** READY FOR BUILD
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`
**Depends on:** WO-001 through WO-011 accepted through `bebdbae`

## 1. Outcome

Persist the existing deterministic S2 result for one durable Expectation projection as an immutable, tenant-scoped verification record.

This ticket turns the already-tested pure `verifyS2` result into authoritative evidence for later persisted manager closure. The model remains unable to write or alter a verdict.

```text
Expectation transition + linked evidence
  -> deterministic verifyS2
  -> immutable Verification record
```

## 2. Minimal files

```text
src/persistence/migrations/0004_s2_verification.sql
src/persistence/verification-repository.ts
test/postgres-verification-repository.test.ts
test/postgres-schema.test.ts
README.md
```

Reuse `verifyS2`, `VerificationResult`, the existing row readers where practical, strict timestamps and `withTenantTransaction`. Small exports from an existing persistence file are allowed only when they remove duplication cleanly. Do not add a dependency, ORM, generic ledger framework or second verification engine.

## 3. Durable record

Add append-only `s2_verification` with:

- `clinic_id`, `id`, `workflow_id`, `expectation_id`;
- `source_transition_id`, identifying the exact Expectation projection evaluated;
- `verifier_version`, fixed to `S2_V1` in this ticket;
- `status: PENDING | VERIFIED | CONFLICT`;
- controlled `reason_codes`;
- nullable `trigger_artifact_id` and `consequence_artifact_id`;
- exact ordered `evidence_artifact_ids`;
- `evaluated_at`, equal to the source Expectation transition instant;
- tenant-composite foreign keys to Workflow, Expectation, source transition and selected Artifacts;
- one record per clinic, source transition and verifier version;
- append-only UPDATE/DELETE refusal;
- `ENABLE + FORCE RLS` and tenant `USING + WITH CHECK` policy.

Row constraints must enforce:

- `VERIFIED` has no reasons, has both trigger and consequence, and evidence is exactly `[trigger, consequence]`;
- `CONFLICT` has at least one controlled reason;
- every non-null selected Artifact appears in `evidence_artifact_ids`;
- arrays contain no nulls or duplicate evidence IDs;
- `verifier_version` is non-empty.

The database protects shape and lineage. Only the deterministic engine calculates the verdict.

## 4. Operation

Expose one operation equivalent to:

```ts
verifyCurrentExpectation(context, expectationId)
```

Before acquisition:

- synchronously snapshot and validate ActorContext and non-empty Expectation ID;
- expose no caller fields for status, reasons, evidence, time, version, Workflow or transition authority.

Within one tenant transaction:

1. lock and read the tenant-scoped current Expectation;
2. lock and read its Workflow;
3. locate exactly one immutable Expectation transition whose `evaluated_at` and `to_state` match the current projection;
4. for a new verification require the Workflow remains `OPEN`; a terminal Workflow may only replay an already persisted matching record;
5. load all Workflow-linked Artifacts in deterministic order, retaining identity/time/kind conflicts for S2 diagnosis;
6. include only Links visible at the source transition time (`attached_at <= evaluated_at`);
7. call the existing pure `verifyS2` with stored Workflow, stored Expectation, visible linked Artifacts and stored evaluation time;
8. construct a deterministic `S2_V1` record, insert idempotently, read back and compare exact content;
9. return a detached `VerificationResult` plus immutable record metadata.

No clock read, model call or caller verdict is allowed.

## 5. Idempotency and consistency

- Record ID is deterministic from clinic, source transition and verifier version.
- Exact replay returns the existing record without duplicates.
- If the same deterministic identity now computes different content, fail with a stable conflict and write nothing. A backdated Link cannot silently rewrite an old verdict.
- Source transition, Expectation and Workflow identities must agree.
- `evaluatedAt` and verdict evidence must be derived from the stored source transition/projection.
- Invalid stored timestamps, malformed rows, missing source transition or link timestamps fail closed.
- Returned arrays and objects are detached.

## 6. Required tests

1. current `MET` projection with exact trigger/consequence persists `VERIFIED`;
2. `OPEN` and `UNMET` projections persist deterministic `PENDING` reasons;
3. conflicting identity, kind, time or missing evidence persists `CONFLICT`, never `VERIFIED`;
4. only Links visible at the source transition time are evaluated;
5. Artifact input order cannot change the stored result;
6. source transition must match current Expectation state, time, Workflow and tenant;
7. missing/cross-clinic Expectation or Workflow fails closed;
8. terminal Workflow permits exact replay but rejects a new verification;
9. exact replay is idempotent;
10. deterministic record conflict fails without mutation;
11. forced insert/read failure rolls back with no partial row;
12. invalid context/ID fails before connection acquisition;
13. caller mutation during acquisition cannot change authority;
14. returned reason/evidence arrays are detached;
15. SQL rejects invalid VERIFIED/CONFLICT shapes, duplicate evidence and duplicate source-version records;
16. append-only, composite foreign keys and RLS fail closed;
17. migration rerun/checksum and every earlier test remain green;
18. both demos remain green.

## 7. Honest boundary

This ticket does not claim:

- persisted manager decisions or Workflow closure;
- automatic scheduling, queueing or event dispatch;
- Verification supersession across verifier versions;
- UI/API persistence parity;
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

- No edits to migrations `0001` through `0003`.
- No changes to S2 verdict rules unless a correctness defect is first reported to Architecture Review.
- No model/provider call, UI wiring, worker, retry framework or generic event bus.
- No manager decision, Workflow close or VOID persistence.
- No real PHI, destructive reset or direct remote push by the Builder.

## 10. Builder handoff

The Builder must read the Constitution and WO-004 plus WO-007 through WO-012, implement only this slice, run all acceptance commands, commit as `feat(persistence): add S2 verification ledger`, report exact files/tests/deviations, and not push before Architecture Review.
