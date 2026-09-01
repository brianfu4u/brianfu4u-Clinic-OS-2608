# WO-041 — Local Ollama Recommendation Provider

**Status:** Architecture frozen / Builder active
**Depends on:** Constitution §2–§4; WO-039; WO-040

## Goal

Make the accepted recommendation boundary usable with a real, separately
running local model on an Apple Silicon Mac. Add a small Ollama adapter for
manager-attention guidance only; it is independent from the pinned Tesseract
OCR provider used by evidence extraction.

## Boundaries

- Only allow an explicit loopback `http://127.0.0.1` or `http://localhost`
  Ollama endpoint. No cloud URL, redirect, proxy, model pull or download.
- The endpoint and model ID are private startup values. They never appear in
  readiness, API responses, logs or browser state.
- Do not replace the OCR `InferenceGateway`. Construct a separate local
  recommendation gateway only when the explicit local recommendation settings
  are present; absent settings leave core OCR and closure flows unchanged.
- Send only WO-039's bounded manager-attention input. Request a single,
  non-streaming JSON response; bound body size/time and reject malformed or
  foreign model responses.
- The provider remains read-only: no migrations, database writes, S2 changes,
  manager decisions or UI endpoint in this work order.

## Acceptance

Test loopback validation, startup redaction, request shape, non-streaming JSON
response validation, timeout/oversize/redirect failure, no remote fallback and
unchanged OCR assembly. Run focused/full tests locally; commit locally, then
push only after acceptance.

## Operator note

Ollama is a local runner, not a required app dependency. A future Mac setup
will install it and choose/pull a small approved model explicitly.
