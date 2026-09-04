import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { types } from "node:util";

import type { LocalOcrEvaluationLanguage } from "./local-ocr-evaluation.ts";

const CONFIRMATIONS = Object.freeze({
  APPROVE_LOCAL_OCR_LANGUAGE_RELEASE: "APPROVED",
  REJECT_LOCAL_OCR_LANGUAGE_RELEASE: "REJECTED",
} as const);
const MAX_RESULT_BYTES = 4 * 1024;

export const LOCAL_OCR_LANGUAGE_RELEASE_RECORD_DIRECTORY = resolve(process.env.HOME ?? "/var/empty", "clinic-os-data/ocr-language-releases");

export type LocalOcrLanguageReleaseRecord = Readonly<{
  language: LocalOcrEvaluationLanguage;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  averageCerBasisPoints: number;
  decision: "APPROVED" | "REJECTED";
  decidedAt: string;
}>;

export type LocalOcrLanguageReleaseResult =
  | Readonly<{ status: "RECORDED"; record: LocalOcrLanguageReleaseRecord }>
  | Readonly<{ status: "REFUSED"; code: "LOCAL_OCR_LANGUAGE_RELEASE_INPUT_REFUSED" | "LOCAL_OCR_LANGUAGE_RELEASE_CONFLICT" }>;

/**
 * A deliberately narrow, side-effect-free projection for local readiness.
 * Approval is an operator record only; it never changes OCR configuration.
 */
export function inspectLocalOcrLanguageReleaseRecords(recordDirectory: unknown = LOCAL_OCR_LANGUAGE_RELEASE_RECORD_DIRECTORY): Readonly<{
  chiSim: boolean;
  jpn: boolean;
}> {
  try {
    const directory = existingSafeRecordDirectory(recordDirectory);
    return Object.freeze({
      chiSim: approvedRecord(directory, "chi_sim"),
      jpn: approvedRecord(directory, "jpn"),
    });
  } catch {
    return Object.freeze({ chiSim: false, jpn: false });
  }
}

export function recordLocalOcrLanguageRelease(input: {
  language: unknown;
  evaluationResultPath: unknown;
  confirmation: unknown;
  recordDirectory: unknown;
}, now: () => string = () => new Date().toISOString()): LocalOcrLanguageReleaseResult {
  try {
    if (!isLanguage(input.language) || typeof input.confirmation !== "string" ||
      !Object.hasOwn(CONFIRMATIONS, input.confirmation)) throw new Error();
    const result = readEvaluationResult(input.evaluationResultPath);
    if (!validReadyResult(result, input.language)) throw new Error();
    const recordDirectory = safeRecordDirectory(input.recordDirectory);
    const decision = CONFIRMATIONS[input.confirmation as keyof typeof CONFIRMATIONS];
    const candidate = Object.freeze({
      language: input.language,
      totalCases: result.totalCases,
      passedCases: result.passedCases,
      failedCases: result.failedCases,
      averageCerBasisPoints: result.averageCerBasisPoints,
      decision,
    });
    const path = `${recordDirectory}/${input.language}.json`;
    try {
      const existing = readRecord(path);
      if (!sameRecord(existing, candidate)) return Object.freeze({ status: "REFUSED", code: "LOCAL_OCR_LANGUAGE_RELEASE_CONFLICT" });
      return Object.freeze({ status: "RECORDED", record: existing });
    } catch (error) {
      if (!(error instanceof MissingRecordError)) throw error;
    }
    const decidedAt = now();
    if (!validInstant(decidedAt)) throw new Error();
    const record = Object.freeze({ ...candidate, decidedAt });
    writeNewRecord(path, record);
    return Object.freeze({ status: "RECORDED", record });
  } catch {
    return Object.freeze({ status: "REFUSED", code: "LOCAL_OCR_LANGUAGE_RELEASE_INPUT_REFUSED" });
  }
}

function readEvaluationResult(path: unknown): Record<string, unknown> {
  const value = parseJson(readSafeFile(path, MAX_RESULT_BYTES));
  if (!plainDataObject(value) || !exactKeys(value, ["averageCerBasisPoints", "failedCases", "language", "passedCases", "reasonCodes", "status", "totalCases"])) throw new Error();
  return value;
}

function validReadyResult(value: Record<string, unknown>, language: LocalOcrEvaluationLanguage): value is Record<string, number | string | readonly unknown[]> {
  return value.language === language && value.status === "READY" && Array.isArray(value.reasonCodes) && value.reasonCodes.length === 0 &&
    metrics(value) && value.totalCases === expectedCases(language);
}

function metrics(value: Record<string, unknown>): value is Record<string, number | string | readonly unknown[]> {
  return Number.isSafeInteger(value.totalCases) && value.totalCases > 0 &&
    Number.isSafeInteger(value.passedCases) && value.passedCases === value.totalCases &&
    value.failedCases === 0 && Number.isSafeInteger(value.averageCerBasisPoints) &&
    value.averageCerBasisPoints >= 0 && value.averageCerBasisPoints <= 10_000;
}

function expectedCases(language: LocalOcrEvaluationLanguage): number { return language === "eng" ? 2 : 1; }
function isLanguage(value: unknown): value is LocalOcrEvaluationLanguage { return value === "eng" || value === "chi_sim" || value === "jpn"; }

function safeRecordDirectory(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/") throw new Error();
  mkdirSync(value, { recursive: true, mode: 0o700 });
  assertSafeDirectory(value);
  return value;
}

function existingSafeRecordDirectory(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === "/") throw new Error();
  assertSafeDirectory(value);
  return value;
}

function approvedRecord(directory: string, language: "chi_sim" | "jpn"): boolean {
  try {
    const record = readRecord(`${directory}/${language}.json`);
    return record.language === language && record.decision === "APPROVED";
  } catch {
    return false;
  }
}

function readRecord(path: string): LocalOcrLanguageReleaseRecord {
  try {
    const value = parseJson(readSafeFile(path, MAX_RESULT_BYTES));
    if (!plainDataObject(value) || !exactKeys(value, ["averageCerBasisPoints", "decidedAt", "decision", "failedCases", "language", "passedCases", "totalCases"]) ||
      !isLanguage(value.language) || !metrics(value) || (value.decision !== "APPROVED" && value.decision !== "REJECTED") || !validInstant(value.decidedAt)) throw new Error();
    return Object.freeze(value as LocalOcrLanguageReleaseRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingRecordError();
    throw error;
  }
}

function writeNewRecord(path: string, record: LocalOcrLanguageReleaseRecord): void {
  const temporary = `${path}.tmp`;
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, bytes);
    closeSync(fd); fd = undefined;
    // link(2) is create-only: unlike rename, it cannot overwrite a record
    // another local process wrote after our initial absence check.
    linkSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* absent after successful rename */ }
  }
}

function readSafeFile(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error();
  assertSafeDirectory(dirname(value));
  const fd = openSync(value, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); const pathname = lstatSync(value);
    if (!stat.isFile() || pathname.isSymbolicLink() || stat.dev !== pathname.dev || stat.ino !== pathname.ino || !trusted(stat.uid, stat.mode) || stat.size <= 0 || stat.size > maxBytes) throw new Error();
    const bytes = Buffer.allocUnsafe(stat.size);
    for (let offset = 0; offset < bytes.length;) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) throw new Error(); offset += count; }
    const after = lstatSync(value);
    if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error();
    return new Uint8Array(bytes);
  } finally { closeSync(fd); }
}

function assertSafeDirectory(path: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trusted(stat.uid, stat.mode)) throw new Error();
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}

function trusted(uid: number, mode: number): boolean { const current = process.geteuid?.(); return current !== undefined && (uid === 0 || uid === current) && (mode & 0o022) === 0; }
function validInstant(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function parseJson(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(); } }
function plainDataObject(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false; const descriptors = Object.getOwnPropertyDescriptors(value); const prototype = Object.getPrototypeOf(value); return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.hasOwn(descriptors[key], "value")); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
function sameRecord(existing: LocalOcrLanguageReleaseRecord, candidate: Omit<LocalOcrLanguageReleaseRecord, "decidedAt">): boolean { return existing.language === candidate.language && existing.totalCases === candidate.totalCases && existing.passedCases === candidate.passedCases && existing.failedCases === candidate.failedCases && existing.averageCerBasisPoints === candidate.averageCerBasisPoints && existing.decision === candidate.decision; }
class MissingRecordError extends Error {}
