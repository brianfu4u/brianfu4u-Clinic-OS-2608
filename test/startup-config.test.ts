import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/domain/errors.ts";
import * as startupConfig from "../src/runtime/startup-config.ts";
import { createConfiguredLocalRuntime, validateStartupConfig } from "../src/runtime/startup-config.ts";

const cloud = (overrides: Record<string, string> = {}) => ({
  CLINIC_OS_PROFILE: "CLOUD",
  DATABASE_URL: "postgresql://user:password@db.example/clinic",
  CLINIC_OS_DATABASE_PROVIDER: "CLOUD_SQL_POSTGRES",
  CLINIC_OS_FILE_PROVIDER: "CLOUD_OBJECT_STORE",
  CLINIC_OS_INFERENCE_PROVIDER: "DISABLED",
  CLINIC_OS_BACKUP_PROVIDER: "CLOUD_MANAGED_BACKUP",
  CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "false",
  CLINIC_OS_MANIFEST_VERSION: "clinic-os-v1",
  ...overrides,
});

test("synthetic mode is explicit and returns only a redacted frozen snapshot", () => {
  const config = validateStartupConfig({ PREVIEW_MODE: "synthetic", PORT: "3010" });
  assert.equal(config.snapshot.profile, "SYNTHETIC_PREVIEW");
  assert.equal(config.port, 3010);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.snapshot), true);
  assert.equal("DATABASE_URL" in config, false);
  assert.equal(JSON.stringify(config).includes("password"), false);
});

test("cloud declaration validates but never exposes secret endpoint or URL", () => {
  const config = validateStartupConfig(cloud({
    CLINIC_OS_INFERENCE_PROVIDER: "PRIVATE_CLOUD_MODEL",
    CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "true",
    CLINIC_OS_PRIVATE_INFERENCE_ENDPOINT: "https://private.example/infer",
    CLINIC_OS_PRIVATE_INFERENCE_MODEL_ID: "model-v1",
    CLINIC_OS_PRIVATE_INFERENCE_MANIFEST_SHA256: "a".repeat(64),
    CLINIC_OS_INFERENCE_CAPABILITIES: "EXTRACT_EYE_EXAM_REPORT",
  }));
  assert.equal(config.snapshot.profile, "CLOUD");
  assert.equal(JSON.stringify(config).includes("private.example"), false);
  assert.equal(JSON.stringify(config).includes("postgresql"), false);
  assert.equal("getStartupPrivateValues" in startupConfig, false);
  assert.equal(createConfiguredLocalRuntime(config), null);
  assert.throws(
    () => createConfiguredLocalRuntime({ ...config } as never),
    (error) => error instanceof DomainError && error.code === "INVALID_STARTUP_CONFIG",
  );
});

test("private inference requires exact authorization and complete metadata", () => {
  assert.throws(
    () => validateStartupConfig(cloud({
      CLINIC_OS_INFERENCE_PROVIDER: "PRIVATE_CLOUD_MODEL",
      CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "yes",
    })),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_INFERENCE_AUTHORIZATION_REQUIRED",
  );
  assert.throws(
    () => validateStartupConfig(cloud({
      CLINIC_OS_INFERENCE_PROVIDER: "PRIVATE_CLOUD_MODEL",
      CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "true",
      CLINIC_OS_INFERENCE_CAPABILITIES: "EXTRACT_EYE_EXAM_REPORT",
    })),
    (error) => error instanceof DomainError && error.code === "PRIVATE_INFERENCE_ENDPOINT_REQUIRED",
  );
});

test("canonical configuration is required and legacy aliases never silently apply", () => {
  assert.throws(() => validateStartupConfig({}), (error) => error instanceof DomainError && error.code === "PROFILE_REQUIRED");
  assert.throws(
    () => validateStartupConfig({ CLINIC_OS_PROFILE: "CLOUD", PREVIEW_OBJECT_STORE_ROOT: "/tmp/objects" }),
    (error) => error instanceof DomainError && error.code === "LEGACY_CONFIGURATION_NAME",
  );
  assert.throws(
    () => validateStartupConfig({ ...cloud(), CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "1" }),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_INFERENCE_AUTHORIZATION_REQUIRED",
  );
  assert.throws(
    () => validateStartupConfig({ ...cloud(), PREVIEW_PORT: "3001" }),
    (error) => error instanceof DomainError && error.code === "LEGACY_CONFIGURATION_NAME",
  );
});

test("profile/provider incompatibility and port bounds fail closed", () => {
  assert.throws(() => validateStartupConfig(cloud({ CLINIC_OS_DATABASE_PROVIDER: "LOCAL_POSTGRES" })), DomainError);
  assert.throws(() => validateStartupConfig(cloud({ PORT: "0" })), (error) => error instanceof DomainError && error.code === "PORT_INVALID");
  assert.throws(() => validateStartupConfig(cloud({ PORT: "65536" })), (error) => error instanceof DomainError && error.code === "PORT_INVALID");
});

test("approved local demo transport settings do not bypass the configuration boundary", () => {
  const config = validateStartupConfig(cloud({
    CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP: "1",
    CLINIC_OS_PREVIEW_WORKSPACE: "EXAM",
    CLINIC_OS_LAN_DEMO: "LOCAL_WIFI_DEMO",
    CLINIC_OS_LAN_ADDRESS: "192.168.1.20",
    PREVIEW_HOST: "0.0.0.0",
  }));
  assert.equal(config.snapshot.profile, "CLOUD");
  assert.throws(
    () => validateStartupConfig(cloud({ CLINIC_OS_DEMO_DATABASE_URL: "postgresql://demo@localhost:5432/clinic_os_demo" })),
    (error) => error instanceof DomainError && error.code === "UNKNOWN_CONFIGURATION_FIELD",
  );
});

test("Strict cannot dilute its declared local OCR capability", () => {
  const strict = {
    CLINIC_OS_PROFILE: "ON_PREM_STRICT",
    DATABASE_URL: "postgresql://user:password@db.example/clinic",
    CLINIC_OS_DATABASE_PROVIDER: "LOCAL_POSTGRES",
    CLINIC_OS_FILE_PROVIDER: "LOCAL_OBJECT_STORE",
    CLINIC_OS_INFERENCE_PROVIDER: "DISABLED",
    CLINIC_OS_BACKUP_PROVIDER: "LOCAL_ENCRYPTED_BACKUP",
    CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "false",
    CLINIC_OS_MANIFEST_VERSION: "clinic-os-v1",
    CLINIC_OS_OBJECT_STORE_ROOT: "/var/lib/clinic-os/objects",
  };
  assert.throws(
    () => validateStartupConfig(strict),
    (error) => error instanceof DomainError && error.code === "STRICT_LOCAL_INFERENCE_REQUIRED",
  );
  assert.throws(
    () => validateStartupConfig({ ...strict, CLINIC_OS_INFERENCE_PROVIDER: "PRIVATE_CLOUD_MODEL" }),
    (error) => error instanceof DomainError && error.code === "STRICT_REMOTE_PROVIDER_FORBIDDEN",
  );
});

test("Hybrid disabled and Cloud declarations are exact, immutable and redacted", () => {
  const hybrid = validateStartupConfig({
    CLINIC_OS_PROFILE: "ON_PREM_HYBRID",
    DATABASE_URL: "postgresql://user:password@db.example/clinic",
    CLINIC_OS_DATABASE_PROVIDER: "LOCAL_POSTGRES",
    CLINIC_OS_FILE_PROVIDER: "LOCAL_OBJECT_STORE",
    CLINIC_OS_INFERENCE_PROVIDER: "DISABLED",
    CLINIC_OS_BACKUP_PROVIDER: "LOCAL_ENCRYPTED_BACKUP",
    CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED: "false",
    CLINIC_OS_MANIFEST_VERSION: "hybrid-v1",
    CLINIC_OS_OBJECT_STORE_ROOT: "/var/lib/clinic-os/objects",
  });
  assert.equal(hybrid.snapshot.profile, "ON_PREM_HYBRID");
  assert.equal(hybrid.snapshot.inferenceCapabilityConfigured, false);
  assert.equal(Object.isFrozen(hybrid.snapshot.capabilities), true);
  assert.equal(JSON.stringify(hybrid.snapshot).includes("/var/lib"), false);
  assert.throws(
    () => validateStartupConfig(cloud({ CLINIC_OS_TYPO_PROVIDER: "LOCAL_MODEL" })),
    (error) => error instanceof DomainError && error.code === "UNKNOWN_CONFIGURATION_FIELD",
  );
});

test("errors retain controlled codes and never echo sensitive input", () => {
  const secretUrl = "postgresql://person:password@db.example/clinic?token=secret";
  assert.throws(
    () => validateStartupConfig(cloud({ DATABASE_URL: secretUrl })),
    (error) => error instanceof DomainError && error.code === "DATABASE_CONFIGURATION_INVALID" &&
      !error.message.includes("password") && !error.message.includes("secret"),
  );
});
