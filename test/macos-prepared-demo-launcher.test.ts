import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const launcher = join(root, "scripts/start-macos-prepared-demo.sh");

test("prepared macOS launcher refuses an unsafe target before it can invoke startup", async () => {
  const tools = await fakeTools();
  try {
    const result = spawnSync("/bin/bash", [launcher], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, USER: "demo", PATH: `${tools.bin}:/usr/bin:/bin`, CLINIC_OS_DEMO_DATABASE_URL: "postgresql://demo@localhost:5432/clinic_os_local" },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "PREPARED_DEMO_LAUNCH_REFUSED\n");
    assert.equal(result.stderr, "");
    assert.equal(result.error, undefined);
  } finally { await tools.dispose(); }
});

test("prepared macOS launcher delegates only to existing startup with non-mutating prepared environment", async () => {
  const tools = await fakeTools();
  const home = await mkdtemp(join(tmpdir(), "clinic-os-prepared-home-"));
  const objectRoot = join(home, "clinic-os-data", "demo-objects");
  const capture = join(home, "capture");
  await mkdir(objectRoot, { recursive: true });
  try {
    const result = spawnSync("/bin/bash", [launcher], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env, USER: "demo", HOME: home, PATH: `${tools.bin}:/usr/bin:/bin`, CAPTURE: capture,
        CLINIC_OS_DEMO_DATABASE_URL: "postgresql://demo@localhost:5432/clinic_os_demo",
      },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "PREPARED_DEMO_LAUNCH_UNAVAILABLE\n");
    assert.equal(await readFile(capture, "utf8"), "1:1:postgresql://demo@localhost:5432/clinic_os_demo\n");
  } finally {
    await rm(home, { recursive: true, force: true });
    await tools.dispose();
  }
});

test("prepared launcher has no preparation command and filters child output to loopback URLs", async () => {
  const source = await readFile(launcher, "utf8");
  assert.doesNotMatch(source, /\b(reset|seed|migrate|createdb|dropdb|rm|mkdir|chmod|curl|brew|npm)\b/i);
  assert.match(source, /CLINIC_OS_PREPARED_DEMO_LAUNCH=1/);
  assert.match(source, /127\\\.0\\\.0\\\.1:3000\\\/employee/);
  assert.match(source, /127\\\.0\\\.0\\\.1:3000\\\/manager/);
  const startup = await readFile(join(root, "scripts/start-macos-local.sh"), "utf8");
  assert.match(startup, /CLINIC_OS_PREPARED_DEMO_LAUNCH:-\}" != "1"/);
});

async function fakeTools(): Promise<{ bin: string; dispose(): Promise<void> }> {
  const bin = await mkdtemp(join(tmpdir(), "clinic-os-prepared-bin-"));
  await executable(bin, "uname", "#!/bin/sh\n[ \"$1\" = \"-s\" ] && echo Darwin || echo arm64\n");
  await executable(bin, "stat", "#!/bin/sh\necho \"$USER:700\"\n");
  await executable(bin, "bash", "#!/bin/sh\nprintf '%s:%s:%s\\n' \"$CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP\" \"$CLINIC_OS_PREPARED_DEMO_LAUNCH\" \"$CLINIC_OS_DEMO_DATABASE_URL\" > \"$CAPTURE\"\nexit 1\n");
  return { bin, dispose: () => rm(bin, { recursive: true, force: true }) };
}

async function executable(directory: string, name: string, body: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
}
