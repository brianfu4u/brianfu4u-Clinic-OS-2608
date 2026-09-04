import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("multi-role demo launcher is explicit, bounded and keeps manager local", async () => {
  const source = await readFile(join(root, "scripts/start-macos-multi-role-demo.sh"), "utf8");
  assert.match(source, /CLINIC_OS_LAN_DEMO_CONFIRMATION/);
  assert.match(source, /clinic_os_demo/);
  assert.match(source, /CLINIC_OS_PREVIEW_WORKSPACE/);
  assert.match(source, /start_workspace RECEPTION 3001 0\.0\.0\.0 LOCAL_WIFI_DEMO/);
  assert.match(source, /start_workspace DOCTOR 3002 0\.0\.0\.0 LOCAL_WIFI_DEMO/);
  assert.match(source, /start_workspace EXAM 3003 0\.0\.0\.0 LOCAL_WIFI_DEMO/);
  assert.match(source, /start_workspace CASHIER 3004 0\.0\.0\.0 LOCAL_WIFI_DEMO/);
  assert.match(source, /start_workspace RECEPTION 3000 127\.0\.0\.1 ""/);
  assert.match(source, /trap cleanup EXIT INT TERM/);
  assert.doesNotMatch(source, /reset|migrate|seed|createdb|dropdb|curl|ssh|route |pfctl/i);
});
