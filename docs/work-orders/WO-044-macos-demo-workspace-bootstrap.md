# WO-044 — macOS Demo Workspace Bootstrap

**Status:** Accepted
**Depends on:** WO-040; WO-043

## Goal

Give the local Mac operator one explicit command that resets and seeds a
dedicated, non-PHI PostgreSQL demo workspace through the accepted application
seams, then starts the existing employee and manager preview. The result must
be immediately usable for the five accepted synthetic demonstrations.

## Boundaries

- Require an explicit dedicated local database URL and an explicit confirmation
  flag. Never infer or reuse a cloud, production, pooled or unrecognised
  database target.
- The generated data is fixed synthetic demonstration data only. No patient
  names, files, OCR bytes, paths or model output enter command output.
- Use migrations and existing application services/repositories; no raw SQL
  business-row inserts, changed domain rules, new migrations or browser
  authority.
- Reset only the exact configured demo database. Fail closed before any reset
  if the URL/profile/confirmation is unsafe; do not launch the preview on a
  failed bootstrap.
- This is a developer/demo convenience, not production backup, restore,
  authentication, multi-user access or deployment automation.

## Acceptance

Test target validation and refusal before reset; deterministic synthetic seed
and exact rerun behavior; no sensitive command output; and that the existing
employee/manager preview starts against the prepared workspace. Run focused
and full regressions, then independently review before acceptance.

## Acceptance record

Accepted 2026-09-01. Independent focused tests passed 4/4 and the full suite
passed 395/395. The command refuses before database access unless the exact
confirmed localhost-only `clinic_os_demo` target is supplied; it never resets
the ordinary local workspace or a cloud target.
