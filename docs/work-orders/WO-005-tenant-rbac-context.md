# WO-005 — Tenant and RBAC Context

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-004 accepted through `2dbb271`  

## 1. Outcome

Make tenant and role authority explicit at every preview application boundary:

```text
trusted server adapter resolves ActorContext
→ application method checks role + clinic + ownership
→ domain objects derive clinic/actor fields from context
→ caller body cannot override authority
```

This ticket creates an enforceable in-process boundary and multi-tenant fixtures. It does not claim production authentication or database RLS.

## 2. Frozen contracts

### ActorContext

- `clinicId`
- `actorId`
- `role: "EMPLOYEE" | "MANAGER"`

All values are non-empty, exact strings. Role is deterministic and never inferred from a URL or request body inside the application layer.

### PreviewTopic / PreviewMessage

Add:

- `clinicId`
- `ownerEmployeeId`

Conversation ownership is exact. Managers do not gain ordinary-conversation access merely because their role is higher.

## 3. Authorization rules

### Employee

An `EMPLOYEE` context may, only within its exact clinic and for itself:

- read own bootstrap/status/topics/messages;
- change own work status;
- create own topic;
- add ordinary conversation to own topic;
- submit a formal work update to own topic.

Employee A cannot read or mutate Employee B's topics/messages/status. An employee cannot call manager closure or decision methods.

### Manager

A `MANAGER` context may, only within its exact clinic:

- read manager closure projections;
- submit manager decisions;
- read manager decision history.

A manager cannot read employee ordinary conversation through any store method or API payload. A manager cannot change an employee's self-declared work status in this ticket.

### Tenant

- Every operation checks `context.clinicId` against the configured clinic/runtime and target resource.
- Cross-clinic access fails closed with a stable `TENANT_SCOPE_VIOLATION` error, not an empty success for mutations.
- Resource lookup must not reveal whether another clinic's ID exists; use the same not-found/scope behavior consistently.

## 4. Authority derivation

- Artifact `clinicId` and `sourceEmployeeId` derive from the employee ActorContext.
- ManagerDecision `clinicId`, `actorId`, and `actorRole` derive from the manager ActorContext.
- HTTP request JSON cannot submit or override `clinicId`, `actorId`, `actorRole`, `employeeId`, `ownerEmployeeId`, `sourceEmployeeId` or manager lineage fields.
- Domain/application methods no longer accept caller-selected authority fields when a context supplies them.

## 5. Preview adapter

`createPreviewServer` receives trusted synthetic contexts in options and defaults to:

- employee: `demo-clinic / demo-employee / EMPLOYEE`
- manager: `demo-clinic / demo-manager / MANAGER`

Employee routes use only the configured employee context. Manager routes use only the configured manager context. This is a localhost demo adapter, not authentication.

The UI and health response must continue to say synthetic/local preview. Do not add login screens, cookies, tokens or security claims.

## 6. Store shape

- Configure `PreviewStore` with an exact `clinicId` instead of module-level tenant constants.
- Store employee statuses by exact employee actor ID, not one global status variable.
- Filter bootstrap topics/messages by both clinic and owner.
- Workflow and expectation lookup remains clinic-scoped.
- It is acceptable for one PreviewStore instance to represent one clinic, provided cross-clinic contexts are rejected and contract tests instantiate more than one clinic.

## 7. Minimal implementation surface

Expected changes:

```text
src/domain/contracts.ts
src/domain/access-context.ts
src/domain/workflow-saga.ts
src/preview/preview-store.ts
src/preview/server.ts
test/access-context.test.ts
test/manager-decision.test.ts
test/preview.test.ts
```

Do not add an RBAC framework, policy DSL, token parser, session database or middleware package.

## 8. Mandatory tests

At minimum prove:

1. Invalid/empty ActorContext fails closed.
2. Employee can read and mutate only its own status/topics/messages.
3. Employee A cannot read or append to Employee B's topic.
4. Cross-clinic employee context cannot read or mutate another clinic runtime.
5. Employee cannot read manager closures or submit a decision.
6. Manager can read/decide only its exact clinic.
7. Manager cannot read ordinary employee conversations through store methods or manager payloads.
8. Manager cannot change employee self-declared status.
9. Artifact clinic and source employee derive from context, ignoring/rejecting caller authority fields.
10. Manager decision clinic/actor/role derive from context.
11. HTTP bodies attempting any protected authority field are rejected without mutation.
12. Two clinic fixtures using identical identity anchors never share Workflow, Artifact, Expectation or decision data.
13. Existing 67 tests remain green after signature migrations.

## 9. Acceptance commands

```bash
npm test
npm run demo
```

Run HTTP smoke for an employee report and manager close in one clinic, plus a direct negative fixture proving another clinic context is refused.

## 10. Prohibited scope

- No production authentication.
- No JWT, OAuth, cookies or password storage.
- No database/RLS implementation.
- No founder/platform analytics role yet.
- No manager access to ordinary chat.
- No employee performance metrics.
- No changes to exact identity, Expectation, S2 or human-decision semantics.

## 11. Builder handoff

The Builder must:

1. read the Constitution and WO-001 through WO-005 before editing;
2. implement only this ticket;
3. migrate existing tests deliberately; do not weaken old assertions;
4. run all tests, demo and HTTP smoke;
5. commit with message `feat(core): enforce tenant and role context`;
6. report SHA, test count, smoke result, deviations and migrated public signatures;
7. not push until Architecture Review is complete.
