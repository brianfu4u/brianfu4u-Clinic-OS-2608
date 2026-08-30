# WO-028 — Employee-Scoped Open Expectation Selection

**Status:** Ready for Builder  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** Constitution, WO-005, WO-015, WO-016, WO-023 through WO-027

## 1. Outcome

Replace the preview's page-memory `expectationByAnchor` prerequisite with one authoritative,
tenant-scoped employee read projection. An employee can select one currently pending `EXAM_REPORT`
Expectation before uploading evidence:

```text
trusted employee ActorContext
  -> GET /api/employee/open-expectations
  -> detached safe selectable projection
  -> employee selects opaque expectationId in page memory
  -> upload
  -> existing POST /api/employee/extraction/exam-report
```

This is a read and preview-selection slice only. It does not change composition, identity gating,
extraction, attachment, S2, manager reads, persistence schema, authentication, or worker/job
behavior.

## 2. Why a new read is necessary

The existing `ExpectationRepository.getExpectation` is a single-ID core preflight: it returns the
full domain Expectation, acquires a locking path, and has no employee ownership or bounded list
projection. `ManagerClosureReadRepository` is manager-only and deliberately includes identity and
evidence fields. Neither is a safe employee selection read.

Add one narrow authoritative repository, preferably:

```ts
EmployeeOpenExpectationReadRepository.listOpenExamReportExpectations(context, query)
```

It is the only new durable read authority. It must run in the existing tenant transaction wrapper,
use the existing RLS session binding, and return detached projection values. It must never call the
manager read repository, the extraction path, or a browser/in-memory map.

## 3. Eligibility and time semantics

The repository accepts a server-supplied strict ISO instant `asOf`; HTTP obtains it from the
injected server clock once at request start. The browser never supplies `asOf`, a clinic, actor,
role, identity anchor, workflow ID, or status filter.

An item is selectable exactly when all of the following are true at that `asOf` instant:

1. `expectation.state = OPEN`;
2. `workflow.status = OPEN`;
3. `expectation.consequence_kind = EXAM_REPORT`;
4. `triggered_at <= asOf < due_at` (the due instant is exclusive);
5. the unique initialization transition points to a linked trigger Artifact whose
   `source_employee_id` exactly equals `context.actorId`; and
6. every joined row has the request clinic ID.

Rule 5 is the present durable, auditable employee scope. It neither guesses a patient nor creates a
new ownership model. A future assigned-work model can add its own authority later; it must not
weaken this exact trigger-source scope.

`MET`, `UNMET`, `VOIDED`, missing/terminal Workflow, future-triggered, due-at-or-past, malformed,
or inconsistent rows are not returned. This query is read-only: it does not re-evaluate a stale
Expectation, create a transition, or make an overdue OPEN projection appear current. Inconsistent
stored relationships must fail closed with a stable internal domain code, never be silently
projected.

## 4. Safe projection, ordering, and pagination

Each item contains exactly:

```ts
{
  expectationId: string;       // opaque durable ID
  workflowFamily: string;
  consequenceKind: "EXAM_REPORT";
  dueAt: string;               // canonical ISO instant
  state: "OPEN";
}
```

No identity anchor, patient/subject field, employee ID, artifact/link/transition ID, workflow ID,
verification, decision, OCR/model result, candidate, payload, path, object reference, or raw SQL
error may enter this projection.

Order is deterministic: `due_at ASC, expectation.id ASC`. Support bounded keyset pagination:

- `limit` is an optional base-10 integer, default `25`, minimum `1`, maximum `50`;
- `cursor` is optional, bounded opaque base64url state containing only the last returned canonical
  due instant and opaque expectation ID; it must be strictly decoded/validated;
- a cursor advances only after that `(due_at, id)` tuple; it must not alter clinic or actor scope;
- query one extra row to determine `nextCursor`; return `null` when exhausted.

The public response is exactly:

```json
{ "items": ["safe projection"], "nextCursor": "opaque string or null" }
```

Returned objects, arrays, and nested values must be cloned/detached before resolving. Inputs are
snapshotted before the first await. A malformed query/cursor fails before repository acquisition.

## 5. Backend and HTTP boundary

Extend `ClinicalPreviewBackend` with the narrow list method and let
`PostgresClinicalPreviewBackend` delegate only to the new repository after
`assertActorAccess(context, context.clinicId, "EMPLOYEE")`.

Add only this route:

```text
GET /api/employee/open-expectations?limit=<1..50>&cursor=<opaque>
```

- It always uses the server-injected employee `ActorContext` and server clock; request input cannot
  select another tenant, actor, role, query time, consequence kind, or workflow.
- Accept only `limit` and `cursor` query keys. Duplicate or unknown keys, empty values, malformed
  percent encoding, malformed cursor, and non-canonical limits receive one fixed public
  `400 { error, message }` vocabulary such as `INVALID_EXPECTATION_QUERY`; do not echo values.
- A durable backend missing from synthetic preview receives the existing bounded unavailable
  behavior. Synthetic preview must not fabricate selectable Expectations.
- The route must map all domain/database failures to fixed safe public responses. It must not expose
  raw DomainError messages, query values, SQL, paths, object IDs beyond the normal response,
  provider output, stack traces, or PHI.
- Same-origin remains the only default. No CORS, authentication mechanism, query logging, cache
  header that shares employee data, or manager endpoint is added.

The authoritative consequence route remains unchanged: it independently validates the selected
Expectation against the resulting attachment and exact identity rules. This list is a convenience
read, never authorization to attach or close anything.

## 6. Preview behavior

In persisted PostgreSQL preview, selecting `EXAM_REPORT` work mode fetches the first safe page and
shows a required `<select>` whose option labels contain only workflow family, consequence kind and
formatted due time. The option value is the opaque `expectationId`; no free-text expectation input
exists.

- The selected ID and fetched projections exist only in current JavaScript/DOM state. Do not use
  `localStorage`, URLs, browser database, analytics, console logging, topic text, or conversation.
- Before upload, require a valid current selection. Missing/failed/empty selection makes neither
  upload nor extraction request and renders a short static instruction.
- The existing `expectationByAnchor` map is removed from the persisted evidence flow. Registration
  may still create an Expectation, but the UI refreshes this server list rather than treating a
  registration response as a selection authority.
- On success, review, mode/anchor change, refresh, or list reload, clear the selected value when it
  is no longer present. A page reload naturally re-fetches; it does not restore a previous choice.
- The extraction request takes its `expectationId` only from the validated selected safe item. It
  still sends the existing explicit employee-supplied identity anchor and timestamps; browser code
  must not infer identity from a selected item.
- Synthetic mode keeps durable evidence disabled and displays no fake options. Ordinary
  conversation remains entirely separate and makes no list, upload, or extraction request.

The preview may provide a bounded “load more” control using `nextCursor`, but it must retain only
safe projection values, cap displayed/current-page items at 50 per request, and never concatenate
unbounded result history.

## 7. Minimal implementation surface

```text
src/persistence/employee-open-expectation-read-repository.ts
src/preview/clinical-preview-backend.ts
src/preview/server.ts
src/preview/public/app.js
src/preview/public/app.css                 # only if selection status needs compact styling
test/employee-open-expectation-read-repository.test.ts
test/postgres-preview.test.ts
test/preview.test.ts                        # only for static/browser-contract coverage
```

No migration, domain-contract change, ORM, manager projection change, object-store/model/OCR
change, authentication/session framework, workflow assignment model, queue/WebSocket, browser
storage, new dependency, or HTTP POST is permitted.

## 8. Required acceptance tests

1. An employee receives only own exact-trigger-source, same-clinic, `OPEN`, future-due
   `EXAM_REPORT` Expectations; the projection has exactly the five safe fields.
2. Another employee, another clinic, a manager role, cross-tenant ID coincidence, and a source
   employee merely mentioned in payload cannot read or redirect the list.
3. `MET`, `UNMET`, `VOIDED`, terminal Workflow, due-at/past, future-trigger, wrong consequence kind,
   orphan/missing/ambiguous initialization lineage and malformed stored rows are absent or fail
   closed as applicable; the read writes no row.
4. Strict `asOf` boundary is proved: trigger is inclusive and due is exclusive; the browser cannot
   provide or override it.
5. Order is stable by due time then ID; limits/cursors are bounded and deterministic; malformed,
   duplicate, non-canonical or scope-altered cursors fail before acquisition without leaking data.
6. Input mutation during an await and mutation of a returned page/item cannot alter query or
   subsequent read result.
7. HTTP uses only the server Employee `ActorContext`, permits only exact query shape, returns the
   exact detached bounded response, maps error/unavailable cases safely, and adds no wildcard CORS.
8. Synthetic preview returns no durable options and no durable fallback.
9. Browser `EXAM_REPORT` gets selection first, never uses `expectationByAnchor`, and sends upload
   then extraction only after a valid selected item; ordinary conversation sends none of these.
10. An employee-created registration appears through the list when otherwise eligible; its selected
    consequence still passes the existing independent authoritative golden-path checks.
11. Existing tests, both demos, `accept:ocr-local`, and explicit `accept:postgres-real` gate remain
    green/explicit.

## 9. Honest boundary

This makes an employee-side selection usable after refresh without exposing patient identity. It is
not production login, an assignment/task system, a general employee work queue, a manager read,
real-time subscription, retry scheduler, audit-search UI, or a claim that expired Expectations are
automatically reconciled. Real PostgreSQL application-role RLS/concurrency and production
deployment remain separate acceptance gates.

## 10. Builder handoff

Read the Constitution and WO-005, WO-015, WO-016, WO-023 through WO-027 before editing. Implement
only this read, route, and preview selection. Run:

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
feat(preview): select scoped open expectations
```

Do not push before independent Architecture Review. Report exact files, test count, the external
PostgreSQL gate separately, and any deviation.
