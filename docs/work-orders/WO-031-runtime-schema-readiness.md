# WO-031 — Runtime Schema Compatibility Readiness

**Status:** Architecture frozen / Builder ready  
**Architect:** Codex Architecture Designer  
**Depends on:** Constitution; WO-007, WO-018, WO-027, WO-030

## 1. Outcome

Make the configured On-Prem runtime fail closed unless its explicitly supplied PostgreSQL
database has exactly the migration ledger required by the checked-in application.

The existing startup readiness probe proves only `SELECT 1`. A reachable empty, stale, or
checksum-drifted database could therefore advertise `ready` and fail only when the first clinical
write arrives. This work order turns schema compatibility into a bounded readiness dependency.

`GET /api/readiness` must return `503` with the existing bounded `DATABASE_UNAVAILABLE` code when
the ledger is absent, unreadable, incomplete, has an unknown migration, or a migration checksum
does not equal the checked-in SQL checksum. It must reveal neither database identity nor migration
content. A complete exact ledger may become ready only if the other selected adapters are ready.

## 2. Scope

Minimal files:

```text
src/persistence/migration-runner.ts
src/runtime/startup-config.ts
test/migration-runner.test.ts (or an existing focused test)
test/startup-config.test.ts / test/readiness.test.ts
README.md
```

Add one reusable, read-only migration-compatibility check that:

1. loads the repository migration list using the existing authoritative loader;
2. computes the same SHA-256 values used by `applyMigrations`;
3. reads only `schema_migration(id, checksum)` through the configured application pool;
4. accepts only one exact set of IDs and checksums (no missing, unknown, duplicate, or changed
   ledger entries); and
5. returns a detached boolean/result suitable for a readiness probe, never raw rows/errors.

The configured local runtime must use that check inside its database readiness probe, not a bare
`SELECT 1`. The check is read-only and must not create `schema_migration`, write migrations,
alter roles, or run a transaction with elevated authority.

## 3. Non-goals and invariants

- No automatic migration at application startup; `npm run db:migrate` remains an explicit
  administrative action.
- No schema migration, business/domain behavior, RLS policy, object-store, OCR, HTTP contract,
  authentication, backup implementation, Cloud adapter, Docker/CI or dependency change.
- This is not a substitute for WO-018 real-server RLS/concurrency/backup-restore acceptance.
- Never log or serialize `DATABASE_URL`, database names, hostnames, role names, SQL, migration
  checksums or raw driver errors.
- A healthy TCP connection with an incompatible schema is **not** ready.
- The synthetic preview keeps its existing explicit not-ready clinical status.

## 4. Acceptance tests

1. Fresh PGlite migrations produce an exact compatible result.
2. Missing ledger/table, missing expected migration, unknown migration, duplicate ID, malformed
   checksum and changed checksum each fail closed.
3. The compatibility check performs no writes; an absent ledger remains absent.
4. A configured runtime's database readiness probe calls compatibility rather than accepting a
   successful `SELECT 1` alone.
5. Readiness returns only the existing bounded database status/code for every incompatibility;
   neither readiness nor errors include URL/path/database/role/checksum/SQL data.
6. Existing regression, closure demo, local OCR gate and real PostgreSQL gate's intentional
   environment failure still behave as before.

## 5. Builder handoff

Implement only the bounded compatibility check and readiness wiring. Commit with:

```text
feat(runtime): gate readiness on schema compatibility
```

Do not push. Report focused tests, full regression, demos, local OCR result and the external
real-PostgreSQL gate separately.

## 6. External gate

WO-018 remains `IMPLEMENTED / ENVIRONMENT GATE OPEN` until the destructive suite passes on a
dedicated PostgreSQL 16/17 environment. WO-031 only prevents a deployed runtime from claiming
clinical readiness against the wrong schema; it does not prove application-role RLS or recovery.

## 7. Architecture review — 2026-08-31

**Status:** Accepted — Architecture Review passed

- Implementation: `d5392e4` (`feat(runtime): gate readiness on schema compatibility`).
- The local database readiness probe now invokes one read-only exact ledger comparison instead of
  `SELECT 1`; it releases the acquired application connection in `finally`.
- Independent attack review covered missing ledger, missing and unknown rows, checksum drift,
  exceptions, no-write behavior and secret/error redaction. All fail closed through the existing
  bounded `DATABASE_UNAVAILABLE` readiness result.
- Regression: 356/356 passed. Golden-path and persisted-closure demos passed. Local OCR: 2/2.
- `npm run accept:postgres-real` remains intentionally blocked with
  `ENVIRONMENT_REQUIRED`; no dedicated PostgreSQL 16/17 acceptance environment is configured in
  this workspace. WO-018 is still an external acceptance gate.
- No GitHub push was performed.
