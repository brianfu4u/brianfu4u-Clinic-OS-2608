# Clinic OS

Clinic OS turns clinic artifacts into traceable workflows and manager closure views.

This repository contains the WO-001 in-memory domain tracer, the WO-002 local preview shell,
and the WO-003 append-only human decision ledger:

```text
employee report -> Artifact -> EvidenceFactCard -> Workflow -> Expectation -> manager view
manager decision -> immutable ledger -> authoritative Workflow transition
```

Requirements: Node.js 24 or newer. The browser-only synthetic preview is explicit:

```bash
npm test
npm run demo
PREVIEW_MODE=synthetic npm run preview
```

Open `http://127.0.0.1:3000/employee` for the employee preview or
`http://127.0.0.1:3000/manager` for the manager preview. The implementation
uses in-memory synthetic data by default and is not a production application.

To run the configured On-Prem Strict preview against an already migrated PostgreSQL database,
configure all canonical local extraction dependencies explicitly:

```bash
CLINIC_OS_PROFILE=ON_PREM_STRICT \
DATABASE_URL='postgresql://...' \
CLINIC_OS_DATABASE_PROVIDER=LOCAL_POSTGRES \
CLINIC_OS_FILE_PROVIDER=LOCAL_OBJECT_STORE \
CLINIC_OS_INFERENCE_PROVIDER=LOCAL_MODEL \
CLINIC_OS_BACKUP_PROVIDER=LOCAL_ENCRYPTED_BACKUP \
CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED=false \
CLINIC_OS_MANIFEST_VERSION='on-prem-v1' \
CLINIC_OS_OBJECT_STORE_ROOT='/var/lib/clinic-os/objects' \
WO021_TESSERACT_PATH='/usr/bin/tesseract' \
WO021_TESSDATA_DIR='/usr/share/tesseract-ocr/5/tessdata' \
CLINIC_OS_INFERENCE_CAPABILITIES=EXTRACT_EYE_EXAM_REPORT \
npm run preview
```

This startup path does not run migrations. A missing database URL, local object-store root,
or OCR path fails startup and never falls back to the in-memory clinical backend. The persisted
extraction route is therefore never advertised by a server that only has a database pool.

`GET /api/health` confirms only that the HTTP process is alive. `GET /api/readiness` is the
dependency gate; it returns bounded stable codes and `503` until every selected adapter is ready.
Cloud declarations are validated but deliberately return `CLOUD_PROVIDER_UNAVAILABLE` in this
repository: cloud providers have not yet been implemented. No URL, credential, endpoint, or local
path is included in either response. Legacy `PREVIEW_MODE=postgres` and old object-root names are
rejected with `LEGACY_CONFIGURATION_NAME`; only the canonical settings above configure deployment.
See [WO-027](docs/work-orders/WO-027-startup-profile-readiness.md).

## PostgreSQL acceptance boundary

`npm run db:migrate` applies checksum-guarded migrations to an explicitly supplied
`DATABASE_URL`. PostgreSQL schema semantics are tested with PGlite in the restricted
development executor. Real PostgreSQL server integration, application-role RLS
enforcement, backup and restore remain required before production or clinic use.

The tenant-scoped capture repository persists only Artifact + EvidenceFactCard through
the same SQL-semantic harness.
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

## Persisted closure acceptance demo

Run the deterministic, non-PHI SQL-semantic closure proof with:

```bash
npm run demo:closure
```

It exercises the production registration, employee-safe selection, local object ingestion,
stored extraction, attach/Expectation/S2 and manager-close services against fresh PGlite
migrations. Output is deliberately limited to phase/status/count totals. It is not a real
PostgreSQL, browser, OCR-accuracy, authentication, or clinic-readiness acceptance result.
An explicitly supplied clinical backend now accepts one narrow durable employee command:
`POST /api/employee/registration-trigger` with only an exact synthetic identity anchor and
occurrence instant. The server derives all Artifact, FactCard and Expectation identities, then
uses the persisted golden path to create an `EXAM_REPORT` expectation due fifteen minutes later.
The browser refreshes the employee-safe open-expectations list before evidence upload; it never
uses the registration response as upload authority. In this mode legacy
`/api/employee/work-updates` is disabled for clinical writes. Topics, ordinary chat and employee
status remain volatile synthetic preview state. The default `npm run preview` path remains wholly
in memory; missing PostgreSQL configuration never silently selects it as a persistence fallback.
Reopen/correction flows, real PostgreSQL application-role
RLS/concurrency proof, backup and restore remain separate acceptance gates.

The tenant-scoped due-Expectation batch is an explicit manager command, not a scheduler.
It advances a bounded keyset page inside one transaction and isolates controlled item failures
with loop-index savepoints before persisting S2. `nextCursor` advances past every selected row,
including failed rows; retry failed rows with a later run starting from a null cursor. Because
locked rows may be skipped, the command does not claim `hasMore` or real-server worker parity.

Real PostgreSQL deployment acceptance is intentionally separate from ordinary tests:

```bash
npm run accept:postgres-real
```

The command requires four explicit dedicated-database URLs, the destructive-reset confirmation
documented in the runbook, and same-major PostgreSQL 16/17 server/client binaries.
It is destructive, fails non-zero when its environment is absent, and never reports a skipped gate
as success. See `docs/runbooks/postgres-real-acceptance.md` before running it.

Original evidence bytes now have a narrow immutable object-store boundary. The On-Prem provider
uses an explicitly configured absolute local root, atomic no-overwrite writes and integrity checks;
the gateway enforces a 25 MiB per-object limit. It is not yet wired to Artifact persistence or OCR.
Stored evidence can now pass through a narrow extraction boundary that assembles a candidate
Artifact and FactCard after deterministic schema and authority-key validation. The included tests
use a synthetic local provider only; real OCR/model integration and persistence remain separate.
The synthetic extraction spec freezes its fixture model identity; a real adapter requires a new
server-approved spec and contract tests rather than silently reusing that fixture identity.

The extraction golden-path application service now makes extraction restartable: it snapshots and
validates the command, checks the tenant-scoped immutable extraction projection before reading
object bytes, persists the validated result, and sends only `READY` results to the authoritative
persisted Workflow/Expectation/S2 path. `REVIEW_REQUIRED` stops at extraction for human review;
replays reuse the stored lineage and never rerun inference.

The local preview also exposes `POST /api/employee/extraction/exam-report` when a persisted
extraction backend is explicitly configured. It accepts a bounded JSON consequence command for
an already-stored object, injects the server employee context, and returns only a bounded
completed/review projection; synthetic preview never falls back to this durable route.

The first real local OCR adapter uses the exact hashed Tesseract 5.3.4 English baseline documented
in `models/tesseract-eng-v1.manifest.json`. Its separate non-PHI synthetic smoke gate is:

```bash
npm run accept:ocr-local
```

Passing this command proves only the English adapter path. Strict network isolation and approved
Japanese/Chinese clinical-language accuracy remain open deployment gates; see
`docs/runbooks/local-ocr-acceptance.md`.

The persisted preview also accepts one bounded employee evidence upload at
`POST /api/employee/evidence-objects`. Send a single `multipart/form-data` part named `file`
(PNG, JPEG or PDF) with an `Idempotency-Key`; the response contains only the server-derived
`objectRef` needed by the extraction route. Synthetic preview deliberately returns
`PERSISTED_UPLOAD_UNAVAILABLE` instead of pretending that an upload is durable.

In the PostgreSQL preview, the employee page wires the same sequence into the browser: record a
synthetic `REGISTRATION`, choose `EXAM_REPORT`, select one PNG/JPEG/PDF, then upload and extract.
The page keeps the returned reference and server-issued Expectation ID only in memory, shows only
bounded completion/review status, and leaves closure state to the existing manager projection.
Refreshing the page clears the preview's volatile Expectation prerequisite map; submit the
registration again when the page asks for it. Ordinary Conversation mode never calls either
clinical endpoint.
