# WO-050 — Local OCR Language Release Record

**Status:** Accepted
**Depends on:** WO-047; WO-048; WO-049

## Goal

Provide a local, human-operated release-record command that converts one
already completed synthetic OCR evaluation result into a bounded approval or
rejection record for exactly one language. This makes the distinction explicit:
the system measures; an operator approves; clinical extraction remains
unchanged.

## Boundaries

- Require an explicit language, an explicit evaluator result file, and an
  explicit operator confirmation. Refuse arbitrary JSON, wrong language,
  incomplete/failed results or unapproved confirmation before creating a
  record.
- Store only a local, non-PHI fixed-schema record with language, aggregate
  metrics, decision (`APPROVED` or `REJECTED`) and timestamp. Never store
  operator identity, file paths, corpus labels, OCR text, hashes, raw errors
  or clinical data.
- No browser route, database, object storage, workflow/S2 write, model/OCR
  execution, language installation/download or automatic enablement. The record
  is an audit aid, not an authorization to process clinical data.
- Rerun must be exact-idempotent; conflicting retry must fail closed.

## Acceptance

Test confirmation/result/language validation before write, aggregate redaction,
exact idempotent rerun, conflicting retry, no external side effect and unchanged
clinical OCR behavior. Run focused and full regressions then independently
review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 3/3 and the full suite
passed 410/410. A release record is local, fixed-schema and create-only; exact
replay is safe while conflicting retry is rejected. It has no effect on OCR or
clinical processing.
