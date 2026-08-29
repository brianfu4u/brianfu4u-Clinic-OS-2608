# WO-009 — Authoritative Workflow Attach Persistence

**Status:** ACCEPTED
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-008 accepted through `0e7d2b3`  

## 1. Outcome

Given one already-persisted Artifact and EvidenceFactCard, resolve the exact open Workflow candidate and persist the authoritative WorkflowArtifactLink through one tenant transaction.

The transaction must produce exactly one of:

- one exact candidate: attach to it;
- zero exact candidates: create one Workflow and attach;
- more than one exact candidate: return review-required and write nothing.

This ticket persists composition only. Expectation evaluation, Verification, manager decisions, preview wiring and model calls remain out of scope.

## 2. Minimal files

Add only:

```text
src/persistence/workflow-attach-repository.ts
test/postgres-workflow-attach-repository.test.ts
```

Small edits to shared persistence contracts, README and existing tests are allowed only when required. Add no dependency, ORM, query builder, schema table or generic repository layer.

## 3. Input contract

Expose one async operation equivalent to:

```ts
attachCapture(context, artifactId, factCardId, attachedAt)
```

Rules:

- synchronously snapshot and validate all caller inputs before connection acquisition;
- only valid `EMPLOYEE` or `MANAGER` ActorContext may call;
- clinic authority derives only from ActorContext;
- Artifact and FactCard must already exist in the active clinic;
- FactCard must reference that Artifact and include it in lineage;
- patient identity must be exact, non-empty and unchanged from the Artifact;
- `attachedAt` must be a valid explicit timestamp; no default current time;
- no caller may supply Workflow status, resolution, candidate list, Link ID, decision source or reasoning chain.

## 4. Deterministic candidate rule

Within the same tenant transaction, select open Workflows whose values exactly equal the FactCard:

- `clinic_id` from ActorContext;
- `subject_type`;
- `identity_anchor`, including exact whitespace and case;
- `workflow_family`;
- `status = 'OPEN'`.

Use parameterized SQL. Do not trim, case-fold, fuzzy-match or use timestamps, model scores or client-provided candidates.

Candidate ordering must be deterministic by Workflow ID so review output is stable.

## 5. Authoritative saga outcomes

### One exact candidate

- insert the authoritative Link to that Workflow;
- return `ATTACH_EXISTING` with detached Workflow and Link values.

### Zero exact candidates

- create one open Workflow from the FactCard identity and family;
- use deterministic IDs derived from clinic and Artifact ID, following the existing WO-001 convention;
- insert Workflow before Link in the same transaction;
- return `CREATE_NEW` with detached Workflow and Link values;
- any Link failure must roll back the newly created Workflow.

### More than one exact candidate

- return `REVIEW_REQUIRED` with the sorted exact candidate IDs;
- create no Workflow and no Link.

## 6. Link authority and idempotency

The repository is the only PostgreSQL write path for WorkflowArtifactLink in this phase.

- Link authority fields are server-derived: `decision_source = 'DETERMINISTIC'` and the exact reasoning chain `exact_clinic`, `exact_subject`, `exact_identity`, `exact_workflow_family`.
- Replaying the same capture returns the existing Link and its Workflow without duplicates.
- Reuse of a deterministic Workflow or Link ID with different semantic content fails closed with a stable DomainError; never update or merge it.
- An Artifact already linked to another Workflow in the same clinic fails closed and creates no additional Workflow.
- returned objects are detached copies.

## 7. Transaction and tenant boundary

Reuse `withTenantTransaction`; do not create another transaction helper.

All reads, candidate resolution, Workflow creation and Link insertion happen on its callback-scoped tenant client. Every business query must include `clinic_id` even though RLS also applies. No raw connection may escape.

This ticket must not relax `ENABLE + FORCE RLS`, composite tenant foreign keys or append-only Link protection.

## 8. Concurrency boundary

Use PostgreSQL atomic conflict handling for deterministic Workflow and Link IDs. Do not add an in-process mutex: it would fail across Cloud Run instances and multiple On-Prem workers.

PGlite cannot prove real multi-connection interleavings. Real PostgreSQL concurrent creation for two different Artifacts with the same exact identity remains a deployment acceptance case. Do not claim that this ticket prevents that race unless a real-server-safe lock or constraint is implemented and tested without prohibiting legitimate review-required duplicates.

## 9. Required tests

1. exact existing Workflow attaches and round-trips;
2. zero candidates creates Workflow and Link atomically;
3. two exact candidates return sorted review-required and write nothing;
4. near-miss identity, subject or family never attaches;
5. missing/rewritten patient identity fails before acquisition;
6. cross-clinic Artifact, FactCard and Workflow remain invisible;
7. missing Artifact or FactCard fails closed without writes;
8. malformed lineage fails closed;
9. same replay is idempotent with no duplicate Link or Workflow;
10. deterministic ID conflict returns a stable DomainError without mutation;
11. existing different-Workflow Link blocks a second attach;
12. injected authority fields cannot influence outcome;
13. SQL injection strings remain bound data;
14. failed Link insert rolls back a newly created Workflow;
15. caller mutation during acquisition cannot change persisted values;
16. returned values are detached;
17. all prior tests and both demos remain green.

## 10. Honest acceptance boundary

This ticket must not claim:

- Expectation, Verification or manager-decision persistence;
- preview/API persistence parity;
- model/OCR integration;
- real PostgreSQL application-role RLS or concurrent interleaving proof;
- backup/restore readiness;
- production or real-PHI readiness.

## 11. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
```

The worktree must be clean after the implementation commit.

## 12. Prohibited scope

- No schema expansion unless an existing fail-closed constraint blocks the ticket and Architecture Review approves it.
- No ORM, event bus, background worker, retry framework or in-process lock.
- No Expectation update, S2 write, manager decision or Workflow close/void operation.
- No preview-server wiring, conversation persistence or model/provider call.
- No destructive reset, real PHI or remote push.

## 13. Builder handoff

The Builder must:

1. read the Constitution and WO-007 through WO-009 before editing;
2. implement only this authoritative attach slice;
3. reuse existing domain identity rules and tenant transaction boundary;
4. run every acceptance command;
5. commit with message `feat(persistence): add authoritative workflow attach`;
6. report SHA, test count, exact files, dependency/schema changes and deviations;
7. not push until Architecture Review is complete.

## 14. Architecture acceptance

Accepted on 2026-08-29 through `8070bfa` after two independent review rounds.

- 148/148 tests and both demos pass.
- Source Artifact and exact candidate Workflow rows are locked before authoritative resolution.
- Existing, created and deterministic-ID replay outcomes are stable.
- Patient identity, lineage, tenant and append-only Link authority fail closed.
- `attachedAt` accepts only real ISO-8601 datetimes with an explicit zone and JavaScript/PostgreSQL-safe millisecond precision.

Real PostgreSQL multi-worker interleavings, application-role RLS, backup and restore remain deployment acceptance gates.
