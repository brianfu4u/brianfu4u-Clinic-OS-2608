import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceError, loadConfig } from "../acceptance/real-postgres.ts";

function hasCode(code: string) {
  return (error: unknown) => error instanceof AcceptanceError && error.code === code;
}

test("real PostgreSQL gate requires all explicit URLs before any connection", () => {
  assert.throws(() => loadConfig({}), hasCode("ENVIRONMENT_REQUIRED"));
});

test("real PostgreSQL gate rejects unsafe or same database names before any connection", () => {
  const base = {
    WO018_SOURCE_ADMIN_URL: "postgresql://admin:a@db/source_wo018_acceptance",
    WO018_SOURCE_APP_URL: "postgresql://app:a@db/source_wo018_acceptance",
    WO018_RESTORE_ADMIN_URL: "postgresql://admin:b@db/restore_wo018_acceptance",
    WO018_RESTORE_APP_URL: "postgresql://app:b@db/restore_wo018_acceptance",
  };
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base,
    WO018_RESTORE_ADMIN_URL: "postgresql://admin:b@db/production",
  }), hasCode("UNSAFE_DATABASE_NAME"));
  assert.throws(() => loadConfig({ ...base,
    WO018_RESTORE_ADMIN_URL: base.WO018_SOURCE_ADMIN_URL,
    WO018_RESTORE_APP_URL: base.WO018_SOURCE_APP_URL,
  }), hasCode("DATABASES_MUST_DIFFER"));
});
