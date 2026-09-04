# WO-057 — macOS LAN Employee Demo

**Status:** Accepted
**Depends on:** WO-044; WO-052; WO-055; WO-056

## Goal

Permit a phone on the same private Wi-Fi to use the employee capture page of
the already prepared synthetic macOS demo. The Mac remains the application and
PostgreSQL server; the phone never connects to PostgreSQL.

## Boundaries

- Disabled by default. It requires the exact prepared `clinic_os_demo` target,
  an existing protected demo object root and an explicit LAN confirmation.
- Accept only a private LAN address discovered by the Mac launcher. Do not add
  routing, port forwarding, TLS, cloud access, QR persistence or dependencies.
- Remote LAN requests may use employee routes only. Server-side routing rejects
  `/manager` and every `/api/manager/*` request unless it originates from the
  Mac loopback interface.
- The mode is a synthetic, unauthenticated local demo only. It is not a
  production remote-access feature and must not be used with real patient data.

## Acceptance

Test flag validation, launcher refusal paths, private-address selection and
remote manager-route rejection. Preserve ordinary loopback manager operation,
employee upload limits and all accepted database/OCR/model boundaries. Run
focused and full regression, then independent review.

## Acceptance record

- Flag validation, launcher-boundary and remote manager-route rejection tests:
  3/3 passed.
- Independent full regression: 426/426 passed.
- Review confirmed that the Mac keeps PostgreSQL and manager authority local;
  a LAN peer receives only employee-preview access in this synthetic demo mode.
