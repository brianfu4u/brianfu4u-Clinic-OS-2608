# WO-059 — macOS Multi-Role LAN Launcher

**Status:** Accepted
**Depends on:** WO-057; WO-058

## Goal

Start the prepared synthetic Mac demo as four simultaneous, server-controlled
employee workspaces on the private LAN: Reception, Doctor, Exam and Cashier.
Keep the Manager command center bound to the Mac loopback interface.

## Boundaries

- Reuse only the prepared `clinic_os_demo`, protected demo object root and
  accepted startup path. The launcher neither resets, migrates, seeds,
  downloads nor changes PostgreSQL.
- Require macOS Apple Silicon, exact explicit LAN confirmation and a detected
  RFC1918 address. Bind employee workspaces to fixed ports 3001–3004 and the
  manager to loopback port 3000.
- Every employee process receives a server-owned workspace value; its actor is
  derived in WO-058. LAN manager pages and manager APIs remain rejected.
- No device registration, browser role selection, QR persistence, cloud access
  or production authentication. This is synthetic local demonstration only.

## Acceptance

Test refusal before child processes, exact fixed process environment and ports,
bounded printed URLs, cleanup on termination, manager loopback binding and
four-workspace role coverage. Run full regression and independently review.

## Acceptance record

- Launcher safety and fixed role/port topology tests: 4/4 passed.
- Full regression: 427/427 passed.
- Review confirmed manager binds only to loopback and each employee workspace
  is started with server-owned role configuration.
