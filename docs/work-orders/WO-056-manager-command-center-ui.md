# WO-056 — Manager Command Center UI

**Status:** Accepted
**Depends on:** WO-038; WO-042; WO-046; WO-055

## Goal

Polish the manager preview into a clear command-center companion to the
ChatGPT-style employee workspace: a readable left navigation, prominent
attention/closure summary, scenario walkthrough and controlled manager action
area. It must make the five-case local demo easy to follow without changing
manager authority or business logic.

## Boundaries

- UI-only: consume existing safe manager APIs and server-injected context.
  No new endpoint, database/domain change, model execution, OCR, upload,
  workflow/S2 mutation or browser-supplied authority.
- Display only existing safe manager fields. Do not introduce persistence,
  URL identifiers, console logging, raw errors, paths, object/fact/workflow
  identifiers or identity data beyond the existing accepted projection.
- Preserve existing manager decision form, confirmation/reason validation and
  authorization. The visual redesign must not add auto-close or one-click
  operational action.
- Use existing vanilla HTML/CSS/JS and assets; accessible/responsive; no
  framework/dependency.

## Acceptance

Test static command-center layout and browser-boundary invariants; verify the
existing decision route/authority and ordinary employee separation are
unchanged. Run focused/full regressions then independently review before
acceptance.

## Acceptance record

- Focused UI boundary test: passed.
- Independent full regression: 423/423 passed.
- Review confirmed this is a presentation-only change: existing manager
  authority, decision confirmation/reason validation, employee separation and
  safe API boundaries are unchanged.
