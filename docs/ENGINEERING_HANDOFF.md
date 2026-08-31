# Clinic OS Engineering Handoff

**Repository:** `https://github.com/brianfu4u/brianfu4u-Clinic-OS-2608`  
**Primary branch:** `main`  
**Updated:** 2026-08-31 — accepted through WO-040
**Product authority:** `docs/CONSTITUTION.md`

## Product boundary

Clinic OS reconstructs traceable clinic evidence and operational workflows so a
manager can see what happened, what is still expected, which evidence conflicts,
and why an item needs attention. It is not an autonomous operator, employee
performance judge or medical-decision system.

```text
Evidence capture -> immutable Artifact -> EvidenceFactCard -> Workflow
-> Expectation -> deterministic S2 -> recommendation -> manager decision
```

OCR and models may extract, explain and recommend. They cannot write an S2
verdict, close a Workflow or approve an operational action. Actor and clinic
authority are server-injected and never accepted from a browser command.

## Deployment target

One codebase supports `ON_PREM_STRICT`, `ON_PREM_HYBRID` and `CLOUD` profiles.
The current delivery target is On-Prem on an Apple Silicon Mac with PostgreSQL
17, local immutable object storage and pinned Tesseract 5.5.3. Cloud provider
declarations are fail-closed placeholders; Tencent Cloud, Cloud Run, Firestore
and production cloud adapters are not implemented.

## Implemented foundation and prototype flow

Work orders WO-001 through WO-031 establish:

- tenant/RBAC context and server-injected authority;
- immutable Artifact, FactCard lineage and exact Workflow attachment;
- Expectation initialization, re-evaluation and append-only transitions;
- persisted deterministic S2 verification;
- manager closure read model and immutable manager decision Saga;
- PostgreSQL migrations `0001` through `0007` and schema readiness;
- local immutable evidence object storage and safe upload;
- stored extraction lineage, restart-safe orchestration and HTTP transport;
- pinned local Tesseract OCR with manifest/hash/path/ownership gates;
- employee-safe open-Expectation reads;
- persisted registration, extraction and manager-closure acceptance demo;
- a first operational employee workspace and manager dashboard.

WO-032 through WO-040 complete the local prototype path:

```text
REGISTRATION -> PRESCRIPTION -> EXAM_REPORT -> PAYMENT -> manager close
```

This includes persisted payment, four-document deterministic alignment,
manager attention reads, server-scoped reception/doctor/exam/cashier
workspaces, a manager operations dashboard, a local-only read-only model
recommendation boundary, and five synthetic end-to-end UI/API acceptance
cases. Independent full regression is 382/382.

## Not implemented

The following remain product or production work:

1. A real local distilled/LLM provider and its manager-page presentation. The
   accepted WO-039 capability is the trusted local-only recommendation boundary.
2. Production authentication and real-clinic identity integration.
3. Chinese/Japanese clinical OCR and extraction accuracy validation.
4. Monitoring, installer, backup automation and upgrade/rollback packaging.
5. WO-018 external PostgreSQL application-role RLS, concurrency and destructive
   backup/restore acceptance. Local connectivity is not a substitute.
6. Production Tencent/cloud database, object storage and inference adapters.

## Next milestone

The WO-033 through WO-040 prototype milestone is complete. Select the next
production milestone before freezing WO-041; do not weaken an accepted trust
boundary to speed deployment or model integration.

## Local development

```bash
npm ci
npm test
npm run demo:closure
npm run accept:five-patient
```

Apple Silicon local profile:

```bash
bash scripts/start-macos-local.sh
```

Then open `/employee` and `/manager` on the printed loopback address. Never use
real patient data in this unauthenticated preview.

## Change rules

- Read the Constitution and dependency work orders before editing.
- Preserve append-only evidence and exact idempotent replay.
- Do not rewrite migrations `0001` through `0007`.
- Do not expose clinic, actor, path, database, Artifact, FactCard or Workflow
  authority to the browser.
- Do not allow model output to mutate Workflow, Expectation, S2 or manager state.
- Do not silently fall back to synthetic, cloud or alternate inference.
- Run focused negative tests, the full suite and `git diff --check`.
- Every change needs Architecture Review, focused negative tests, the full suite
  and `git diff --check` before it is pushed.
