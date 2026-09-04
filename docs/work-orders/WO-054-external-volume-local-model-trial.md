# WO-054 — External-Volume Local Model Trial

**Status:** Accepted
**Depends on:** WO-041; WO-043; WO-053

## Goal

Provide one explicit local trial command that proves a manually installed,
approved model on the safely mounted external model volume can satisfy the
existing bounded manager-guidance contract over loopback. This is a model
compatibility trial, not model download or clinical enablement.

## Boundaries

- Require canonical loopback endpoint, approved model ID and the WO-053 safe
  external volume gate before attempting the existing WO-043 preflight. Missing
  any input returns fixed unavailable/refused status without transport.
- Do not install/pull/delete a model, set `OLLAMA_MODELS`, mount/format a disk,
  run OCR, query a database, access object storage, change workflow/S2 or make
  a browser request.
- Output fixed status/suggestion/reason vocabulary only. Never emit endpoint,
  model ID, volume path, model response, prompt, token, corpus, record or raw
  error.
- A successful trial does not activate model output for clinical processing;
  existing model output stays read-only manager guidance.

## Acceptance

Test unavailable unsafe volume before transport, missing/invalid model config,
loopback-only exact successful contract, redaction and no external side effect.
Run focused and full regressions, then independently review before acceptance.

## Acceptance record

Accepted 2026-09-02. Independent focused tests passed 5/5 and the full suite
passed 422/422. Invalid volume/configuration performs no local transport; a
successful trial remains the existing read-only guidance contract only.
