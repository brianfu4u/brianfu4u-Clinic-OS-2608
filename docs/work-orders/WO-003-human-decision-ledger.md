# WO-003 — Human Decision Ledger

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 and WO-002 accepted through `4d2d34e`  

## 1. Outcome

Complete the first manager-controlled loop:

```text
manager reviews composed evidence
→ chooses a permitted human action
→ action and evidence lineage are appended immutably
→ Workflow status changes through one authoritative saga
→ manager projection reflects the resolved or still-open state
```

The machine may surface and explain. Only a human manager may close or void a Workflow.

## 2. Scope

Add four manager actions:

- `CLOSE_STANDARD`
- `CLOSE_EXCEPTION`
- `KEEP_OPEN`
- `VOID`

Add an append-only `ManagerDecision` ledger and expose the actions in the local synthetic preview.

## 3. Frozen contract

### ManagerDecision

- `id`
- `clinicId`
- `workflowId`
- `expectationId`
- `action`
- `reasonCode: string | null`
- `note: string | null`
- `actorId`
- `actorRole: "MANAGER"`
- `decidedAt`
- `evidenceArtifactIds`

The stored decision is immutable. It is a human governance record, not model output.

## 4. Decision rules

### CLOSE_STANDARD

- Allowed only when the evaluated Expectation is `MET`.
- Transitions an open Workflow to `CLOSED`.
- `reasonCode` may be null.

### CLOSE_EXCEPTION

- Allowed only when the evaluated Expectation is `UNMET`.
- Requires a non-empty controlled `reasonCode`.
- Transitions an open Workflow to `CLOSED`.
- The decision preserves that closure was exceptional; it must not rewrite history to pretend the Expectation was `MET`.

### KEEP_OPEN

- Allowed for `OPEN` or `UNMET`.
- Requires a non-empty controlled `reasonCode` when the Expectation is `UNMET`.
- Leaves Workflow status `OPEN` and appends the decision.
- An `UNMET` Workflow kept open remains in review; the action acknowledges review but does not erase the evidence gap.

### VOID

- Human-only and requires a non-empty controlled `reasonCode`.
- Transitions an open Workflow to `VOIDED`.
- The effective expectation projection becomes `VOIDED`; the prior evidence and prior expectation evaluations remain historically recoverable.

### Transition boundaries

- Closed and voided Workflows are terminal in this ticket.
- No reopen, unvoid or edit action is implemented.
- Repeating the same decision ID with byte-equivalent content is idempotent.
- Reusing a decision ID with different content fails closed.
- A failed transition must append no decision; a failed append must leave Workflow unchanged.

## 5. Authority boundary

- The authoritative Workflow saga is the only component allowed to persist both the decision and resulting Workflow transition.
- Callers cannot write a decision directly to a generic repository.
- `actorRole` must be exactly `MANAGER` at the domain boundary.
- Parser, LLM, Skill or Agent-shaped input cannot set actor identity, decision action or Workflow status.
- The local preview may inject a fixed synthetic `demo-manager` actor at the server boundary, but must remain explicitly labelled unauthenticated and non-production.

## 6. Controlled reason codes

Use this minimal fixed set for the preview:

- `LEGITIMATE_DEVIATION`
- `MISSING_EXTERNAL_RECORD`
- `DUPLICATE_WORKFLOW`
- `PATIENT_CANCELLED`
- `NEEDS_MORE_EVIDENCE`

Reject free-form reason codes. `note` is optional, trimmed, and capped at 500 characters.

## 7. Projection behavior

- An open `UNMET` Workflow requires review.
- A Workflow closed by standard or exception decision no longer requires review.
- A voided Workflow no longer requires review and projects effective Expectation state `VOIDED`.
- `KEEP_OPEN` does not hide an `UNMET` review item.
- Manager payload adds only the latest decision summary needed by the UI; full decision history uses a dedicated manager endpoint.
- Ordinary employee conversation remains absent from all manager and decision payloads.

## 8. Preview API and UI

Add the minimum routes:

- `POST /api/manager/decisions`
- `GET /api/manager/decisions?workflowId=...`

The decision POST accepts only `workflowId`, `action`, `reasonCode`, and `note`. The server supplies decision ID, actor, clinic, evidence lineage and clock.

Manager cards must offer only valid actions for their current state:

- `MET`: standard close or void;
- `OPEN`: keep open or void;
- `UNMET`: exception close, keep open or void;
- terminal Workflow: no action buttons.

Use a small native dialog or inline form for reason and optional note. No UI framework.

## 9. Technical constraints

- Node.js 24+, ESM, zero third-party dependencies.
- Extend existing domain and preview code; do not create a generic workflow engine.
- No database, login system, RBAC framework, event bus, state-machine library or plugin loader.
- No real patient data.
- No autonomous close/void endpoint.

## 10. Mandatory tests

At minimum prove:

1. `CLOSE_STANDARD` closes a `MET` Workflow and appends one immutable decision.
2. `CLOSE_STANDARD` against `OPEN` or `UNMET` fails without mutation.
3. `CLOSE_EXCEPTION` closes `UNMET` only with an allowed reason code.
4. `KEEP_OPEN` leaves Workflow open and `UNMET` visible for review.
5. `VOID` requires a reason and produces terminal `VOIDED` projection.
6. Non-manager actor is refused before mutation.
7. Same decision repeated is idempotent; conflicting reuse fails.
8. Terminal Workflow rejects a different later decision.
9. Decision evidence IDs exactly match the Workflow links visible at decision time.
10. Returned or caller-held object mutation cannot alter the stored decision.
11. Manager POST ignores/rejects caller attempts to supply `actorId`, `actorRole`, `clinicId`, `decisionId`, `evidenceArtifactIds` or Workflow status.
12. Manager decision history contains no employee ordinary conversation.
13. Closed/voided projection has `needsReview: false`; `KEEP_OPEN` on `UNMET` remains true.
14. Existing WO-001 and WO-002 tests remain green.

## 11. Acceptance commands

```bash
npm test
npm run demo
```

Also run a local HTTP smoke that creates a synthetic registration/report, performs a standard close, and reads back the decision history and terminal manager projection.

## 12. Prohibited scope

- No reopen or correction workflow yet.
- No automated manager decisions.
- No LLM reasoning in decision validation.
- No employee score, duration or accountability metric.
- No database or deployment.
- No role claims beyond the fixed synthetic preview actor.
- No changes to conversation-to-Artifact boundaries.

## 13. Builder handoff

The Builder must:

1. read the Constitution and WO-001 through WO-003 before editing;
2. implement only this ticket;
3. run all tests and the required HTTP smoke;
4. commit with message `feat(core): add human decision ledger`;
5. return the commit SHA, test count, smoke result and deviations;
6. not push until Architecture Review is complete.
