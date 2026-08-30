# WO-024 — Local HTTP Extraction Transport

**Status:** Accepted — Architecture Review passed 2026-08-30  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** Constitution, WO-005, WO-019, WO-020, WO-022, WO-023  

## 1. Outcome

Add the smallest local HTTP transport that makes the already accepted extraction golden path
demonstrable through a browser or `curl` request:

```text
employee HTTP request
  -> server-injected ActorContext
  -> exact EXAM_REPORT consequence command
  -> ExtractionGoldenPath
  -> persisted extraction lineage
  -> authoritative Workflow / Expectation / S2 path
  -> bounded JSON response
```

The request references an object that was uploaded and stored before this operation. This ticket
does not upload bytes. A successful request therefore proves the transport-to-application seam,
not a multipart upload product.

This is a localhost/on-prem preview adapter. It is not a production authentication system and it
does not add a second business path.

## 2. Product and security decisions frozen by this ticket

### 2.1 One route, one supported operation

Add one employee route:

```text
POST /api/employee/extraction/exam-report
```

The route itself fixes the operation to `EXAM_REPORT` and `CONSEQUENCE`. The body must not submit
`kind`, `operation.kind`, `workflowFamily`, `topicId`, free-form text or any trigger specification.
The server constructs those two fixed values before calling the application service.

The employee supplies only the data needed to identify an already-created request and to describe
the evidence occurrence:

```json
{
  "requestId": "extract:report-0001",
  "artifactId": "artifact:report-0001",
  "factCardId": "fact:report-0001",
  "objectRef": {
    "objectId": "object-0001",
    "contentSha256": "<64 lowercase hex characters>",
    "sizeBytes": 1234,
    "mediaType": "image/png"
  },
  "occurredAt": "2026-08-30T09:10:00.000Z",
  "occurredAtSource": "employee_confirmed",
  "identityAnchor": "DEMO-001",
  "createdAt": "2026-08-30T09:10:01.000Z",
  "expectationId": "expectation:registration-0001",
  "attachedAt": "2026-08-30T09:10:02.000Z",
  "evaluatedAt": "2026-08-30T09:10:03.000Z"
}
```

The transport maps this allowlisted body to:

```ts
{
  extraction: {
    requestId, artifactId, factCardId, objectRef,
    kind: "EXAM_REPORT", occurredAt, occurredAtSource,
    identityAnchor, createdAt,
  },
  operation: {
    kind: "CONSEQUENCE", expectationId, attachedAt, evaluatedAt,
  },
}
```

The transport must build a new command object. It must never pass the parsed body, a result-shaped
object or a caller-selected context directly to `ExtractionGoldenPath`.

### 2.2 Authority and result fields are server-controlled

The request body must reject, before acquiring the extraction or database dependency, all extra
keys, including (but not limited to):

- `clinicId`, `actorId`, `role`, `sourceEmployeeId`, `ownerEmployeeId`;
- `status`, `reviewStage`, `workflowId`, `workflow`, `expectation`, `verification`, `decision`;
- `artifact`, `factCard`, `candidate`, `lineage`, `reasonCodes`, `result`;
- `bytes`, `path`, `filesystemPath`, `providerOutput`, `modelOutput`;
- `kind`, `workflowFamily`, `topicId`, `text`, trigger/manager fields and unknown keys.

`clinicId`, `actorId` and `role` are taken only from the trusted server-created `ActorContext`.
Artifact `clinicId` and source employee are consequently derived by the existing application
service. Identity is an exact clinical input and is validated by WO-020/WO-023; it is never sent
to the inference provider.

### 2.3 Tenant binding is a server-instance boundary

The URL contains no caller-selected clinic ID. A configured server instance has one trusted
employee context and one trusted manager context, both bound to the instance's clinic. The new
route accepts only the employee context and rejects any non-employee context through the existing
access assertion.

There is no route that accepts `/:clinicId` and no query/body field that can switch tenants. Two
server fixtures with identical object/request IDs but different configured clinics must use
different tenant-scoped backends and never observe one another's rows.

### 2.4 Existing manager read model only

The existing `GET /api/manager/closures` route may remain the manager's read-only state surface.
If the transport needs a backend seam, add only a narrow delegation to the accepted
`ManagerClosureReadRepository.listManagerClosures`; do not write new SQL, joins, projections or
manager queries in this ticket.

The manager response is the existing bounded closure projection. It must not expose ordinary chat,
raw object bytes, filesystem paths, OCR/provider output or extraction candidate payload. Existing
manager projection fields and synthetic identity handling remain governed by WO-002 and its
accepted read-model contract; this ticket does not broaden manager visibility.

## 3. HTTP contract

### 3.1 Request headers and body limits

- Accept only `Content-Type: application/json` with optional parameters such as
  `charset=utf-8`. Missing, multipart, text or form content types fail with HTTP `415` and
  `UNSUPPORTED_CONTENT_TYPE`.
- Read and count UTF-8 bytes, not JavaScript character count. The maximum request body is 64 KiB.
  A body exceeding the limit fails with HTTP `413` and `REQUEST_TOO_LARGE`; it is never parsed or
  passed downstream.
- The body must be one JSON object with exactly the frozen keys above. Empty, malformed, array,
  primitive, duplicate-key or non-JSON-safe input fails with HTTP `400` and a controlled error.
- All IDs, anchors and strings remain bounded by the existing WO-020/WO-023 validation rules.
  The transport may reject earlier, but may not loosen downstream limits.
- `Idempotency-Key` is required for this mutating route and must be a bounded token under the
  existing preview contract. It must equal `requestId`; otherwise return HTTP `400`
  `IDEMPOTENCY_KEY_MISMATCH`. `requestId` remains the durable WO-022/WO-023 operation identity.

The route must not log request bodies, identity anchors, object paths, bytes, OCR text or model
output. Access logs, if present, contain method, route, status, duration and a non-PHI request
correlation value only.

### 3.2 Timeouts and connection behavior

- Body-read timeout: 5 seconds by default.
- Application-operation response deadline: 30 seconds by default; it must be configurable only
  within a bounded range (1–120 seconds).
- A deadline produces HTTP `504` with `REQUEST_TIMEOUT` and no downstream error detail. The
  adapter must not claim that a timed-out operation was rolled back: WO-023 immutable replay
  semantics require the client to retry the exact command. If the underlying operation cannot be
  cancelled by its existing contract, it may finish after the response and a replay must reuse its
  durable record.
- The server must stop reading an oversized body and must not acquire the application service
  before body/content/shape validation completes.
- The route must handle client disconnects without writing a second response. No retry loop,
  queue, worker or background dispatch is added.

### 3.3 Success and review response

Both semantic outcomes use HTTP `200`. The operation is idempotent and the adapter does not need
to guess whether the caller is the first request or a replay.

The response is a new, bounded projection with no identity anchor, object reference, bytes, path,
candidate fields, OCR text, provider output, lineage or database details:

```json
{
  "status": "COMPLETED",
  "reviewStage": null,
  "artifactId": "artifact:report-0001",
  "workflowId": "workflow:eye-exam-0001",
  "expectationId": "expectation:registration-0001",
  "expectationState": "MET",
  "verificationStatus": "VERIFIED",
  "reasonCodes": []
}
```

An extraction review maps to:

```json
{
  "status": "REVIEW_REQUIRED",
  "reviewStage": "EXTRACTION",
  "artifactId": "artifact:report-0001",
  "workflowId": null,
  "expectationId": null,
  "expectationState": null,
  "verificationStatus": null,
  "reasonCodes": ["LOW_CONFIDENCE"]
}
```

A composition review maps to the same shape with `reviewStage: "COMPOSITION"`; only the bounded
workflow/attachment identifiers and reason codes actually returned by the accepted path may be
included. The adapter must never turn a `REVIEW_REQUIRED` result into a completed state.

The projection must be detached before serialization. Unknown result keys are ignored only after
the result has passed the application result-shape validator; result-shaped input from the caller
is always rejected.

### 3.4 Controlled errors

New transport code maps errors to a fixed public vocabulary and generic messages. It must not
serialize `DomainError.message` when that message could contain an ID, path, SQL detail, provider
stderr or clinical text.

| Condition | HTTP | Public error |
|---|---:|---|
| malformed JSON, exact-shape/enum/time/authority failure | 400 | `INVALID_REQUEST` |
| Idempotency header absent/invalid/mismatched | 400 | `INVALID_IDEMPOTENCY_KEY` / `IDEMPOTENCY_KEY_MISMATCH` |
| employee context/role/tenant failure | 403 | `FORBIDDEN` |
| referenced stored object unavailable or integrity mismatch | 422 | `EVIDENCE_UNAVAILABLE` |
| durable extraction/request replay conflict | 409 | `REQUEST_CONFLICT` |
| body too large | 413 | `REQUEST_TOO_LARGE` |
| unsupported content type | 415 | `UNSUPPORTED_CONTENT_TYPE` |
| body/application deadline | 504 | `REQUEST_TIMEOUT` |
| unexpected failure | 500 | `INTERNAL_ERROR` |

All error bodies have exactly `{ error, message }`, with a short static message. They contain no
raw command, identity, candidate, object reference, stack, SQL, URL, path or provider output.

## 4. Application/backend seam

The Builder may extend the existing preview backend with one narrow operation equivalent to:

```ts
submitExamReportConsequence(
  context: ActorContext,
  command: ProcessGoldenPathCommand,
): Promise<ProcessGoldenPathResult>
```

The backend must delegate to the accepted `ExtractionGoldenPath.processGoldenPath`. It must not:

- reconstruct Artifact, FactCard, Workflow, Expectation or Verification objects;
- call `CaptureRepository`, `WorkflowAttachRepository`, `ExpectationRepository` or
  `VerificationRepository` directly for this route;
- call the in-memory `runGoldenPath` or silently fall back to `PreviewStore`;
- accept a caller-supplied result, identity/authority override, Workflow ID or Expectation object;
- add a second extraction/candidate validator or model policy.

The production PostgreSQL backend must construct this seam from the already accepted object-store,
inference, extraction persistence and golden-path authorities. Tests may inject a narrow fake
port, but the configured production path must fail closed if that port is absent.

## 5. Runtime profile and real PostgreSQL gate

The existing synthetic preview remains available for WO-002 UI work. It must not pretend that the
new route is durable:

- `PREVIEW_MODE=synthetic`: the new route is unavailable and returns controlled
  `PERSISTED_TRANSPORT_UNAVAILABLE`, or the server may fail startup if the route is advertised.
  It must never invoke an in-memory extraction/golden-path fallback.
- `PREVIEW_MODE=postgres`: startup requires a nonblank `DATABASE_URL`, an absolute configured local
  object-store root and a fully constructed extraction golden-path backend. Missing configuration
  fails startup with stable configuration errors; no PGlite, SQLite, memory database or default
  connection URL is allowed.
- The PostgreSQL pool remains the existing explicit `pg` adapter. No connection is opened at module
  import, and the server closes the pool when the server closes.
- Existing WO-006 deployment/provider gates remain authoritative. A local/offline provider must be
  explicitly selected and its frozen manifest/spec must be validated before the route is enabled;
  no cloud or model fallback is introduced by this transport ticket.

The executor's `accept:postgres-real` may still fail closed with `ENVIRONMENT_REQUIRED` when no
server is configured. That is an honest external gate, not a reason to route production requests
to PGlite or memory.

## 6. Minimal implementation surface

Expected changes:

```text
src/preview/server.ts                    # route, body/content/timeout and safe response adapter
src/preview/clinical-preview-backend.ts  # narrow ExtractionGoldenPath delegation/configuration
test/extraction-http.test.ts              # focused HTTP transport matrix
test/postgres-preview.test.ts             # only if existing manager/PG wiring needs coverage
README.md                                 # one local command/route note
```

No migration, ORM, dependency, multipart parser, upload endpoint, authentication framework, UI
rewrite, WebSocket, queue, worker, scheduler, cloud deployment or new business state is allowed.

## 7. Mandatory acceptance matrix

Use a test-local object store/inference/golden-path seam where appropriate, plus the existing PGlite
repository harness for persisted integration coverage. Tests must verify the adapter itself, not
just the application service:

1. A valid employee request injects the configured ActorContext, constructs fixed `EXAM_REPORT` /
   `CONSEQUENCE` fields and calls `ExtractionGoldenPath` exactly once.
2. A `COMPLETED` result maps to HTTP 200 and the bounded response contains expected durable IDs and
   states but no identity anchor, object ref, bytes, path, candidate, lineage, OCR or provider data.
3. Extraction `REVIEW_REQUIRED` maps to HTTP 200 / `reviewStage: EXTRACTION`; composition review
   maps to `COMPOSITION`; neither is reported as completed.
4. Exact replay returns the same detached bounded JSON and does not create a second extraction or
   inference call.
5. Missing, malformed, array, oversized, wrong-content-type and duplicate-key bodies fail before
   the application port is acquired.
6. Unknown keys and injected authority/result/workflow/manager/model fields fail before the port;
   request body cannot override context, operation kind, Artifact kind or Workflow family.
7. Missing, invalid or mismatched `Idempotency-Key` fails without state mutation.
8. Non-employee context, cross-clinic object reference, unknown expectation and wrong-Workflow
   expectation fail closed without cross-tenant disclosure.
9. Stored-object-not-found, integrity mismatch, provider failure, persistence conflict and
   unexpected errors map to the fixed public error vocabulary with no raw details.
10. Body and application timeout return a single controlled response; a later exact replay follows
    WO-023 durable idempotency and never deletes an immutable object or extraction record.
11. A manager `GET /api/manager/closures` after a completed/reviewed operation uses the existing
    read repository, remains read-only and contains no ordinary chat or raw extraction payload.
12. Two configured clinics with identical IDs remain isolated; the URL/body cannot select the
    other clinic.
13. `PREVIEW_MODE=postgres` without real `DATABASE_URL`, object-store root or extraction backend
    fails closed; synthetic mode never silently enables the persisted route.
14. All prior tests, both demos, local OCR acceptance and the real-PostgreSQL fail-closed check
    remain green/explicit.

## 8. Non-goals

- multipart, upload, streaming bytes or object deletion;
- authentication, login, JWT, cookies, production identity provider or user provisioning;
- trigger-side HTTP flow or arbitrary consequence kinds;
- automatic OCR/model invocation outside the already constructed WO-020/WO-021 provider boundary;
- new Workflow/Expectation/S2/manager business rules;
- manager decisions or a new manager query;
- WebSocket/live subscriptions, queue, worker, scheduler or retry loop;
- cloud deployment, remote storage, cloud inference or public internet exposure;
- PHI display, candidate/OCR text response or clinical-language accuracy claims.

## 9. Builder handoff

The Builder must read the Constitution and WO-002, WO-005, WO-008, WO-019, WO-020, WO-022 and
WO-023 before editing. Implement only this local transport seam. Run:

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
feat(preview): expose persisted extraction HTTP transport
```

Do not push before independent Architecture Review. Report the exact route, request/response
contract, test count, timeout semantics, profile gates and any external acceptance gate separately.

## 10. Architecture review checklist

Review must inspect implementation, not only tests, for:

- complete body/content/authority validation before dependency acquisition;
- fixed route semantics and server-derived ActorContext/kind/operation;
- no direct domain/repository writes or second extraction policy;
- bounded detached success/review projections with no PHI/bytes/path/provider output;
- controlled error mapping with no raw messages or stack traces;
- byte-based body limit, single-response timeout/disconnect handling and explicit replay semantics;
- tenant isolation at the configured backend and manager read reuse;
- no synthetic/PGlite/database fallback in the persisted profile;
- no hidden upload, UI, queue, authentication or cloud scope.

## Architecture acceptance

Accepted after commits `92bd1a1`, `1ccd2cb`, `a33a8a7`, and `06fe46b`, followed by independent
review.

- Full regression: 322/322.
- HTTP/Postgres/OCR focused checks: 21/21.
- Domain and Runtime demos: passed.
- Local Tesseract acceptance: 2/2 passed.
- Real PostgreSQL acceptance: intentionally fail-closed with `ENVIRONMENT_REQUIRED` because no
  PostgreSQL server configuration is present.
- Postgres Preview startup validates the complete OCR asset and checked-in manifest trust chain
  before creating the server; synthetic preview remains independent.
- The current workspace has a 0777 `/workspace` ancestor, so secure Postgres Preview correctly
  rejects it with `OCR_MODEL_INTEGRITY_FAILED`; deployment must use a protected path such as
  `/opt/clinic-os-2608`.
- GitHub push remains deferred for the batch release.
