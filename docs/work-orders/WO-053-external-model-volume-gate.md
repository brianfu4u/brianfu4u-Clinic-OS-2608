# WO-053 — External Model Volume Gate

**Status:** Accepted
**Depends on:** WO-041; WO-045

## Goal

Add an explicit macOS local-model storage gate for an operator-chosen encrypted
external SSD. The preview must show only whether the approved mounted model
volume is safely usable; Clinic OS continues to call the existing loopback
model endpoint and never reads model weights itself.

## Boundaries

- Require one explicit absolute mounted-volume root from canonical local
  configuration. Verify a protected, non-symlink directory with safe ancestry,
  owner and permissions; unmounted/unsafe input is unavailable.
- The gate does not create directories, format/encrypt/mount a disk, set
  `OLLAMA_MODELS`, download/pull/delete models, read model contents or start a
  process. Those are explicit operator actions.
- Browser projection is fixed `AVAILABLE`/`UNAVAILABLE` only. Never expose
  volume name, path, owner, disk UUID, endpoint, model ID, model contents or
  errors.
- No impact on database, object store, OCR, workflow/S2, manager decision,
  browser authority or cloud fallback.

## Acceptance

Test absent, relative, symlinked, unsafe and safe mounted roots; redaction;
no side effects; unchanged model/OCR/clinical flow. Run focused and full
regressions, then independently review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 23/23 and the full suite
passed 419/419. An absent, unsafe or unmounted volume is only unavailable; it
does not cause cloud fallback or alter any clinical path.
