# Clinic OS

Clinic OS turns clinic artifacts into traceable workflows and manager closure views.

This repository contains the WO-001 in-memory domain tracer, the WO-002 local preview shell,
and the WO-003 append-only human decision ledger:

```text
employee report -> Artifact -> EvidenceFactCard -> Workflow -> Expectation -> manager view
manager decision -> immutable ledger -> authoritative Workflow transition
```

Requirements: Node.js 24 or newer.

```bash
npm test
npm run demo
npm run preview
```

Open `http://127.0.0.1:3000/employee` for the employee preview or
`http://127.0.0.1:3000/manager` for the manager preview. The implementation
uses in-memory synthetic data only and is not a production application.

## PostgreSQL acceptance boundary

`npm run db:migrate` applies checksum-guarded migrations to an explicitly supplied
`DATABASE_URL`. PostgreSQL schema semantics are tested with PGlite in the restricted
development executor. Real PostgreSQL server integration, application-role RLS
enforcement, backup and restore remain required before production or clinic use.

The tenant-scoped capture repository persists only Artifact + EvidenceFactCard through
the same SQL-semantic harness. The preview still uses synthetic in-memory state; preview
persistence parity and durable Workflow/Expectation/Decision operations are not complete.
PostgreSQL `timestamptz` stores instants rather than the input timestamp spelling. Capture
replay therefore compares only the declared Artifact/FactCard timestamp fields by instant;
identity anchors, payload fields and all other strings remain exact.
Atomic `ON CONFLICT` capture writes remove the application SELECT-to-INSERT race. Real
PostgreSQL concurrent replay remains part of the existing real-server acceptance gate.
Authoritative Workflow attach persistence now covers exact match, deterministic creation
and append-only Link writes only; Expectation and later closure persistence remain separate.
