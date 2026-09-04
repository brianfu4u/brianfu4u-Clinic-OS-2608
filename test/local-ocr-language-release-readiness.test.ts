import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectLocalOcrLanguageReleaseRecords } from "../src/runtime/local-ocr-language-release-record.ts";

const RECORD = (language: "chi_sim" | "jpn", decision: "APPROVED" | "REJECTED" = "APPROVED") => JSON.stringify({
  language, totalCases: 1, passedCases: 1, failedCases: 0, averageCerBasisPoints: 0,
  decision, decidedAt: "2026-09-01T12:00:00.000Z",
});

test("release readiness exposes only exact approved optional-language records", async (t) => {
  const root = await directory(t);
  await writeFile(join(root, "chi_sim.json"), RECORD("chi_sim"), { mode: 0o600 });
  await writeFile(join(root, "jpn.json"), RECORD("jpn", "REJECTED"), { mode: 0o600 });
  assert.deepEqual(inspectLocalOcrLanguageReleaseRecords(root), { chiSim: true, jpn: false });
  assert.doesNotMatch(JSON.stringify(inspectLocalOcrLanguageReleaseRecords(root)), /decidedAt|average|path|record|2026/i);
});

test("release readiness fails closed for missing, malformed and unsafe local records", async (t) => {
  const root = await directory(t);
  assert.deepEqual(inspectLocalOcrLanguageReleaseRecords(root), { chiSim: false, jpn: false });
  await writeFile(join(root, "chi_sim.json"), "{}", { mode: 0o600 });
  assert.deepEqual(inspectLocalOcrLanguageReleaseRecords(root), { chiSim: false, jpn: false });
  await rm(join(root, "chi_sim.json"));
  const target = join(root, "target.json");
  await writeFile(target, RECORD("chi_sim"), { mode: 0o600 });
  await symlink(target, join(root, "chi_sim.json"));
  assert.deepEqual(inspectLocalOcrLanguageReleaseRecords(root), { chiSim: false, jpn: false });
  await rm(join(root, "chi_sim.json"));
  await writeFile(join(root, "chi_sim.json"), RECORD("chi_sim"), { mode: 0o600 });
  await chmod(root, 0o722);
  assert.deepEqual(inspectLocalOcrLanguageReleaseRecords(root), { chiSim: false, jpn: false });
});

async function directory(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(homedir(), "clinic-os-release-readiness-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
