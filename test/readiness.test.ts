import assert from "node:assert/strict";
import test from "node:test";

import { StartupReadiness } from "../src/runtime/readiness.ts";
import { validateStartupConfig } from "../src/runtime/startup-config.ts";
import { createConfiguredPreviewServer } from "../src/preview/server.ts";

const cloud = validateStartupConfig({
  CLINIC_OS_PROFILE: "CLOUD",
  DATABASE_URL: "postgresql://db/clinic",
  CLINIC_OS_DATABASE_PROVIDER: "CLOUD_SQL_POSTGRES",
  CLINIC_OS_FILE_PROVIDER: "CLOUD_OBJECT_STORE",
  CLINIC_OS_INFERENCE_PROVIDER: "DISABLED",
  CLINIC_OS_BACKUP_PROVIDER: "CLOUD_MANAGED_BACKUP",
  CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "false",
  CLINIC_OS_MANIFEST_VERSION: "v1",
});

test("health/readiness facts are bounded and cloud remains explicitly unavailable", async () => {
  const result = await new StartupReadiness(cloud).evaluate();
  assert.deepEqual(result, {
    status: "not_ready",
    profile: "CLOUD",
    checks: [{ name: "cloud_provider", status: "not_ready", code: "CLOUD_PROVIDER_UNAVAILABLE" }],
  });
  assert.equal(JSON.stringify(result).includes("postgresql"), false);
});

test("synthetic preview has no clinical readiness", async () => {
  const config = validateStartupConfig({ PREVIEW_MODE: "synthetic" });
  assert.deepEqual(await new StartupReadiness(config).evaluate(), {
    status: "not_ready",
    profile: "SYNTHETIC_PREVIEW",
    checks: [{ name: "clinical_runtime", status: "not_ready", code: "SYNTHETIC_PREVIEW" }],
  });
});

test("Hybrid readiness needs every selected dependency and sanitizes probe errors", async () => {
  const config = validateStartupConfig({
    CLINIC_OS_PROFILE: "ON_PREM_HYBRID",
    DATABASE_URL: "postgresql://user:password@db.example/clinic",
    CLINIC_OS_DATABASE_PROVIDER: "LOCAL_POSTGRES",
    CLINIC_OS_FILE_PROVIDER: "LOCAL_OBJECT_STORE",
    CLINIC_OS_INFERENCE_PROVIDER: "DISABLED",
    CLINIC_OS_BACKUP_PROVIDER: "LOCAL_ENCRYPTED_BACKUP",
    CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "false",
    CLINIC_OS_MANIFEST_VERSION: "v1",
    CLINIC_OS_OBJECT_STORE_ROOT: "/var/lib/clinic-os/objects",
  });
  const result = await new StartupReadiness(config, {
    database: async () => { throw new Error("postgresql://user:password@db.example/secret"); },
    objectStore: async () => true,
  }).evaluate();
  assert.deepEqual(result, {
    status: "not_ready",
    profile: "ON_PREM_HYBRID",
    checks: [
      { name: "database", status: "not_ready", code: "DATABASE_UNAVAILABLE" },
      { name: "object_store", status: "ok" },
      { name: "inference_capability", status: "not_ready", code: "INFERENCE_UNAVAILABLE" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /password|postgresql|secret/);
});

test("readiness projection is immutable and does not reuse a probe object", async () => {
  const result = await new StartupReadiness(cloud).evaluate();
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
  assert.equal(Object.isFrozen(result.checks[0]), true);
});

test("configured cloud HTTP is live but cannot fall back to a synthetic clinical API", async () => {
  const instance = createConfiguredPreviewServer({
    CLINIC_OS_PROFILE: "CLOUD",
    DATABASE_URL: "postgresql://user:password@db.example/clinic",
    CLINIC_OS_DATABASE_PROVIDER: "CLOUD_SQL_POSTGRES",
    CLINIC_OS_FILE_PROVIDER: "CLOUD_OBJECT_STORE",
    CLINIC_OS_INFERENCE_PROVIDER: "DISABLED",
    CLINIC_OS_BACKUP_PROVIDER: "CLOUD_MANAGED_BACKUP",
    CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "false",
    CLINIC_OS_MANIFEST_VERSION: "v1",
  });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  try {
    const address = instance.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", profile: "CLOUD" });
    const readiness = await fetch(`${base}/api/readiness`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), {
      status: "not_ready", profile: "CLOUD",
      checks: [{ name: "cloud_provider", status: "not_ready", code: "CLOUD_PROVIDER_UNAVAILABLE" }],
    });
    const bootstrap = await fetch(`${base}/api/employee/bootstrap`);
    assert.equal(bootstrap.status, 503);
    assert.doesNotMatch(await bootstrap.text(), /password|postgresql|db\.example/);
  } finally {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
});
