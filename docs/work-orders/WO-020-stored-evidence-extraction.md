# WO-020 — Stored Evidence Extraction Boundary

**Status:** Architecture frozen / Builder ready  
**Depends on:** Constitution, WO-004, WO-006, WO-008, WO-015, WO-019

## 1. Goal

Add one application service that turns a verified stored evidence object into either a deterministic
`Artifact + EvidenceFactCard` candidate or an explicit review result:

`StoredObjectRef -> ObjectStoreGateway.get -> InferenceGateway -> schema gate -> deterministic assembly`

This ticket uses a test-only deterministic local inference fixture. It does not download or claim a
real OCR/model integration, and it performs no persistence or Workflow mutation.

## 2. Minimal file surface

- `src/application/evidence-extraction.ts`
- `test/evidence-extraction.test.ts`
- small README edit only

Add no dependency, migration, repository, HTTP route, UI or model runtime.

## 3. Trusted inputs

The service receives a valid `ActorContext`, an exact-shape command and a server-frozen
`ExtractionSpec`. The command contains only:

- `requestId`, `artifactId`, `factCardId`;
- `objectRef`;
- `kind`, `occurredAt`, `occurredAtSource`, `identityAnchor`, `createdAt`.

`clinicId` and `sourceEmployeeId` derive only from ActorContext. Caller-supplied payload, authority,
lineage, Workflow, Expectation, Verification or decision fields are rejected. Clinical patient
evidence requires an exact nonblank identity anchor before storage read or inference.

The frozen first spec supports `image/png`, `image/jpeg` and `application/pdf`, and one tracer:
`EXAM_REPORT -> PATIENT / EYE_EXAM`. It declares capability, schema/policy versions, allowed media
types, allowed taxonomy, required field names and minimum confidence.

## 4. Model boundary

Inference input contains cloned bytes, media type, content hash and Artifact kind only. It never
contains the patient identity anchor. Existing RuntimeManifest and InferenceGateway rules remain
authoritative; there is no provider fallback.

Provider output is an exact bounded candidate:

- `subjectTypeCandidate`;
- `workflowFamilyCandidate`;
- `fields`;
- `missingFields`;
- `confidence`.

Recursively reject the frozen authority/verdict key set, including `clinicId`, `actorId`,
`sourceEmployeeId`, `identityAnchor`, formal Artifact/FactCard/Workflow/Link/Expectation/
Verification/Decision IDs, authority timestamps, lineage and formal state/action fields. Do not
blanket-reject every `*Id`: report and device identifiers can be legitimate extracted facts. Reject
non-JSON-safe/uncloneable values, unknown shape, excessive fields, non-finite confidence, duplicate
or unknown missing fields and taxonomy outside the frozen whitelist.

## 5. Deterministic output

- `READY` returns detached `Artifact`, `EvidenceFactCard` and inference lineage.
- `REVIEW_REQUIRED` returns detached Artifact, validated candidate, controlled reason codes and
  inference lineage; it creates no FactCard.
- Low confidence or a missing required field produces review, not invented data.

Artifact payload is assembled as `{ storedObjectRef }`. FactCard clinic, Artifact ID, identity,
occurred time and lineage inherit exactly from the Artifact. The service, not the model, assigns
FactCard ID and parser version. Existing identity gates must be reused.

Inference lineage contains request/provider/model/capability/schema/policy/completion time and object
content hash, but no bytes, filesystem path, model output or identity anchor. This ticket does not
claim that lineage is durable until later persistence wiring.

## 6. Acceptance tests

At minimum prove:

1. local stored-object round trip produces a READY exact-lineage FactCard;
2. identity and authority are inherited verbatim and never sent to inference;
3. top-level or nested authority/verdict injection fails closed;
4. cross-clinic or mismatched object ref fails before inference;
5. missing/damaged objects never invoke inference;
6. provider/manifest mutation is blocked without fallback;
7. request/schema/model identity mismatch and malformed output fail without FactCard;
8. taxonomy escape, non-JSON values, oversized fields and invalid confidence fail;
9. low confidence or missing required fields returns REVIEW_REQUIRED only;
10. missing patient anchor fails before object read and inference;
11. caller mutation during awaits and returned-value mutation cannot alter results;
12. same input and fixture produce the same domain projection;
13. receipts/lineage contain no bytes, filesystem path, output or identity;
14. service dependencies expose no repository or domain write authority;
15. full regression and both demos remain green.

## 7. Non-goals

Real PaddleOCR/Qwen/model download, OCR accuracy, persistence, migrations, HTTP/UI, automatic
Composition, Workflow/Link, Expectation, S2, manager decisions, queues/retries, cloud model/provider,
prompt DSL and a general plugin runtime are out of scope.

## 8. Builder handoff

Read the Constitution and dependency work orders. Implement only this boundary with a test-local
deterministic provider, run targeted and full tests plus both demos, commit as
`feat(application): extract stored evidence`, report exact files/tests/deviations, and do not push
before independent Architecture Review.

## 9. Architecture review — 2026-08-30

**Status:** Accepted

- Extraction and shared inference-boundary tests: 34/34 passed.
- Full regression: 291/291 passed.
- Domain and runtime demos: passed.
- Dependencies, migrations, UI and real model changes: none.
- Independent review: passed after exact ActorContext enforcement, nominal gateway binding, frozen
  response-lineage checks, inert descriptor/proxy validation and bounded candidate traversal.

The accepted model is still a deterministic test fixture. A real local OCR/model adapter must use a
new explicitly frozen model/spec identity and pass the same gateway and extraction contracts.
