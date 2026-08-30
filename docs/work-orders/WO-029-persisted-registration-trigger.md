# WO-029 — Persisted Employee Registration Trigger

**Status:** Ready for Builder  
**Architect:** Codex Architecture Designer  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** Constitution, WO-005, WO-015, WO-016, WO-023 through WO-028

## 1. Outcome

Make the first half of the employee evidence demonstration durable without reusing the old
synthetic text work-update path:

```text
explicit employee "create registration"
  -> server-injected Employee ActorContext
  -> server-derived Artifact / FactCard / Expectation identities
  -> PersistedGoldenPath.recordTrigger
  -> durable OPEN EXAM_REPORT Expectation
  -> refresh existing WO-028 safe open-expectations list
  -> select it -> existing upload and extraction chain
```

This is a deliberately narrow `REGISTRATION` trigger command. It creates no generic event API,
does not accept a Workflow or Expectation rule from the browser, and does not make ordinary chat
an Artifact.

## 2. Why a new route is required

`POST /api/employee/work-updates` is the original preview adapter. Its input includes a topic,
free text and a synthetic `kind` selector; when a PostgreSQL backend is present it happens to
construct a durable event. That is useful legacy preview behavior, but it is not a safe authority
boundary for the durable first trigger: it lets browser text and the synthetic PreviewStore shape
participate in the clinical command.

Add one route with one fixed operation instead:

```text
POST /api/employee/registration-trigger
Idempotency-Key: <bounded opaque token>
Content-Type: application/json
```

The route fixes all of the following server side:

- employee role and clinic from the injected `ActorContext`;
- `REGISTRATION`, `PATIENT`, `EYE_EXAM`, `EXAM_REPORT` and the 15-minute consequence window;
- Artifact, FactCard and Expectation IDs, each domain-separated from the trusted clinic, employee
  and idempotency token;
- FactCard lineage, parser version and deterministic preview fields;
- received/attached/evaluated time from one server clock sample.

The client submits exactly this body:

```json
{
  "identityAnchor": "DEMO-001",
  "occurredAt": "2026-08-30T09:00:00.000Z"
}
```

No `topicId`, `text`, `kind`, `workflowFamily`, `requestId`, Artifact/FactCard/Workflow/
Expectation/Verification/decision ID or state, due time, source employee, tenant, actor, role,
provider, model, candidate, object reference or extra key is accepted. Query parameters are not
accepted. Duplicate JSON keys and a non-JSON body fail before backend acquisition.

## 3. Application/backend contract

Add a narrow backend operation, for example:

```ts
createRegistrationTrigger(context, {
  identityAnchor: string;
  occurredAt: string;
  idempotencyKey: string;
  receivedAt: string; // sampled once by server transport
}): Promise<ClinicalRegistrationTriggerResult>
```

`PostgresClinicalPreviewBackend` is the only durable preview implementation. It snapshots and
validates the entire input before its first repository call, asserts exact `EMPLOYEE` access, and
then calls only the accepted `PersistedGoldenPath.recordTrigger`.

Construction is fixed as follows:

| Value | Authority |
|---|---|
| clinic / source employee / role | injected `ActorContext` |
| identity anchor | exact employee input, no normalization or inference |
| Artifact kind / subject / family | frozen server values `REGISTRATION` / `PATIENT` / `EYE_EXAM` |
| Artifact payload | minimal fixed non-PHI marker such as `{ previewRegistration: true }`; no free text |
| Artifact / FactCard / Expectation IDs | three distinct domain-separated stable hashes of trusted context + idempotency key |
| FactCard identity / occurrence / lineage | copied exactly from the Artifact |
| parser version | frozen server literal, e.g. `preview-registration-trigger-1` |
| triggeredAt | supplied strict `occurredAt` |
| dueAt | `triggeredAt + 15 minutes`, computed once by server |
| createdAt / attachedAt / evaluatedAt | one validated server `receivedAt` sample |

The Artifact `occurredAt` and FactCard occurrence must exactly equal `triggeredAt`; the FactCard
must contain the original Artifact ID in lineage. The backend must use the existing exact identity
gate and the existing authoritative Attach Saga; it must not choose a Workflow itself.

### 3.1 Time and replay rules

`occurredAt` and the one server-clock `receivedAt` must be strict zoned ISO instants. The route
rejects future occurrence (`occurredAt > receivedAt`) before the backend. The backend repeats the
cross-field check before repository acquisition. `attachedAt` and `evaluatedAt` both use
`receivedAt`, so their order is exact and reproducible for a request.

The browser never supplies received, attached, evaluated, trigger, due or policy time. A past
registration is allowed to preserve observed fact time; ordinary Expectation rules determine
whether its resulting projection is already `UNMET`, and WO-028 will not offer it as selectable
after its due boundary.

Exact replay means the same trusted clinic, employee and idempotency key with the same anchor and
occurrence. It must return the same immutable durable identities and no duplicate rows. A changed
anchor or occurrence under the same derived identity is an immutable conflict. The race recovery
pattern may reuse the accepted CaptureRepository read/retry behavior, but it must not alter
`createdAt`, recompute IDs from mutable browser fields, or swallow a conflict.

### 3.2 Result and controlled errors

Return one detached bounded public projection only:

```json
{
  "status": "COMPLETED",
  "expectationId": "expectation:<opaque-id>",
  "expectationState": "OPEN",
  "verificationStatus": "PENDING"
}
```

The server must not return a Workflow ID, Artifact ID, FactCard ID, identity anchor, source
employee, due time, payload, link, candidate, verification reasons, object reference, model data
or raw repository error. `REVIEW_REQUIRED` is possible only if the accepted Attach Saga says so;
its public projection contains only `{ status: "REVIEW_REQUIRED" }`. The UI must not treat this as
a successful registration or create a selectable item.

Use the existing `{ error, message }` static public error shape. Invalid command/body/time,
idempotency conflict, unavailable durable backend and unexpected failures must use fixed safe
codes/messages. Never serialize `DomainError.message`, request input, identity anchor, SQL,
paths, provider output or stack trace.

## 4. HTTP and preview behavior

### 4.1 Route boundary

The route is available only when the PostgreSQL clinical backend is explicitly assembled. In
synthetic preview it returns the controlled durable-unavailable response and performs no memory
or fake persistence write. It must not be registered as a route that quietly delegates to
`PreviewStore`.

When a durable backend is active, `POST /api/employee/work-updates` is no longer a durable
clinical command. It must reject rather than route a synthetic text `REGISTRATION` or
`EXAM_REPORT` into PostgreSQL. The legacy work-update route remains only for the explicitly
synthetic PreviewStore and existing synthetic tests/demo behavior. This prevents an old page,
curl request, or topic text from creating a durable clinical event through a second path.

The route always uses the injected employee context and requires the existing bounded
`Idempotency-Key`. It adds no CORS, authentication/session framework, cookies, URL parameter,
query logging or cache sharing. Same-origin remains the only default.

### 4.2 Browser flow

In a configured durable preview, Work mode presents two explicit choices:

1. **Registration** — shows only exact synthetic identity-anchor entry and occurrence time, then
   calls `/api/employee/registration-trigger`.
2. **Exam report** — keeps the existing WO-028 safe list, file upload and extraction flow.

On a completed registration, the browser immediately re-fetches
`GET /api/employee/open-expectations?limit=25`; it does **not** take the trigger response's
Expectation ID as upload authority, retain an `expectationByAnchor` map, or synthesize a list
entry. The employee must select the returned opaque safe-list item before upload. The list's
existing server-side exact trigger-employee/clinic/time checks remain the authority.

Registration UI supplies no text field to the durable trigger. It may append a static local
display message such as “registration recorded” after a bounded completed response, but must not
write patient identity, opaque identifiers, timestamps, or server response data into the chat
thread. Ordinary Conversation continues to call only `/api/employee/messages`, and must never
call registration, list, upload or extraction endpoints.

The browser holds its form values and bounded response status only in current DOM/JavaScript
state. It must not use localStorage (the existing language preference is unrelated and may stay),
URL parameters, browser database, analytics or console logging for clinical operation data. A
refresh re-fetches safe expectations and does not restore a previous selection. On identity/mode
change, review/error, or list reload, current selection is cleared as WO-028 requires.

Synthetic preview continues to show the explicit non-production warning. Its Registration control
may continue to demonstrate the existing synthetic work-update flow only if it is visibly labeled
synthetic; it must never return or display a fake durable success, fake open-expectation option,
or make upload/extraction available.

## 5. Minimal implementation surface

```text
src/preview/clinical-preview-backend.ts   # narrow server-derived registration command
src/preview/server.ts                     # one strict route; durable legacy-route rejection
src/preview/public/app.js                 # explicit trigger UI and safe-list refresh
src/preview/public/app.css                # only compact trigger status styling if required
test/postgres-preview.test.ts             # durable trigger/replay/list integration
test/preview.test.ts                      # synthetic separation/UI contract
test/extraction-http.test.ts              # route shape/error mapping only if needed
README.md                                 # durable registration -> select -> upload demonstration
```

No migration, schema/domain-contract change, ORM, model/OCR/provider change, object-store change,
manager read change, new authentication, worker, queue, scheduler, browser persistence,
WebSocket, generic event API, or new dependency is allowed.

## 6. Mandatory acceptance matrix

1. Valid durable registration creates one persisted Artifact/FactCard/authoritative link/
   Expectation/S2 verification through `PersistedGoldenPath.recordTrigger`; the resulting OPEN
   Expectation appears only through the WO-028 employee-safe list.
2. The HTTP body accepts exactly `identityAnchor` and `occurredAt`; all client authority,
   Workflow/Expectation/Verification, payload/text, due-time, model/object and unknown fields,
   duplicate keys, query parameters and malformed content types fail before backend acquisition.
3. Server-injected ActorContext controls clinic, employee and role. Cross-clinic, manager,
   spoofed employee, non-`DEMO-` anchor, blank/normalized/mismatched identity and future/non-zoned
   times fail closed; no row is written.
4. Artifact/FactCard/Expectation IDs are distinct, server-derived and stable. Browser-supplied IDs
   cannot replace them. FactCard copies the exact identity/occurrence and includes source Artifact
   lineage.
5. Due window is exactly 15 minutes from trigger. The server, not browser, supplies received,
   attached and evaluated time; `occurredAt <= receivedAt` is enforced before durable acquisition.
6. Exact idempotent replay returns the same detached bounded result and creates no duplicate
   immutable rows; changed identity or occurrence with the same key is an immutable conflict;
   first-call races fail safely or converge to exact replay.
7. Attach ambiguity returns only controlled registration review and creates no Expectation or S2
   result. A normal registration does not manually create/choose a Workflow.
8. Durable preview immediately refreshes the existing WO-028 list after completed registration;
   selection comes only from that safe projection. Registration response, identity anchor and
   opaque IDs are never used as browser persistence or upload authority.
9. With a durable backend, legacy `work-updates` cannot create a persistent clinical event; with
   synthetic preview, the new durable route is unavailable and no fake persistent success/options
   are produced. Conversation remains entirely separate.
10. Returned objects and inputs are mutation-safe across awaits. Browser/client response handling
    accepts only the bounded registration/list projections and maps errors to static text without
    raw server detail or PHI.
11. Existing full regression, Domain Demo, Runtime Demo, `accept:ocr-local`, and explicit
    `accept:postgres-real` gate remain green/explicit.

## 7. Honest boundary

This gives the demonstration a durable, explicit registration trigger before evidence upload. It
does not provide production authentication, real patient identity, assignment, a general event
ingestion API, automatic retry, durable employee session/chat, OCR clinical-language acceptance,
real PostgreSQL application-role RLS/concurrency proof, backup/restore, cloud deployment or a
claim that synthetic preview data is production-safe.

## 8. Builder handoff

Read the Constitution and WO-005, WO-015, WO-016, WO-023 through WO-028 before editing. Implement
only the frozen route/command and browser seam. Run:

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
feat(preview): add persisted registration trigger
```

Do not push before independent Architecture Review. Report changed files, test count, the external
PostgreSQL gate separately, and any deviation.
