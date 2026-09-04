# Clinic OS Engineering Handoff

**Repository:** `https://github.com/brianfu4u/brianfu4u-Clinic-OS-2608`  
**Primary branch:** `main`  
**Updated:** 2026-09-04 — accepted through WO-059
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
recommendation boundary, an optional loopback-only Ollama provider, safe
manager guidance presentation, five synthetic end-to-end UI/API acceptance
cases, a bounded macOS local-model preflight, and a guarded resettable macOS
five-case demo workspace, browser-visible redacted local readiness, and a
read-only manager five-scenario walkthrough, an offline pinned English OCR
evaluation baseline, a visible safe Chinese/Japanese language-asset gate, and
separately pinned synthetic OCR evaluation for all three languages, and a
create-only local human OCR language release record, and safe browser-visible
language release readiness, a non-destructive prepared Mac demo launcher, an
external model-volume gate, a ChatGPT-style employee workspace, a bounded
external-volume local-model trial, and a matching manager command-center UI.
It also includes an explicit same-Wi-Fi synthetic employee-phone demo mode:
the Mac hosts the application and PostgreSQL, while remote manager access is
rejected. It also supports durable Reception → Doctor → Exam → Cashier task
handoff and one-command four-workspace LAN demonstration startup. Independent
full regression is 427/427.

## Not implemented

The following remain product or production work:

1. Installation and selection of an approved local model on the clinic Mac.
   The trusted local-only boundary, manager-page presentation and preflight are
   accepted; neither downloads a model automatically.
2. Production authentication and real-clinic identity integration.
3. Chinese/Japanese clinical OCR and extraction accuracy validation.
4. Monitoring, installer, backup automation and upgrade/rollback packaging.
5. WO-018 external PostgreSQL application-role RLS, concurrency and destructive
   backup/restore acceptance. Local connectivity is not a substitute.
6. Production Tencent/cloud database, object storage and inference adapters.

## Next milestone

The local prototype milestone through WO-059 is complete. The next action is
an operator-led Mac and phone multi-role demonstration, not more speculative UI
work; do not weaken an accepted trust boundary to speed deployment or model
integration.

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
