# WO-042 — Manager Recommendation Presentation

**Status:** Architecture frozen / Builder active
**Depends on:** WO-038; WO-039; WO-041

## Goal

Show one optional, read-only local-model recommendation on each eligible
manager attention item. The existing manager closure queue and decision command
remain separate and authoritative.

## Boundaries

- Add a manager-only GET projection that obtains the existing safe attention
  item, invokes the optional `localRecommendations` service, and returns only
  bounded availability, suggestion code and reason codes.
- It must never include workflow ID, patient identity, evidence, OCR text,
  model endpoint, model ID, raw response, receipt, note or error detail.
- If Ollama is not configured, unavailable, malformed or slow, return the
  controlled unavailable projection; the manager dashboard still loads.
- No write route, migration, decision action, browser persistence, cloud
  fallback or model download. The browser can display guidance but cannot send
  it back as a command.

## Acceptance

Test manager and tenant scope before model work, safe projection/redaction,
unavailable behavior, no decision path and dashboard display. Run focused/full
tests locally; commit and push only after independent acceptance.
