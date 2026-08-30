# WO-023 — Extract, Persist, and Process the Golden Path

**Status:** Accepted — Architecture Review passed 2026-08-30
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** Constitution, WO-015, WO-020, WO-021, WO-022

## 1. Outcome

Close the first durable application gap with one small, restartable orchestration service:

```text
StoredObjectRef
  -> StoredEvidenceExtractionService
  -> ExtractionPersistenceRepository (atomic lineage)
  -> READY gate
  -> PersistedGoldenPath.recordConsequence
  -> authoritative Attach Saga / Expectation / S2
```

The service turns one already-uploaded object into a durable extraction record and, only when the
extraction is `READY`, sends its server-validated Artifact and FactCard through the existing
PostgreSQL golden path. It does not create a second composition or persistence policy.

The first tracer is deliberately the existing WO-020 `EXAM_REPORT` extraction. It is a consequence
event for an Expectation created by the already-accepted registration/trigger path in WO-015. A
future trigger-specific extraction pack may add `recordTrigger`; this work order does not broaden
the extraction taxonomy or frozen parser spec merely to make a symmetrical API.

## 2. Architecture boundary

Add one application-level service/function, preferably:

```ts
processGoldenPath(context, command, ports): Promise<ProcessGoldenPathResult>
```

The implementation may be a `PersistedExtractionGoldenPath` class, but the public behavior must be
one narrow command. It must call only these existing authorities:

1. `StoredEvidenceExtractionService.extract` for object read, inference and candidate validation;
2. `ExtractionPersistenceRepository` for the atomic StoredObjectRef/Artifact/FactCard/Attempt
   write and a tenant-scoped detached lookup by extraction `requestId`. Migration `0007` binds
   every durable attempt to both the requested consequence Expectation and the requested FactCard;
   these two opaque IDs are request identity, not model claims. This is required because a
   `requestId` replay with a changed `expectationId` or FactCard ID must never reuse extraction and
   invoke the golden path against a different operation, including `REVIEW_REQUIRED` results.
3. `PersistedGoldenPath.recordConsequence`, which in turn uses the existing Capture Repository,
   authoritative Workflow Attach Repository, Expectation Repository and Verification Repository.

Do not call `CaptureRepository` directly from the new service and do not call the in-memory
`runGoldenPath`. There is one authoritative link writer: the existing Attach Saga.

## 3. Frozen command and result

The command contains no Artifact, FactCard, candidate, lineage, clinic, actor, Workflow, status,
verification or decision fields. Those are produced or read from trusted application state.

```ts
interface ProcessGoldenPathCommand {
  extraction: StoredEvidenceExtractionCommand;
  operation: {
    kind: "CONSEQUENCE";
    expectationId: string;
    attachedAt: string;
    evaluatedAt: string;
  };
}
```

`extraction` is exactly the WO-020 command. `operation.expectationId` is a bounded opaque ID
returned by the prior server-side trigger flow; it is not a rule or Workflow ID. The service must
not accept a caller-supplied Expectation specification for this operation. `attachedAt` and
`evaluatedAt` are explicit strict zoned instants and are never read from the system clock.

The result must be detached and must distinguish where review stopped:

```ts
type ProcessGoldenPathResult =
  | {
      status: "COMPLETED";
      reviewStage: null;
      extraction: Extract<StoredEvidenceExtractionResult, { status: "READY" }>;
      goldenPath: PersistedConsequenceResult;
    }
  | {
      status: "REVIEW_REQUIRED";
      reviewStage: "EXTRACTION" | "COMPOSITION";
      extraction: StoredEvidenceExtractionResult;
      goldenPath: PersistedConsequenceResult | null;
    };
```

For `reviewStage: "EXTRACTION"`, `goldenPath` is null and no FactCard, Link, Expectation or
Verification is fabricated. For `reviewStage: "COMPOSITION"`, the extraction is `READY` and
durable; the existing Attach Saga returned its review result, and no Expectation or Verification
call is made. A thrown error is not converted into review.

## 4. Exact stage order

### 4.1 Validate and snapshot before acquisition

Before calling the object store, inference gateway, database or golden-path repository:

- snapshot the complete `{ context, command }` using the same inert/safe-input boundary used by
  WO-020/WO-022;
- enforce exact command shapes and a valid exact `ActorContext`;
- enforce context clinic scope, nonblank bounded IDs and strict zoned times;
- require `operation.kind === "CONSEQUENCE"` and a bounded nonblank `expectationId`;
- require the extraction command's `kind` to remain the frozen `EXAM_REPORT` kind;
- reject caller authority/verdict fields, extra keys, proxies, accessors, symbols, unsafe values
  and cross-clinic object references;
- enforce `attachedAt <= evaluatedAt` and `occurredAt <= evaluatedAt` where an occurrence exists.

Validation must be complete before the first dependency method is acquired. Do not rely on
TypeScript types, route names or the downstream repository as the only boundary.

### 4.2 Restart lookup before model work

Use a tenant-scoped detached `ExtractionPersistenceRepository.getExtraction(context, requestId)`
before invoking extraction. The read must return only the persisted object/artifact/candidate/
lineage projection and must contain no object bytes, filesystem path or model output beyond the
validated bounded candidate already defined by WO-020.

- If a record exists, compare its immutable extraction identity with the current command:
  clinic, request, object ref/hash, Artifact ID/kind/identity/occurrence/source actor, requested
  FactCard ID, consequence Expectation ID and the server-frozen lineage. A changed value is a
  stable `EXTRACTION_REQUEST_CONFLICT`.
- If it matches, reuse the stored detached result and do not read the object or call inference.
- If no record exists, call `StoredEvidenceExtractionService.extract`, then persist the exact
  result with `saveExtraction`.
- If two first callers race and one save reports request conflict, reload the stored record and
  use it only if the complete immutable extraction identity matches; otherwise fail visibly.

This lookup is necessary for retry after a later golden-path failure. Re-running a model and
trying to overwrite its timestamp/lineage would turn a recoverable restart into a false conflict.

### 4.3 REVIEW_REQUIRED is terminal for this command

After a fresh extraction, `saveExtraction` is called before branching on status. The persisted
`REVIEW_REQUIRED` result is returned with `reviewStage: "EXTRACTION"`; no workflow repository is
acquired. The original object reference and Artifact remain durable for future human review.

### 4.4 READY enters the existing persisted golden path

For a persisted `READY` result, call exactly:

```ts
PersistedGoldenPath.recordConsequence(context, {
  artifact: saved.artifact,
  factCard: saved.factCard,
  expectationId: operation.expectationId,
  attachedAt: operation.attachedAt,
  evaluatedAt: operation.evaluatedAt,
})
```

The service must use the result returned by the persistence repository, not an original mutable
extractor object. `recordConsequence` remains responsible for authoritative attach, workflow
matching/creation rules, Expectation workflow preflight, reevaluation and S2 verification.

If it returns its accepted `REVIEW_REQUIRED` result, return `reviewStage: "COMPOSITION"`. If it
throws, preserve the controlled error and leave the durable extraction lineage available for a
later exact replay. Never delete, void or compensate immutable records.

## 5. Replay and failure semantics

This service coordinates short atomic stages; it does not claim one global ACID transaction across
object storage, extraction persistence and Workflow processing.

| Failure point | Durable effect | Replay behavior |
|---|---|---|
| validation/object/inference | none in the database | same command may retry |
| extraction persistence | WO-022 transaction rolls back all new rows | retry extraction; orphan object is never deleted |
| after persisted extraction, before attach | extraction lineage remains | lookup skips inference and retries golden path |
| attach ambiguity | extraction + capture remain visible; no Expectation/S2 | exact replay returns composition review |
| attach/Expectation/S2 error | prior committed stages remain | exact replay resumes through idempotent repositories |
| exact completed replay | no new immutable rows | return detached current durable result |

The service must not add a queue, retry loop, scheduler, outbox, worker, compensation delete or
independent in-memory fallback. Automatic retry belongs to a later operational layer.

## 6. Security and authority rules

- `ActorContext` is the only source of clinic, actor and role authority.
- The extractor is never given the identity anchor; the resulting Artifact/FactCard inherit it
  through the WO-020 deterministic assembly.
- `modelManifestSha256`, parser/schema/policy versions and provider/model identity come from the
  frozen extraction spec/lineage. The orchestration command cannot replace them.
- Only `READY` can reach Workflow processing. A model candidate or `REVIEW_REQUIRED` result cannot
  create a Workflow, Link, Expectation, Verification or manager conclusion.
- `expectationId` is checked by WO-015 through a tenant-scoped read and exact Workflow match
  before reevaluation/verification. The new service must not preflight with an untrusted global
  query or accept a Workflow ID as a substitute.
- Every returned object is structured-cloned/detached. Caller mutation during awaits and mutation
  after return cannot alter any committed row or replay result.
- Errors expose controlled domain codes only; no bytes, OCR text, candidate dump, database URL,
  path, provider stderr or PHI is included.

## 7. Minimal file surface

Expected changes:

```text
src/application/extraction-golden-path.ts       # new orchestration service
src/persistence/extraction-persistence-repository.ts # detached get by requestId
test/extraction-golden-path.test.ts             # new focused integration tests
test/postgres-extraction-persistence-repository.test.ts # read/replay coverage if needed
README.md                                       # one usage/authority note only
```

No migration beyond the required append-only `0007` operation-identity columns, dependency, ORM, HTTP route, UI, queue, worker, scheduler, object-store provider,
OCR/model change, manager action, or new domain state is allowed.

## 8. Acceptance matrix

Use the existing PGlite SQL-semantic harness, real repositories and test-local deterministic
inference/object providers. Do not claim real PostgreSQL server acceptance; retain the existing
fail-closed gate.

| # | Acceptance proof |
|---|---|
| 1 | A valid stored `EXAM_REPORT` goes through extract → four-record persistence → consequence Attach/Expectation/S2 in that exact order. |
| 2 | An extraction `REVIEW_REQUIRED` persists Object/Artifact/Attempt, no FactCard, and acquires no golden-path repository. |
| 3 | A composition ambiguity after a `READY` extraction returns `reviewStage: COMPOSITION`, with no Expectation or Verification mutation. |
| 4 | Exact replay after success returns detached durable identities, performs no second object read/inference, and creates no duplicates. |
| 5 | Replay after a forced attach/Expectation/Verification failure skips extraction and successfully resumes through existing idempotent repositories. |
| 6 | A changed request object/hash, Artifact identity/time, operation expectation ID or lineage is a stable conflict and cannot overwrite prior rows. |
| 7 | Two first-call races either reuse one exact durable extraction or fail with a visible conflict; no duplicate FactCard/Attempt/Link is created. |
| 8 | Missing/invalid object, provider failure, malformed candidate or model identity failure causes no database writes and no fallback. |
| 9 | A consequence with an unknown, cross-clinic or wrong-Workflow Expectation cannot produce Expectation/S2 completion. |
| 10 | Context, command, provider result and returned result are mutation-safe across awaits; hostile prototypes/accessors/symbols/extra keys fail before acquisition. |
| 11 | Future, non-zoned or reversed timestamps fail before object/model/database acquisition. |
| 12 | Caller cannot inject Workflow, Link, Expectation state, Verification, decision, identity or manager fields into the orchestration command. |
| 13 | Cross-clinic same IDs and object hashes remain isolated; all reads use ActorContext clinic scope. |
| 14 | The persisted replay projection contains bounded candidate and lineage but no bytes, path, OCR output, identity leak or PHI. |
| 15 | Full regression, both demos, local OCR acceptance and `accept:postgres-real` fail-closed check remain green/explicit. |

## 9. Non-goals

- trigger-side extraction or a new trigger ExtractionSpec;
- automatic OCR/model invocation beyond calling the already-accepted WO-020 service;
- HTTP/multipart/UI wiring;
- queues, background workers, retries, scheduling or event dispatch;
- a global transaction or distributed object-store/database commit;
- changing candidate schema, identity gates, Attach Saga, Expectation or S2 rules;
- automatic Workflow creation outside the existing authoritative Saga;
- manager decisions/read-model changes;
- object deletion, cloud storage, model downloads or clinical-language accuracy claims;
- production authentication, real PostgreSQL application-role RLS/concurrency, backup/restore.

## 10. Builder handoff

Read the Constitution and WO-015, WO-020, WO-021 and WO-022 before editing. Implement only the
minimal orchestration and detached extraction lookup, add the focused tests, run:

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
npm run accept:ocr-local
npm run accept:postgres-real
git diff --check
```

Commit as `feat(application): orchestrate extraction golden path`. Do not push before independent
Architecture Review. Report stage order, replay behavior, exact tests and any external gates
separately.

## 11. Review checklist

Architecture Review must inspect implementation (not only tests) for:

- no inference/object acquisition before complete validation or existing-attempt lookup;
- no branch allowing `REVIEW_REQUIRED` to reach a Workflow repository;
- no direct Link/Workflow writes outside the accepted Saga;
- persisted result is used for downstream processing;
- exact request replay skips model work and preserves original lineage/time;
- race/conflict behavior is fail-closed;
- stage errors are not swallowed and immutable rows are never deleted;
- all tenant reads and returned projections are detached and bounded;
- no hidden HTTP/UI/queue/ORM/dependency scope.

## 12. Architecture acceptance

Accepted after commits `60a1800`, `133d76c`, and `deb59d5`, followed by independent review.

- Full regression: 315/315.
- Domain and Runtime demos: passed.
- Local Tesseract acceptance: 2/2 passed.
- Real PostgreSQL acceptance: intentionally fail-closed with `ENVIRONMENT_REQUIRED` because no
  PostgreSQL server configuration is present in this environment.
- Review fixes included durable operation identity (`expectationId` and requested FactCard ID) and
  a database-level READY binding check; old unbound migration state fails closed.
- No HTTP/UI/queue/worker scope added; GitHub push remains deferred for the batch release.
