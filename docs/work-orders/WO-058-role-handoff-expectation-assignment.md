# WO-058 — Role-Handoff Expectation Assignment

**Status:** Accepted
**Depends on:** WO-029; WO-030; WO-040; WO-057

## Goal

Turn the four existing local preview workspaces into a real synthetic
cross-role handoff. A registration made at Reception creates a Doctor-owned
prescription task; a Doctor prescription creates an Exam-owned report task;
an Exam report creates a Cashier-owned payment task. Each resulting Artifact
retains the server-injected source terminal/role provenance.

## Why this precedes device enrollment

The present prototype correctly scopes open tasks to the employee who created
the trigger. That is safe for one-user testing, but it means a different
preview terminal cannot complete the next stage. Registering devices before
the durable assignee rule exists would only make that defect more visible.

## Data and authority rules

- Add one minimal migration to persist the server-derived assignee workspace
  on every Expectation. Existing rows are deterministically backfilled from
  their immutable `consequence_kind`; unknown rows fail closed.
- Accepted assignees are only `DOCTOR` for `PRESCRIPTION`, `EXAM` for
  `EXAM_REPORT`, and `CASHIER` for `PAYMENT`.
- The browser never submits an assignee, role, actor or terminal identity.
  The configured local server derives both the preview workspace and its
  synthetic actor identity. The repository receives a server-owned workspace,
  not a browser field.
- Open-task reads require clinic, `OPEN` state, valid time window and the exact
  persisted assignee workspace. They no longer rely on the trigger employee as
  the owner of a later stage.
- The existing single-server demo remains valid by using its configured
  workspace. No production authentication, real device registration, LAN
  pairing, model/OCR change or broad API is added here.

## Acceptance

Prove a Reception → Doctor → Exam → Cashier chain using four distinct
server-injected synthetic actors; prove cross-workspace, cross-clinic,
browser-injected role and replay attempts fail before writes. Verify the
migration and direct SQL constraints, the existing single-workspace preview,
manager closure and full regression. Then independently review before
acceptance.

## Acceptance record

- Migration, repository compatibility, role-scoped reads and preview regressions passed.
- Full regression: 427/427 passed.
- Review confirmed that stage ownership is server-derived and durable; browser
  role/actor injection remains rejected.
