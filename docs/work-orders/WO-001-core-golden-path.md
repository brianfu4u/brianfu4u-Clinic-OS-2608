# WO-001 — Core Golden Path

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Constitution baseline:** Clinic OS v1.0 Approved  

## 1. Outcome

Implement the smallest executable domain kernel that proves this chain:

```text
employee report
→ immutable Artifact
→ validated EvidenceFactCard
→ exact clinical identity gate
→ match an existing Workflow OR create a new Workflow
→ authoritative WorkflowArtifactLink
→ evaluate one Expectation
→ project a manager closure view
```

The result is a tested domain slice, not a production application.

## 2. Technical constraints

- Node.js 24+.
- TypeScript executed with Node's built-in type stripping.
- Node built-in test runner (`node --test`).
- No runtime or test dependencies in this work order.
- Pure functions and in-memory repositories only.
- ESM.
- Do not copy Base44 SDK code or Od-os infrastructure into this ticket.
- Do not add React, NestJS, an ORM, PostgreSQL, Docker, OCR, an LLM, billing, Skill Runtime, or deployment code.

## 3. Required repository baseline

Create only what is needed:

```text
README.md
package.json
docs/CONSTITUTION.md
docs/work-orders/WO-001-core-golden-path.md
src/domain/contracts.ts
src/domain/errors.ts
src/domain/identity-gate.ts
src/domain/workflow-resolver.ts
src/domain/workflow-saga.ts
src/domain/expectation.ts
src/domain/manager-projection.ts
src/domain/golden-path.ts
test/golden-path.test.ts
```

`docs/CONSTITUTION.md` must be copied from the approved local baseline at:

`/workspace/scratch/73741ab81c07/Clinic-OS-Constitution-and-Execution-Blueprint-v1.0.md`

Do not create speculative directories.

## 4. Frozen domain contracts

Use string IDs and ISO-8601 timestamps. Every persisted domain object must contain `clinicId`.

### Artifact

- `id`
- `clinicId`
- `kind`
- `occurredAt: string | null`
- `occurredAtSource: "source" | "employee_confirmed" | "unknown"`
- `sourceEmployeeId`
- `identityAnchor: string | null`
- `payload`
- `createdAt`

Artifact is immutable after creation. Missing `occurredAt` remains null with source `unknown`; never default it to now.

### EvidenceFactCard

- `id`
- `clinicId`
- `artifactId`
- `subjectType`
- `identityAnchor: string | null`
- `workflowFamily`
- `occurredAt: string | null`
- `fields`
- `missingFields`
- `confidence`
- `parserVersion`
- `lineageArtifactIds`

FactCard is model/parse output, not an operational verdict.

### Workflow

- `id`
- `clinicId`
- `subjectType`
- `identityAnchor: string | null`
- `workflowFamily`
- `status: "OPEN" | "CLOSED" | "VOIDED"`
- `createdAt`
- `updatedAt`

### WorkflowArtifactLink

- `id`
- `clinicId`
- `workflowId`
- `artifactId`
- `attachedAt`
- `decisionSource: "DETERMINISTIC" | "HUMAN"`
- `reasoningChain`

Only `WorkflowSaga` may create links. Repeating the same attach is idempotent.

### Expectation

- `id`
- `clinicId`
- `workflowId`
- `triggerKind`
- `consequenceKind`
- `triggeredAt`
- `dueAt`
- `state: "OPEN" | "MET" | "UNMET" | "VOIDED"`
- `satisfiedByArtifactId: string | null`
- `evaluatedAt`

### ManagerClosureView

- `workflowId`
- `workflowStatus`
- `expectationState`
- `evidenceArtifactIds`
- `needsReview`
- `reasonCodes`

## 5. Frozen behavior

### 5.1 Identity gate

- A clinical FactCard cannot attach to or create a patient Workflow without an exact non-empty `identityAnchor`.
- Never normalize, infer, fuzzy-match, or repair an identity anchor.
- Cross-tenant candidates are rejected before scoring.

### 5.2 Workflow resolution

- Exact `workflowFamily`, `subjectType`, and exact `identityAnchor` match selects an existing open Workflow.
- Zero matches produces a `CREATE_NEW` resolution.
- More than one exact match produces `REVIEW_REQUIRED`; do not attach.
- This ticket contains no LLM matcher and no score threshold.

### 5.3 Create-or-attach saga

- `ATTACH_EXISTING` attaches to the selected Workflow.
- `CREATE_NEW` creates a Workflow and attaches the Artifact in one saga result.
- If link creation fails, a newly created Workflow must not remain committed in the in-memory store.
- Duplicate Artifact-to-Workflow attach returns the existing link.
- No generic repository method may bypass the saga to create a link.

### 5.4 Expectation evaluator

Implement a pure function. It receives the Expectation, linked Artifacts, and explicit `now`.

- Matching consequence at or before `dueAt` → `MET`.
- No consequence and `now < dueAt` → `OPEN`.
- No consequence and `now >= dueAt` → `UNMET`.
- Explicit void input → `VOIDED`.
- No function may read the system clock internally.

### 5.5 Manager projection

- `UNMET` or identity/matching ambiguity requires review.
- `OPEN` is normal and does not require review.
- `MET` does not require review.
- Projection contains reason codes and evidence IDs, not model prose.

## 6. Golden-path API

Expose one orchestration function for tests:

```ts
runGoldenPath(input, repositories): GoldenPathResult
```

It may use a deterministic parser stub supplied by the caller. The parser stub must return a FactCard and must not write Workflow, Link, Expectation, or manager state.

## 7. Mandatory tests

1. Existing Workflow: exact anchored clinical FactCard attaches idempotently.
2. New Workflow: exact anchored clinical FactCard creates and attaches a new Workflow.
3. Missing anchor: clinical FactCard is blocked before resolution.
4. Near-miss anchor: `P-001` never matches `P-OO1`.
5. Cross-tenant: candidate cannot be read or attached.
6. Ambiguity: two exact open Workflows produce review-required and no link.
7. MET boundary: consequence at `dueAt` is MET.
8. UNMET boundary: no consequence at `dueAt` is UNMET.
9. OPEN: no consequence before `dueAt` remains quiet.
10. VOIDED: explicit void does not become UNMET.
11. Model authority: parser output cannot set Workflow, Link, Expectation, or manager verdict fields.
12. Artifact immutability: attempted mutation does not change stored Artifact.
13. Saga rollback: link failure leaves no newly created Workflow.
14. Manager projection: only UNMET/ambiguity requires review.

## 8. Acceptance commands

```bash
npm test
npm run demo
```

`npm run demo` must print a compact JSON result for one successful create-new Workflow path and one UNMET manager-review path. It must use synthetic data only.

## 9. Prohibited scope

- No UI.
- No HTTP API.
- No database.
- No real patient data.
- No autonomous task assignment.
- No employee scoring.
- No auto-published knowledge.
- No direct reuse of legacy schema or Base44 entities.
- No implementation beyond this work order.

## 10. Builder handoff

The Builder must:

1. read `docs/CONSTITUTION.md` and this work order before editing;
2. keep all changes in this repository;
3. run acceptance commands;
4. commit with message `feat(core): implement WO-001 golden path`;
5. return the commit SHA, test results, and any deliberate deviations;
6. not push until the Architect completes review.
