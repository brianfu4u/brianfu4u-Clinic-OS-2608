# WO-022 — Persisted Stored-Evidence and Extraction Lineage

**Status:** Accepted — Architecture Review passed 2026-08-30  
**Depends on:** Constitution, WO-007, WO-008, WO-019, WO-020, WO-021

## 1. Goal

Persist every accepted stored-object reference and extraction outcome in one tenant transaction so
the system can restart without losing the original-evidence link, validated candidate, review reason
or model lineage.

`READY` persists StoredObjectRef + Artifact + FactCard + ExtractionAttempt.
`REVIEW_REQUIRED` persists StoredObjectRef + Artifact + validated candidate + ExtractionAttempt,
but no FactCard.

This ticket intentionally precedes HTTP/UI wiring. An upload endpoint without durable extraction
lineage would create an unauditable restart gap.

## 2. Migration 0006

Add two tenant-scoped tables with `ENABLE + FORCE RLS`, exact USING/WITH CHECK policies and
append-only UPDATE/DELETE triggers.

### stored_object_ref

- `clinic_id`, `object_id` composite primary key;
- `content_sha256`, `size_bytes`, `media_type`;
- unique `(clinic_id, object_id, content_sha256)` for composite lineage FKs;
- strict hash, size and media-type checks.

### evidence_extraction_attempt

- tenant-scoped `request_id` primary identity;
- composite FK to StoredObjectRef including content hash;
- composite FK to Artifact;
- nullable composite FK to FactCard;
- `READY | REVIEW_REQUIRED` status;
- bounded validated candidate JSON and controlled reason-code array;
- provider kind, model ID, model-manifest SHA-256, capability;
- schema, policy and parser versions;
- strict `completed_at`;
- state-shape checks: READY requires FactCard and no reasons; REVIEW requires no FactCard and one or
  more allowed review reasons.

Add the missing append-only trigger to existing `evidence_fact_card`; it is formal derived evidence
and must not remain mutable.

Update the WO-018 real-server business-table, grants, RLS, append-only and backup/restore coverage
for the new tables and FactCard trigger.

## 3. Application contract

Add one `ExtractionPersistenceRepository` method receiving a valid exact ActorContext, an accepted
WO-020 result and the trusted `StoredObjectRef`/model-manifest hash. It must revalidate runtime
shape; TypeScript types are not a trust boundary.

Reuse the WO-020 candidate/authority validator by exporting a narrow pure validation function rather
than creating a second model-output policy. Extend frozen `ExtractionSpec` and `ExtractionLineage`
with `modelManifestSha256`; deterministic fixture and Tesseract specs each use an explicit frozen
64-hex identity.

One tenant transaction must:

1. verify the result Artifact payload contains exactly the same StoredObjectRef;
2. insert or verify idempotent StoredObjectRef;
3. insert or verify immutable Artifact;
4. insert or verify FactCard only for READY;
5. insert or verify immutable ExtractionAttempt;
6. commit only when every row is semantically identical to a prior replay or newly accepted.

Do not call existing repository methods that open independent transactions. Reuse existing pure row
canonicalization/validation helpers where possible; a small shared SQL helper is allowed only when it
removes real duplication.

The object store and PostgreSQL are not represented as one distributed ACID transaction. A database
failure may leave an immutable unreferenced object; the same command must be safely replayable. The
system must never delete or overwrite that object as rollback.

## 4. Idempotency and conflict

Exact semantic replay under the same clinic/request ID returns the stored detached projection and
creates no duplicate rows. Reordered JSON keys and equivalent timestamp offsets follow the existing
canonical persistence rules. Any reuse with changed object ref/hash, Artifact, candidate, outcome,
FactCard or lineage is a stable conflict and rolls back all new database writes.

Same IDs remain legal in different clinics. Authority always derives from ActorContext and every FK
contains `clinic_id`.

## 5. Acceptance tests

Use the existing PGlite SQL-semantic harness and exact production migration. At minimum prove:

1. READY writes all four durable records and can trace FactCard -> Attempt -> Object/model;
2. REVIEW_REQUIRED writes Object/Artifact/Attempt and no FactCard;
3. exact replay is idempotent; any changed field is a stable conflict;
4. cross-clinic IDs, object hashes and composite FK attacks fail;
5. READY/REVIEW reason and FactCard contradictions fail at SQL and repository layers;
6. candidate authority keys, malformed/non-JSON values and size limits fail before acquisition;
7. model-manifest hash is required, frozen and included in replay identity;
8. forced failures at each write stage roll back the whole tenant transaction;
9. StoredObjectRef, Attempt and FactCard reject UPDATE and DELETE;
10. all three tables have forced tenant RLS with exact policies;
11. caller mutation during awaits and returned mutation do not affect stored data;
12. SQL remains parameterized and errors expose controlled codes only;
13. WO-018 catalog/grant/digest lists include the new tables;
14. full regression, demos, local OCR acceptance and PostgreSQL local fail-closed gate remain correct.

## 6. Non-goals

HTTP/multipart/UI, automatic OCR invocation, Workflow attach, Expectation/S2, manager review actions,
queues/retries, object deletion, real cloud storage and clinical-language acceptance are out of
scope. WO-023 will orchestrate extraction -> persistence -> golden-path processing; transport follows
after that.

## 7. Builder handoff

Read the Constitution and dependency work orders. Implement only migration 0006, the narrow
repository/shared validation changes and tests. Add no dependency or ORM. Run targeted/full tests,
both demos, local OCR acceptance and the local real-PostgreSQL fail-closed check. Commit as
`feat(persistence): persist extraction lineage`, report exact files/schema/tests/deviations, and do
not push before independent Architecture Review.

## 8. Architecture acceptance

Accepted after Builder commits `da9dec7` and `3f51209`, followed by an independent review.

- Full regression: 308/308.
- Domain and Runtime demos: passed.
- Local Tesseract acceptance: 2/2 passed.
- Real PostgreSQL acceptance: intentionally fail-closed with `ENVIRONMENT_REQUIRED` because no
  PostgreSQL server configuration is present in this environment.
- Review blockers fixed: exact single-source extraction lineage and inert pre-acquisition input
  snapshotting for getters, proxies, symbols and hostile prototypes.
- No HTTP/UI/ORM/queue scope added; GitHub push remains deferred for the batch release.
