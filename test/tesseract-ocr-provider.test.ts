import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { InferenceRequest } from "../src/runtime/contracts.ts";
import { InferenceGateway } from "../src/runtime/inference-gateway.ts";
import {
  TESSERACT_OCR_MODEL_ID,
  TESSERACT_OCR_SCHEMA_VERSION,
  TesseractOcrProvider,
  TesseractProcessFailure,
  createNodeTesseractProcessRunner,
  FROZEN_TESSERACT_MANIFEST,
  validateFrozenTesseractAssetsForTest,
  type TesseractProcessInvocation,
  type TesseractProcessResult,
  type TesseractProcessRunner,
} from "../src/runtime/tesseract-ocr-provider.ts";

const CONTEXT: ActorContext = { clinicId: "clinic-1", actorId: "employee-1", role: "EMPLOYEE" };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const VERSION = "tesseract 5.3.4\n leptonica-1.82.0\n";
const TSV_HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function row(word: string, confidence = 95): string {
  return `5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t${confidence}\t${word}\n`;
}

class FixtureRunner implements TesseractProcessRunner {
  invocations: TesseractProcessInvocation[] = [];
  output = TSV_HEADER + row("EYE") + row("EXAM") + row("REPORT");
  failure: unknown = null;
  exitCode = 0;
  versionExitCode = 0;

  async run(invocation: TesseractProcessInvocation): Promise<TesseractProcessResult> {
    this.invocations.push(structuredClone(invocation));
    if (this.failure) throw this.failure;
    return {
      exitCode: invocation.args[0] === "--version" ? this.versionExitCode : this.exitCode,
      stdout: new TextEncoder().encode(invocation.args[0] === "--version" ? VERSION : this.output),
      stderr: new Uint8Array(),
    };
  }
}

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "clinic-os-tesseract-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "tesseract");
  const tessdata = join(root, "tessdata");
  const engPath = join(tessdata, "eng.traineddata");
  const configs = join(tessdata, "configs");
  const tsvPath = join(configs, "tsv");
  await mkdir(tessdata);
  await mkdir(configs);
  await writeFile(executable, await readFile("/usr/bin/tesseract"));
  await writeFile(engPath, await readFile("/usr/share/tesseract-ocr/5/tessdata/eng.traineddata"));
  await writeFile(tsvPath, await readFile("/usr/share/tesseract-ocr/5/tessdata/configs/tsv"));
  const runner = new FixtureRunner();
  const provider = new TesseractOcrProvider({
    executablePath: executable,
    tessdataDir: tessdata,
    runner,
    timeoutMs: 1_000,
  });
  return { root, executable, tessdata, engPath, tsvPath, runner, provider };
}

function request(overrides: Record<string, unknown> = {}): InferenceRequest {
  return {
    requestId: "ocr-1",
    clinicId: CONTEXT.clinicId,
    capability: "EXTRACT_EYE_EXAM_REPORT",
    schemaVersion: TESSERACT_OCR_SCHEMA_VERSION,
    input: {
      bytes: PNG,
      mediaType: "image/png",
      contentSha256: hash(PNG),
      kind: "EXAM_REPORT",
    },
    ...overrides,
  };
}

function code(expected: string) {
  return (error: unknown) => error instanceof DomainError && error.code === expected &&
    !/\/tmp|tessdata|EYE EXAM REPORT|stderr|clinic-1/.test(error.message);
}

test("exact request gates recompute content hash and reject media magic mismatch", async (t) => {
  const { provider, runner } = await setup(t);
  for (const invalid of [
    request({ capability: "OTHER" }),
    request({ schemaVersion: "other" }),
    request({ input: { ...(request().input as object), contentSha256: "0".repeat(64) } }),
    request({ input: { ...(request().input as object), mediaType: "image/jpeg" } }),
    { ...request(), extra: true },
  ]) {
    await assert.rejects(provider.infer(CONTEXT, invalid as InferenceRequest), code("OCR_INVALID_REQUEST"));
  }
  assert.equal(runner.invocations.length, 0);
});

test("fixed invocation uses version check then stdin-only English TSV OCR arguments", async (t) => {
  const { provider, runner, executable } = await setup(t);
  const response = await provider.infer(CONTEXT, request());
  assert.equal(response.modelId, TESSERACT_OCR_MODEL_ID);
  assert.deepEqual(runner.invocations.map(({ executable: path, args }) => ({ path, args })), [
    { path: executable, args: ["--version"] },
    { path: executable, args: ["stdin", "stdout", "--tessdata-dir", join(executable, "..", "tessdata").replace("/tesseract/..", ""), "-l", "eng", "--psm", "6", "tsv"] },
  ]);
  assert.deepEqual(runner.invocations[1].input, PNG);
  assert.equal(JSON.stringify(runner.invocations).includes("PATH"), false);
});

test("recognized and missing report markers produce bounded deterministic candidates", async (t) => {
  const { provider, runner } = await setup(t);
  const recognized = (await provider.infer(CONTEXT, request())).output as Record<string, unknown>;
  assert.deepEqual(recognized, {
    subjectTypeCandidate: "PATIENT",
    workflowFamilyCandidate: "EYE_EXAM",
    fields: { ocrText: "EYE EXAM REPORT", reportType: "EYE_EXAM" },
    missingFields: [],
    confidence: 0.95,
  });
  runner.output = TSV_HEADER + row("UNMARKED") + row("DOCUMENT");
  const missing = (await provider.infer(CONTEXT, request())).output as Record<string, unknown>;
  assert.deepEqual(missing, {
    subjectTypeCandidate: "PATIENT",
    workflowFamilyCandidate: "EYE_EXAM",
    fields: { ocrText: "UNMARKED DOCUMENT", reportType: null },
    missingFields: ["reportType"],
    confidence: 0.95,
  });
});

test("manifest, binary and model mutation are checked before every inference", async (t) => {
  const { provider, runner, executable, engPath } = await setup(t);
  await provider.infer(CONTEXT, request());
  await writeFile(engPath, "mutated");
  await assert.rejects(provider.infer(CONTEXT, request()), code("OCR_MODEL_INTEGRITY_FAILED"));
  await writeFile(engPath, await readFile("/usr/share/tesseract-ocr/5/tessdata/eng.traineddata"));
  await writeFile(executable, "mutated");
  await assert.rejects(provider.infer(CONTEXT, request()), code("OCR_MODEL_INTEGRITY_FAILED"));
  assert.equal(runner.invocations.length, 2);
});

test("asset owners, permissions and directory path identity fail closed", async (t) => {
  const unsafeFile = await setup(t);
  await chmod(unsafeFile.engPath, 0o666);
  await assert.rejects(unsafeFile.provider.infer(CONTEXT, request()), code("OCR_MODEL_INTEGRITY_FAILED"));
  assert.equal(unsafeFile.runner.invocations.length, 0);

  const unsafeDirectory = await setup(t);
  await chmod(unsafeDirectory.tessdata, 0o777);
  await assert.rejects(unsafeDirectory.provider.infer(CONTEXT, request()), code("OCR_MODEL_INTEGRITY_FAILED"));

  const swapped = await setup(t);
  const displaced = join(swapped.root, "displaced-tessdata");
  const outside = join(swapped.root, "outside");
  await mkdir(outside);
  await assert.rejects(validateFrozenTesseractAssetsForTest({
    executablePath: swapped.executable,
    tessdataDir: swapped.tessdata,
  }, async () => {
      await rename(swapped.tessdata, displaced);
      await symlink(outside, swapped.tessdata);
    }), code("OCR_MODEL_INTEGRITY_FAILED"));
  assert.equal(swapped.runner.invocations.length, 0);

  const fileSwap = await setup(t);
  const displacedFile = join(fileSwap.root, "displaced-eng");
  await assert.rejects(validateFrozenTesseractAssetsForTest({
    executablePath: fileSwap.executable,
    tessdataDir: fileSwap.tessdata,
  }, async () => {
    await rename(fileSwap.engPath, displacedFile);
    await writeFile(fileSwap.engPath, await readFile("/usr/share/tesseract-ocr/5/tessdata/eng.traineddata"));
  }), code("OCR_MODEL_INTEGRITY_FAILED"));
});

test("unknown manifest fields and identity mutations fail closed", async (t) => {
  const { root } = await setup(t);
  const { provider } = await setup(t);
  assert.throws(() => Object.defineProperty(provider, "modelId", { value: "mutated" }));
  assert.throws(() => new TesseractOcrProvider({
    executablePath: join(root, "tesseract"), tessdataDir: join(root, "tessdata"),
    runner: new FixtureRunner(), manifest: { arbitrary: true },
  } as never), code("OCR_MODEL_UNAVAILABLE"));
  assert.equal(Object.isFrozen(FROZEN_TESSERACT_MANIFEST), true);
  assert.equal(FROZEN_TESSERACT_MANIFEST.minimumHardware, "x86_64 CPU; 512 MiB available memory");
  assert.equal(FROZEN_TESSERACT_MANIFEST.offlinePackageReference, "clinic-os-tesseract-eng-v1");
  let traps = 0;
  const proxy = new Proxy({}, { ownKeys() { traps += 1; throw new Error("trap"); } });
  assert.throws(() => new TesseractOcrProvider(proxy as never), code("OCR_MODEL_UNAVAILABLE"));
  assert.equal(traps, 0);
});

test("direct Provider requires exact ActorContext and rejects proxies without traps", async (t) => {
  const { provider, runner } = await setup(t);
  for (const context of [
    { ...CONTEXT, actorId: "" },
    { ...CONTEXT, role: "PATIENT" },
    { ...CONTEXT, extra: true },
  ]) await assert.rejects(provider.infer(context as ActorContext, request()));
  let traps = 0;
  const hostileRequest = new Proxy(request(), { ownKeys() { traps += 1; throw new Error("trap"); } });
  const hostileContext = new Proxy(CONTEXT, { ownKeys() { traps += 1; throw new Error("trap"); } });
  await assert.rejects(provider.infer(CONTEXT, hostileRequest), code("OCR_INVALID_REQUEST"));
  await assert.rejects(provider.infer(hostileContext, request()), code("OCR_INVALID_REQUEST"));
  assert.equal(traps, 0);
  assert.equal(runner.invocations.length, 0);
});

test("engine identity, process failure, timeout and output limits are sanitized", async (t) => {
  const cases: Array<[unknown, string]> = [
    [new TesseractProcessFailure("TIMEOUT"), "OCR_EXECUTION_TIMEOUT"],
    [new TesseractProcessFailure("ABORTED"), "OCR_EXECUTION_ABORTED"],
    [new TesseractProcessFailure("OUTPUT_LIMIT"), "OCR_OUTPUT_LIMIT_EXCEEDED"],
    [new Error("stderr /tmp/private EYE EXAM REPORT"), "OCR_EXECUTION_FAILED"],
  ];
  for (const [failure, expected] of cases) {
    const { provider, runner } = await setup(t);
    runner.failure = failure;
    await assert.rejects(provider.infer(CONTEXT, request()), code(expected));
  }
  const { provider, runner } = await setup(t);
  runner.output = VERSION.replace("5.3.4", "5.4.0");
  const original = runner.run.bind(runner);
  runner.run = async (invocation) => invocation.args[0] === "--version" ? {
    exitCode: 0, stdout: new TextEncoder().encode(runner.output), stderr: new Uint8Array(),
  } : original(invocation);
  await assert.rejects(provider.infer(CONTEXT, request()), code("OCR_MODEL_INTEGRITY_FAILED"));
});

test("malformed TSV and hostile confidence fail without OCR text disclosure", async (t) => {
  for (const output of [
    "not tsv EYE EXAM REPORT",
    TSV_HEADER + row("EYE", 101),
    TSV_HEADER + row("EYE", Number.NaN),
    TSV_HEADER + row("EYE", "0x10" as unknown as number),
    TSV_HEADER + row("EYE", "1e2" as unknown as number),
    TSV_HEADER + row("EYE", " 95" as unknown as number),
    TSV_HEADER + row("EYE", "" as unknown as number),
    TSV_HEADER + row("EYE\0EXAM"),
  ]) {
    const { provider, runner } = await setup(t);
    runner.output = output;
    await assert.rejects(provider.infer(CONTEXT, request()), code("OCR_INVALID_OUTPUT"));
  }
  const { provider, runner } = await setup(t);
  runner.exitCode = 1;
  await assert.rejects(provider.infer(CONTEXT, request()), code("OCR_EXECUTION_FAILED"));
  runner.exitCode = 0;
  runner.output = "x".repeat(300 * 1024);
  await assert.rejects(provider.infer(CONTEXT, request()), code("OCR_OUTPUT_LIMIT_EXCEEDED"));
});

test("gateway enforces provider identity and receipts contain no OCR data", async (t) => {
  const { provider } = await setup(t);
  const manifest = {
    profile: "ON_PREM_STRICT" as const,
    databaseProvider: "LOCAL_POSTGRES" as const,
    fileProvider: "LOCAL_OBJECT_STORE" as const,
    inferenceProvider: "LOCAL_MODEL" as const,
    backupProvider: "LOCAL_ENCRYPTED_BACKUP" as const,
    externalInferenceAuthorized: false,
    manifestVersion: "manifest-1",
  };
  const gateway = new InferenceGateway(manifest, provider);
  await gateway.infer(CONTEXT, request());
  const receipts = JSON.stringify(gateway.listReceipts(CONTEXT));
  assert.doesNotMatch(receipts, /EYE EXAM REPORT|137,80,78|tessdata/);
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(provider)).sort(), [
    "constructor", "infer", "kind", "modelId",
  ]);
});

test("node runner fixes shell, environment and stdin and escalates TERM to KILL", async () => {
  const calls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [];
  const signals: string[] = [];
  const fakeSpawn = ((executable: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
      kill(signal: string): boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
      return true;
    };
    return child;
  }) as unknown as Parameters<typeof createNodeTesseractProcessRunner>[0];
  const runner = createNodeTesseractProcessRunner(fakeSpawn);
  await assert.rejects(runner.run({
    executable: "/fixed/tesseract", args: ["stdin", "stdout"], input: PNG,
    timeoutMs: 5, maxOutputBytes: 1024,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "TIMEOUT");
  assert.deepEqual(calls, [{
    executable: "/fixed/tesseract",
    args: ["stdin", "stdout"],
    options: { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C" } },
  }]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.run({
    executable: "/fixed/tesseract", args: ["stdin", "stdout"], input: PNG,
    timeoutMs: 1_000, maxOutputBytes: 1024, signal: controller.signal,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "ABORTED");
  assert.equal(calls.length, 1);
});

test("node runner rejects after final KILL deadline when child never closes", async () => {
  const signals: string[] = [];
  let child!: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(signal: string): boolean };
  const fakeSpawn = (() => {
    child = new EventEmitter() as typeof child;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { signals.push(signal); return false; };
    return child;
  }) as unknown as Parameters<typeof createNodeTesseractProcessRunner>[0];
  const started = Date.now();
  await assert.rejects(createNodeTesseractProcessRunner(fakeSpawn).run({
    executable: "/fixed/tesseract", args: ["stdin"], input: PNG,
    timeoutMs: 5, maxOutputBytes: 1024,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "TIMEOUT");
  assert.ok(Date.now() - started < 1_500);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);

  const thrownSignals: string[] = [];
  const throwingSpawn = (() => {
    const stuck = new EventEmitter() as EventEmitter & {
      stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(signal: string): boolean;
    };
    stuck.stdin = new PassThrough();
    stuck.stdout = new PassThrough();
    stuck.stderr = new PassThrough();
    stuck.kill = (signal) => { thrownSignals.push(signal); throw new Error("kill failed"); };
    return stuck;
  }) as unknown as Parameters<typeof createNodeTesseractProcessRunner>[0];
  await assert.rejects(createNodeTesseractProcessRunner(throwingSpawn).run({
    executable: "/fixed/tesseract", args: ["stdin"], input: PNG,
    timeoutMs: 5, maxOutputBytes: 1024,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "TIMEOUT");
  assert.deepEqual(thrownSignals, ["SIGTERM", "SIGKILL"]);
});

test("node runner treats stdin errors and abort-listener race as controlled failures", async () => {
  function spawning(mode: "stdin" | "abort") {
    return (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(signal: string): boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
      if (mode === "stdin") queueMicrotask(() => child.stdin.emit("error", new Error("private")));
      return child;
    }) as unknown as Parameters<typeof createNodeTesseractProcessRunner>[0];
  }
  await assert.rejects(createNodeTesseractProcessRunner(spawning("stdin")).run({
    executable: "/fixed/tesseract", args: ["stdin"], input: PNG,
    timeoutMs: 1_000, maxOutputBytes: 1024,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "SPAWN_FAILED");

  let reads = 0;
  const racedSignal = {
    get aborted() { reads += 1; return reads >= 2; },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  await assert.rejects(createNodeTesseractProcessRunner(spawning("abort")).run({
    executable: "/fixed/tesseract", args: ["stdin"], input: PNG,
    timeoutMs: 1_000, maxOutputBytes: 1024, signal: racedSignal,
  }), (error) => error instanceof TesseractProcessFailure && error.code === "ABORTED");
  assert.equal(reads, 2);
});

test("source contains no network, repository or domain-write authority", async () => {
  const source = await readFile(new URL("../src/runtime/tesseract-ocr-provider.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /https?:|fetch\(|Workflow|Expectation|Verification|ManagerDecision|Repository/);
});
