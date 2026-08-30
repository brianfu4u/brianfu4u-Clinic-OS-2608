# WO-019 — Immutable Evidence Object Store Foundation

**Status:** Architecture frozen / Builder ready  
**Depends on:** Constitution, WO-006, WO-008, WO-018

## 1. Goal

Create the smallest production-shaped storage boundary for original image, audio and document
bytes before OCR is introduced. On-Prem gets a real local-filesystem provider. Cloud readiness is
proved by the same narrow provider contract and an in-memory contract fixture, not by adding a
cloud SDK.

A successful write returns a detached `StoredObjectRef` containing only:

- `clinicId`;
- `objectId`;
- `contentSha256`;
- `sizeBytes`;
- `mediaType`.

Bytes and base64 must not be stored in PostgreSQL JSONB. This ticket does not yet connect the
reference to Artifact persistence.

## 2. Minimal file surface

- `src/storage/contracts.ts`
- `src/storage/object-store-gateway.ts`
- `src/storage/local-object-store.ts`
- `test/object-store.test.ts`
- small README/package exports edits only when required

No framework, cloud SDK, database migration or new dependency.

## 3. Contract and authority

`ObjectStoreProvider` exposes only `put` and `get`. It has no list, delete, rename, arbitrary path,
domain repository or network fallback capability. Its kind is one of the already-frozen
`LOCAL_OBJECT_STORE | CLOUD_OBJECT_STORE` values.

The gateway must:

1. derive clinic authority from a valid trusted `ActorContext`;
2. reject extra authority fields and malformed exact-shape commands;
3. snapshot bytes before the first await;
4. enforce non-empty bytes, a documented bounded maximum, strict object ID and media type;
5. compute SHA-256 and size itself;
6. verify manifest/provider kind at construction and again immediately before every call;
7. validate the complete provider response against the request and computed digest;
8. return detached refs/bytes and stable errors without bytes, local paths or PHI;
9. never silently switch providers.

`ON_PREM_STRICT` and `ON_PREM_HYBRID` accept only the local provider. `CLOUD` accepts only the
cloud provider contract fixture. The existing RuntimeManifest remains authoritative.

## 4. Local provider

- Uses one configured absolute root and creates it explicitly.
- Never concatenates caller-controlled paths. Tenant and object storage names are fixed SHA-256
  derivations.
- Uses atomic create/no-overwrite semantics. Same scoped ID plus identical bytes is idempotent;
  different bytes is a stable conflict and never overwrites.
- Re-reads committed content and verifies hash/size before returning success.
- `get` verifies exact tenant/object scope and rechecks hash/size; missing or damaged content fails
  closed.
- Symlinks, path traversal and absolute-path input cannot escape the configured root.
- There is deliberately no physical delete operation; legal retention/deletion is a later,
  dedicated mechanism.

## 5. Acceptance tests

At minimum prove:

1. local put/get round trip and detached input/output;
2. exact replay is idempotent and conflicting replay never overwrites;
3. cross-clinic identical object IDs remain isolated;
4. concurrent same-ID same-content writes converge; conflicting content yields one success and one
   controlled conflict;
5. traversal, absolute paths, symlink escape, empty/oversize bytes and invalid media types fail
   before unsafe effects;
6. on-disk truncation or modification is detected on get;
7. provider/manifest mismatch and provider identity mutation fail before invocation;
8. Strict cannot invoke a cloud provider and no fallback occurs;
9. malformed provider ref/hash/size/clinic/object responses fail without a success receipt;
10. local and cloud-fixture providers pass the same contract behavior;
11. receipts and errors expose no bytes or filesystem paths;
12. the provider surface exposes no delete/list/rename or business write authority;
13. all existing regression tests and demos remain green.

## 6. Explicit non-goals

- HTTP multipart or UI upload;
- OCR, LLM, vision or FactCard generation;
- Artifact/database wiring or metadata migration;
- real cloud object storage or signed URLs;
- virus scanning, archive extraction, thumbnails or range reads;
- lifecycle policy, backup, encryption key management or lawful deletion;
- a generic plugin marketplace.

## 7. Builder handoff

Read the Constitution and WO-006 before implementation. Keep the provider contract smaller than
the filesystem API, implement only the files above, run the full test suite and both demos, commit
as `feat(storage): add immutable evidence object store`, report exact files/tests/deviations, and
do not push GitHub before Architecture Review.
