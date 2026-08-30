import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { types } from "node:util";

import { assertActorContext } from "../domain/access-context.ts";
import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { InferenceProvider, InferenceRequest, InferenceResponse } from "./contracts.ts";

export const TESSERACT_OCR_MODEL_ID = "tesseract-eng-eye-exam-v1";
export const TESSERACT_OCR_SCHEMA_VERSION = "eye-exam-candidate-v1";
export const TESSERACT_MODEL_MANIFEST_SHA256 = "8ccd734c69eb6dc4ce8f78ee1aa5cf66c39a2e92b544bebd2fa088aa34162951";

const CAPABILITY = "EXTRACT_EYE_EXAM_REPORT";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_OCR_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 500;
const FINAL_GRACE_MS = 500;

export interface TesseractModelManifest {
  manifestVersion: string;
  modelId: string;
  engineName: string;
  engineVersion: string;
  leptonicaVersion: string;
  purpose: string;
  executableSha256: string;
  engTraineddataSha256: string;
  tsvConfigSha256: string;
  language: string;
  licenseSpdx: string;
  schemaVersion: string;
  minimumHardware: string;
  rollbackModelId: string;
  offlinePackageReference: string;
}

export const FROZEN_TESSERACT_MANIFEST: Readonly<TesseractModelManifest> = Object.freeze({
  manifestVersion: "tesseract-model-manifest-v1",
  modelId: TESSERACT_OCR_MODEL_ID,
  engineName: "tesseract",
  engineVersion: "5.3.4",
  leptonicaVersion: "1.82.0",
  purpose: "synthetic-english-eye-exam-ocr-smoke",
  executableSha256: "9f831cab7525c3dab04af41bda35182af7ea1df9dceeaaa2f3bf207ac45c06a5",
  engTraineddataSha256: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
  tsvConfigSha256: "59d079bb75d8b3d7c839a3564580cb559e362c93a9d70f234e421c0c3e767e04",
  language: "eng",
  licenseSpdx: "Apache-2.0",
  schemaVersion: TESSERACT_OCR_SCHEMA_VERSION,
  minimumHardware: "x86_64 CPU; 512 MiB available memory",
  rollbackModelId: "disabled",
  offlinePackageReference: "clinic-os-tesseract-eng-v1",
});

export interface TesseractProcessInvocation {
  executable: string;
  args: readonly string[];
  input: Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface TesseractProcessResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface TesseractProcessRunner {
  run(invocation: TesseractProcessInvocation): Promise<TesseractProcessResult>;
}

export class TesseractProcessFailure extends Error {
  readonly code: "TIMEOUT" | "ABORTED" | "OUTPUT_LIMIT" | "SPAWN_FAILED";

  constructor(code: "TIMEOUT" | "ABORTED" | "OUTPUT_LIMIT" | "SPAWN_FAILED") {
    super(code);
    this.name = "TesseractProcessFailure";
    this.code = code;
  }
}

export function createNodeTesseractProcessRunner(
  spawnProcess: typeof spawn = spawn,
): TesseractProcessRunner {
  return Object.freeze({
    run(invocation) {
      return new Promise((resolve, reject) => {
        if (invocation.signal?.aborted) {
          reject(new TesseractProcessFailure("ABORTED"));
          return;
        }
        let child: ReturnType<typeof spawn>;
        try {
          child = spawnProcess(invocation.executable, [...invocation.args], {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            env: { LANG: "C", LC_ALL: "C" },
          });
        } catch {
          reject(new TesseractProcessFailure("SPAWN_FAILED"));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let failure: TesseractProcessFailure | null = null;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        let finalTimer: NodeJS.Timeout | undefined;

        const abort = () => stop(new TesseractProcessFailure("ABORTED"));
        const onError = () => stop(new TesseractProcessFailure("SPAWN_FAILED"));
        const onStdinError = () => stop(new TesseractProcessFailure("SPAWN_FAILED"));
        const onPipeError = () => stop(new TesseractProcessFailure("SPAWN_FAILED"));
        const onStdout = (chunk: Buffer) => collect(stdout, chunk);
        const onStderr = (chunk: Buffer) => collect(stderr, chunk);
        const onClose = (code: number | null) => finish(code);
        const timeout = setTimeout(
          () => stop(new TesseractProcessFailure("TIMEOUT")),
          invocation.timeoutMs,
        );
        timeout.unref();

        const cleanup = () => {
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          if (finalTimer) clearTimeout(finalTimer);
          invocation.signal?.removeEventListener("abort", abort);
          child.stdout.off("data", onStdout);
          child.stderr.off("data", onStderr);
          child.stdout.off("error", onPipeError);
          child.stderr.off("error", onPipeError);
          child.stdin.off("error", onStdinError);
          child.off("error", onError);
          child.off("close", onClose);
        };
        const rejectFailure = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(failure ?? new TesseractProcessFailure("SPAWN_FAILED"));
        };
        function finish(code: number | null) {
          if (settled) return;
          settled = true;
          cleanup();
          if (failure) reject(failure);
          else resolve({
            exitCode: code ?? -1,
            stdout: new Uint8Array(Buffer.concat(stdout)),
            stderr: new Uint8Array(Buffer.concat(stderr)),
          });
        }
        function stop(reason: TesseractProcessFailure) {
          if (failure || settled) return;
          failure = reason;
          try { child.kill("SIGTERM"); } catch { /* final KILL still follows */ }
          killTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* final deadline rejects */ }
            finalTimer = setTimeout(rejectFailure, FINAL_GRACE_MS);
            finalTimer.unref();
          }, KILL_GRACE_MS);
          killTimer.unref();
        }
        function collect(target: Buffer[], chunk: Buffer) {
          if (failure || settled) return;
          outputBytes += chunk.byteLength;
          if (outputBytes > invocation.maxOutputBytes) {
            stop(new TesseractProcessFailure("OUTPUT_LIMIT"));
            return;
          }
          target.push(Buffer.from(chunk));
        }

        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.stdout.on("error", onPipeError);
        child.stderr.on("error", onPipeError);
        child.stdin.on("error", onStdinError);
        child.on("error", onError);
        child.on("close", onClose);
        invocation.signal?.addEventListener("abort", abort, { once: true });
        if (invocation.signal?.aborted) abort();
        if (!failure && !settled) {
          try { child.stdin.end(Buffer.from(invocation.input)); } catch { onStdinError(); }
        }
      });
    },
  });
}

export const nodeTesseractProcessRunner = createNodeTesseractProcessRunner();

interface TrustedPath {
  path: string;
  handle: FileHandle;
  dev: number;
  ino: number;
  expectedSha256?: string;
}

interface ProviderConfig {
  executablePath: string;
  tessdataDir: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export class TesseractOcrProvider implements InferenceProvider {
  readonly #executablePath: string;
  readonly #tessdataDir: string;
  readonly #manifest: Readonly<TesseractModelManifest>;
  readonly #timeoutMs: number;
  readonly #abortSignal: AbortSignal | undefined;

  constructor(config: ProviderConfig) {
    if (!plainDataObject(config) ||
      !allowedKeys(config, ["abortSignal", "executablePath", "tessdataDir", "timeoutMs"]) ||
      !isAbsolute(config.executablePath) || !isAbsolute(config.tessdataDir) ||
      resolve(config.executablePath) !== config.executablePath ||
      resolve(config.tessdataDir) !== config.tessdataDir ||
      (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 100 || config.timeoutMs > 120_000)) ||
      (config.abortSignal !== undefined && !(config.abortSignal instanceof AbortSignal))) {
      throw new DomainError("OCR_MODEL_UNAVAILABLE", "Local OCR configuration is invalid.");
    }
    this.#manifest = FROZEN_TESSERACT_MANIFEST;
    this.#executablePath = config.executablePath;
    this.#tessdataDir = config.tessdataDir;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#abortSignal = config.abortSignal;
    Object.preventExtensions(this);
  }

  get kind(): "LOCAL_MODEL" {
    return "LOCAL_MODEL";
  }

  get modelId(): string {
    return this.#manifest.modelId;
  }

  async infer(context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    const captured = captureRequest(context, request);
    const trusted = await openTrustedAssets(this.#executablePath, this.#tessdataDir, this.#manifest);
    try {
      await assertAssetState(trusted);
      const version = await this.#run(["--version"], new Uint8Array(), 64 * 1024);
      validateEngineVersion(version, this.#manifest);
      await assertAssetState(trusted);
      const result = await this.#run([
        "stdin", "stdout", "--tessdata-dir", this.#tessdataDir,
        "-l", "eng", "--psm", "6", "tsv",
      ], captured.input.bytes, MAX_OCR_BYTES);
      await assertAssetState(trusted);
      if (result.exitCode !== 0) {
        throw new DomainError("OCR_EXECUTION_FAILED", "Local OCR execution failed.");
      }
      const candidate = parseTesseractTsv(result.stdout);
      return {
        requestId: captured.requestId,
        providerKind: "LOCAL_MODEL",
        modelId: this.modelId,
        schemaVersion: captured.schemaVersion,
        output: candidate,
        completedAt: new Date().toISOString(),
      };
    } finally {
      await Promise.allSettled(trusted.map(({ handle }) => handle.close()));
    }
  }

  async #run(args: readonly string[], input: Uint8Array, maxOutputBytes: number): Promise<TesseractProcessResult> {
    let result: TesseractProcessResult;
    try {
      result = await nodeTesseractProcessRunner.run({
        executable: this.#executablePath,
        args: Object.freeze([...args]),
        input: new Uint8Array(input),
        timeoutMs: this.#timeoutMs,
        maxOutputBytes,
        signal: this.#abortSignal,
      });
    } catch (error) {
      if (error instanceof TesseractProcessFailure && error.code === "TIMEOUT") {
        throw new DomainError("OCR_EXECUTION_TIMEOUT", "Local OCR execution timed out.");
      }
      if (error instanceof TesseractProcessFailure && error.code === "ABORTED") {
        throw new DomainError("OCR_EXECUTION_ABORTED", "Local OCR execution was cancelled.");
      }
      if (error instanceof TesseractProcessFailure && error.code === "OUTPUT_LIMIT") {
        throw new DomainError("OCR_OUTPUT_LIMIT_EXCEEDED", "Local OCR output exceeded its limit.");
      }
      throw new DomainError("OCR_EXECUTION_FAILED", "Local OCR execution failed.");
    }
    if (!plainDataObject(result) || !exactKeys(result, ["exitCode", "stderr", "stdout"]) ||
      !Number.isSafeInteger(result.exitCode) || !(result.stdout instanceof Uint8Array) ||
      !(result.stderr instanceof Uint8Array)) {
      throw new DomainError("OCR_EXECUTION_FAILED", "Local OCR execution failed.");
    }
    if (result.stdout.byteLength + result.stderr.byteLength > maxOutputBytes) {
      throw new DomainError("OCR_OUTPUT_LIMIT_EXCEEDED", "Local OCR output exceeded its limit.");
    }
    return {
      exitCode: result.exitCode,
      stdout: new Uint8Array(result.stdout),
      stderr: new Uint8Array(result.stderr),
    };
  }
}

async function openTrustedPath(
  path: string,
  directory: boolean,
  expectedSha256?: string,
): Promise<TrustedPath> {
  if (typeof constants.O_NOFOLLOW !== "number" ||
    (directory && typeof constants.O_DIRECTORY !== "number")) throw new Error();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    (directory ? constants.O_DIRECTORY : 0));
  try {
    const stat = await handle.stat();
    assertTrustedOwnership(stat, directory);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error();
    if (expectedSha256 !== undefined) {
      const actual = await hashHandle(handle, stat);
      if (actual !== expectedSha256) {
        throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR asset integrity failed.");
      }
    }
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR asset identity changed.");
    }
    if (directory) {
      const resolved = await realpath(path);
      const resolvedStat = await lstat(resolved);
      if (resolvedStat.isSymbolicLink() || resolvedStat.dev !== stat.dev || resolvedStat.ino !== stat.ino) {
        throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR directory identity changed.");
      }
    }
    return { path, handle, dev: stat.dev, ino: stat.ino, expectedSha256 };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openTrustedAssets(
  executablePath: string,
  tessdataDir: string,
  manifest: Readonly<TesseractModelManifest>,
): Promise<TrustedPath[]> {
  const opened: TrustedPath[] = [];
  const files = [
    [executablePath, manifest.executableSha256],
    [join(tessdataDir, "eng.traineddata"), manifest.engTraineddataSha256],
    [join(tessdataDir, "configs", "tsv"), manifest.tsvConfigSha256],
  ] as const;
  try {
    const directories = new Set<string>();
    for (const leaf of [dirname(executablePath), tessdataDir, join(tessdataDir, "configs")]) {
      for (const path of directoryAncestry(leaf)) directories.add(path);
    }
    for (const path of directories) {
      opened.push(await openTrustedPath(path, true));
    }
    for (const [path, expected] of files) opened.push(await openTrustedPath(path, false, expected));
    return opened;
  } catch (error) {
    await Promise.allSettled(opened.map(({ handle }) => handle.close()));
    if (error instanceof DomainError) throw error;
    throw new DomainError("OCR_MODEL_UNAVAILABLE", "Local OCR assets are unavailable.");
  }
}

export async function validateTesseractAssetPathChain(
  config: { executablePath: string; tessdataDir: string },
): Promise<void> {
  if (!plainDataObject(config) || !exactKeys(config, ["executablePath", "tessdataDir"]) ||
    !isAbsolute(config.executablePath) || !isAbsolute(config.tessdataDir) ||
    resolve(config.executablePath) !== config.executablePath || resolve(config.tessdataDir) !== config.tessdataDir) {
    throw new DomainError("OCR_MODEL_UNAVAILABLE", "Local OCR configuration is invalid.");
  }
  const trusted = await openTrustedAssets(
    config.executablePath,
    config.tessdataDir,
    FROZEN_TESSERACT_MANIFEST,
  );
  try {
    await assertAssetState(trusted);
  } finally {
    await Promise.allSettled(trusted.map(({ handle }) => handle.close()));
  }
}

async function assertAssetState(paths: readonly TrustedPath[]): Promise<void> {
  try {
    for (const trusted of paths) {
      const [handleStat, pathStat] = await Promise.all([trusted.handle.stat(), lstat(trusted.path)]);
      if (pathStat.isSymbolicLink() || handleStat.dev !== trusted.dev || handleStat.ino !== trusted.ino ||
        pathStat.dev !== trusted.dev || pathStat.ino !== trusted.ino) throw new Error();
      assertTrustedOwnership(handleStat, handleStat.isDirectory());
      if (trusted.expectedSha256 !== undefined &&
        await hashHandle(trusted.handle, handleStat) !== trusted.expectedSha256) throw new Error();
    }
  } catch {
    throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR asset identity changed.");
  }
}

function directoryAncestry(path: string): string[] {
  const result: string[] = [];
  let current = resolve(path);
  while (true) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result.reverse();
}

async function hashHandle(handle: FileHandle, stat: Stats): Promise<string> {
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > 64 * 1024 * 1024) throw new Error();
  const buffer = Buffer.allocUnsafe(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) throw new Error();
    offset += bytesRead;
  }
  return createHash("sha256").update(buffer).digest("hex");
}

function assertTrustedOwnership(stat: Stats, directory: boolean): void {
  const currentUid = process.geteuid?.();
  if (currentUid === undefined || (stat.uid !== 0 && stat.uid !== currentUid) ||
    (stat.mode & 0o022) !== 0 || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR asset permissions are unsafe.");
  }
}

function captureRequest(context: ActorContext, request: InferenceRequest): {
  requestId: string;
  schemaVersion: string;
  input: { bytes: Uint8Array; mediaType: string; contentSha256: string; kind: string };
} {
  if (!plainDataObject(context) || !exactKeys(context, ["actorId", "clinicId", "role"]) ||
    !plainDataObject(request) || !exactKeys(request, ["capability", "clinicId", "input", "requestId", "schemaVersion"]) ||
    !plainDataObject(request.input) ||
    !exactKeys(request.input, ["bytes", "contentSha256", "kind", "mediaType"]) ||
    context.clinicId !== request.clinicId || request.capability !== CAPABILITY ||
    request.schemaVersion !== TESSERACT_OCR_SCHEMA_VERSION || !nonblank(request.requestId) ||
    request.input.kind !== "EXAM_REPORT" ||
    !["image/png", "image/jpeg"].includes(request.input.mediaType as string) ||
    !(request.input.bytes instanceof Uint8Array) || request.input.bytes.byteLength === 0 ||
    request.input.bytes.byteLength > MAX_IMAGE_BYTES ||
    !/^[a-f0-9]{64}$/.test(request.input.contentSha256 as string)) {
    throw new DomainError("OCR_INVALID_REQUEST", "Local OCR request is invalid.");
  }
  assertActorContext({ clinicId: context.clinicId, actorId: context.actorId, role: context.role });
  const bytes = new Uint8Array(request.input.bytes);
  const mediaType = request.input.mediaType as string;
  if (!validMagic(bytes, mediaType) ||
    createHash("sha256").update(bytes).digest("hex") !== request.input.contentSha256) {
    throw new DomainError("OCR_INVALID_REQUEST", "Local OCR request is invalid.");
  }
  return {
    requestId: request.requestId,
    schemaVersion: request.schemaVersion,
    input: { bytes, mediaType, contentSha256: request.input.contentSha256 as string, kind: "EXAM_REPORT" },
  };
}

function validateEngineVersion(result: TesseractProcessResult, manifest: TesseractModelManifest): void {
  if (result.exitCode !== 0 || !(result.stdout instanceof Uint8Array) || !(result.stderr instanceof Uint8Array)) {
    throw new DomainError("OCR_MODEL_UNAVAILABLE", "Local OCR engine identity is unavailable.");
  }
  const version = decode(result.stdout, "OCR_MODEL_UNAVAILABLE");
  if (!version.startsWith(`tesseract ${manifest.engineVersion}\n`) ||
    !version.includes(`leptonica-${manifest.leptonicaVersion}`)) {
    throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR engine identity does not match its manifest.");
  }
}

export function parseTesseractTsv(bytes: Uint8Array): Record<string, unknown> {
  const text = decode(bytes, "OCR_INVALID_OUTPUT");
  if (Buffer.byteLength(text) > MAX_OCR_BYTES || /[\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    throw new DomainError("OCR_INVALID_OUTPUT", "Local OCR returned invalid output.");
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.shift() !== "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext") {
    throw new DomainError("OCR_INVALID_OUTPUT", "Local OCR returned invalid output.");
  }
  const words: string[] = [];
  const confidences: number[] = [];
  for (const line of lines) {
    if (line === "") continue;
    const columns = line.split("\t");
    if (columns.length !== 12 || columns.slice(0, 10).some((value) => !/^\d+$/.test(value))) {
      throw new DomainError("OCR_INVALID_OUTPUT", "Local OCR returned invalid output.");
    }
    if (!/^(?:-1|(?:0|[1-9]\d?)(?:\.\d+)?|100(?:\.0+)?)$/.test(columns[10])) {
      throw new DomainError("OCR_INVALID_OUTPUT", "Local OCR returned invalid confidence.");
    }
    const confidence = Number(columns[10]);
    if (!Number.isFinite(confidence) || confidence < -1 || confidence > 100) {
      throw new DomainError("OCR_INVALID_OUTPUT", "Local OCR returned invalid confidence.");
    }
    if (columns[0] === "5" && columns[11].trim() !== "") {
      if (confidence < 0 || /[\t\r\n]/.test(columns[11])) {
        throw new DomainError("OCR_INVALID_OUTPUT", "Local OCR returned invalid output.");
      }
      words.push(columns[11].trim());
      confidences.push(confidence);
    }
  }
  const ocrText = words.join(" ").replace(/\s+/g, " ").trim();
  if (!ocrText || Buffer.byteLength(ocrText) > 16 * 1024 || confidences.length === 0) {
    throw new DomainError("OCR_INVALID_OUTPUT", "Local OCR returned no bounded text.");
  }
  const normalized = ocrText.toUpperCase();
  const reportType = normalized.includes("FUNDUS EXAM REPORT") ? "FUNDUS" :
    normalized.includes("EYE EXAM REPORT") ? "EYE_EXAM" : null;
  return {
    subjectTypeCandidate: "PATIENT",
    workflowFamilyCandidate: "EYE_EXAM",
    fields: { ocrText, reportType },
    missingFields: reportType === null ? ["reportType"] : [],
    confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length / 100,
  };
}

function decode(bytes: Uint8Array, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError(code, "Local OCR returned invalid encoded output.");
  }
}

function validMagic(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType === "image/png") {
    return bytes.byteLength >= 8 && [137, 80, 78, 71, 13, 10, 26, 10]
      .every((value, index) => bytes[index] === value);
  }
  return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.includes("executablePath") && actual.includes("tessdataDir") &&
    actual.every((key) => keys.includes(key));
}

function plainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.hasOwn(descriptors[key], "value"));
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
