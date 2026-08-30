# WO-025 — Safe Employee Evidence-Object Ingestion

**Status:** Architecture frozen / Builder ready  
**Architect:** Codex Architecture Designer  
**Depends on:** Constitution, WO-005, WO-019, WO-020, WO-022, WO-023, WO-024  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`

## 1. Outcome

Add the smallest employee upload seam for one image or PDF:

```text
employee multipart request
  -> strict parser and bounded temporary staging
  -> server-derived object identity
  -> ObjectStoreGateway.put
  -> bounded public objectRef
  -> existing WO-024 extraction request
```

The endpoint stores bytes in the configured local ObjectStore and returns a server-generated
reference which the employee can copy into the already accepted
`POST /api/employee/extraction/exam-report` request. This ticket does not change extraction,
Workflow, Expectation, Verification or manager decision rules.

The upload is an object-store operation only. It does not create an Artifact, FactCard, Workflow or
extraction attempt. Durable linkage begins when WO-024/WO-023 is called.

## 2. Frozen transport choice

Use strict single-file `multipart/form-data`; do not use JSON base64. The existing immutable object
limit is 25 MiB. A 64 KiB JSON request limit cannot carry a useful report, and base64 adds about
33% transport overhead and a large in-memory decode. Multipart permits a bounded 25 MiB file while
streaming into a private temporary file.

Add exactly one mutating route:

```text
POST /api/employee/evidence-objects
```

The route accepts one file part named `file`. It accepts only these media types:

- `image/png`
- `image/jpeg`
- `application/pdf`

The part `Content-Type` must be exact (no charset or arbitrary parameters), and the first bytes
must match the declared media type:

- PNG: the standard eight-byte PNG signature;
- JPEG: the JPEG start-of-image signature;
- PDF: `%PDF-` header.

The client filename is bounded, must be a simple basename without `/`, `\\`, control characters or
path traversal, is never persisted or returned, and is not used for storage naming. No form field
other than the one file part is accepted. Multiple files, unknown parts, missing file parts,
malformed boundaries, malformed headers and trailing bytes after the final boundary fail closed.

The public success response is a new bounded projection:

```json
{
  "status": "STORED",
  "objectRef": {
    "objectId": "upload-<server-generated-opaque-id>",
    "contentSha256": "<64 lowercase hex>",
    "sizeBytes": 1234,
    "mediaType": "image/png"
  }
}
```

`clinicId` is intentionally omitted from the public projection. The internal
`StoredObjectRef.clinicId` is derived from the trusted `ActorContext`; WO-024 likewise reconstructs
tenant scope from the server context. The response contains no path, filename, bytes, OCR text,
provider output, database detail or PHI.

## 3. Authority, identity and idempotency

The route accepts only the server-injected employee `ActorContext` for one configured clinic. It
must reject before staging or ObjectStore acquisition any body, header or query attempt to submit:

- `clinicId`, `actorId`, `role` or `sourceEmployeeId`;
- `objectId`, `contentSha256`, `sizeBytes`, `mediaType` or a complete `objectRef`;
- filesystem paths, roots, URLs, provider names or storage keys;
- Artifact, FactCard, Workflow, Expectation, Verification, decision or status fields;
- extra form parts, query authority and unknown headers used as authority.

Require the existing bounded `Idempotency-Key` syntax. The key is an operation token, not an object
ID. The server derives the object ID from a domain-separated hash of the trusted clinic, trusted
employee and idempotency key, for example:

```text
upload-<sha256("clinic-os:upload:v1" || clinicId || actorId || idempotencyKey)>
```

The exact canonical encoding is frozen in the implementation and covered by tests. The client never
chooses or observes a filesystem name. The server passes only this derived ID, the parsed media
type and staged bytes to `ObjectStoreGateway.put`.

Consequences:

- same employee, clinic, key and identical bytes/media type: exact replay is idempotent and returns
  the same detached reference;
- same employee, clinic and key with different bytes, size or media type: the immutable provider
  returns a stable conflict, mapped to HTTP `409 UPLOAD_CONFLICT`; no overwrite occurs;
- same key in another clinic or for another employee: separate server-derived object identity and
  tenant scope;
- no database idempotency row is added in this ticket. The immutable object ID is the idempotency
  anchor; extraction request identity remains the separate WO-022/WO-023 `requestId`.

`ObjectStoreGateway` remains the only object write authority. The upload path must not write files
directly, call `LocalObjectStore` directly, add a delete/rename/list capability or silently fall
back to memory/cloud storage.

## 4. Body limits, staging and cancellation

The multipart parser must enforce all of the following before calling the object-store gateway:

- total HTTP body: `MAX_OBJECT_SIZE_BYTES + 1 MiB` at most, including multipart framing;
- decoded file bytes: `1..MAX_OBJECT_SIZE_BYTES` (25 MiB);
- boundary length and header section length: bounded constants;
- one file part only; no unbounded header, filename or boundary buffering;
- if `Content-Length` is present, reject invalid, negative or over-limit values before reading;
- count raw UTF-8/HTTP bytes, not JavaScript character count.

Use a private temporary directory created by the server through the operating system temporary-root
facility, with owner-only directory/file permissions. The parser streams the file part to a
temporary file and then supplies a bounded byte snapshot to the existing `ObjectStoreGateway.put`.
It must never expose the temporary path in a response, log or error.

Every exit path must attempt cleanup in `finally`, including malformed input, size overflow,
timeout, client abort, parser failure, ObjectStore failure and success. A cleanup failure is a
controlled failed operation and must not be reported as a clean upload. No background cleanup,
retry worker or queue is introduced; operational cleanup policy is a later ticket.

The request must observe a bounded body-read deadline (default 60 seconds, configurable only within
a narrow documented range). Client `aborted`/premature `close`, stream error and deadline cancel
parsing, prevent ObjectStore acquisition, and trigger temporary-file cleanup. The route must not
write a second response after disconnect. A storage-operation deadline may be applied separately;
it must not claim that a committed immutable object was rolled back. An exact client retry remains
the recovery mechanism.

The staging directory is server-created and is not derived from any request value. The configured
ObjectStore root is still validated by the existing `LocalObjectStore` trust checks (absolute,
non-root, owner/mode/symlink/identity checks). No upload input can select or alter that root.

## 5. Application/backend seam

Add one narrow application operation, preferably an `EvidenceObjectIngestionService`:

```ts
ingest(
  context: ActorContext,
  input: { idempotencyKey: string; mediaType: string; bytes: Uint8Array },
): Promise<StoredObjectRef>
```

The service must:

1. synchronously snapshot and exact-shape validate context/input before the first await;
2. assert employee access and the bounded idempotency token;
3. accept only the three frozen media types and a non-empty bounded byte array;
4. derive the object ID from trusted context and the key;
5. call `ObjectStoreGateway.put` exactly once for a new request;
6. validate and return a detached provider reference already verified by the gateway;
7. preserve provider conflicts and map only to stable public transport errors at the HTTP boundary.

The HTTP server may parse/stage bytes, but must delegate the write through the backend/application
seam. `PostgresClinicalPreviewBackend` may expose one narrow
`uploadEvidenceObject(context, input)` delegation to this service. It must not reconstruct
`StoredObjectRef`, call `LocalObjectStore` directly or reuse the synthetic `PreviewStore` path.

`PREVIEW_MODE=synthetic` must return controlled `PERSISTED_UPLOAD_UNAVAILABLE` (or fail startup if
the route is advertised). It must never pretend that an in-memory upload is durable. Configured
PostgreSQL preview must construct the existing local `ObjectStoreGateway` and fail closed when the
gateway or trusted object-store root is absent.

The returned reference can be fed to WO-024 by using its public fields:

```text
upload response.objectRef
  -> WO-024 objectRef.objectId/contentSha256/sizeBytes/mediaType
  -> server reconstructs clinicId from ActorContext
```

The upload endpoint does not accept `requestId`, `artifactId`, `factCardId`, identity anchor or
Expectation ID. Those belong to the separate extraction request and are not silently generated by
this ticket.

## 6. HTTP response and controlled errors

Success is HTTP `201` for the first successful store and HTTP `200` for an exact replay; both return
the same bounded `STORED` projection. The implementation may use one status consistently if the
first/replay distinction cannot be established without a second authority, but it must not expose
provider internals.

Use exactly `{ error, message }` for errors. Public mapping:

| Condition | HTTP | Error |
|---|---:|---|
| Missing/invalid employee context | 403 | `FORBIDDEN` |
| Missing/invalid idempotency key | 400 | `INVALID_IDEMPOTENCY_KEY` |
| Missing/malformed content type or multipart body | 400/415 | `INVALID_UPLOAD` / `UNSUPPORTED_CONTENT_TYPE` |
| Body or decoded file exceeds limit | 413 | `UPLOAD_TOO_LARGE` |
| Same derived ID with changed content/media type | 409 | `UPLOAD_CONFLICT` |
| Client abort or bounded read/storage deadline | 408/504 | `UPLOAD_TIMEOUT` |
| Local object store unavailable/integrity failure | 503 | `UPLOAD_UNAVAILABLE` |
| Unexpected error or cleanup failure | 500 | `INTERNAL_UPLOAD_ERROR` |

Messages are static. Never serialize DomainError messages, request bodies, object references,
temporary paths, provider stderr, SQL details, filenames or bytes.

## 7. Manager visibility decision

No separate manager upload or raw-object read endpoint is needed for WO-025. The existing
`GET /api/manager/closures` projection remains the manager's read-only surface and must not be
expanded to include raw bytes, object paths, filenames or provider output. If a future evidence
review screen needs to display an original image/PDF, it requires a separate audited, tenant-scoped,
role-checked read ticket with bounded streaming and explicit redaction/retention rules. It is not
implicit in this upload operation.

## 8. Minimal implementation surface

Expected changes:

```text
src/application/evidence-object-ingestion.ts     # narrow server-authoritative put service
src/preview/server.ts                             # strict multipart route, staging and safe projection
src/preview/clinical-preview-backend.ts           # one upload delegation/configuration seam
test/evidence-object-ingestion.test.ts            # service, authority and replay matrix
test/upload-http.test.ts                          # parser, timeout, cleanup and public HTTP matrix
test/postgres-preview.test.ts                     # configured-root/gateway wiring only if needed
README.md                                         # one local upload -> extraction usage note
```

No migration, ORM, dependency, cloud SDK, multipart package, authentication framework, UI rewrite,
OCR/model change, queue, worker, scheduler, manager query, object deletion or backup implementation.

## 9. Mandatory acceptance matrix

1. Valid PNG, JPEG and PDF multipart uploads store locally and return the correct server-verified
   hash, byte size and media type; returned objects are detached.
2. The returned public reference contains no clinic authority, filename, temporary path, bytes,
   OCR text, provider output or PHI, and can be used by WO-024 to start extraction.
3. Object ID is server-derived; body, query and headers cannot inject object ID, hash, size,
   clinic, actor, role, path or provider authority.
4. Same key plus identical bytes/media type is idempotent; a changed replay is a stable conflict
   and never overwrites the first object.
5. Identical keys and object IDs in two clinics/employees remain isolated through the trusted
   `ActorContext` and local provider scope.
6. Missing, repeated, unknown or malformed multipart parts and malformed boundaries fail before
   ObjectStore acquisition.
7. Unsupported declared media type, media-type/magic mismatch, empty file, malformed PNG/JPEG/PDF
   header and unsafe filename fail closed.
8. Raw body and decoded file byte limits are enforced before storage; `Content-Length` lies cannot
   bypass the streaming limit; no unbounded header/boundary allocation occurs.
9. Client disconnect, stream error, body timeout and storage timeout prevent unsafe continuation,
   do not write a second response and clean temporary staging files.
10. Temporary files are owner-only, never returned/logged, and cleanup is attempted on every success
    and failure path; cleanup failure is visible as a failed operation.
11. LocalObjectStore root/path trust remains authoritative; traversal, absolute path, symlink and
    root injection attempts cannot escape the configured root.
12. Synthetic preview never falls back to an in-memory upload; missing configured object storage
    fails closed.
13. ObjectStoreGateway remains the single write authority and no delete/list/rename surface is
    added.
14. Errors are static and contain no paths, bytes, filenames, provider details, SQL or PHI.
15. Full regression, both demos, local OCR acceptance and the real-PostgreSQL fail-closed command
    remain green/explicit.

## 10. Non-goals and honest boundary

- no JSON base64 upload and no general multipart framework;
- no object download/read endpoint for employees or managers;
- no durable upload metadata table or database transaction;
- no Artifact/FactCard/extraction/Workflow mutation;
- no client-selected object identity or public filesystem name;
- no cloud object provider, signed URL, resumable upload or browser direct-to-cloud flow;
- no virus scanning, archive extraction, thumbnails, PDF OCR or clinical-language claim;
- no production authentication, real PostgreSQL application-role RLS or backup/restore claim;
- no automatic retry, queue, worker or background temporary-file janitor.

The object-store write and database extraction lineage are separate immutable stages. If the client
loses the response after storage commits, repeating the same idempotency key and bytes is the
recovery path. This ticket does not claim distributed ACID between the filesystem and PostgreSQL.

## 11. Builder handoff

Read the Constitution and WO-019/WO-020/WO-022/WO-023/WO-024 before editing. Implement the narrow
multipart ingestion seam, write negative tests before accepting the happy path, and run:

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
npm run accept:ocr-local
npm run accept:postgres-real
git diff --check
```

Commit as:

```text
feat(preview): add safe evidence object upload
```

Do not push before independent Architecture Review. Report exact upload limits, cleanup behavior,
replay/conflict behavior, test counts and external gates separately.

## 12. Architecture review checklist

The independent review must inspect implementation, not only tests, for:

- exact single-part parser and byte-boundary handling without a dependency;
- no storage acquisition before complete request/header/part validation;
- trusted-context-only tenant/employee authority and server-derived ID;
- no client-supplied ref/hash/size/media type accepted as authoritative;
- gateway-only writes and preserved immutable conflict behavior;
- stream abort/deadline cancellation and `finally` cleanup on every path;
- no path/filename/bytes/provider/PHI leakage in success, logs or errors;
- synthetic preview fail-closed behavior and existing LocalObjectStore root trust;
- detached bounded response and unchanged WO-024 extraction contract;
- no manager raw-object read surface or hidden migration/dependency/queue scope.
