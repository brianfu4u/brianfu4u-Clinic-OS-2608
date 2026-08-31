# Clinic OS Engineering Handoff

**Repository:** `https://github.com/brianfu4u/brianfu4u-Clinic-OS-2608`  
**Primary branch:** `main`  
**Updated:** 2026-08-31 — accepted through WO-032  
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

## Implemented foundation

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

WO-032 is accepted and adds the staged prescription slice:

```text
REGISTRATION -> PRESCRIPTION -> EXAM_REPORT
```

Read `docs/work-orders/WO-032-persisted-prescription-stage.md` before changing
that flow.

## Not implemented

The following are product work, not accepted capabilities:

1. `EXAM_REPORT -> PAYMENT` and persisted payment completion.
2. Frozen structured schemas for registration, prescription, exam and payment
   documents, including patient/time/department/document/amount alignment.
3. Cross-document conflict rules such as order inversion, duplicate documents,
   left/right-eye conflict and near-identity review.
4. A real local distilled/LLM provider for gap explanation and next-step
   recommendation. Tesseract is OCR, not this model.
5. Final reception, doctor, exam and cashier staff surfaces.
6. Final manager operations dashboard, patient timeline and attention queue.
7. Five-patient demo coverage for normal, missing, late, reversed and conflicting
   flows.
8. Production authentication, real-clinic identity integration, Chinese/Japanese
   OCR accuracy validation, monitoring, installer and upgrade/rollback packaging.
9. WO-018 external PostgreSQL application-role RLS, concurrency and destructive
   backup/restore acceptance. Local connectivity is not a substitute.
10. Production cloud providers or cloud deployment.

## Recommended next work orders

```text
WO-033 EXAM_REPORT -> PAYMENT Expectation
WO-034 persisted PAYMENT completion
WO-035 structured document schemas and deterministic alignment
WO-036 manager attention and gap read model
WO-037 reception/doctor/exam/cashier workspaces
WO-038 manager operations dashboard
WO-039 local model recommendation boundary
WO-040 five-patient end-to-end UI acceptance
```

Freeze one work order at a time. Do not implement a later item by weakening an
earlier trust boundary.

## Local development

```bash
npm ci
npm test
npm run demo:closure
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
