# WO-055 — Chat-Style Employee Workspace

**Status:** Accepted
**Depends on:** WO-026; WO-037; WO-045

## Goal

Redesign the employee preview into a clean ChatGPT-style local workbench:
a left sidebar for workspace functions and time-grouped topics, with the
current task/conversation and evidence capture in the main panel. Keep the
existing trusted employee capture flow intact.

## Boundaries

- UI-only: reuse existing APIs, server-injected employee context and capture
  commands. No browser-supplied role/clinic/workflow authority, new endpoint,
  storage, OCR, model, database or domain change.
- Left sidebar may show existing synthetic topic/time/status projections only;
  never retain PHI/object references/bytes/paths in browser storage, URL or
  console.
- Preserve all existing formal-update, upload, expectation selection and error
  behavior. Ordinary chat must remain non-operational.
- Implement accessible responsive HTML/CSS/vanilla JS with existing assets; no
  UI framework or new dependency.

## Acceptance

Test static UI structure and existing browser-boundary checks; verify ordinary
chat does not trigger capture, authority remains server-injected, and no
browser persistence/logging is introduced. Run focused/full regressions then
independently review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 23/23 and the full suite
passed 419/419. The redesign remains UI-only: it preserves server authority,
does not persist browser data, and keeps ordinary conversation non-operational.
