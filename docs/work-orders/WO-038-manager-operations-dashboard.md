# WO-038 — Manager Operations Dashboard

**Status:** Accepted  
**Depends on:** WO-036; WO-037

## Goal

Make the existing manager preview useful as one operational dashboard: show the
existing closure queue together with the WO-036 attention gaps, with controlled
counts and filters so a manager can find a chain needing a decision without
seeing evidence payloads or staff-monitoring data.

## Boundaries

- Reuse only the existing manager-only read endpoints and decision command.
  No migrations, new write paths, model calls, OCR, authentication or employee
  browser state.
- The dashboard is a presentation of server-authorized projections. It must not
  derive a verdict, infer a patient identity or turn a reason code into a
  clinical recommendation.
- Attention items contain only the existing safe fields: workflow ID, family,
  stage, alignment state and controlled reasons. Never persist them in a URL,
  local storage, console or query parameter.
- A manager decision remains available only through the existing closure queue
  and its existing S2/Workflow guards.

## Acceptance

Prove the manager view loads both safe read models, has stable bounded counts
and filters, shows no aligned-chain noise, cannot manufacture a decision from
an attention item, and keeps employee workspaces unchanged. Run focused and
full tests locally; no push, merge or PR.

## Acceptance record

Focused dashboard test passed; independent full regression passed: 376/376.
