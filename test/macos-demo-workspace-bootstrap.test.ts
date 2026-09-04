import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDedicatedMacosDemoDatabase,
  MACOS_DEMO_CONFIRMATION,
  prepareMacosDemoWorkspace,
  runFiveSyntheticDemoCases,
} from "../scripts/macos-demo-workspace-bootstrap.ts";
import { DomainError } from "../src/domain/errors.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const good = "postgresql://demo@localhost:5432/clinic_os_demo";
const refused = (error: unknown) => error instanceof DomainError && error.code === "MACOS_DEMO_DATABASE_REFUSED";

test("macOS demo bootstrap only admits the exact confirmed dedicated local database", () => {
  assert.equal(assertDedicatedMacosDemoDatabase(good, MACOS_DEMO_CONFIRMATION), good);
  for (const value of [
    "postgresql://demo@localhost:5432/clinic_os_local", "postgresql://demo@db.example:5432/clinic_os_demo",
    "postgresql://demo@localhost:5433/clinic_os_demo", "postgresql://demo@localhost:5432/clinic_os_demo?sslmode=require",
    "postgresql://demo:secret@localhost:5432/clinic_os_demo",
  ]) assert.throws(() => assertDedicatedMacosDemoDatabase(value, MACOS_DEMO_CONFIRMATION), refused);
  assert.throws(() => assertDedicatedMacosDemoDatabase(good, "yes"), refused);
});

test("macOS demo bootstrap refuses before reset, seed, or launch", async () => {
  let called = false;
  await assert.rejects(
    prepareMacosDemoWorkspace({ databaseUrl: "postgresql://demo@localhost:5432/clinic_os_local", confirmation: MACOS_DEMO_CONFIRMATION }, {
      reset: async () => { called = true; }, seed: async () => { called = true; }, launch: async () => { called = true; },
    }),
    refused,
  );
  assert.equal(called, false);
});

test("macOS demo bootstrap runs reset then seed and has bounded success output", async () => {
  const calls: string[] = [];
  const summary = await prepareMacosDemoWorkspace({ databaseUrl: good, confirmation: MACOS_DEMO_CONFIRMATION, launch: false }, {
    reset: async () => { calls.push("reset"); }, seed: async () => { calls.push("seed"); },
  });
  assert.deepEqual(calls, ["reset", "seed"]);
  assert.deepEqual(summary, { status: "PREPARED", cases: 5 });
  assert.doesNotMatch(JSON.stringify(summary), /postgres|demo-|path|object|model/i);
});

test("five synthetic cases have a fixed ordered plan and a reset rerun repeats exactly that plan", async () => {
  const calls: string[] = [];
  const seeder = {
    open: async (anchor: string, key: string, at: Date) => { calls.push(`OPEN:${anchor}:${key}:${at.toISOString()}`); },
    closed: async (anchor: string, key: string, at: Date, replay: boolean) => { calls.push(`CLOSED:${anchor}:${key}:${replay}:${at.toISOString()}`); },
  };
  await runFiveSyntheticDemoCases(seeder, Date.parse("2026-09-01T10:00:00.000Z"));
  await runFiveSyntheticDemoCases(seeder, Date.parse("2026-09-01T10:00:00.000Z"));
  assert.deepEqual(calls, [
    "CLOSED:DEMO-FIVE-01:one:false:2026-09-01T09:50:00.000Z",
    "CLOSED:DEMO-FIVE-05:five:true:2026-09-01T09:50:00.000Z",
    "OPEN:DEMO-FIVE-02:two:2026-09-01T09:50:00.000Z",
    "OPEN:DEMO-FIVE-03:three:2026-09-01T08:20:00.000Z",
    "OPEN:DEMO-FIVE-04:four:2026-09-01T09:50:00.000Z",
    "CLOSED:DEMO-FIVE-01:one:false:2026-09-01T09:50:00.000Z",
    "CLOSED:DEMO-FIVE-05:five:true:2026-09-01T09:50:00.000Z",
    "OPEN:DEMO-FIVE-02:two:2026-09-01T09:50:00.000Z",
    "OPEN:DEMO-FIVE-03:three:2026-09-01T08:20:00.000Z",
    "OPEN:DEMO-FIVE-04:four:2026-09-01T09:50:00.000Z",
  ]);
});

test("CLI permits an explicit prepare-only local demo and reports only a bounded failure stage", async () => {
  const source = await readFile(join(new URL("..", import.meta.url).pathname, "scripts/macos-demo-workspace-bootstrap.ts"), "utf8");
  assert.match(source, /CLINIC_OS_DEMO_NO_LAUNCH !== "1"/);
  assert.match(source, /DATABASE_RESET/);
  assert.match(source, /DEMO_SEED/);
  assert.match(source, /PREVIEW_START/);
  assert.match(source, /DATABASE_OR_STORAGE_FAILURE/);
  assert.doesNotMatch(source, /error\.message|String\(error\)/);
});

test("closed demo cases place the manager decision after the payment verification snapshot", async () => {
  const source = await readFile(join(new URL("..", import.meta.url).pathname, "scripts/macos-demo-workspace-bootstrap.ts"), "utf8");
  assert.match(source, /Date\.parse\(paymentAt\) \+ 2/);
  assert.match(source, /receivedAt: decisionAt/);
});
