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
Exact candidate rows and their source Artifact are locked during attach. Real PostgreSQL
close/attach and multi-worker interleavings remain deployment acceptance cases.
Expectation initialization now persists the current projection with one append-only,
tenant-scoped initialization transition. Explicit re-evaluation appends each automatic
`OPEN`/`UNMET`/`MET` transition atomically with the current projection, including preserved
`UNMET -> MET` recovery history. Scheduling, VOID and manager-decision persistence remain
separate work.
The current Expectation projection can now be passed through the existing deterministic
S2 engine and recorded in an immutable, tenant-scoped verification ledger. Persisted
manager decisions now bind that exact S2 snapshot to an immutable human record and update
Workflow/Expectation projections atomically, including append-only human VOID history.
The PostgreSQL manager closure read model returns tenant-scoped Workflow, Expectation,
Verification, evidence-ID and decision summaries without reading raw Artifact, FactCard,
employee-conversation or decision-note content. Incomplete chains remain explicit review items.
The restartable persisted golden-path application service now coordinates capture, authoritative
attach, Expectation evaluation and S2 Verification for explicit trigger and consequence commands.
Each repository stage remains its own short atomic transaction; replay resumes incomplete chains
without claiming a global Artifact-to-Verification transaction.
Preview/API persistence parity, reopen/correction flows, real PostgreSQL application-role
RLS/concurrency proof, backup and restore remain separate acceptance gates.
