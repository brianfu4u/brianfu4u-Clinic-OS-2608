# WO-046 — Manager Demo Scenario Navigation

**Status:** Accepted
**Depends on:** WO-040; WO-044; WO-045

## Goal

Let the manager preview present the five existing synthetic demonstration
scenarios as a short, read-only walkthrough: normal completion, open work,
overdue work, attention/review, and idempotent replay. It must help an operator
understand what to look for without creating a new workflow, decision, or
browser-supplied authority path.

## Boundaries

- Derive all scenario labels from the existing safe manager attention,
  expectation and decision projections. No new database fields, migrations,
  fake business writes or raw SQL.
- Fixed synthetic labels and bounded stage/status vocabulary only. Never show
  patient identity, anchors, object/artifact/fact/workflow IDs, notes, paths,
  model output or internal errors.
- Read-only UI/API. It must not trigger uploads, OCR, model inference,
  re-evaluation, manager decision, reset, seeding or replay from the browser.
- Keep existing manager dashboard and closure controls unchanged. The scenario
  panel is a local demo explanation, not a manager authorization mechanism.

## Acceptance

Test exact five bounded projections, tenant/manager authorization before read,
redaction, absence of write endpoints/side effects, and unchanged decision
controls. Run focused and full regressions, then independently review before
acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 23/23 and the full suite
passed 401/401. The endpoint returns exactly five fixed scenario/status pairs;
manager authorization is checked before reads and no browser request can seed,
replay, decide, infer or write.
