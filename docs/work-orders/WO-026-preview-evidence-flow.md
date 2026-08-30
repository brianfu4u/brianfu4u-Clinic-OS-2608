# WO-026 — Employee Evidence Flow in the Local Preview

**Status:** FROZEN FOR BUILD — Architecture work order
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`
**Depends on:** Constitution, WO-002, WO-005, WO-019, WO-020, WO-022, WO-023, WO-024, WO-025

## 1. Outcome

Connect the accepted safe upload and extraction HTTP transports to the existing browser preview so
one employee-side demonstration follows the real persisted path:

```text
choose image/PDF
  -> POST /api/employee/evidence-objects
  -> receive detached objectRef in memory
  -> POST /api/employee/extraction/exam-report
  -> COMPLETED or REVIEW_REQUIRED
  -> existing manager closure projection
```

This is a preview wiring ticket. It does not change the domain kernel, database schema, extraction
policy, OCR/model provider, authentication, or manager read model.

## 2. Product behavior frozen

### 2.1 Conversation remains separate from Event

- The existing `Conversation` mode remains unchanged and never calls upload or extraction.
- Only the explicit `Record as work update` mode can create a formal event.
- `REGISTRATION` continues to use the existing work-update route and creates the server-side
  Expectation through the accepted backend.
- `EXAM_REPORT` in the persisted PostgreSQL preview uses the upload-then-extract path below. It
  must not use the old synthetic text shortcut when the durable clinical backend is active.
- The employee UI must require a known server-returned `expectationId` for the same exact anchor,
  normally obtained from the immediately preceding registration in the current preview session.
  If it is absent, the UI shows a bounded instruction and makes no extraction request.

The client must not invent an Expectation, Workflow, identity override, or clinical conclusion.
The existing `expectationByAnchor` value is only an opaque operation reference; the server remains
the authority and rejects unknown or cross-Workflow references.

### 2.2 Synthetic mode is visibly limited

`GET /api/health` remains the profile signal. In `synthetic-local-preview`:

- the UI keeps the existing synthetic warning;
- the durable evidence control is disabled or clearly marked unavailable;
- no upload bytes are sent to a synthetic or in-memory fallback;
- no `COMPLETED`/`REVIEW_REQUIRED` claim is fabricated by the browser.

In `hybrid-postgres-preview`, the UI must additionally retain the existing warning that chat and
employee work status are volatile even though the clinical chain is persisted.

### 2.3 One employee tracer

The formal work-update form adds a file control only for `EXAM_REPORT`:

- one file, `accept="image/png,image/jpeg,application/pdf"`;
- no filename or file bytes in query parameters, DOM URLs, logs, or telemetry;
- identity anchor and occurrence time are the existing explicit synthetic preview fields;
- the form does not expose `clinicId`, `actorId`, `role`, object identity, model, provider,
  Workflow state, verification state, candidate, or manager fields.

The client generates bounded opaque request IDs for the operation (`requestId`, `artifactId` and
`factCardId`) with `crypto.randomUUID()`. These are request identities, not authority. The
extraction `Idempotency-Key` must equal `requestId`; upload uses a separate bounded key. Keys are
held only in page state and are never logged or put in a URL.

## 3. Exact browser sequence

### 3.1 Registration prerequisite

The employee submits a normal explicit `REGISTRATION` work update while `ON_DUTY`. On success,
the existing response's opaque `expectationId` is stored for the exact identity anchor. No other
client field is treated as authority. If the page is refreshed and the prerequisite reference is
gone, the employee must submit the registration again or use a future server-issued lookup; this
ticket does not add a new employee query.

### 3.2 Upload

On `EXAM_REPORT` submit, the browser first creates a fresh upload idempotency key and sends the
selected `File` as native `multipart/form-data` to:

```text
POST /api/employee/evidence-objects
Idempotency-Key: <bounded upload key>
```

Use `FormData` and let the browser set the multipart boundary. Do not set a manual
`Content-Type`, base64 encode the file, or include any JSON authority field. The existing server
parser and `ObjectStoreGateway` remain the sole upload/storage authorities.

The response is accepted only if it is the bounded WO-025 projection:

```json
{
  "status": "STORED",
  "objectRef": {
    "objectId": "upload-<64 lowercase hex>",
    "contentSha256": "<64 lowercase hex>",
    "sizeBytes": 1234,
    "mediaType": "image/png"
  }
}
```

The client retains this detached reference in memory solely to construct the next request. It may
show a generic “evidence stored” status, but must not render the object ID/hash, object path,
filename, bytes, or provider details.

### 3.3 Extraction operation

Immediately after a valid upload response, create one fresh extraction operation and send exactly
the allowlisted WO-024 body to:

```text
POST /api/employee/extraction/exam-report
Idempotency-Key: <requestId>
Content-Type: application/json
```

The body is assembled by the browser from the existing explicit form values, the opaque
`expectationId` returned by registration, and the server-returned `objectRef`:

```json
{
  "requestId": "extract:<opaque-id>",
  "artifactId": "artifact:<opaque-id>",
  "factCardId": "fact:<opaque-id>",
  "objectRef": {
    "objectId": "...",
    "contentSha256": "...",
    "sizeBytes": 1234,
    "mediaType": "image/png"
  },
  "occurredAt": "2026-08-30T09:10:00.000Z",
  "occurredAtSource": "employee_confirmed",
  "identityAnchor": "DEMO-001",
  "createdAt": "2026-08-30T09:10:01.000Z",
  "expectationId": "expectation:<server-issued-id>",
  "attachedAt": "2026-08-30T09:10:01.000Z",
  "evaluatedAt": "2026-08-30T09:10:01.000Z"
}
```

The route fixes `EXAM_REPORT` and `CONSEQUENCE`; the browser must not send `kind`,
`operation.kind`, a Workflow ID, a result, or any extra key. Times are explicit strict instants
and must satisfy the existing WO-024 constraints. The browser must not run OCR, infer identity,
score candidates, attach a Workflow, or decide `MET`/`VERIFIED`.

### 3.4 Result display

The client accepts only the bounded WO-024 response projection and displays:

- `COMPLETED`: a generic success state and the returned bounded Workflow/Expectation status;
- `REVIEW_REQUIRED` + `EXTRACTION`: “evidence needs review” and bounded reason codes;
- `REVIEW_REQUIRED` + `COMPOSITION`: “workflow match needs review” and bounded reason codes.

The UI must never display or persist in browser storage: identity anchor from the response,
objectRef, candidate JSON, OCR text, model output, lineage, filesystem path, SQL/provider errors,
or raw server messages. It must never turn review into completion. A network or malformed response
maps to a short static local error.

After a completed or composition-reviewed operation, the existing manager page remains the read
surface. The UI may navigate or refresh `GET /api/manager/closures`; it must not add a manager
query or read raw evidence. The existing manager projection is the only data displayed there and
must continue to exclude ordinary chat, raw bytes, paths, OCR/provider output and extraction
candidate payload.

## 4. HTTP safety and CORS boundary

The employee and manager pages are served by the same preview origin. Same-origin requests are the
default and require no CORS headers. Do not add `Access-Control-Allow-Origin: *`, credentialed
wildcard CORS, or a public cross-origin upload surface.

If a narrow explicit CORS option is needed for a local reverse proxy, it must be an opt-in exact
origin allowlist (one configured origin, no wildcard), must not allow credentials, and must emit
headers only for that exact origin. Preflight must allow only the two existing employee methods
and required headers (`content-type`, `idempotency-key`); it must not create a tenant-selection
or authentication mechanism. Tests must cover same-origin/default denial and configured-origin
exact matching. If no external origin is needed, leave CORS disabled.

The existing upload and extraction handlers remain responsible for byte limits, multipart/JSON
shape validation, actor context, tenant binding, idempotency, timeout and static error mapping.
WO-026 may add only the shared safe client response/error adapter needed by the UI; it must not
expose `DomainError.message`, stack traces, paths, SQL, provider stderr or PHI. All endpoint error
bodies remain exactly `{ error, message }` with the fixed public vocabulary from WO-024/WO-025.

## 5. Minimal implementation surface

Expected changes:

```text
src/preview/public/app.js       # explicit evidence control and two-call flow
src/preview/public/app.css      # compact upload/status styling and disabled state
src/preview/server.ts            # only if required for safe CORS/default error consistency
test/preview.test.ts              # synthetic UI assets/profile contract if needed
test/extraction-http.test.ts      # transport/UI seam tests only if needed
test/upload-http.test.ts          # unchanged behavior or CORS tests only if needed
README.md                         # one local PostgreSQL preview demonstration note
```

No domain, migration, ORM, repository, model/OCR, object-store, manager query, auth, queue,
WebSocket, browser database, localStorage of clinical data, or second validation policy may be
added. Do not rewrite the preview framework or add a frontend dependency.

## 6. Mandatory acceptance matrix

1. In synthetic mode, the UI is visibly marked non-production and the durable upload/extraction
   control never falls back to memory or reports a fake clinical result.
2. In PostgreSQL preview, explicit registration followed by selecting a PNG/JPEG/PDF performs
   upload first, then exactly one extraction request using the returned objectRef.
3. Ordinary conversation sends neither upload nor extraction requests and creates no Artifact.
4. The browser sends no authority/result/model/path/PHI fields; route-fixed kind and operation are
   not client-selectable.
5. A missing expectation prerequisite prevents extraction without acquiring either HTTP operation.
6. Upload success is accepted only for the bounded detached WO-025 reference; malformed or unsafe
   responses stop before extraction.
7. Extraction `COMPLETED`, extraction review and composition review render their distinct bounded
   states; review is never shown as completed.
8. Upload and extraction replay/error responses use static safe messages; no object reference,
   filename, path, bytes, candidate, OCR text, SQL, stack or provider output is logged or shown.
9. Upload and extraction errors remain the existing fixed HTTP status/error vocabulary, including
   timeout, unavailable, conflict and invalid request mappings.
10. Manager refresh after a successful persisted operation uses only `GET /api/manager/closures`,
    shows the existing closure state, and contains no ordinary conversation or raw evidence data.
11. Same-origin requests work; default CORS is not wildcard. Any opt-in CORS origin is exact,
    non-credentialed and covered by tests.
12. Existing tests, both demos, `accept:ocr-local`, and the explicit fail-closed
    `accept:postgres-real` gate remain green/explicit.

## 7. Honest boundary

This ticket makes a browser demonstration of the already-built persisted transport. It does not
claim production login, cloud deployment, real patient data readiness, clinical-language OCR
accuracy, a durable employee session, automatic retry, object download, real-time push, or
distributed upload/database ACID. The page refresh limitation for the in-memory expectation map
is intentional and should be reported in the preview notice or README.

## 8. Builder handoff

Read the Constitution and WO-002, WO-019, WO-020, WO-022, WO-023, WO-024 and WO-025 before editing.
Implement only this browser wiring and any narrowly necessary safe transport consistency. Run:

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
feat(preview): wire persisted evidence extraction flow
```

Do not push before independent Architecture Review. Report the exact browser sequence, profile
behavior, test count and any external PostgreSQL gate separately.

## 9. Architecture review checklist

- Conversation and explicit work-update modes remain separate.
- The browser does not perform OCR, identity inference, composition, expectation or verification.
- Upload response is validated and kept only as detached in-memory operation state.
- Extraction body is exactly allowlisted and uses the server-issued expectation reference.
- No raw object reference, bytes, path, filename, candidate, lineage or provider output enters URL,
  logs, browser storage or unbounded DOM output.
- Synthetic mode cannot masquerade as durable clinical processing.
- Manager uses the existing closure read model only.
- Error mapping is static and bounded; CORS is same-origin by default and never wildcard.
- No new dependency or domain/database/model scope was introduced.
