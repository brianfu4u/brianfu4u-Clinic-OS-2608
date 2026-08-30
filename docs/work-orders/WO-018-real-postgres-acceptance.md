# WO-018 — Real PostgreSQL Server Acceptance Gate

**Status:** FROZEN
**Architect:** Codex Architecture Designer
**Depends on:** WO-001 through WO-017 accepted locally through `ff6ba00`

## 1. Outcome

Deliver one explicit, repeatable, destructive-by-design acceptance command for dedicated test databases only:

```bash
npm run accept:postgres-real
```

It validates real PostgreSQL application-role RLS, multi-connection locking and `pg_dump -> pg_restore`. Missing environment, binaries or privileges must exit non-zero; the command must never skip and print success.

The current Codex container cannot run PostgreSQL Server because it has no server/client binaries, container runtime or ability to switch away from root. Therefore this ticket can reach `IMPLEMENTED / ENVIRONMENT GATE OPEN` locally. It becomes `ACCEPTED` only after the command passes on an official PostgreSQL 16/17 CI service or dedicated On-Prem VM.

## 2. Minimal files

```text
acceptance/real-postgres.ts
acceptance/real-postgres.test.ts
docs/runbooks/postgres-real-acceptance.md
package.json
README.md
```

The acceptance test must stay outside `test/*.test.ts` so ordinary `npm test` never pretends to execute the real gate. No migration, production dependency, ORM, business-rule change or Docker requirement in product code.

## 3. Required environment

Require four explicit URLs:

- `WO018_SOURCE_ADMIN_URL`
- `WO018_SOURCE_APP_URL`
- `WO018_RESTORE_ADMIN_URL`
- `WO018_RESTORE_APP_URL`
- `WO018_ALLOW_DESTRUCTIVE_RESET=I_UNDERSTAND_WO018_DATABASES_WILL_BE_DROPPED`

Safety preflight before any write:

- source and restore resolve to different real database identities, using server system identifier plus database OID rather than URL/DNS spelling;
- both database names end exactly `_wo018_acceptance`;
- both source and restore `public` schemas contain no user tables, views, materialized views, sequences, foreign tables, functions or user-defined types before any destructive action;
- admin and app are different LOGIN roles;
- app is not owner, superuser or `BYPASSRLS`;
- `pg_dump` and `pg_restore` exist and report a supported major version;
- never print URLs, passwords, row payloads, PHI or raw database errors.

Use bounded statement/lock timeouts. Temporary dump files use an isolated temporary directory and are removed in `finally`.

Schema reset uses `DROP SCHEMA + CREATE SCHEMA` in one explicit transaction. No cleanup runs for a database that did not pass every safety preflight. Cleanup failure is a failed acceptance result; `PASS` may be printed only after successful cleanup and resource closure.

## 4. RLS gate

Apply accepted migrations through source admin, grant only required schema/table/sequence capabilities to app, then verify:

1. every business table has `ENABLE + FORCE RLS` and tenant USING/WITH CHECK policies;
2. app role remains LOGIN, NOSUPERUSER, NOBYPASSRLS and non-owner;
3. without transaction-local `app.clinic_id`, app reads no tenant rows and writes fail;
4. tenant A cannot read/write tenant B rows;
5. COMMIT/ROLLBACK and pooled connection reuse do not leak the prior clinic setting;
6. every business table receives synthetic rows for tenants A and B, and each tenant context can see only its own rows;
7. at least one accepted repository read/write runs through the real app connection.

## 5. Concurrency gate

Use distinct real app connections and inspect final database state, not only Promise results:

- same Artifact attach replay concurrently: one authoritative Link, identical result;
- two Artifacts concurrently attach to one already-existing exact open Workflow: both links target it, no duplicate Link;
- hold the earliest due Expectation lock on connection A; connection B batch uses `SKIP LOCKED` for the next row; after A releases, the first row processes once;
- two different manager decision IDs race on one Workflow: exactly one terminal decision wins and the loser is controlled;
- same manager decision ID replay remains one row;
- batch versus manager on one Expectation produces no deadlock, orphan transition, orphan Verification or incoherent projection.

Do not claim that two different first Artifacts concurrently create only one new same-identity Workflow. The current contract permits the split/ambiguity window; changing that requires a separate product/schema decision.

## 6. Backup and restore gate

Invoke binaries with argument arrays and `PG*` environment, never a shell command string:

```text
pg_dump --format=custom --no-owner --no-acl
pg_restore --exit-on-error --single-transaction --no-owner --no-acl
```

Record the dump SHA-256 without printing data. Restore only into the preflighted empty restore database, reapply minimum app grants, then verify:

- migration IDs and checksums;
- required tables, constraints, RLS/FORCE, policies and append-only triggers;
- per-table row count and canonical ordered logical digest for every business table and migration ledger;
- restored app is still non-owner/NOSUPERUSER/NOBYPASSRLS;
- restored app passes cross-tenant RLS and at least one accepted repository read/write.

Source and restore must also compare a canonical catalog digest for constraints, tenant policies and triggers. Exercise append-only protection with real UPDATE/DELETE attacks, not trigger-name inspection alone.

## 7. Harness behavior

- Stable labeled progress and failure codes; no connection strings or raw SQL errors.
- Any failed required assertion exits non-zero.
- Signal/exception cleanup removes temporary dump content and closes pools; cleanup errors cannot be swallowed into a successful exit.
- Query source/restore `server_version_num`; only 16/17 are accepted. `pg_dump` and `pg_restore` must share that server major.
- The harness may seed synthetic `WO018-` data only.
- `acceptance/real-postgres.test.ts` is the executable real-server suite, not a mocked unit test.

## 8. Local verification

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
npm run accept:postgres-real   # must fail closed here with ENVIRONMENT_REQUIRED
git diff --check
```

Local implementation acceptance requires ordinary tests green plus a controlled non-zero environment failure. It does not close the real-server gate.

## 9. Builder handoff

Implement only this acceptance harness/runbook, commit `test(postgres): add real server acceptance gate`, do not push, and report separately:

- ordinary regression result;
- local fail-closed result;
- real-server result as `NOT RUN` unless actually executed.

## 10. Architecture review — 2026-08-30

**Status:** `IMPLEMENTED / ENVIRONMENT GATE OPEN`

- Ordinary regression: 250/250 passed.
- Destructive-safety unit tests: 6/6 passed.
- Domain and runtime demos: passed.
- Local gate behavior: controlled non-zero `ENVIRONMENT_REQUIRED`.
- Independent review: passed after destructive confirmation, database identity, RLS,
  transactional cleanup, signal cancellation and binary timeout hardening.
- Real PostgreSQL 16/17 execution: `NOT RUN` in the current executor.

This status accepts the harness implementation only. WO-018 becomes `ACCEPTED` only after
`npm run accept:postgres-real` completes with `[WO018][PASS]` on a qualifying real server.
