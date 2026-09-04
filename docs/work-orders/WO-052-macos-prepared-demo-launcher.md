# WO-052 — macOS Prepared Demo Launcher

**Status:** Accepted
**Depends on:** WO-044; WO-045; WO-051

## Goal

Give the M1 Mac operator one explicit non-destructive command to launch an
already prepared `clinic_os_demo` workspace and open the existing local
employee/manager preview. It is for repeat demonstrations after the separate,
explicit WO-044 reset/seed operation.

## Boundaries

- Require the exact dedicated local `postgresql://<user>@localhost:5432/clinic_os_demo`
  target and pre-existing safe demo object root. Refuse non-local, wrong-port,
  wrong-database, credentials/query/fragment or absent workspace inputs before
  launching.
- Never reset, migrate, seed, delete, write, download, install or configure a
  language/model from this command. First-time workspace preparation remains
  the separately confirmed WO-044 command.
- Reuse the existing validated macOS startup configuration and print only the
  loopback employee/manager URLs and fixed success/failure vocabulary; never
  print database URL/user, paths, records, OCR text, model output or errors.
- The command is a local demo helper, not authentication, production startup,
  cloud deployment or a browser endpoint.

## Acceptance

Test unsafe/missing target refusal before process launch, exact safe launch
environment, redacted output and proof it does not invoke reset/seed/migrate.
Run focused and full regressions, then independently review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 3/3 and the full suite
passed 419/419. The prepared launcher refuses unsafe targets before invoking
startup and does not include any preparation, reset, seed or migration action.
