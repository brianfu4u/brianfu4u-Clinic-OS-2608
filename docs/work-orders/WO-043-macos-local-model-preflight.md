# WO-043 — macOS Local Model Preflight

**Status:** Accepted
**Depends on:** WO-041; WO-042

## Goal

Give the M1 Mac operator one bounded preflight command which proves that the
configured local Ollama endpoint and selected model can produce the exact
safe, structured manager-guidance shape before the Clinic OS preview starts.

## Boundaries

- No model pull, download, installation, subprocess management or external
  network. Ollama must already be installed and started by the operator.
- Read only the explicit loopback endpoint and model configuration accepted by
  WO-041. Never print endpoint, model response, token, path, PHI or prompt.
- Use a synthetic, non-clinical attention input and a fixed output contract.
  It must not touch PostgreSQL, object storage, OCR, Workflow, S2 or decisions.
- Clear bounded success/failure vocabulary; the normal preview stays usable
when this optional model preflight is unavailable.

## Acceptance

Test absent, malformed, unavailable and bad-model configurations; exact safe
success output; no network beyond loopback; and no change to the standard Mac
preview startup. Run focused/full tests locally; commit and push after
independent acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 9/9 and the full suite
passed 391/391. The preflight stays read-only and optional: an unavailable
local model does not make the preview pretend it has guidance.
