# WO-016 — PostgreSQL Clinical Preview Wiring

**Status:** FROZEN
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`
**Depends on:** WO-001 through WO-015 accepted locally through `6c3c723`

## 1. Outcome

Wire the existing preview's three clinical operations to the accepted PostgreSQL application/repositories while preserving ordinary conversation isolation:

```text
employee work update -> WO-015 persisted golden path
manager closure list -> WO-014 safe read model
manager decision     -> WO-013 authoritative decision Saga
```

Topics, ordinary chat and employee status remain synthetic in-memory preview state. The server and health response must call this `hybrid-postgres-preview`; they must not imply production readiness or full restart persistence.

## 2. Minimal files

Expected files:

```text
src/preview/clinical-preview-backend.ts
src/preview/server.ts
src/preview/preview-store.ts
src/preview/public/app.js
test/postgres-preview.test.ts
test/preview.test.ts
README.md
```

Small changes to existing safe read/result types are allowed only if required. No migration, dependency, ORM, authentication framework, session table, chat table, scheduler or event bus.

## 3. Backend boundary

Add one narrow async `ClinicalPreviewBackend` contract covering only:

- `submitWorkUpdate(context, input)`;
- `listManagerClosures(context)`;
- `submitManagerDecision(context, input)`.

The default server path keeps the existing in-memory preview behavior. PostgreSQL mode is enabled only by an explicitly supplied backend/pool. Missing or invalid PostgreSQL configuration fails closed; it must never silently use the in-memory clinical path.

All clinical routes must `await` the backend. GET closure is pure read and must never advance an Expectation.

## 4. Trusted server derivation

For PostgreSQL work updates:

- clinic, actor and source employee come only from `ActorContext`;
- Artifact, FactCard, Workflow/Link, Expectation, Verification and decision IDs are server-derived;
- only synthetic `DEMO-` identity anchors and `EYE_EXAM` are accepted in this preview;
- `REGISTRATION` resolves the fixed preview policy `REGISTRATION -> EXAM_REPORT`, due after 15 minutes, then calls `recordTrigger`;
- `EXAM_REPORT` requires the server-issued `expectationId` returned by registration, then calls `recordConsequence`; arbitrary IDs remain harmless because WO-015 performs tenant/workflow preflight;
- caller cannot supply clinic, actor, role, source employee, state, verdict, evidence, Workflow ID or database IDs.

Use a bounded `Idempotency-Key` request header for work updates and manager decisions. Derive stable IDs from the trusted context + operation + key using Node's standard crypto. Exact replay returns the same durable result; key reuse with different content fails closed through immutable conflict rules. Do not add an idempotency table.

The browser may generate and retain an idempotency key per submitted action. It may retain the returned `expectationId` for the current synthetic sequence; employee topics and that browser continuation are not claimed to survive restart in this ticket.

## 5. Local preview state ordering

The in-memory store continues to enforce topic ownership and `ON_DUTY` before a formal update. Split only the minimum validation/message helpers needed by the async backend path.

- Validate topic/status/input before database work.
- Append local `WORK_UPDATE` and `WORK_UPDATE_RESULT` messages only after PostgreSQL completion or controlled review result.
- If any database stage throws, append no local success or work-update message.
- Ordinary conversation never calls the clinical backend and never appears in manager output.

## 6. Manager operations

- Closure GET uses `ManagerClosureReadRepository.listManagerClosures` and returns its safe allowlist only.
- Decision POST accepts `expectationId`, controlled action/reason/note and `Idempotency-Key`; IDs, actor and time are server-derived/injected.
- Decision POST calls `ManagerDecisionRepository.recordManagerDecision` and returns its detached durable result or a freshly read safe manager item.
- PostgreSQL mode does not pretend that the old in-memory decision-history endpoint is durable. Return a controlled `NOT_AVAILABLE_IN_POSTGRES_PREVIEW` response or leave that route disabled in PostgreSQL mode.
- Missing Expectation/Verification chains remain visible but must not render an executable decision form.

## 7. Required tests

1. PostgreSQL HTTP registration produces one OPEN/PENDING chain and returns `expectationId`;
2. EXAM_REPORT with that ID attaches to the same Workflow and produces MET/VERIFIED;
3. manager standard close produces CLOSED and remains visible after creating a new server/backend over the same database;
4. GET closure never advances OPEN to UNMET;
5. ordinary chat never acquires a DB connection and never enters manager payload;
6. OFF_DUTY, wrong topic/owner or malformed update fails before DB acquisition;
7. database failure leaves no local `WORK_UPDATE` or success message;
8. missing/invalid idempotency key fails before DB acquisition; exact key replay is idempotent; conflicting reuse fails closed;
9. request bodies cannot inject clinic, actor, source employee, state, verdict, evidence, Workflow or resource IDs;
10. manager decision requires `expectationId`; Workflow ID alone is rejected;
11. employee/manager role and cross-clinic isolation are enforced before or inside the authoritative boundary;
12. manager response contains no Artifact payload, FactCard fields, employee conversation or decision note;
13. incomplete chain does not expose an executable decision action;
14. health and UI identify the mode as hybrid and disclose which preview state remains volatile;
15. all existing tests and both demos remain green.

Use PGlite as the existing SQL-semantic harness. Server restart means a new HTTP server/backend/store instance over the same PGlite database; only the clinical chain is expected to persist.

## 8. Honest boundary

This ticket does not implement or claim:

- production authentication/session security;
- durable topics, chat, employee status or browser continuation;
- automatic Expectation scheduling or GET-time state mutation;
- decision-history persistence API beyond the accepted manager read item;
- file/blob storage, OCR, model inference or policy administration;
- real PostgreSQL application-role RLS/concurrency proof;
- backup/restore, offline installation or real-PHI readiness.

## 9. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
git diff --check
```

## 10. Builder handoff

The Builder must read the Constitution and WO-002, WO-003, WO-013 through WO-016, implement only this vertical preview slice, run all acceptance commands, commit as `feat(preview): wire postgres clinical backend`, report exact files/tests/deviations, and not push before Architecture Review.
