import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { InferenceRequest } from "../src/runtime/contracts.ts";
import {
  FROZEN_TESSERACT_MANIFEST,
  TESSERACT_OCR_MODEL_ID,
  TESSERACT_OCR_SCHEMA_VERSION,
  TesseractOcrProvider,
  TesseractProcessFailure,
  createNodeTesseractProcessRunner,
  parseTesseractTsv,
  validateTesseractCheckedInManifestSync,
} from "../src/runtime/tesseract-ocr-provider.ts";

const CONTEXT: ActorContext = { clinicId: "clinic-1", actorId: "employee-1", role: "EMPLOYEE" };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const TSV_HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";

function request(overrides: Record<string, unknown> = {}): InferenceRequest {
  return {
    requestId: "ocr-1", clinicId: CONTEXT.clinicId,
    capability: "EXTRACT_EYE_EXAM_REPORT", schemaVersion: TESSERACT_OCR_SCHEMA_VERSION,
    input: { bytes: PNG, mediaType: "image/png",
      contentSha256: createHash("sha256").update(PNG).digest("hex"), kind: "EXAM_REPORT" },
    ...overrides,
  };
}

function row(word: string, confidence: string | number = 95): string {
  return `5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t${confidence}\t${word}\n`;
}

function hasCode(expected: string) {
  return (error: unknown) => error instanceof DomainError && error.code === expected;
}

test("invalid request and ActorContext fail before asset access", async () => {
  const provider = new TesseractOcrProvider({
    executablePath: "/definitely-missing/tesseract", tessdataDir: "/definitely-missing/tessdata",
  });
  for (const [context, value] of [
    [CONTEXT, request({ capability: "OTHER" })],
    [CONTEXT, request({ schemaVersion: "other" })],
    [CONTEXT, request({ input: { ...(request().input as object), contentSha256: "0".repeat(64) } })],
    [{ ...CONTEXT, actorId: "" }, request()],
    [{ ...CONTEXT, role: "PATIENT" }, request()],
    [{ ...CONTEXT, extra: true }, request()],
  ] as Array<[ActorContext, InferenceRequest]>) {
    await assert.rejects(provider.infer(context, value), (error: unknown) =>
      error instanceof DomainError && error.code !== "OCR_MODEL_UNAVAILABLE");
  }
  let traps = 0;
  const proxy = new Proxy(request(), { ownKeys() { traps += 1; throw new Error("trap"); } });
  await assert.rejects(provider.infer(CONTEXT, proxy), hasCode("OCR_INVALID_REQUEST"));
  assert.equal(traps, 0);
});

test("production config rejects runner and manifest trust injection", () => {
  const base = { executablePath: "/usr/bin/tesseract", tessdataDir: "/usr/share/tesseract-ocr/5/tessdata" };
  for (const config of [
    { ...base, runner: { run() {} } },
    { ...base, manifest: { executableSha256: "0".repeat(64) } },
    { ...base, executablePath: "/usr/bin/../bin/tesseract" },
  ]) assert.throws(() => new TesseractOcrProvider(config as never), hasCode("OCR_MODEL_UNAVAILABLE"));
  assert.equal(Object.isFrozen(FROZEN_TESSERACT_MANIFEST), true);
  assert.equal(FROZEN_TESSERACT_MANIFEST.modelId, TESSERACT_OCR_MODEL_ID);
  assert.equal(FROZEN_TESSERACT_MANIFEST.minimumHardware, "x86_64 CPU; 512 MiB available memory");
  assert.equal(FROZEN_TESSERACT_MANIFEST.offlinePackageReference, "clinic-os-tesseract-eng-v1");
});

test("checked-in Tesseract manifest is exact, hashed and fail-closed on mutation or replacement", async (t) => {
  const source = new URL("../models/tesseract-eng-v1.manifest.json", import.meta.url);
  // /tmp is intentionally world-writable and therefore rejected by the same
  // complete-ancestry gate used in production. A user-owned home directory is
  // also trusted when its ancestry is not group/world writable, so it keeps
  // this positive-path fixture portable to macOS without weakening the gate.
  const root = await mkdtemp(join(homedir(), "clinic-os-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = join(root, "models", "tesseract-eng-v1.manifest.json");
  await mkdir(join(root, "models"), { recursive: true });
  await copyFile(source, valid);
  assert.doesNotThrow(() => validateTesseractCheckedInManifestSync(valid));

  await writeFile(valid, `${await readFile(valid, "utf8")}\n`);
  assert.throws(() => validateTesseractCheckedInManifestSync(valid), hasCode("OCR_MODEL_INTEGRITY_FAILED"));

  const missing = join(root, "missing", "tesseract-eng-v1.manifest.json");
  assert.throws(() => validateTesseractCheckedInManifestSync(missing),
    (error) => error instanceof DomainError && ["OCR_MODEL_UNAVAILABLE", "OCR_MODEL_INTEGRITY_FAILED"].includes(error.code));

  const replaced = join(root, "replaced", "tesseract-eng-v1.manifest.json");
  await mkdir(join(root, "replaced"), { recursive: true });
  await symlink(source, replaced);
  assert.throws(() => validateTesseractCheckedInManifestSync(replaced),
    (error) => error instanceof DomainError && ["OCR_MODEL_UNAVAILABLE", "OCR_MODEL_INTEGRITY_FAILED"].includes(error.code));
});

test("TSV parser recognizes bounded markers and derives confidence", () => {
  assert.deepEqual(parseTesseractTsv(new TextEncoder().encode(
    TSV_HEADER + row("EYE", "96.5") + row("EXAM", "95") + row("REPORT", "93.5"),
  )), {
    subjectTypeCandidate: "PATIENT", workflowFamilyCandidate: "EYE_EXAM",
    fields: { ocrText: "EYE EXAM REPORT", reportType: "EYE_EXAM" },
    missingFields: [], confidence: 0.95,
  });
  assert.deepEqual(parseTesseractTsv(new TextEncoder().encode(TSV_HEADER + row("UNMARKED"))), {
    subjectTypeCandidate: "PATIENT", workflowFamilyCandidate: "EYE_EXAM",
    fields: { ocrText: "UNMARKED", reportType: null },
    missingFields: ["reportType"], confidence: 0.95,
  });
});

test("TSV parser rejects malformed output and non-decimal confidence", () => {
  for (const output of ["not tsv", TSV_HEADER + row("EYE", "101"),
    TSV_HEADER + row("EYE", "0x10"), TSV_HEADER + row("EYE", "1e2"),
    TSV_HEADER + row("EYE", " 95"), TSV_HEADER + row("EYE", ""),
    TSV_HEADER + row("EYE\0EXAM")]) {
    assert.throws(() => parseTesseractTsv(new TextEncoder().encode(output)), hasCode("OCR_INVALID_OUTPUT"));
  }
});

test("node runner fixes process shape and escalates TERM to KILL", async () => {
  const calls: unknown[] = [];
  const signals: string[] = [];
  const fakeSpawn = ((executable: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ executable, args, options });
    const child = fakeChild();
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
      return true;
    };
    return child;
  }) as unknown as Parameters<typeof createNodeTesseractProcessRunner>[0];
  await assert.rejects(createNodeTesseractProcessRunner(fakeSpawn).run({
    executable: "/fixed/tesseract", args: ["stdin", "stdout"], input: PNG,
    timeoutMs: 5, maxOutputBytes: 1024,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "TIMEOUT");
  assert.deepEqual(calls, [{ executable: "/fixed/tesseract", args: ["stdin", "stdout"],
    options: { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C" } } }]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("node runner bounds kill failure, stdin error and abort race", async () => {
  for (const behavior of ["false", "throw"] as const) {
    const signals: string[] = [];
    const child = fakeChild();
    child.kill = (signal) => { signals.push(signal); if (behavior === "throw") throw new Error(); return false; };
    await assert.rejects(createNodeTesseractProcessRunner((() => child) as never).run({
      executable: "/x", args: [], input: PNG, timeoutMs: 5, maxOutputBytes: 10,
    }), (error) => error instanceof TesseractProcessFailure && error.code === "TIMEOUT");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(child.listenerCount("close"), 0);
  }
  const stdinChild = fakeChild();
  stdinChild.kill = () => { queueMicrotask(() => stdinChild.emit("close", null)); return true; };
  queueMicrotask(() => stdinChild.stdin.emit("error", new Error("private")));
  await assert.rejects(createNodeTesseractProcessRunner((() => stdinChild) as never).run({
    executable: "/x", args: [], input: PNG, timeoutMs: 1_000, maxOutputBytes: 10,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "SPAWN_FAILED");

  let reads = 0;
  const signal = { get aborted() { reads += 1; return reads >= 2; },
    addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
  const abortChild = fakeChild();
  abortChild.kill = () => { queueMicrotask(() => abortChild.emit("close", null)); return true; };
  await assert.rejects(createNodeTesseractProcessRunner((() => abortChild) as never).run({
    executable: "/x", args: [], input: PNG, timeoutMs: 1_000, maxOutputBytes: 10, signal,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "ABORTED");
  assert.equal(reads, 2);
});

test("provider source has no network, repository or test trust seam", async () => {
  const source = await readFile(new URL("../src/runtime/tesseract-ocr-provider.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /https?:|fetch\(|Workflow|Expectation|Repository|ForTest|testTrust|config\.runner/);
});

function fakeChild(): EventEmitter & {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(signal: string): boolean;
} {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}
