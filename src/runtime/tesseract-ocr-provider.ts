import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { InferenceProvider, InferenceRequest, InferenceResponse } from "./contracts.ts";

export const TESSERACT_OCR_MODEL_ID = "tesseract-eng-eye-exam-v1";
export const TESSERACT_OCR_SCHEMA_VERSION = "eye-exam-candidate-v1";

const CAPABILITY = "EXTRACT_EYE_EXAM_REPORT";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_OCR_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 500;
const MANIFEST_KEYS = [
  "engTraineddataSha256", "engineName", "engineVersion", "executableSha256",
  "language", "leptonicaVersion", "licenseSpdx", "manifestVersion", "minimumHardware",
  "modelId", "offlinePackageReference", "osdTraineddataSha256", "purpose",
  "rollbackModelId", "schemaVersion",
];

export interface TesseractModelManifest {
  manifestVersion: string;
  modelId: string;
  engineName: string;
  engineVersion: string;
  leptonicaVersion: string;
  purpose: string;
  executableSha256: string;
  engTraineddataSha256: string;
  osdTraineddataSha256: string;
  language: string;
  licenseSpdx: string;
  schemaVersion: string;
  minimumHardware: string;
  rollbackModelId: string;
  offlinePackageReference: string;
}

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
      const child = spawnProcess(invocation.executable, [...invocation.args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { LANG: "C", LC_ALL: "C" },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let failure: TesseractProcessFailure | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const stop = (reason: TesseractProcessFailure) => {
        if (failure) return;
        failure = reason;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      const abort = () => stop(new TesseractProcessFailure("ABORTED"));
      invocation.signal?.addEventListener("abort", abort, { once: true });
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > invocation.maxOutputBytes) {
          stop(new TesseractProcessFailure("OUTPUT_LIMIT"));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", () => {
        failure ??= new TesseractProcessFailure("SPAWN_FAILED");
      });
      const timeout = setTimeout(
        () => stop(new TesseractProcessFailure("TIMEOUT")),
        invocation.timeoutMs,
      );
      timeout.unref();
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        invocation.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else resolve({
          exitCode: code ?? -1,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
        });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(Buffer.from(invocation.input));
      });
    },
  });
}

export const nodeTesseractProcessRunner = createNodeTesseractProcessRunner();

export class TesseractOcrProvider implements InferenceProvider {
  readonly #executablePath: string;
  readonly #tessdataDir: string;
  readonly #manifest: Readonly<TesseractModelManifest>;
  readonly #runner: TesseractProcessRunner;
  readonly #timeoutMs: number;
  readonly #abortSignal: AbortSignal | undefined;

  constructor(config: {
    executablePath: string;
    tessdataDir: string;
    manifest: TesseractModelManifest;
    runner?: TesseractProcessRunner;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }) {
    if (!config || !isAbsolute(config.executablePath) || !isAbsolute(config.tessdataDir) ||
      (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 100 || config.timeoutMs > 120_000)) ||
      (config.runner !== undefined && typeof config.runner.run !== "function") ||
      (config.abortSignal !== undefined && !(config.abortSignal instanceof AbortSignal))) {
      throw new DomainError("OCR_MODEL_UNAVAILABLE", "Local OCR configuration is invalid.");
    }
    this.#manifest = validateManifest(captureManifest(config.manifest));
    this.#executablePath = config.executablePath;
    this.#tessdataDir = config.tessdataDir;
    this.#runner = config.runner ?? nodeTesseractProcessRunner;
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
    await this.#validateAssets();
    const version = await this.#run(["--version"], new Uint8Array(), 64 * 1024);
    validateEngineVersion(version, this.#manifest);
    const result = await this.#run([
      "stdin", "stdout", "--tessdata-dir", this.#tessdataDir,
      "-l", "eng", "--psm", "6", "tsv",
    ], captured.input.bytes, MAX_OCR_BYTES);
    if (result.exitCode !== 0) {
      throw new DomainError("OCR_EXECUTION_FAILED", "Local OCR execution failed.");
    }
    const candidate = parseTsv(result.stdout);
    return {
      requestId: captured.requestId,
      providerKind: "LOCAL_MODEL",
      modelId: this.modelId,
      schemaVersion: captured.schemaVersion,
      output: candidate,
      completedAt: new Date().toISOString(),
    };
  }

  async #validateAssets(): Promise<void> {
    const assets = [
      [this.#executablePath, this.#manifest.executableSha256],
      [join(this.#tessdataDir, "eng.traineddata"), this.#manifest.engTraineddataSha256],
      [join(this.#tessdataDir, "osd.traineddata"), this.#manifest.osdTraineddataSha256],
    ] as const;
    try {
      for (const [path, expected] of assets) {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error();
        const actual = createHash("sha256").update(await readFile(path)).digest("hex");
        if (actual !== expected) {
          throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR asset integrity failed.");
        }
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("OCR_MODEL_UNAVAILABLE", "Local OCR assets are unavailable.");
    }
  }

  async #run(args: readonly string[], input: Uint8Array, maxOutputBytes: number): Promise<TesseractProcessResult> {
    let result: TesseractProcessResult;
    try {
      result = await this.#runner.run({
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

function captureManifest(value: TesseractModelManifest): TesseractModelManifest {
  if (!plainDataObject(value)) {
    throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR manifest is invalid.");
  }
  try {
    return structuredClone(Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(value))
        .map(([key, descriptor]) => [key, descriptor.value]),
    )) as TesseractModelManifest;
  } catch {
    throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR manifest is invalid.");
  }
}

function validateManifest(value: TesseractModelManifest): Readonly<TesseractModelManifest> {
  if (!plainDataObject(value) || Object.keys(value).length !== MANIFEST_KEYS.length ||
    Object.keys(value).some((key) => !MANIFEST_KEYS.includes(key)) ||
    value.manifestVersion !== "tesseract-model-manifest-v1" ||
    value.modelId !== TESSERACT_OCR_MODEL_ID || value.engineName !== "tesseract" ||
    value.engineVersion !== "5.3.4" || value.leptonicaVersion !== "1.82.0" ||
    value.purpose !== "synthetic-english-eye-exam-ocr-smoke" || value.language !== "eng" ||
    value.licenseSpdx !== "Apache-2.0" || value.schemaVersion !== TESSERACT_OCR_SCHEMA_VERSION ||
    value.rollbackModelId !== "disabled" ||
    !nonblank(value.minimumHardware) || !nonblank(value.offlinePackageReference) ||
    ![value.executableSha256, value.engTraineddataSha256, value.osdTraineddataSha256]
      .every((hash) => /^[a-f0-9]{64}$/.test(hash))) {
    throw new DomainError("OCR_MODEL_INTEGRITY_FAILED", "Local OCR manifest is invalid.");
  }
  return Object.freeze({ ...value });
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

function parseTsv(bytes: Uint8Array): Record<string, unknown> {
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

function plainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.hasOwn(descriptors[key], "value"));
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
