# WO-039 — Local Model Recommendation Boundary

**Status:** Accepted locally — 2026-08-31
**Depends on:** WO-035; WO-036; WO-038

## Goal

Add one bounded, local-only recommendation seam for a manager attention item.
It may turn controlled alignment state and reason codes into a controlled next
step suggestion. It does not inspect evidence bytes, patient identity, OCR
text, notes or employee activity.

## Boundaries

- Reuse `InferenceGateway` with `LOCAL_MODEL` only; failure or disabled
  inference returns an explicit unavailable result and never falls back to a
  remote provider.
- Input and output use a closed, cloneable schema with bounded strings. The
  model cannot return an action, verdict, expectation state, manager decision,
  score or authority field.
- The result is read-only and non-clinical. It creates no database row and
  cannot close, void, verify or mutate a chain.
- No migrations, network client, model download, OCR change or UI persistence.

## Acceptance

Prove schema and provider identity checks, no sensitive input/receipt, local
only/disabled failure behavior, output bounds, no write capability and no
manager-decision path. Run focused and full tests locally; no push, merge or
PR.

## Acceptance record

- Recommendation boundary tests passed 3/3; combined WO-039/040 independent
  focused tests passed 5/5.
- Independent full regression passed 382/382.
- The trusted service boundary is complete. A real distilled-model provider
  and manager-page presentation remain future product work.
