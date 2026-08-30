# Real PostgreSQL acceptance runbook

WO-018 is a destructive acceptance gate for dedicated synthetic test databases. Never point it at
a development, staging, production or patient-data database. Both database names must end exactly
`_wo018_acceptance`.

## Prerequisites

- PostgreSQL Server 16 or 17;
- matching `pg_dump` and `pg_restore` major version 16 or 17 on `PATH`;
- two different empty dedicated databases;
- one admin LOGIN and one non-owner application LOGIN for each database;
- application roles must be `NOSUPERUSER NOBYPASSRLS`;
- admin roles must be able to migrate, grant and reset the dedicated public schemas.

Use disposable credentials and export all four URLs without printing them:

```bash
export WO018_SOURCE_ADMIN_URL='postgresql://.../clinic_source_wo018_acceptance'
export WO018_SOURCE_APP_URL='postgresql://.../clinic_source_wo018_acceptance'
export WO018_RESTORE_ADMIN_URL='postgresql://.../clinic_restore_wo018_acceptance'
export WO018_RESTORE_APP_URL='postgresql://.../clinic_restore_wo018_acceptance'
npm run accept:postgres-real
```

The source and restore URLs for one database must use different roles. The source and restore
database names must differ. The restore database must contain none of the Clinic OS business
tables before the command starts.

## What it changes

The command resets the source public schema, applies repository migrations, grants the minimum
application table access, and seeds only `WO018-` synthetic rows. It creates a custom-format dump,
restores it into the preflighted empty restore database, compares logical contents and verifies the
restored application role. Temporary dump content is removed in `finally`.

The harness resets both dedicated public schemas during cleanup, including on a failed assertion.
Loss of those dedicated databases is therefore expected and intentional.

## Required result

Success ends with `[WO018][PASS]` and a zero exit status. Any missing URL, binary, unsafe database
name, role violation, failed RLS/concurrency assertion or backup mismatch exits non-zero with a
stable acceptance code. URLs, passwords, row payloads and raw database errors are not printed.

The gate covers real application-role RLS, pooled tenant-setting cleanup, accepted repository
read/write, concurrent attach replay, shared-Workflow attach, `SKIP LOCKED`, manager-decision races,
batch/manager coherence, and `pg_dump -> pg_restore` parity. It deliberately does not claim that two
different first Artifacts concurrently create only one same-identity Workflow; that remains a
separate product/schema decision.
