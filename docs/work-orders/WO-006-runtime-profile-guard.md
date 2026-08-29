# WO-006 — Runtime Profile and Provider Guard

**Status:** APPROVED FOR BUILD  
**Architect:** Codex Architecture Designer  
**Builder:** delegated Codex Builder  
**Repository:** `brianfu4u/brianfu4u-Clinic-OS-2608`  
**Depends on:** WO-001 through WO-005 accepted through `40a321c`  

## 1. Outcome

Encode the constitutional deployment boundary as executable policy:

- one business kernel;
- `ON_PREM_STRICT`, `ON_PREM_HYBRID`, and `CLOUD` runtime profiles;
- replaceable infrastructure providers selected at boot;
- Strict mode rejects any provider combination that could silently send clinic data outside the clinic;
- unavailable inference is explicit and never disguised as success.

This ticket freezes and tests provider contracts. It does not deploy PostgreSQL, models or cloud services.

## 2. Frozen contracts

### DeploymentProfile

- `ON_PREM_STRICT`
- `ON_PREM_HYBRID`
- `CLOUD`

### RuntimeManifest

- `profile`
- `databaseProvider`
- `fileProvider`
- `inferenceProvider`
- `backupProvider`
- `externalInferenceAuthorized: boolean`
- `manifestVersion`

### Provider kinds

Database:

- `LOCAL_POSTGRES`
- `CLOUD_SQL_POSTGRES`

Files:

- `LOCAL_OBJECT_STORE`
- `CLOUD_OBJECT_STORE`

Inference:

- `LOCAL_MODEL`
- `PRIVATE_CLOUD_MODEL`
- `DISABLED`

Backup:

- `LOCAL_ENCRYPTED_BACKUP`
- `CLOUD_MANAGED_BACKUP`
- `LOCAL_PLUS_ENCRYPTED_REMOTE_BACKUP`

These values are deployment configuration, not SKU entitlements.

## 3. Manifest rules

### ON_PREM_STRICT

- database must be `LOCAL_POSTGRES`;
- files must be `LOCAL_OBJECT_STORE`;
- inference must be `LOCAL_MODEL` or `DISABLED`;
- backup must be `LOCAL_ENCRYPTED_BACKUP`;
- `externalInferenceAuthorized` must be false;
- any cloud or remote provider causes boot validation failure.

### ON_PREM_HYBRID

- database remains `LOCAL_POSTGRES`;
- files remain `LOCAL_OBJECT_STORE`;
- inference may be `LOCAL_MODEL`, `PRIVATE_CLOUD_MODEL`, or `DISABLED`;
- `PRIVATE_CLOUD_MODEL` requires `externalInferenceAuthorized: true`;
- backup may be local-only or local plus explicitly encrypted remote backup;
- it must never report itself as Strict.

### CLOUD

- database must be `CLOUD_SQL_POSTGRES`;
- files must be `CLOUD_OBJECT_STORE`;
- inference may be `PRIVATE_CLOUD_MODEL` or `DISABLED`;
- backup must be `CLOUD_MANAGED_BACKUP`;
- local-only providers are invalid for this first cloud profile.

Malformed or incompatible manifests fail at boot with stable reason codes. There is no fallback profile.

## 4. Inference contract

Define the minimum versioned request/response contract needed to swap local and private-cloud inference later:

### InferenceRequest

- `requestId`
- `clinicId`
- `capability`
- `schemaVersion`
- `input`

### InferenceResponse

- `requestId`
- `providerKind`
- `modelId`
- `schemaVersion`
- `output`
- `completedAt`

### InferenceProvider

- exposes its exact provider kind and model ID;
- accepts one `InferenceRequest` and explicit ActorContext;
- returns one validated `InferenceResponse`;
- cannot write Artifact, Workflow, Expectation, Verification or ManagerDecision.

Implement only:

- `DisabledInferenceProvider`, which returns a stable `INFERENCE_UNAVAILABLE` error;
- deterministic local/private-cloud contract stubs for tests only, clearly named fixtures and never used by the preview UI.

## 5. InferenceGateway guard

The gateway receives a validated RuntimeManifest and a provider at construction.

- Provider kind must exactly equal the manifest inference kind.
- `ON_PREM_STRICT` refuses `PRIVATE_CLOUD_MODEL` before provider invocation.
- Hybrid refuses private-cloud invocation without explicit authorization.
- ActorContext clinic must exactly match request clinic.
- Response request/schema IDs must match the request; malformed provider responses fail closed.
- Provider errors remain explicit; no silent provider fallback.
- The gateway records only a small returned call receipt in memory for tests: request ID, clinic ID, provider kind, capability, completedAt. It must not record request input or response output.

## 6. Plug-in / plug-out boundary

- Provider selection happens through RuntimeManifest at controlled startup/restart.
- Replacing a compatible provider changes no domain code.
- Do not implement arbitrary code loading, hot reload, package download, entitlement, billing or a plugin marketplace.
- Provider interfaces never receive repository objects or generic write access.

## 7. Minimal implementation surface

Expected files:

```text
src/runtime/contracts.ts
src/runtime/manifest-validator.ts
src/runtime/inference-gateway.ts
test/runtime-profile.test.ts
```

Small README updates are allowed. Do not reorganize existing directories.

## 8. Mandatory tests

At minimum prove:

1. Every valid profile manifest boots.
2. Strict rejects every cloud/remote provider permutation and external authorization flag.
3. Hybrid private-cloud inference requires explicit authorization.
4. Cloud rejects local-only providers.
5. Invalid provider enum or missing manifest field fails closed.
6. Provider/manifest kind mismatch fails before invocation.
7. Cross-clinic inference request fails before invocation.
8. Disabled provider returns explicit unavailable error and no receipt.
9. Strict cannot invoke a private-cloud provider even if a caller constructs one manually.
10. Malformed provider response IDs/schema fail closed.
11. Local and private-cloud fixture providers pass the same request/response schema contract.
12. Gateway receipt contains no request input or response output.
13. Provider objects have no domain repository/write capability.
14. Existing tests remain green.

## 9. Acceptance commands

```bash
npm test
npm run demo
```

Add a one-shot `npm run runtime:demo` that prints only a synthetic Strict/local success receipt and a Disabled explicit-error code. It must perform no network call.

## 10. Prohibited scope

- No real model call or model weights.
- No OCR.
- No network request.
- No secrets or environment credential loading.
- No PostgreSQL driver or migration.
- No dynamic code execution.
- No SKU entitlement logic.
- No silent fallback.

## 11. Builder handoff

The Builder must:

1. read the Constitution and WO-001 through WO-006 before editing;
2. implement only this ticket;
3. keep provider fixtures test/demo-only;
4. run all tests, domain demo and runtime demo;
5. commit with message `feat(runtime): enforce deployment profile guards`;
6. report SHA, test count, both demos and deviations;
7. not push until Architecture Review is complete.
