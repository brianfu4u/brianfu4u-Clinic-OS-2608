import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  AcceptanceError, assertDatabaseIdentities, installSignalCancellation, loadConfig,
  resetPublicSchema, runBinary,
} from "../acceptance/real-postgres.ts";

function hasCode(code: string) {
  return (error: unknown) => error instanceof AcceptanceError && error.code === code;
}

test("real PostgreSQL gate requires all explicit URLs before any connection", () => {
  assert.throws(() => loadConfig({}), hasCode("ENVIRONMENT_REQUIRED"));
  assert.throws(() => loadConfig({
    WO018_ALLOW_DESTRUCTIVE_RESET: "I_UNDERSTAND_WO018_DATABASES_WILL_BE_DROPPED",
  }), hasCode("ENVIRONMENT_REQUIRED"));
});

test("real PostgreSQL gate rejects unsafe or same database names before any connection", () => {
  const base = {
    WO018_ALLOW_DESTRUCTIVE_RESET: "I_UNDERSTAND_WO018_DATABASES_WILL_BE_DROPPED",
    WO018_SOURCE_ADMIN_URL: "postgresql://admin:a@db/source_wo018_acceptance",
    WO018_SOURCE_APP_URL: "postgresql://app:a@db/source_wo018_acceptance",
    WO018_RESTORE_ADMIN_URL: "postgresql://admin:b@db/restore_wo018_acceptance",
    WO018_RESTORE_APP_URL: "postgresql://app:b@db/restore_wo018_acceptance",
  };
  const { WO018_ALLOW_DESTRUCTIVE_RESET: _confirmation, ...unconfirmed } = base;
  assert.throws(() => loadConfig(unconfirmed), hasCode("DESTRUCTIVE_CONFIRMATION_REQUIRED"));
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base,
    WO018_RESTORE_ADMIN_URL: "postgresql://admin:b@db/production",
  }), hasCode("UNSAFE_DATABASE_NAME"));
  assert.doesNotThrow(() => loadConfig({ ...base,
    WO018_RESTORE_ADMIN_URL: base.WO018_SOURCE_ADMIN_URL,
    WO018_RESTORE_APP_URL: base.WO018_SOURCE_APP_URL,
  }));
});

test("real PostgreSQL gate compares connected database identities and major versions", async () => {
  const pool = (system_identifier: string, database_oid: string, version = "160000") => ({
    query: async () => ({ rows: [{ system_identifier, database_oid, version }] }),
  });
  await assert.rejects(assertDatabaseIdentities(
    pool("server", "1") as never, pool("server", "1") as never,
    pool("server", "1") as never, pool("server", "1") as never,
  ), hasCode("DATABASES_MUST_DIFFER"));
  await assert.rejects(assertDatabaseIdentities(
    pool("server", "1") as never, pool("server", "2") as never,
    pool("server", "3") as never, pool("server", "3") as never,
  ), hasCode("ROLE_DATABASE_MISMATCH"));
  await assert.rejects(assertDatabaseIdentities(
    pool("server", "1") as never, pool("server", "1") as never,
    pool("server", "2", "170000") as never, pool("server", "2", "170000") as never,
  ), hasCode("POSTGRES_VERSION_MISMATCH"));
  assert.deepEqual(await assertDatabaseIdentities(
    pool("server", "1") as never, pool("server", "1") as never,
    pool("server", "2") as never, pool("server", "2") as never,
  ), { sourceMajor: 16, restoreMajor: 16 });
});

test("public schema reset commits atomically and rolls back failures", async () => {
  const statements: string[] = [];
  const client = {
    query: async (text: string) => {
      statements.push(text);
      if (text === "CREATE SCHEMA public") throw new Error("synthetic");
    },
    release() {},
  };
  await assert.rejects(resetPublicSchema({ connect: async () => client } as never));
  assert.deepEqual(statements, [
    "SET statement_timeout = '15s'", "SET lock_timeout = '3s'", "BEGIN",
    "DROP SCHEMA public CASCADE", "CREATE SCHEMA public", "ROLLBACK",
  ]);
});

test("signal coordination aborts once and removes listeners without exiting", () => {
  const emitter = new EventEmitter();
  const controller = new AbortController();
  const cancellation = installSignalCancellation(controller, emitter);
  emitter.emit("SIGTERM");
  emitter.emit("SIGINT");
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancellation.exitCode, 143);
  cancellation.dispose();
  assert.equal(emitter.listenerCount("SIGTERM"), 0);
  assert.equal(emitter.listenerCount("SIGINT"), 0);
});

test("binary runner kills and awaits children on abort and timeout", async () => {
  const url = "postgresql://unused:unused@localhost/unused";
  const controller = new AbortController();
  const aborted = runBinary(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], url,
    controller.signal, 5_000);
  controller.abort();
  await assert.rejects(aborted, hasCode("POSTGRES_BINARY_ABORTED"));
  await assert.rejects(
    runBinary(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], url, undefined, 20),
    hasCode("POSTGRES_BINARY_TIMEOUT"),
  );
});
