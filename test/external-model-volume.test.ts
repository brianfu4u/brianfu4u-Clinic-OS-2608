import assert from "node:assert/strict";
import test from "node:test";

import { inspectExternalModelVolumeRootSync, type ExternalModelVolumeFilesystem } from "../src/runtime/external-model-volume.ts";

type FakeStat = Readonly<{ dev: number; uid: number; mode: number; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
const directory = (dev: number, overrides: Partial<Pick<FakeStat, "uid" | "mode" | "isSymbolicLink">> = {}): FakeStat => Object.freeze({
  dev, uid: overrides.uid ?? 501, mode: overrides.mode ?? 0o40700,
  isDirectory: () => true, isSymbolicLink: overrides.isSymbolicLink ?? (() => false),
});

function filesystem(entries: Record<string, FakeStat>): ExternalModelVolumeFilesystem {
  return Object.freeze({
    geteuid: () => 501,
    lstatSync: (path) => {
      const value = entries[path];
      if (!value) throw new Error("missing");
      return value as never;
    },
  });
}

test("external model volume accepts only a protected distinct mounted root", () => {
  const fs = filesystem({
    "/Volumes/ClinicModels": directory(9), "/Volumes": directory(1), "/": directory(1, { uid: 0, mode: 0o40755 }),
  });
  assert.equal(inspectExternalModelVolumeRootSync("/Volumes/ClinicModels", fs), true);
});

test("external model volume fails closed for absent, relative, symlinked, unsafe and unmounted roots", () => {
  const safe = { "/Volumes": directory(1), "/": directory(1, { uid: 0, mode: 0o40755 }) };
  assert.equal(inspectExternalModelVolumeRootSync(undefined, filesystem(safe)), false);
  assert.equal(inspectExternalModelVolumeRootSync("Volumes/ClinicModels", filesystem(safe)), false);
  assert.equal(inspectExternalModelVolumeRootSync("/Volumes/ClinicModels", filesystem({
    ...safe, "/Volumes/ClinicModels": directory(9, { isSymbolicLink: () => true }),
  })), false);
  assert.equal(inspectExternalModelVolumeRootSync("/Volumes/ClinicModels", filesystem({
    ...safe, "/Volumes/ClinicModels": directory(9, { mode: 0o40722 }),
  })), false);
  assert.equal(inspectExternalModelVolumeRootSync("/Volumes/ClinicModels", filesystem({
    ...safe, "/Volumes/ClinicModels": directory(1),
  })), false);
});
