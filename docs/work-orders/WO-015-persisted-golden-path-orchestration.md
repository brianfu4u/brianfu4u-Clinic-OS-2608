# WO-015 — Restartable Persisted Golden Path Orchestration

**Status:** ACCEPTED
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`
**Depends on:** WO-001 through WO-014 accepted locally through `96189fe`

## 1. Outcome

Expose one narrow application service that coordinates the already-authoritative PostgreSQL repositories for two structured clinical events:

```text
trigger capture -> authoritative attach/create -> Expectation initialization -> S2 Verification
result capture  -> authoritative attach        -> Expectation re-evaluation -> S2 Verification
```

The service is a restartable process manager, not a generic workflow framework and not one global database transaction. Each existing repository stage remains atomic in its own short tenant transaction. A failed call is resumed by replaying the same deterministic inputs.

## 2. Minimal files

```text
src/application/persisted-golden-path.ts
test/persisted-golden-path.test.ts
src/persistence/expectation-repository.ts
README.md
```

The only allowed repository edit is a tenant-scoped, detached `getExpectation(context, expectationId)` read used for consequence preflight. No migration, repository rewrite, dependency, queue, outbox, worker, command bus or framework.

## 3. Commands

Expose one service with operations equivalent to:

```ts
recordTrigger(context, {
  artifact,
  factCard,
  expectation,
  attachedAt,
  evaluatedAt,
})

recordConsequence(context, {
  artifact,
  factCard,
  expectationId,
  attachedAt,
  evaluatedAt,
})
```

Inputs are snapshotted before asynchronous work. Time is always explicit; the service must not read the system clock.

Before the first repository acquisition, validate the complete command's cross-field consistency: Actor clinic scope; FactCard-to-Artifact reference, lineage and identity; strict zoned timestamps; `attachedAt <= evaluatedAt`; and, for a trigger, matching trigger kind plus an Artifact occurrence instant equal to `triggeredAt`. The Expectation specification is trusted server-resolved policy input, not an employee-editable HTTP rule.

## 4. Trigger flow

In order:

1. `CaptureRepository.saveCapture`;
2. `WorkflowAttachRepository.attachCapture`;
3. if attach returns `REVIEW_REQUIRED`, stop and return a controlled review result; the durable capture remains visible and no Expectation/Verification is fabricated;
4. require the Expectation specification's clinic/workflow-independent trigger fields to agree with the supplied trigger Artifact;
5. `ExpectationRepository.initializeExpectation` on the authoritative Workflow;
6. `VerificationRepository.verifyCurrentExpectation`;
7. return detached stage results.

## 5. Consequence flow

In order:

1. save capture;
2. authoritative attach;
3. if attach returns `REVIEW_REQUIRED`, stop with a controlled review result;
4. read the caller-identified durable Expectation through the allowed tenant-scoped preflight;
5. require its Workflow ID exactly equals the authoritative attached Workflow ID before any Expectation mutation;
6. re-evaluate that Expectation at the explicit evaluation time;
7. verify the current Expectation;
8. return detached stage results.

Workflow mismatch fails closed with a stable `DomainError`. The already-authoritative capture/link may remain committed, but the service must not verify or claim completion for the wrong Expectation.

## 6. Restart and failure semantics

- Do not wrap all stages in another transaction or hold one connection across repository calls.
- Do not change established lock order.
- Exact replay relies on existing deterministic IDs, immutable content comparison and repository idempotency.
- Never compensate by deleting immutable rows.
- Never swallow a stage error or silently fall back to memory.
- If a replay uses an evaluation time older than the current projection, preserve the repository's stale/conflict failure; do not claim the event is processed.
- The returned result identifies whether processing is `COMPLETED` or `REVIEW_REQUIRED` and includes only results actually committed.

This ticket does not claim Artifact-to-Verification global ACID. Incomplete chains remain fail-visible through the accepted manager read model and can be resumed with the same deterministic command.

## 7. Required tests

1. trigger command creates capture, Workflow/Link, Expectation and PENDING Verification;
2. exact trigger replay returns the same durable identities without duplicates;
3. ambiguous attach persists capture only and returns `REVIEW_REQUIRED`;
4. consequence command attaches to the same Workflow and advances OPEN or UNMET to MET + VERIFIED;
5. exact consequence replay is idempotent;
6. consequence-to-Expectation Workflow mismatch fails before Verification and leaves the target Expectation unchanged;
7. injected failures after capture, attach, initialization/re-evaluation and before/inside Verification are recoverable by replay without duplicate immutable rows;
8. stale evaluation replay fails visibly rather than reporting completion;
9. tenant, identity and actor validation remain enforced; caller authority or cross-clinic data cannot redirect processing;
10. malformed/non-zoned or cross-field-inconsistent command times fail before the first write;
11. caller mutation during awaits and returned-object mutation cannot change committed/result state;
12. all existing tests and both demos remain green.

Use the existing PGlite SQL-semantic harness and real repositories for the main integration tests. Focused dependency fakes are allowed only for deterministic stage-failure injection; they must implement the narrow repository method shapes, not a second business rule set.

## 8. Honest boundary

This ticket does not implement:

- HTTP/UI persistence wiring;
- automatic retry, scheduling, queueing or event dispatch;
- one global ACID transaction;
- manager decisions or read-model changes;
- file/blob storage, OCR, model inference or parsing;
- real PostgreSQL application-role RLS/concurrency proof;
- backup/restore or production readiness.

## 9. Acceptance commands

```bash
npm ci
npm test
npm run demo
npm run runtime:demo
git diff --check
```

## 10. Builder handoff

The Builder must read the Constitution and WO-008 through WO-015, implement only this application slice, run all acceptance commands, commit as `feat(application): orchestrate persisted golden path`, report exact files/tests/deviations, and not push before Architecture Review.

## 11. Architecture acceptance

Accepted on 2026-08-30 through `0b3d33e` after independent review.

- 226/226 tests and both demos pass.
- Trigger and consequence commands coordinate only the accepted authoritative repositories, preserving their short tenant transactions and lock order.
- Exact replay resumes failed stages without duplicate immutable rows; ambiguity and stale evaluation remain fail-visible.
- Consequence Workflow mismatch is checked through a detached tenant read before Expectation mutation.
- Trigger replay after later progression intentionally returns the current durable Expectation projection plus the original initialization transition lineage; this is covered by a `trigger -> consequence -> trigger replay` database test.
- Inputs are snapshotted before asynchronous work and outputs are detached.
- No migration, dependency, queue, worker, command bus or global-ACID claim was added.

HTTP/UI persistence wiring, scheduling, real PostgreSQL application-role RLS/concurrency, backup and restore remain later acceptance gates.
