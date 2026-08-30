# WO-027 — Normalized Deployment Profiles and Startup Readiness

**Status:** Architecture frozen / Builder ready
**Architect:** Codex Architecture Designer
**Builder:** delegated Codex Builder
**Depends on:** Constitution, WO-006, WO-018, WO-021, WO-022, WO-024, WO-026

## 1. Outcome

Normalize deployment configuration and startup self-checks behind one code path so the same
application can be declared for an On-Prem clinic or Cloud Run without silently changing its
business behavior.

This ticket adds only:

- a pure, exact-shape startup configuration parser and validator;
- a redacted immutable startup snapshot;
- a liveness (`health`) contract separated from a dependency (`readiness`) contract;
- fail-closed wiring of the existing preview server to that contract.

It does not deploy anything or add a cloud implementation. A valid Cloud profile is a supported
configuration declaration; readiness must explicitly report unavailable cloud adapters until the
corresponding production adapters are implemented.

## 2. Constitutional boundary

The three existing `RuntimeManifest` profiles remain authoritative:

| Profile | Database | Evidence storage | Inference | First required clinical capability |
|---|---|---|---|---|
| `ON_PREM_STRICT` | `LOCAL_POSTGRES` | `LOCAL_OBJECT_STORE` | `LOCAL_MODEL` | local OCR `EXTRACT_EYE_EXAM_REPORT` |
| `ON_PREM_HYBRID` | `LOCAL_POSTGRES` | `LOCAL_OBJECT_STORE` | local, explicitly authorized private cloud, or disabled | capability must be explicitly available |
| `CLOUD` | `CLOUD_SQL_POSTGRES` | `CLOUD_OBJECT_STORE` | private/cloud provider or disabled | capability must be explicitly available |

The business kernel, data contracts, RLS, migrations, object-store authority and S2 authority are
unchanged. Configuration only selects already-approved infrastructure adapters. It must not add a
second domain path, mutate a domain object, or treat a model's output as a decision.

`PREVIEW_MODE=synthetic` remains an explicit UI/demo mode only. It is not a deployment profile and
is never an implicit fallback for a missing or invalid deployment configuration.

## 3. Canonical startup configuration

Add a pure `StartupConfig` contract, separate from `RuntimeManifest` but producing one validated
manifest for existing gateways. The parser receives an explicit environment-like record; tests do
not mutate global `process.env`.

### 3.1 Canonical environment names

The following names are the only names the configured server may consume:

| Variable | Required | Meaning |
|---|---:|---|
| `CLINIC_OS_PROFILE` | yes for configured mode | `ON_PREM_STRICT`, `ON_PREM_HYBRID` or `CLOUD` |
| `DATABASE_URL` | all profiles | PostgreSQL connection string; value is never returned or logged |
| `CLINIC_OS_DATABASE_PROVIDER` | all profiles | `LOCAL_POSTGRES` or `CLOUD_SQL_POSTGRES`; must agree with profile |
| `CLINIC_OS_FILE_PROVIDER` | all profiles | `LOCAL_OBJECT_STORE` or `CLOUD_OBJECT_STORE`; must agree with profile |
| `CLINIC_OS_INFERENCE_PROVIDER` | all profiles | `LOCAL_MODEL`, `PRIVATE_CLOUD_MODEL` or `DISABLED` |
| `CLINIC_OS_BACKUP_PROVIDER` | all profiles | existing approved backup enum |
| `CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED` | all profiles | exact `true`/`false`, no truthy aliases |
| `CLINIC_OS_MANIFEST_VERSION` | all profiles | nonblank bounded version |
| `CLINIC_OS_OBJECT_STORE_ROOT` | On-Prem | absolute local object-store root |
| `WO021_TESSERACT_PATH` | Strict | absolute fixed Tesseract executable |
| `WO021_TESSDATA_DIR` | Strict | absolute fixed Tesseract data directory |
| `CLINIC_OS_PRIVATE_INFERENCE_ENDPOINT` | private provider | approved private/cloud endpoint; never exposed |
| `CLINIC_OS_PRIVATE_INFERENCE_MODEL_ID` | private provider | bounded server-approved model ID |
| `CLINIC_OS_PRIVATE_INFERENCE_MANIFEST_SHA256` | private provider | exact lowercase 64-hex model identity |
| `CLINIC_OS_INFERENCE_CAPABILITIES` | model provider | comma-separated bounded capability allowlist |
| `PORT` | optional | bounded listen port; default remains `3000` for local preview |

The accepted `PREVIEW_OBJECT_STORE_ROOT`, `LOCAL_OBJECT_STORE_ROOT`, `OBJECT_STORE_ROOT`, and
`PREVIEW_MODE=postgres` names are migration-era aliases. WO-027 must either reject them with a
stable `LEGACY_CONFIGURATION_NAME` error or support them only in an explicit compatibility parser
that emits a deprecation warning without changing the canonical snapshot. They must never override
or silently supply a missing canonical value. `PREVIEW_MODE=synthetic` is the sole explicit
synthetic-preview selector.

Unknown `CLINIC_OS_*`, `WO021_*` or deployment variables that look like provider selection must
not be silently ignored. The validator may ignore unrelated platform variables such as Cloud Run's
`K_SERVICE`, but must not accept a typo in a required Clinic OS variable as valid configuration.

### 3.2 Profile requirements

`validateStartupConfig` must call the existing exact `validateRuntimeManifest` rules and then apply
the infrastructure requirements below.

#### On-Prem Strict

Required before server construction:

- nonblank `DATABASE_URL` and `LOCAL_POSTGRES`;
- nonblank absolute `CLINIC_OS_OBJECT_STORE_ROOT` and `LOCAL_OBJECT_STORE`;
- `LOCAL_MODEL` inference (the current first tracer requires OCR; `DISABLED` is not ready for the
  clinical extraction capability);
- `WO021_TESSERACT_PATH` and `WO021_TESSDATA_DIR`;
- the checked-in Tesseract model manifest and all frozen asset hashes validate through the accepted
  WO-021 startup gate;
- `LOCAL_ENCRYPTED_BACKUP` and external inference authorization exactly `false`;
- `CLINIC_OS_INFERENCE_CAPABILITIES` includes exactly the currently advertised
  `EXTRACT_EYE_EXAM_REPORT` capability.

Missing or malformed requirements are startup errors. Strict must never construct a server that can
fall back to synthetic storage, a disabled OCR provider, a remote provider, PGlite or SQLite.

#### On-Prem Hybrid

Database and evidence storage remain local PostgreSQL and local object storage. Local inference or
disabled inference is valid configuration; private/cloud inference additionally requires:

- exact external authorization `true`;
- a nonblank endpoint, model ID and manifest SHA-256;
- an explicit capability allowlist containing the capability advertised by that provider.

The profile must be displayed as Hybrid, never Strict. A private provider that is not implemented
or not reachable makes readiness `not_ready`; it is not replaced with local, disabled or synthetic
inference.

#### Cloud

Required configuration is:

- nonblank `DATABASE_URL` and `CLOUD_SQL_POSTGRES`;
- `CLOUD_OBJECT_STORE` and a configured cloud object-store adapter declaration;
- `PRIVATE_CLOUD_MODEL` or `DISABLED` inference, subject to the existing manifest policy;
- `CLOUD_MANAGED_BACKUP`;
- no local-only root or local Tesseract requirement;
- when private inference is selected, exact endpoint/model/manifest/capability declarations.

Cloud configuration validation proves only that the declaration is internally compatible. Because
this ticket does not add cloud SDKs or providers, the configured preview must report an explicit
readiness code such as `CLOUD_PROVIDER_UNAVAILABLE` until those adapters exist. It must not start
claiming `ready` or silently use local/synthetic providers.

### 3.3 Immutable redacted snapshot

The validated startup object is frozen and contains only non-secret configuration facts needed by
health/readiness and provider construction. It must not contain `DATABASE_URL`, endpoint URLs,
credentials, tokens, object-store paths, Tesseract paths or raw environment values in a response,
error, log or thrown exception.

The redacted public snapshot may contain:

- `profile`, provider enum values and manifest version;
- capability names and boolean configured/present flags;
- `databaseConfigured`, `objectStoreConfigured`, `ocrManifestConfigured`;
- a stable configuration fingerprint that is not derived from a secret value.

No startup error may include the value of any `*_URL`, `*_TOKEN`, `*_PASSWORD`, `*_SECRET`, path,
model output, SQL detail or provider stderr.

## 4. Health and readiness contracts

### 4.1 Liveness: `GET /api/health`

Liveness answers only whether the HTTP process is running. It performs no database, object-store,
OCR or inference probe and never reports that the clinical chain is usable.

Success response:

```json
{
  "status": "ok",
  "profile": "ON_PREM_STRICT"
}
```

The response contains no connection string, path, model endpoint, credential, PHI, migration detail
or raw error. The profile is omitted for the explicit synthetic preview or is reported as
`SYNTHETIC_PREVIEW` only when that mode was explicitly selected.

### 4.2 Readiness: `GET /api/readiness`

Readiness answers whether this process may receive the advertised clinical traffic. It returns a
bounded detached projection and stable reason codes only:

```json
{
  "status": "ready",
  "profile": "ON_PREM_STRICT",
  "checks": [
    { "name": "database", "status": "ok" },
    { "name": "object_store", "status": "ok" },
    { "name": "ocr_manifest", "status": "ok" },
    { "name": "inference_capability", "status": "ok" }
  ]
}
```

Not-ready response uses HTTP `503` and the same shape, with a controlled `code` per failed check:

```json
{
  "status": "not_ready",
  "profile": "CLOUD",
  "checks": [
    { "name": "cloud_provider", "status": "not_ready", "code": "CLOUD_PROVIDER_UNAVAILABLE" }
  ]
}
```

Startup configuration errors happen before the server is constructed and exit non-zero. Transient
dependency failures are readiness failures. Neither category may be disguised as a synthetic
preview. Readiness checks must be bounded, must not read PHI, and must not log or return raw driver,
filesystem, OCR or provider errors.

Required checks by profile:

| Check | Strict | Hybrid | Cloud |
|---|---:|---:|---:|
| PostgreSQL configured/reachable | required | required | required |
| Object store configured/reachable | required | required | required |
| Tesseract manifest/assets | required | required only for local OCR | not applicable |
| Selected inference provider | local and capability | selected provider and capability | selected provider and capability |
| Backup declaration | valid manifest | valid manifest | valid manifest |

The route must not perform a destructive migration, backup, restore, model download, network
discovery or cloud SDK call. Existing migrations and WO-018 acceptance remain separate commands.

## 5. Server integration boundary

The configured server must be assembled in this order:

1. parse and validate the explicit startup environment;
2. validate profile/provider compatibility and required local asset manifests;
3. construct only providers allowed by the immutable snapshot;
4. expose health and readiness using the bounded contracts;
5. expose the existing HTTP/application routes only through the selected backend.

The synthetic preview may still be created directly for UI tests, but a configured server must
never call `createPreviewServer()` as a catch-all after a missing database, object-store, OCR or
cloud provider failure. If a requested durable profile cannot be assembled, fail startup or report
503 readiness with the stable code; do not register durable routes against memory state.

`GET /api/health` must remain inexpensive and independent of readiness. `GET /api/readiness` may use
existing narrow provider/pool health seams, but may not acquire domain repositories or write any
row. No domain, migration, RLS, object-store contract or business result changes are permitted.

## 6. Acceptance tests

At minimum prove:

1. valid Strict, Hybrid and Cloud configuration snapshots are exact and immutable;
2. missing profile, unknown profile, unknown provider, malformed boolean, duplicate/unknown config
   fields and profile/provider mismatch fail closed with stable non-secret codes;
3. Strict requires PostgreSQL, local object storage, local OCR and the frozen WO-021 manifest;
4. Strict rejects remote inference, remote storage, external authorization and disabled current
   clinical capability;
5. Hybrid private inference requires explicit authorization and complete bounded provider metadata;
6. Cloud requires PostgreSQL/cloud storage and only the approved private/disabled inference set;
7. current model capability is checked explicitly; missing `EXTRACT_EYE_EXAM_REPORT` is not ready;
8. no startup error, snapshot, health response or readiness response contains URL, password, token,
   secret, local path, SQL detail, OCR output or provider stderr;
9. health returns 200 and performs no dependency probe when readiness is unavailable;
10. readiness returns 200 only when every profile-required check passes, otherwise 503 with stable
    bounded codes;
11. an explicitly selected synthetic preview is visibly synthetic and has no durable clinical
    readiness; absent/invalid durable configuration never selects it;
12. Cloud declaration with unimplemented cloud adapters is `not_ready`/`CLOUD_PROVIDER_UNAVAILABLE`,
    never local or synthetic success;
13. `PORT` is bounded and only affects listening configuration, not provider selection;
14. all existing tests, demos, local OCR acceptance and real-PostgreSQL fail-closed acceptance
    remain unchanged and green.

## 7. Minimal implementation surface

Expected files:

```text
src/runtime/startup-config.ts
src/runtime/readiness.ts
src/preview/server.ts
test/startup-config.test.ts
test/readiness.test.ts
README.md
```

Small additions to existing runtime contracts are allowed. Do not add dependencies, migrations,
ORMs, cloud SDKs, Dockerfiles, CI workflows, deployment scripts, credential loaders, model
downloaders, HTTP client retries, UI changes or domain/repository changes.

## 8. Builder handoff

Read the Constitution and WO-006, WO-018, WO-021, WO-024 and WO-026 in full. Implement only this
configuration/startup/readiness boundary. Use pure fixture probes in tests; do not claim a real
Cloud Run or cloud-provider acceptance. Run:

```bash
npm test
npm run demo
npm run runtime:demo
npm run accept:ocr-local
npm run accept:postgres-real   # must fail closed here if real environment is absent
git diff --check
```

Commit as:

```text
feat(runtime): normalize startup profiles and readiness
```

Do not push before independent Architecture Review. Report separate results for ordinary tests,
local OCR, the local real-PostgreSQL fail-closed gate, and any cloud readiness gate that remains
open.
