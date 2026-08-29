# WO-002 — Local Preview Shell

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 accepted at `bb5ef7c`  

## 1. Outcome

Build the smallest local browser preview that lets us inspect the Phase 1 product shape:

1. an employee opens a familiar chat-style work surface;
2. the employee explicitly chooses whether a message is ordinary conversation or a formal work update;
3. only a formal work update enters the WO-001 `Artifact → Workflow → Expectation` path;
4. a manager opens a separate closure dashboard and sees only workflow evidence and review state, never the employee's ordinary conversation.

This is a product preview around the trusted kernel. It is not a production server.

## 2. Product decisions frozen by this ticket

### 2.1 Conversation is not an Event

- A topic is a conversation container.
- A message is a user interaction record.
- Neither becomes an Artifact by default.
- Only an explicit **Record as work update** action may create an Artifact.
- One topic may contain zero, one, or many future Artifacts; this ticket implements at most one Artifact per submitted work-update message.

### 2.2 Employee state is user-controlled

The preview has exactly three employee states:

- `ON_DUTY`
- `ON_BREAK`
- `OFF_DUTY`

The employee changes their own state. Formal work updates require `ON_DUTY`. Ordinary local conversation remains available, but this preview sends no notifications in any state.

### 2.3 Manager visibility boundary

- Manager APIs and UI contain Workflow, Expectation, evidence IDs and reason codes.
- They do not contain ordinary conversation text.
- They do not expose elapsed-time badges, employee rankings, performance scores or punitive labels.
- `OPEN` is quiet. `UNMET` and matching ambiguity require review.

## 3. Technical constraints

- Keep Node.js 24+, ESM and zero third-party dependencies.
- Use `node:http`, native browser HTML/CSS/JavaScript and the existing WO-001 domain kernel.
- Bind preview server to `127.0.0.1` by default.
- Use in-memory synthetic preview data only; restarting clears all state.
- Do not add React, Vite, a router package, a CSS framework, WebSockets, a database, Docker, authentication, OCR, LLM calls, Skill Runtime, billing or deployment code.
- Do not change WO-001 domain behavior unless a failing integration test demonstrates a kernel defect. Report any such defect to the Architect before changing it.

## 4. Minimal file surface

Prefer this shape and add no speculative directories:

```text
src/preview/server.ts
src/preview/preview-store.ts
src/preview/public/index.html
src/preview/public/app.css
src/preview/public/app.js
test/preview.test.ts
```

Small changes to `package.json` and `README.md` are expected.

## 5. Preview routes

### Pages

- `GET /employee` — employee capture shell.
- `GET /manager` — manager closure dashboard.
- `GET /` — redirect to `/employee`.

The two pages may share one HTML/CSS/JS application. No client framework is needed.

### API

Use the minimum JSON API needed by the pages. It must provide these behaviors even if exact internal function names differ:

- health check;
- employee bootstrap: own status, own topics and own messages;
- set own employee status;
- create a topic;
- add an ordinary message;
- submit a formal work update;
- manager closure projection list.

All mutating requests must reject malformed JSON and invalid enum/input values with a 4xx JSON response. Unexpected failures return a generic 500 response without stack traces.

## 6. Employee preview

Use the visual grammar of a standard LLM assistant without copying a vendor brand:

- left rail: product name, new topic action, topics grouped by date/time, employee-state selector;
- main area: current topic title, chronological message thread and bottom composer;
- clear mode control: **Conversation** versus **Record as work update**;
- work-update mode exposes only the fields needed for the tracer: `kind`, `identityAnchor`, `workflowFamily`, `occurredAt` and message text;
- normal conversation shows a deterministic local acknowledgement; do not pretend an LLM answered;
- work update shows the resulting Workflow ID and current expectation state.

Use Japanese-first interface text with a small Japanese / Chinese / English switch implemented as a local static string map. Persist language preference only in browser `localStorage`.

Accessibility basics are required: labelled controls, keyboard-submittable form, visible focus, semantic buttons and usable contrast.

## 7. One supported tracer

Support only synthetic patient anchors beginning with `DEMO-`; reject other anchors so this preview cannot invite real patient data.

Supported work-update kinds:

1. `REGISTRATION`
   - starts or joins an `EYE_EXAM` Workflow;
   - creates an Expectation for `EXAM_REPORT` due 15 minutes after `occurredAt`;
   - before the due time it projects `OPEN` and no manager review.
2. `EXAM_REPORT`
   - exact same clinic, workflow family and identity anchor joins the existing Workflow;
   - satisfies the registration expectation only when its `occurredAt` is within the frozen causal window;
   - a report without an earlier registration for the same exact anchor is rejected as an unsupported preview sequence, not guessed into a chain.

The preview clock is supplied by the request/store boundary. Domain code must not call the clock implicitly.

## 8. Manager preview

Render compact cards or rows for the synthetic Workflows:

- exact identity anchor (synthetic only);
- Workflow ID and family;
- evidence Artifact IDs;
- Expectation state;
- reason codes;
- `Needs review` only for `UNMET` or ambiguity.

Provide filters for `All`, `Needs review`, `Open`, and `Complete` using client-side filtering. Do not add manager close/void buttons yet: human decision persistence is the subject of a later work order, and a non-persistent button would create a false product promise.

## 9. Mandatory tests

Use Node's built-in test runner. At minimum prove:

1. `/employee`, `/manager` and health endpoints respond successfully.
2. New employee status is `OFF_DUTY` and only the employee can set it through the employee API surface.
3. Ordinary conversation creates a message but no Artifact, Workflow, Expectation or manager item.
4. A formal update while not `ON_DUTY` is rejected and creates no domain state.
5. A valid synthetic registration while `ON_DUTY` creates one Artifact/Workflow and an `OPEN` manager projection with `needsReview: false`.
6. A valid same-anchor report attaches to the same Workflow and becomes `MET`.
7. A near-miss anchor does not attach to the existing Workflow.
8. A report without a matching prior registration is rejected rather than guessed.
9. Manager payload contains no ordinary message text, employee score, ranking or elapsed-duration field.
10. Malformed JSON and invalid enums return deterministic 4xx errors without state mutation.
11. Static assets cannot escape the preview public directory through path traversal.
12. Existing WO-001 tests remain green.

## 10. Acceptance commands

```bash
npm test
npm run preview
```

`npm run preview` must print the local employee and manager URLs. The Builder may add a separate one-shot smoke command if useful, but no new dependency.

## 11. Prohibited scope

- No real PHI or realistic patient names.
- No model-generated conversation.
- No automatic conversion of all chat into events.
- No audio/image upload yet.
- No manager decision persistence yet.
- No authentication claim: the preview is localhost-only and explicitly labelled synthetic.
- No employee monitoring, inactivity alerts, durations or performance inference.
- No plug-in loader or entitlement engine yet.
- No cloud deployment.

## 12. Builder handoff

The Builder must:

1. read `docs/CONSTITUTION.md`, WO-001 and this work order before editing;
2. implement only this ticket;
3. run all acceptance tests and a local HTTP smoke check;
4. commit with message `feat(preview): add local employee and manager shell`;
5. return the commit SHA, test count, smoke result and deliberate deviations;
6. not push until Architecture Review is complete.
