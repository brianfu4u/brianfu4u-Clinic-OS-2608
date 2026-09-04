# WO-045 — Local Preview Readiness

**Status:** Accepted
**Depends on:** WO-031; WO-043; WO-044

## Goal

Give a local Mac operator one safe browser-visible readiness surface before
opening the employee or manager preview. It must say only whether the local
database/schema, OCR assets, optional local-model preflight and synthetic demo
workspace are ready, and link into the existing two role workspaces.

## Boundaries

- The surface is a local preview aid, not login, authorization, clinical data,
  workflow mutation, or a production status endpoint.
- Expose fixed state/reason vocabulary only. Never expose database URL/user,
  filesystem paths, object IDs, model name/response, prompt, PHI, stack trace,
  migration detail or internal exception text.
- Read existing startup/configuration and preflight seams only; do not make a
  schema change, reset, migrate, pull a model, create demo data or start a
  process from a browser request.
- The optional model remains non-blocking and loopback-only. Employee and
  manager routes retain their existing server-injected demo contexts and must
  remain usable when optional guidance is unavailable.

## Acceptance

Test bounded ready/degraded states; redaction of every private value; no write
or subprocess side effect; disabled/unavailable local model behavior; and
links to the unchanged employee/manager routes. Run focused and full
regressions, then independently review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 22/22 and the full suite
passed 398/398. The browser receives only fixed readiness vocabulary and the
two existing workspace links; the optional loopback model probe is bounded and
does not block the employee or manager preview.
