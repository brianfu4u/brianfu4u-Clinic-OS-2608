import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type TesseractModelManifest,
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

function manifest(executable: string, eng: string, osd: string): TesseractModelManifest {
  return {
    manifestVersion: "tesseract-model-manifest-v1",
    modelId: TESSERACT_OCR_MODEL_ID,
    engineName: "tesseract",
    engineVersion: "5.3.4",
    leptonicaVersion: "1.82.0",
    purpose: "synthetic-english-eye-exam-ocr-smoke",
    executableSha256: hash(executable),
    engTraineddataSha256: hash(eng),
    osdTraineddataSha256: hash(osd),
    language: "eng",
    licenseSpdx: "Apache-2.0",
    schemaVersion: TESSERACT_OCR_SCHEMA_VERSION,
    minimumHardware: "synthetic-test",
    rollbackModelId: "disabled",
    offlinePackageReference: "synthetic-test",
  };
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
  const osdPath = join(tessdata, "osd.traineddata");
  await mkdir(tessdata);
  await writeFile(executable, "binary");
  await writeFile(engPath, "eng-model");
  await writeFile(osdPath, "osd-model");
  const runner = new FixtureRunner();
  const provider = new TesseractOcrProvider({
    executablePath: executable,
    tessdataDir: tessdata,
    manifest: manifest("binary", "eng-model", "osd-model"),
    runner,
    timeoutMs: 1_000,
  });
  return { root, executable, engPath, osdPath, runner, provider };
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
  await writeFile(engPath, "eng-model");
  await writeFile(executable, "mutated");
  await assert.rejects(provider.infer(CONTEXT, request()), code("OCR_MODEL_INTEGRITY_FAILED"));
  assert.equal(runner.invocations.length, 2);
});

test("unknown manifest fields and identity mutations fail closed", async (t) => {
  const { root } = await setup(t);
  const bad = { ...manifest("binary", "eng-model", "osd-model"), extra: true };
  assert.throws(() => new TesseractOcrProvider({
    executablePath: join(root, "tesseract"), tessdataDir: join(root, "tessdata"),
    manifest: bad as TesseractModelManifest, runner: new FixtureRunner(),
  }), code("OCR_MODEL_INTEGRITY_FAILED"));
  const { provider } = await setup(t);
  assert.throws(() => Object.defineProperty(provider, "modelId", { value: "mutated" }));
  let getterCalls = 0;
  const hostile = manifest("binary", "eng-model", "osd-model") as unknown as Record<string, unknown>;
  Object.defineProperty(hostile, "purpose", { enumerable: true, get() { getterCalls += 1; return "synthetic-english-eye-exam-ocr-smoke"; } });
  assert.throws(() => new TesseractOcrProvider({
    executablePath: join(root, "tesseract"), tessdataDir: join(root, "tessdata"),
    manifest: hostile as unknown as TesseractModelManifest, runner: new FixtureRunner(),
  }), code("OCR_MODEL_INTEGRITY_FAILED"));
  assert.equal(getterCalls, 0);
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

test("source contains no network, repository or domain-write authority", async () => {
  const source = await readFile(new URL("../src/runtime/tesseract-ocr-provider.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /https?:|fetch\(|Workflow|Expectation|Verification|ManagerDecision|Repository/);
});
