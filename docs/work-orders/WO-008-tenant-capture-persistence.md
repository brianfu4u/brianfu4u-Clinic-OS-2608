# WO-008 — Tenant Capture Persistence

**Status:** ACCEPTED
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-007 accepted through `c1ef8c3`  

## 1. Outcome

Persist one trusted capture unit — an immutable `Artifact` plus its derived `EvidenceFactCard` — through one tenant-scoped PostgreSQL transaction.

This establishes the narrow async persistence port used by future capture/OCR modules without moving matching, closure or model judgment into the database. It does not wire the preview server to PostgreSQL yet.

## 2. Minimal files

Add only:

```text
src/persistence/database-contracts.ts
src/persistence/tenant-transaction.ts
src/persistence/capture-repository.ts
src/persistence/node-pg-pool.ts
test/postgres-capture-repository.test.ts
```

Small edits to existing persistence files, exports, README and tests are allowed when required. Add no dependency and no ORM.

## 3. Database contracts

Define the smallest structural contracts needed for:

- parameterized `query(text, values)`;
- an acquired connection that can `BEGIN`, `COMMIT`, `ROLLBACK` and release;
- a pool that can acquire that connection.

The repository depends on these contracts, not directly on `pg`. `node-pg-pool.ts` is the only production adapter allowed to import `pg` for this ticket.

## 4. Tenant transaction boundary

Expose one function or class operation equivalent to:

```ts
withTenantTransaction(clinicId, operation)
```

Required order on the same acquired connection:

1. reject missing/blank `clinicId` before acquisition;
2. `BEGIN`;
3. `SELECT set_config('app.clinic_id', $1, true)` with the exact clinic ID as a bound parameter;
4. run the operation;
5. `COMMIT` on success;
6. `ROLLBACK` on any failure;
7. release exactly once on every acquired path.

Never interpolate the clinic ID into SQL. Do not allow a caller to obtain or retain the raw connection outside the callback.

## 5. Capture write contract

Expose one async operation equivalent to:

```ts
saveCapture(context, artifact, factCard)
```

Rules:

- validate `ActorContext`; only `EMPLOYEE` and `MANAGER` may call it in this ticket;
- derive authoritative `clinic_id` from `ActorContext`, never from request-body authority fields;
- Artifact and FactCard clinic IDs must exactly equal the context clinic;
- FactCard must reference the supplied Artifact and include its ID in lineage;
- preserve identity anchor, timestamps and JSON fields verbatim;
- insert Artifact first, then FactCard, in one tenant transaction;
- use only parameterized SQL;
- return detached domain-shaped copies, not driver result objects.

No model/provider call is allowed in this repository.

## 6. Idempotency and conflicts

Replaying byte-equivalent domain content with the same IDs succeeds and creates no duplicate row.

Reusing either ID with different content fails closed with a stable domain error and rolls back the transaction. Do not update, merge or silently normalize an existing row.

Equality is semantic at the domain boundary: JSON object key order must not create a false conflict, while array order remains meaningful. Dates and anchors must not be rewritten merely to make equality pass.

## 7. Read contract

Provide tenant-scoped reads sufficient to verify the write:

- `getArtifact(context, artifactId)`;
- `getFactCard(context, factCardId)`.

They run through the same tenant transaction boundary, return `null` when absent in the active clinic, and never accept a separate caller-supplied clinic ID. Returned values are detached copies.

## 8. Production pool adapter

`node-pg-pool.ts` may create a `pg.Pool` only from an explicit supplied connection string or configuration object. It must have:

- no default URL;
- no credentials in source or logs;
- an explicit close operation;
- no connection attempt at module import;
- no PGlite import or fallback.

Do not change RuntimeManifest provider kinds in this ticket.

## 9. Test boundary

Use PGlite only as the existing SQL-semantic harness. Execute the repository migration file, then exercise the same repository and transaction code through a narrow PGlite pool shim located in the test file.

Required tests:

1. exact tenant setting occurs after BEGIN and before the first business query;
2. success commits and releases once;
3. failure rolls back and releases once;
4. blank clinic fails before connection acquisition;
5. Artifact + FactCard persist atomically and round-trip verbatim;
6. malformed lineage or mismatched clinic fails without either row;
7. equivalent replay is idempotent, including reordered JSON object keys;
8. conflicting Artifact replay fails without changing either row;
9. conflicting FactCard replay rolls back a newly inserted Artifact;
10. same IDs may exist in two clinics and reads remain isolated;
11. context clinic cannot be overridden by payload fields;
12. SQL injection text in clinic/IDs remains data, not SQL;
13. reads return detached values;
14. production adapter performs no connection on import and has no fallback URL;
15. all prior tests and both demos remain green.

## 10. Honest acceptance boundary

PGlite can validate transaction flow and PostgreSQL SQL semantics, but it cannot prove application-role RLS against a real server in this executor. The existing real-server acceptance boundary remains open and must stay visible in documentation.

This ticket must not claim:

- preview/API persistence parity;
- durable Workflow/Expectation/Decision operations;
- real PostgreSQL application-role RLS;
- backup/restore readiness;
- production or real-PHI readiness.

## 11. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
```

The worktree must be clean after the implementation commit.

## 12. Prohibited scope

- No ORM, query builder or validation package.
- No schema expansion unless an existing constraint defect blocks the ticket and Architecture Review approves it first.
- No preview-server wiring.
- No conversation persistence.
- No Workflow matching or decision persistence adapter yet.
- No PGlite production path.
- No real PHI, destructive reset or remote push.

## 13. Builder handoff

The Builder must:

1. read the Constitution and WO-007/WO-008 before editing;
2. implement only this capture persistence slice;
3. write negative fixtures before accepting the happy path;
4. run all acceptance commands;
5. commit with message `feat(persistence): add tenant capture repository`;
6. report SHA, test count, exact files, dependency changes and deviations;
7. not push until Architecture Review is complete.

## 14. Architecture acceptance

Accepted on 2026-08-29 through `0e7d2b3` after independent review and repair.

- 129/129 tests and both demos pass.
- Patient FactCard identity is checked against its source Artifact before acquisition.
- Inputs are synchronously snapshotted before the first asynchronous boundary.
- Tenant query capability expires when its transaction callback settles.
- Atomic `ON CONFLICT DO NOTHING` writes replace the application `SELECT`-then-`INSERT` race.
- Declared `timestamptz` fields compare by instant on replay; identity anchors, JSON and other strings remain exact.

Real PostgreSQL multi-connection concurrency, application-role RLS, backup and restore remain part of the real-server acceptance gate and are not claimed by this ticket.
