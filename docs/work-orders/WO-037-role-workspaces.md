# WO-037 — Role-Scoped Workspaces

**Status:** Architecture frozen / Builder active  
**Depends on:** WO-036

## Goal

Turn the existing employee preview into four minimal operational workspaces:
reception (`REGISTRATION`), doctor (`PRESCRIPTION`), exam (`EXAM_REPORT`) and
cashier (`PAYMENT`). Each shows only its current permitted task and cannot
invoke another role's command by changing browser fields.

## Boundaries

- Server-injected role context remains authoritative; the browser only selects
  a presentation workspace and submits the existing bounded command.
- Reuse existing routes and persisted stages. No new authentication, migration,
  model, OCR or patient data.
- Ordinary chat stays non-clinical. Object upload appears only for the exam
  report workspace. Staff views keep IDs and private evidence out of URLs and
  browser persistence.
- Add safe manager navigation only if it is read-only.

## Acceptance

Test each role UI/server mapping, role spoof rejection, no cross-role route
access, no clinical action from chat, and unchanged full synthetic chain. Run
focused/full tests locally; no push, merge or PR.
