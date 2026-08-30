# WO-030 — Persisted Clinical Closure Acceptance Demo

**Status:** Accepted — Architecture Review passed 2026-08-30  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** Constitution; WO-005, WO-015, WO-020 through WO-029

## 1. Outcome

Turn the individually accepted durable pieces into one executable, restartable, non-PHI proof of
the first Clinic OS product closure:

```text
explicit registration trigger
  -> employee-scoped OPEN EXAM_REPORT selection
  -> immutable local-object upload
  -> stored extraction and durable lineage
  -> authoritative consequence attach / Expectation re-evaluation / S2
  -> manager CLOSE_STANDARD decision
  -> closed manager projection
```

The proof must execute the real production migrations, repositories and application services in
the existing PGlite PostgreSQL-semantic harness. It exists to catch integration drift between
accepted work orders; it is not a second implementation, a new business workflow, or a claim
that PGlite replaces the separate real-PostgreSQL acceptance gate.

## 2. Frozen scenario and clock

Use one fixed, synthetic employee, manager and exact synthetic anchor internally. Do not print
the anchor, employee/clinic identifiers, object reference, hash, bytes, extraction candidate,
SQL, filesystem location, or any raw error. The demo input bytes must be a tiny embedded non-PHI
fixture and must not contain a patient name, a real identifier, a document scan or a clinical
claim.

All instants are fixed strict UTC ISO instants; no production or test step may read the system
clock:

| Stage | Instant |
|---|---|
| Registration occurred | `2026-08-30T09:00:00.000Z` |
| Registration received / attached / evaluated | `2026-08-30T09:01:00.000Z` |
| Expected report due (server-derived) | `2026-08-30T09:15:00.000Z` |
| Report occurred | `2026-08-30T09:10:00.000Z` |
| Report created | `2026-08-30T09:10:30.000Z` |
| Fixture inference completed | `2026-08-30T09:10:40.000Z` |
| Report attached / evaluated | `2026-08-30T09:11:00.000Z` |
| Manager decision received / decided | `2026-08-30T09:12:00.000Z` |

The consequence is therefore strictly inside the existing 15-minute window. The demo must obtain
the `expectationId` only from the current employee-safe open-expectations page at an explicit
`asOf` inside that window. It may not reuse a registration return value, derive the ID, query an
internal table for it, or manually construct a Workflow/Expectation identity.

## 3. Required production path

The normal demo must use these existing production seams, in this order:

1. Apply `loadRepositoryMigrations()` to a fresh PGlite database.
2. Construct the existing `PostgresClinicalPreviewBackend` with a real `ExtractionGoldenPath`.
3. Create the registration with `createRegistrationTrigger`, using the existing server-derived
   IDs and `PersistedGoldenPath.recordTrigger` path.
4. Ask `listOpenExamReportExpectations` as the employee; select exactly one returned opaque safe
   item.
5. Put the fixture through `EvidenceObjectIngestionService`, `ObjectStoreGateway`, and
   `LocalObjectStore`. No object reference or object row may be manufactured.
6. Call `submitExamReportConsequence` with the returned stored reference and selected safe
   expectation. Its configured `StoredEvidenceExtractionService`,
   `ExtractionPersistenceRepository`, `ExtractionGoldenPath`, `PersistedGoldenPath`, attach
   repository, Expectation repository and Verification repository remain the sole authorities.
7. Read the current manager projection through `listManagerClosures`; do not reconstruct a
   manager view from tables.
8. Submit `CLOSE_STANDARD` through `submitManagerDecision` as the manager, then read the manager
   projection again through `listManagerClosures`.

The inference provider is the only allowed test fixture. It must be a bounded local
`LOCAL_MODEL` fixture behind the existing `InferenceGateway`, use the accepted server-approved
extraction spec, and return the one valid `EXAM_REPORT` candidate necessary for this non-PHI
transport demonstration. It must not write a domain object, assign identities, choose a workflow,
or produce an S2/manager state. The demo does not invoke Tesseract or represent this fixture as
clinical OCR accuracy.

Direct SQL is allowed only to install migrations and make read-only final row-count/integrity
assertions in tests. It must never seed, update, attach, evaluate, verify or close business state.
Do not route through HTTP, browser state, PreviewStore, a second mock repository, or a synthetic
work-update command; all of those would test a different transport or policy boundary.

## 4. Normal result and replay contract

The normal run must establish all of these durable facts through the path above:

- one persisted `REGISTRATION` Artifact and FactCard, authoritative Workflow/link, `OPEN`
  `EXAM_REPORT` Expectation and `PENDING` S2 result;
- one immutable stored object reference;
- one persisted `EXAM_REPORT` Artifact, FactCard and extraction attempt with `READY` lineage;
- authoritative attachment to the same Workflow, `MET` Expectation and `VERIFIED` S2 result;
- one immutable `CLOSE_STANDARD` manager decision; and
- final manager projection: `CLOSED`, `MET`, `VERIFIED`, `CLOSE_STANDARD`, no review required.

Replay the complete identical sequence against the same PGlite database and local-object root.
It must re-use the durable registration, object, extraction and manager-decision identities; it
must not rerun inference for the stored extraction. The second safe projection and non-PHI demo
summary must be exactly the same as the first. Read-only counts must prove that no immutable
Artifact, FactCard, link, extraction attempt, verification or manager-decision row was duplicated.

Use bounded explicit idempotency keys for registration, upload and manager decision, and fixed
request/artifact/fact-card IDs for the accepted extraction command. Every identity remains
domain-separated under the existing service rules. Never add a new cross-service idempotency
scheme just for this demo.

## 5. Required negative proofs

Add focused integration tests using the same assembly. They must use service calls, not SQL state
injection.

1. **Extraction review:** after a valid registration and employee selection, a low-confidence or
   required-field-missing fixture result persists the object, Artifact and `REVIEW_REQUIRED`
   extraction attempt, but persists no FactCard, performs no consequence attach/evaluation/S2
   completion, and cannot be standard-closed by the manager.
2. **Scope and authority:** another employee, a manager acting as employee, and another clinic
   cannot obtain the selected expectation or use it to complete/close this chain. The safe-list,
   storage, golden path and manager-decision role checks must each remain authoritative.
3. **Replay conflicts:** changed bytes under the same upload key, a changed extraction binding
   under the same request identity, and a changed manager decision under its same key fail
   visibly. Existing durable rows and final projection remain unchanged.
4. **Time/selection boundary:** a report at or after the due instant, an absent selection, and a
   selection from a different chain fail before a consequence state is claimed. The normal case
   must prove the due instant is exclusive.
5. **No accidental private projection:** test the CLI result/output vocabulary contains only
   static phase/result/status counts. It must not contain the synthetic anchor, any clinic/actor
   identifier, object identifier/hash/path, raw candidate fields, model output, decision note or
   raw exception text.

The test may use final read-only SQL counts to demonstrate idempotency, but must validate behavior
through the authoritative repositories/services and detached public/read projections.

## 6. Minimal implementation surface

```text
scripts/persisted-closure-demo.ts
test/persisted-closure-demo.test.ts
package.json                         # one `demo:closure` script only
README.md                            # concise non-PHI command and boundary
```

The script should export a small callable runner for the test and, when launched directly, print
one bounded JSON summary. The summary may contain phase names, enum statuses and row-count totals
only. It must close PGlite and remove only the explicit temporary object-store directory in a
`finally` block.

No migration, domain contract, repository policy, HTTP route/UI change, authentication/session,
provider/OCR change, workflow/Expectation/S2 rule, manager-read shape, queue, scheduler, cloud
adapter, backup implementation, browser persistence, new dependency, or production configuration
change is permitted.

## 7. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
npm run demo:closure
npm run accept:ocr-local
npm run accept:postgres-real
git diff --check
```

`accept:postgres-real` remains an explicit external gate: absent required dedicated server
configuration must fail closed with its documented `ENVIRONMENT_REQUIRED` result and must never be
reported as a passing PGlite test.

## 8. Honest boundary

This ticket proves one deterministic, non-PHI persisted core chain in a SQL-semantic integration
harness. It does not create production authentication, real patient identity, actual clinical OCR
or language-accuracy evidence, an HTTP/browser end-to-end test, automatic retry/scheduling,
real PostgreSQL application-role RLS or concurrency proof, backup/restore, Cloud deployment, or
a claim of clinic readiness. Those remain separate release gates.

## 9. Builder handoff

Read the Constitution and WO-015, WO-020 through WO-029 before editing. Implement only this
acceptance/demo seam. Commit as:

```text
test(acceptance): add persisted clinical closure demo
```

Do not push. Report changed files, targeted/full test counts, the exact bounded demo output, and
the external PostgreSQL gate separately. Architecture Review will independently inspect that no
business state was seeded or mutated by direct SQL and that replay did not quietly rerun inference.

## Architecture acceptance

Accepted after commit `914d177` and independent review.

- Full regression: 353/353.
- Closure, Domain and Runtime demos: passed.
- Local Tesseract acceptance: 2/2 passed.
- Real PostgreSQL acceptance: intentionally fail-closed with `ENVIRONMENT_REQUIRED` because no
  PostgreSQL server configuration is present.
- The fixed-clock non-PHI demo exercises registration, scoped selection, object ingestion,
  extraction, authoritative attach, S2 verification, manager closure and exact replay.
- Cross-employee, cross-clinic, expired, wrong-chain and replay-tampering paths are blocked.
- GitHub push remains deferred for the batch release.
