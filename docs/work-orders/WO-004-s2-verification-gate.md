# WO-004 — S2 Verification Gate

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-003 accepted through `4f4adc4`  

## 1. Outcome

Add the deterministic S2 verification layer between Expectation evaluation and human closure.

Expectation answers:

> Did a consequence of the configured kind appear within the window?

S2 answers the stricter question:

> Does the linked evidence actually prove the declared trigger → consequence chain for this exact clinic, subject and identity?

No LLM may produce or overwrite the S2 verdict.

## 2. Frozen contract

### VerificationResult

- `workflowId`
- `expectationId`
- `status: "PENDING" | "VERIFIED" | "CONFLICT"`
- `reasonCodes: string[]`
- `triggerArtifactId: string | null`
- `consequenceArtifactId: string | null`
- `evidenceArtifactIds: string[]`
- `evaluatedAt`

The result is a deterministic projection. It is computed from a Workflow, an evaluated Expectation, linked Artifacts and explicit `now`.

## 3. Phase 1 verification rules

### Trusted trigger

A trusted trigger Artifact must:

- share the Workflow `clinicId`;
- have `kind === expectation.triggerKind`;
- have the same exact `identityAnchor` as the Workflow;
- have a valid `occurredAt` exactly equal to `expectation.triggeredAt` for this first tracer.

No fuzzy identity, inferred trigger or timestamp repair.

### Trusted consequence

A trusted consequence Artifact must:

- be the exact Artifact referenced by `expectation.satisfiedByArtifactId`;
- share clinic and exact identity anchor with the Workflow;
- have `kind === expectation.consequenceKind`;
- have a valid `occurredAt` within the closed interval `[triggeredAt, dueAt]`.

### Verdicts

- `VERIFIED`: Expectation is `MET` and both trusted trigger and trusted consequence exist.
- `PENDING`: Expectation is `OPEN` or `UNMET`, the trusted trigger exists, and no contradictory satisfying-evidence claim exists. `UNMET` remains a manager review condition through the Expectation projection.
- `CONFLICT`: any declared MET lacks a trusted trigger or trusted consequence; a non-MET Expectation claims `satisfiedByArtifactId`; linked evidence or identity/time fields contradict the declared chain; or required timestamps are invalid.
- `VOIDED` expectation produces `PENDING` with reason `CHAIN_VOIDED`; it is never `VERIFIED` and creates no review once the Workflow is terminal voided.

Use stable reason codes, not model prose. Minimum codes:

- `TRIGGER_NOT_FOUND`
- `CONSEQUENCE_NOT_FOUND`
- `IDENTITY_CONFLICT`
- `TIME_CONFLICT`
- `KIND_CONFLICT`
- `EXPECTATION_EVIDENCE_CONFLICT`
- `CHAIN_OPEN`
- `CHAIN_UNMET`
- `CHAIN_VOIDED`

## 4. Pure engine requirements

- Implement as a pure function with no I/O and no internal clock read.
- Do not mutate Workflow, Expectation or Artifact inputs.
- Output ordering must be deterministic regardless of input Artifact order.
- Evidence IDs must include only the selected trigger and consequence, sorted in causal order.
- Invalid or contradictory evidence returns `CONFLICT`; malformed top-level contract IDs/times fail closed with `DomainError` rather than silently returning green.

## 5. Integration

### Manager projection

- Add Verification status and reason codes to the manager preview item.
- An open `CONFLICT` requires manager review even if Expectation is not yet `UNMET`.
- Terminal CLOSED/VOIDED Workflows do not re-enter the review queue, but retain the historical Verification result.

### Human decision gate

- `CLOSE_STANDARD` requires both `Expectation.state === MET` and `Verification.status === VERIFIED`.
- `CLOSE_EXCEPTION` remains available for `UNMET`; it records the non-verified state rather than rewriting it.
- `KEEP_OPEN` and `VOID` retain the WO-003 rules.
- The decision record adds `verificationStatus` and `verificationReasonCodes` as an immutable snapshot.
- Preview/API callers cannot supply the verification snapshot; the server/store computes it from linked Artifacts.

### Preview tracer

- Registration alone: Expectation `OPEN`, Verification `PENDING`.
- Exact same-anchor report in window: Expectation `MET`, Verification `VERIFIED`.
- The manager card renders both states separately.

## 6. Minimal implementation surface

Expected changes:

```text
src/domain/contracts.ts
src/domain/s2-verification.ts
src/domain/manager-projection.ts
src/domain/workflow-saga.ts
src/preview/preview-store.ts
src/preview/public/app.js
test/s2-verification.test.ts
test/manager-decision.test.ts
test/preview.test.ts
```

Do not add a rules DSL, scorer framework, plugin interface or generic graph engine.

## 7. Mandatory tests

At minimum prove:

1. Exact trigger plus exact in-window consequence produces `VERIFIED`.
2. MET without a linked trigger produces `CONFLICT/TRIGGER_NOT_FOUND`.
3. MET with missing referenced consequence produces `CONFLICT/CONSEQUENCE_NOT_FOUND`.
4. Near-miss identity produces `CONFLICT/IDENTITY_CONFLICT` and never VERIFIED.
5. Wrong trigger/consequence kind produces `KIND_CONFLICT`.
6. Trigger or consequence outside the frozen window produces `TIME_CONFLICT`.
7. OPEN with a trusted trigger produces deterministic `PENDING/CHAIN_OPEN`.
8. UNMET with a trusted trigger produces `PENDING/CHAIN_UNMET` and manager review remains true.
9. Input order does not change the result.
10. Input objects remain unchanged.
11. Standard close refuses a fabricated or conflicting Verification snapshot without mutation.
12. Standard close succeeds only with VERIFIED and stores the immutable verification snapshot.
13. Manager API rejects caller-supplied verification fields.
14. Preview registration→report produces `MET + VERIFIED`, then standard close succeeds.
15. Existing tests remain green.

## 8. Acceptance commands

```bash
npm test
npm run demo
```

Run an HTTP smoke for registration → manager PENDING → report → manager VERIFIED → standard close.

## 9. Prohibited scope

- No LLM/vision call.
- No probabilistic score or threshold.
- No employee evaluation.
- No database or persistence adapter.
- No new clinical chains.
- No automatic close.
- No changes to exact identity policy.

## 10. Builder handoff

The Builder must:

1. read the Constitution and WO-001 through WO-004 before editing;
2. implement only this ticket;
3. run all tests, demo and HTTP smoke;
4. commit with message `feat(core): add S2 verification gate`;
5. report commit SHA, test count, smoke result and deviations;
6. not push until Architecture Review is complete.
