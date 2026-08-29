# WO-007 — PostgreSQL Schema Foundation

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-006 accepted through `6cff5e3`  

## 1. Outcome

Create the first production-target PostgreSQL schema and migration boundary for the trusted Phase 1 core.

This ticket proves SQL semantics inside the current restricted executor with PGlite, a PostgreSQL WASM test engine. Production runtime remains PostgreSQL server through the `pg` driver. PGlite is test-only and must never be selected by a RuntimeManifest.

This ticket does not claim server-level PostgreSQL integration is complete. That remains a separate hard acceptance gate when a real PostgreSQL server or container runtime is available.

## 2. Dependency decision

Add exactly:

- runtime dependency: `pg@8.23.0`;
- development dependency: `@electric-sql/pglite@0.5.8`.

Commit `package-lock.json`. Do not add an ORM, migration framework, query builder or validation library.

## 3. Migration layout

Use a minimal ordered layout:

```text
src/persistence/migrations/0001_trusted_core.sql
src/persistence/migration-runner.ts
src/persistence/node-pg-client.ts
test/postgres-schema.test.ts
```

The migration runner accepts a narrow SQL client contract and records applied migration IDs plus SHA-256 checksums in `schema_migration`.

Rules:

- apply migrations in filename order;
- one transaction per migration;
- re-running an identical migration is a no-op;
- an applied ID with changed checksum fails closed;
- a failed migration records nothing;
- reject unknown or duplicate migration IDs before executing SQL.

`node-pg-client.ts` is the production connection adapter for a supplied `DATABASE_URL`. It must not contain credentials, defaults or automatic cloud connections.

## 4. Tables

Create only these Phase 1 tables:

### `artifact`

- all WO-001 Artifact fields;
- `payload` as `jsonb`;
- primary key `(clinic_id, id)`;
- immutable after insert: UPDATE and DELETE refused by trigger;
- `occurred_at IS NULL` requires source `unknown`; non-null may not use `unknown`;
- patient identity values are stored verbatim; SQL must not normalize them.

### `evidence_fact_card`

- all WO-001 FactCard fields;
- `fields` as `jsonb`;
- `missing_fields` and lineage IDs as text arrays;
- FK `(clinic_id, artifact_id)` → Artifact;
- confidence check `[0,1]`;
- parser output cannot write operational verdict columns because none exist.

### `workflow`

- all WO-001 Workflow fields;
- primary key `(clinic_id, id)`;
- status check `OPEN/CLOSED/VOIDED`;
- patient Workflow requires non-empty exact identity anchor;
- no `session_id` or clinical-only business-line enum.

### `workflow_artifact_link`

- all WO-001 link fields;
- composite FKs to Workflow and Artifact within the same clinic;
- unique `(clinic_id, workflow_id, artifact_id)`;
- append-only; UPDATE and DELETE refused;
- `reasoning_chain` non-empty text array.

### `expectation`

- all WO-001 Expectation fields;
- composite FK to Workflow;
- state check `OPEN/MET/UNMET/VOIDED`;
- `due_at >= triggered_at`;
- MET requires `satisfied_by_artifact_id`; non-MET requires null;
- satisfying Artifact FK remains tenant-scoped.

### `manager_decision`

- all WO-003/WO-004 ManagerDecision fields;
- composite FK to Workflow and Expectation;
- actor role fixed to `MANAGER`;
- action and controlled reason-code checks;
- verification status check `PENDING/VERIFIED/CONFLICT`;
- evidence and verification reason arrays;
- append-only; UPDATE and DELETE refused.

### `schema_migration`

- migration ID primary key;
- SHA-256 checksum;
- applied timestamp supplied by PostgreSQL;
- not tenant-scoped because it is platform schema metadata.

## 5. Tenant isolation

Every business table contains non-null `clinic_id` and enables plus forces Row Level Security.

Use one policy per table based on the exact transaction-local setting:

```sql
clinic_id = current_setting('app.clinic_id', true)
```

Both `USING` and `WITH CHECK` are required. No fallback clinic and no hard-coded demo clinic.

The application adapter must set `app.clinic_id` with `set_config(..., true)` inside each transaction before tenant queries. This ticket tests policy SQL semantics but does not create production database roles; owner/superuser bypass behavior must be documented as a real-server acceptance item.

## 6. Append-only trigger

Use one small shared trigger function to refuse UPDATE/DELETE on append-only tables. Apply it to:

- `artifact`;
- `workflow_artifact_link`;
- `manager_decision`.

Do not make Workflow append-only; its status transitions are authoritative updates. Do not add soft-delete columns speculatively.

## 7. Production migration command

Add:

```bash
npm run db:migrate
```

It must:

- require explicit `DATABASE_URL`;
- open a `pg` connection;
- apply repository migrations;
- print only applied migration IDs/count, never the connection string;
- close the connection on success or failure;
- perform no schema reset or destructive cleanup.

## 8. Test boundary

PGlite tests execute the exact `.sql` file used by PostgreSQL server. They must be clearly marked test-only.

Required tests:

1. Fresh migration creates every required table and constraint.
2. Identical rerun is a no-op.
3. Changed checksum for an applied ID fails closed.
4. Failed migration leaves no migration ledger row.
5. Artifact insert/read preserves exact identity anchor and JSON payload.
6. Artifact UPDATE and DELETE fail.
7. Missing/unknown occurred-at provenance combinations are constrained.
8. FactCard cross-tenant Artifact FK fails.
9. Workflow patient anchor cannot be null/blank.
10. Link duplicate and cross-tenant FKs fail.
11. Link UPDATE/DELETE fail.
12. Expectation due-before-trigger and inconsistent MET/satisfied artifact fail.
13. ManagerDecision invalid actor/action/reason/verification state fails.
14. ManagerDecision UPDATE/DELETE fail.
15. Every business table declares, enables and forces RLS with both policy clauses.
16. Migration SQL contains no hard-coded clinic ID, credentials, extension download or network function.
17. `db:migrate` without `DATABASE_URL` fails before connection attempt.
18. Existing tests remain green.

## 9. Honest acceptance boundary

This work order may be marked complete when PGlite SQL tests and all existing tests pass. It must carry this explicit note in README or persistence documentation:

> PostgreSQL schema semantics are tested with PGlite in the restricted development executor. Real PostgreSQL server integration, application-role RLS enforcement, backup and restore remain required before production or clinic use.

Do not claim:

- real server integration;
- production RLS role enforcement;
- persistence adapter parity;
- backup/restore completion.

## 10. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
```

`npm run db:migrate` without `DATABASE_URL` must fail safely with `DATABASE_URL_REQUIRED` and must not print secrets.

## 11. Prohibited scope

- No SQLite.
- No PGlite in production source paths or RuntimeManifest kinds.
- No ORM or migration framework.
- No schema reset/drop command.
- No real PHI.
- No conversation tables yet.
- No backup implementation yet.
- No persistent repository implementation beyond migration execution.

## 12. Builder handoff

The Builder must:

1. read the Constitution and WO-001 through WO-007 before editing;
2. install only the two frozen dependencies and commit the lockfile;
3. implement only this schema/migration ticket;
4. run every acceptance command and safe missing-URL check;
5. commit with message `feat(persistence): add PostgreSQL schema foundation`;
6. report SHA, test count, migration tests, dependency tree and deviations;
7. not push until Architecture Review is complete.
