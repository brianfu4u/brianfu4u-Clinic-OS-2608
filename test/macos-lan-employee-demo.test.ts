import assert from "node:assert/strict";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { configuredLanEmployeeDemo, createPreviewServer, isLoopbackAddress } from "../src/preview/server.ts";

const root = new URL("..", import.meta.url).pathname;
const launcher = join(root, "scripts/start-macos-lan-employee-demo.sh");

test("LAN employee mode requires the exact explicit prepared-demo flag", () => {
  assert.equal(configuredLanEmployeeDemo({}), false);
  assert.equal(configuredLanEmployeeDemo({ CLINIC_OS_LAN_DEMO: "LOCAL_WIFI_DEMO", CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP: "1" }), true);
  assert.throws(() => configuredLanEmployeeDemo({ CLINIC_OS_LAN_DEMO: "LOCAL_WIFI_DEMO" }), (error: any) => error?.code === "INVALID_LAN_DEMO");
  assert.throws(() => configuredLanEmployeeDemo({ CLINIC_OS_LAN_DEMO: "yes", CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP: "1" }), (error: any) => error?.code === "INVALID_LAN_DEMO");
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.0.0.2"), false);
});

test("LAN employee mode rejects manager access from a non-loopback peer", async () => {
  const server = createPreviewServer({ lanEmployeeOnly: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const client = request({ host: "127.0.0.1", port, path: "/api/manager/closures", localAddress: "127.0.0.2" }, (response) => {
        let body = "";
        response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      client.once("error", reject); client.end();
    });
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.body), { error: "LAN_MANAGER_FORBIDDEN", message: "Manager access is available only on this Mac." });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("LAN launcher requires confirmation, protected demo data and a private Wi-Fi address", async () => {
  const source = await readFile(launcher, "utf8");
  assert.match(source, /CLINIC_OS_LAN_DEMO_CONFIRMATION/);
  assert.match(source, /LOCAL_WIFI_DEMO/);
  assert.match(source, /clinic_os_demo/);
  assert.match(source, /192\\\.168/);
  assert.match(source, /CLINIC_OS_LAN_DEMO=LOCAL_WIFI_DEMO/);
  assert.match(source, /PREVIEW_HOST=0\.0\.0\.0/);
  assert.doesNotMatch(source, /curl|nc |ssh|iptables|pfctl|route /);
});

test("local startup consumes secret launcher controls before Node receives its configuration", async () => {
  const source = await readFile(join(root, "scripts/start-macos-local.sh"), "utf8");
  assert.match(source, /TESSDATA_SOURCE_DIR="\/opt\/homebrew\/share\/tessdata"/);
  assert.match(source, /TESSDATA_DIR="\$HOME\/clinic-os-data\/ocr-assets\/tessdata"/);
  assert.match(source, /cp -Lf/);
  const controls = ["CLINIC_OS_DEMO_DATABASE_URL", "CLINIC_OS_PREPARED_DEMO_LAUNCH", "CLINIC_OS_LAN_DEMO_CONFIRMATION"];
  for (const control of controls) {
    const unset = source.indexOf(`unset ${control}`);
    const launch = source.indexOf("exec env");
    assert.ok(unset >= 0 && unset < launch, `${control} must be removed before Node starts`);
  }
});
