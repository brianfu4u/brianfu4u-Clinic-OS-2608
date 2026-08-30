import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { join } from "node:path";
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { DomainError } from "../domain/errors.ts";
import type { ActorContext, ManagerDecisionAction } from "../domain/contracts.ts";
import { assertActorAccess, assertActorContext } from "../domain/access-context.ts";
import type { ProcessGoldenPathCommand, ProcessGoldenPathResult } from "../application/extraction-golden-path.ts";
import {
  EvidenceObjectIngestionService,
  type EvidenceObjectIngestionInput,
} from "../application/evidence-object-ingestion.ts";
import {
  EYE_EXAM_EXTRACTION_SPEC,
  StoredEvidenceExtractionService,
} from "../application/evidence-extraction.ts";
import { ExtractionGoldenPath } from "../application/extraction-golden-path.ts";
import { PersistedGoldenPath } from "../application/persisted-golden-path.ts";
import { ExtractionPersistenceRepository } from "../persistence/extraction-persistence-repository.ts";
import { CaptureRepository } from "../persistence/capture-repository.ts";
import { ExpectationRepository } from "../persistence/expectation-repository.ts";
import { VerificationRepository } from "../persistence/verification-repository.ts";
import { WorkflowAttachRepository } from "../persistence/workflow-attach-repository.ts";
import { createNodePgPool } from "../persistence/node-pg-pool.ts";
import { parseStrictIsoInstant } from "../persistence/strict-timestamp.ts";
import { InferenceGateway } from "../runtime/inference-gateway.ts";
import type { RuntimeManifest } from "../runtime/contracts.ts";
import {
  TESSERACT_MODEL_MANIFEST_SHA256,
  TESSERACT_OCR_MODEL_ID,
  TesseractOcrProvider,
  validateTesseractAssetPathChainSync,
  validateTesseractCheckedInManifestSync,
} from "../runtime/tesseract-ocr-provider.ts";
import { LocalObjectStore } from "../storage/local-object-store.ts";
import { ObjectStoreGateway } from "../storage/object-store-gateway.ts";
import { PreviewStore, type EmployeeStatus } from "./preview-store.ts";
import type { ClinicalPreviewBackend } from "./clinical-preview-backend.ts";
import { PostgresClinicalPreviewBackend, requireIdempotencyKey } from "./clinical-preview-backend.ts";

const PUBLIC_FILES = new Map([
  ["/app.css", { file: "public/app.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "public/app.js", type: "text/javascript; charset=utf-8" }],
]);
const INDEX_FILE = fileURLToPath(new URL("./public/index.html", import.meta.url));
const TESSERACT_MANIFEST_FILE = fileURLToPath(new URL("../../models/tesseract-eng-v1.manifest.json", import.meta.url));
const EXTRACTION_PATH = "/api/employee/extraction/exam-report";
const UPLOAD_PATH = "/api/employee/evidence-objects";
const MAX_EXTRACTION_BODY_BYTES = 64 * 1024;
const MAX_UPLOAD_BODY_BYTES = 25 * 1024 * 1024 + 1024 * 1024;
const MAX_UPLOAD_HEADER_BYTES = 16 * 1024;
const MAX_UPLOAD_BOUNDARY_BYTES = 70;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_UPLOAD_BODY_TIMEOUT_MS = 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const BODY_KEYS = [
  "artifactId", "attachedAt", "createdAt", "evaluatedAt", "expectationId", "factCardId",
  "identityAnchor", "objectRef", "occurredAt", "occurredAtSource", "requestId",
] as const;
const OBJECT_REF_KEYS = ["contentSha256", "mediaType", "objectId", "sizeBytes"] as const;

export function createPreviewServer(options: {
  store?: PreviewStore;
  clock?: () => string;
  employeeContext?: ActorContext;
  managerContext?: ActorContext;
  clinicalBackend?: ClinicalPreviewBackend;
  extractionBodyTimeoutMs?: number;
  extractionOperationTimeoutMs?: number;
  uploadBodyTimeoutMs?: number;
  evidenceObjectIngestion?: EvidenceObjectIngestionService;
} = {}) {
  const employeeContext = options.employeeContext ?? {
    clinicId: "demo-clinic",
    actorId: "demo-employee",
    role: "EMPLOYEE",
  };
  const managerContext = options.managerContext ?? {
    clinicId: "demo-clinic",
    actorId: "demo-manager",
    role: "MANAGER",
  };
  assertActorContext(employeeContext);
  assertActorContext(managerContext);
  assertActorAccess(employeeContext, employeeContext.clinicId, "EMPLOYEE");
  assertActorAccess(managerContext, managerContext.clinicId, "MANAGER");
  const store = options.store ?? new PreviewStore(employeeContext.clinicId);
  const clock = options.clock ?? (() => new Date().toISOString());
  const bodyTimeoutMs = boundedTimeout(options.extractionBodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS);
  const operationTimeoutMs = boundedTimeout(options.extractionOperationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
  const uploadBodyTimeoutMs = boundedTimeout(options.uploadBodyTimeoutMs, DEFAULT_UPLOAD_BODY_TIMEOUT_MS);

  return createServer(async (request, response) => {
    try {
      await route(
        request,
        response,
        store,
        clock,
        employeeContext,
        managerContext,
        options.clinicalBackend,
        bodyTimeoutMs,
        operationTimeoutMs,
        uploadBodyTimeoutMs,
        options.evidenceObjectIngestion,
      );
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, 400, { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 500, { error: "INTERNAL_ERROR", message: "Unexpected preview error." });
    }
  });
}

export function createConfiguredPreviewServer(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.PREVIEW_MODE ?? "synthetic";
  if (mode === "synthetic") return createPreviewServer();
  if (mode !== "postgres") throw new Error("INVALID_PREVIEW_MODE");
  if (!env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL_REQUIRED");
  const objectStoreRoot = requiredAbsolutePath(
    env.PREVIEW_OBJECT_STORE_ROOT ?? env.LOCAL_OBJECT_STORE_ROOT ?? env.OBJECT_STORE_ROOT,
    "OBJECT_STORE_ROOT_REQUIRED",
  );
  const executablePath = requiredAbsolutePath(env.WO021_TESSERACT_PATH, "TESSERACT_PATH_REQUIRED");
  const tessdataDir = requiredAbsolutePath(env.WO021_TESSDATA_DIR, "TESSDATA_DIR_REQUIRED");
  validateTesseractCheckedInManifestSync(TESSERACT_MANIFEST_FILE);
  validateTesseractAssetPathChainSync({ executablePath, tessdataDir });
  const pool = createNodePgPool(env.DATABASE_URL);
  const runtime: RuntimeManifest = {
    profile: "ON_PREM_STRICT",
    databaseProvider: "LOCAL_POSTGRES",
    fileProvider: "LOCAL_OBJECT_STORE",
    inferenceProvider: "LOCAL_MODEL",
    backupProvider: "LOCAL_ENCRYPTED_BACKUP",
    externalInferenceAuthorized: false,
    manifestVersion: "preview-postgres-local-v1",
  };
  const spec = {
    ...EYE_EXAM_EXTRACTION_SPEC,
    parserVersion: "tesseract-eng-parser-v1",
    modelId: TESSERACT_OCR_MODEL_ID,
    modelManifestSha256: TESSERACT_MODEL_MANIFEST_SHA256,
  } as const;
  const objects = new ObjectStoreGateway(runtime, new LocalObjectStore(objectStoreRoot));
  const inference = new InferenceGateway(runtime, new TesseractOcrProvider({
    executablePath,
    tessdataDir,
  }));
  const capture = new CaptureRepository(pool);
  const persistedPath = new PersistedGoldenPath({
    capture,
    attach: new WorkflowAttachRepository(pool),
    expectation: new ExpectationRepository(pool),
    verification: new VerificationRepository(pool),
  });
  const extractionPath = new ExtractionGoldenPath({
    extractor: new StoredEvidenceExtractionService({ objects, inference, spec }),
    persistence: new ExtractionPersistenceRepository(pool, spec),
    goldenPath: persistedPath,
  });
  const server = createPreviewServer({
    clinicalBackend: new PostgresClinicalPreviewBackend(pool, {
      extractionGoldenPath: extractionPath,
      objectIngestion: new EvidenceObjectIngestionService(objects),
    }),
  });
  server.once("close", () => { void pool.close(); });
  return server;
}

function requiredAbsolutePath(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  const path = value.trim();
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) {
    throw new Error(`${code}:INVALID_ABSOLUTE_PATH`);
  }
  return path;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  store: PreviewStore,
  clock: () => string,
  employeeContext: ActorContext,
  managerContext: ActorContext,
  clinicalBackend?: ClinicalPreviewBackend,
  bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  uploadBodyTimeoutMs = DEFAULT_UPLOAD_BODY_TIMEOUT_MS,
  evidenceObjectIngestion?: EvidenceObjectIngestionService,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === EXTRACTION_PATH) {
    if (method !== "POST") {
      sendJson(response, 404, { error: "NOT_FOUND", message: "Preview route not found." });
      return;
    }
    await handleExamReportExtraction(
      request,
      response,
      employeeContext,
      clinicalBackend,
      bodyTimeoutMs,
      operationTimeoutMs,
    );
    return;
  }
  if (path === UPLOAD_PATH) {
    if (method !== "POST") {
      sendJson(response, 404, { error: "NOT_FOUND", message: "Preview route not found." });
      return;
    }
    if (url.search) {
      await handleUploadError(response, new DomainError("INVALID_UPLOAD", "Upload request is invalid."));
      return;
    }
    await handleEvidenceObjectUpload(
      request,
      response,
      employeeContext,
      clinicalBackend,
      uploadBodyTimeoutMs,
      evidenceObjectIngestion,
    );
    return;
  }

  if (method === "GET" && path === "/") {
    response.writeHead(302, { location: "/employee" });
    response.end();
    return;
  }
  if (method === "GET" && (path === "/employee" || path === "/manager")) {
    send(response, 200, "text/html; charset=utf-8", await readFile(INDEX_FILE));
    return;
  }
  const asset = PUBLIC_FILES.get(path);
  if (method === "GET" && asset) {
    const file = fileURLToPath(new URL(asset.file, import.meta.url));
    send(response, 200, asset.type, await readFile(file));
    return;
  }
  if (method === "GET" && path === "/api/health") {
    sendJson(response, 200, clinicalBackend
      ? {
          status: "ok",
          mode: "hybrid-postgres-preview",
          persistent: ["clinical-chain", "manager-decisions"],
          volatile: ["employee-status", "topics", "conversation", "browser-continuation"],
        }
      : { status: "ok", mode: "synthetic-local-preview" });
    return;
  }
  if (method === "GET" && path === "/api/employee/bootstrap") {
    sendJson(response, 200, store.bootstrap(employeeContext));
    return;
  }
  if (method === "PUT" && path === "/api/employee/status") {
    const body = await jsonBody(request);
    rejectUnexpectedKeys(body, ["status"], "FORBIDDEN_EMPLOYEE_FIELDS");
    sendJson(response, 200, {
      status: store.setStatus(employeeContext, body.status as EmployeeStatus),
    });
    return;
  }
  if (method === "POST" && path === "/api/employee/topics") {
    const body = await jsonBody(request);
    rejectUnexpectedKeys(body, ["title"], "FORBIDDEN_EMPLOYEE_FIELDS");
    sendJson(response, 201, store.createTopic(employeeContext, asString(body.title), clock()));
    return;
  }
  if (method === "POST" && path === "/api/employee/messages") {
    const body = await jsonBody(request);
    rejectUnexpectedKeys(body, ["topicId", "text"], "FORBIDDEN_EMPLOYEE_FIELDS");
    sendJson(
      response,
      201,
      store.addConversation(employeeContext, asString(body.topicId), asString(body.text), clock()),
    );
    return;
  }
  if (method === "POST" && path === "/api/employee/work-updates") {
    const body = await jsonBody(request);
    rejectUnexpectedKeys(
      body,
      clinicalBackend
        ? ["topicId", "kind", "identityAnchor", "workflowFamily", "occurredAt", "text", "expectationId"]
        : ["topicId", "kind", "identityAnchor", "workflowFamily", "occurredAt", "text"],
      "FORBIDDEN_EMPLOYEE_FIELDS",
    );
    const input = store.validateWorkUpdate(employeeContext, {
      topicId: asString(body.topicId),
      kind: asString(body.kind) as "REGISTRATION" | "EXAM_REPORT",
      identityAnchor: asString(body.identityAnchor),
      workflowFamily: asString(body.workflowFamily),
      occurredAt: asString(body.occurredAt),
      text: asString(body.text),
      now: clock(),
    });
    if (!clinicalBackend) {
      sendJson(response, 201, store.submitWorkUpdate(employeeContext, input));
      return;
    }
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const result = await clinicalBackend.submitWorkUpdate(employeeContext, {
      kind: input.kind,
      identityAnchor: input.identityAnchor,
      workflowFamily: "EYE_EXAM",
      occurredAt: input.occurredAt,
      text: input.text,
      expectationId: body.expectationId === undefined ? undefined : asString(body.expectationId),
      idempotencyKey,
      receivedAt: input.now,
    });
    store.appendWorkUpdateResult(
      employeeContext,
      input,
      `${result.workflowId ?? "REVIEW_REQUIRED"} · ${result.expectationState ?? result.status}`,
      idempotencyKey,
    );
    sendJson(response, 201, result);
    return;
  }
  if (method === "GET" && path === "/api/manager/closures") {
    sendJson(response, 200, clinicalBackend
      ? await clinicalBackend.listManagerClosures(managerContext)
      : store.managerClosures(managerContext, clock()));
    return;
  }
  if (method === "POST" && path === "/api/manager/decisions") {
    const body = await jsonBody(request);
    rejectUnexpectedKeys(
      body,
      clinicalBackend
        ? ["expectationId", "action", "reasonCode", "note"]
        : ["workflowId", "action", "reasonCode", "note"],
      "FORBIDDEN_MANAGER_FIELDS",
    );
    if (clinicalBackend) {
      const expectationId = asString(body.expectationId);
      await clinicalBackend.submitManagerDecision(managerContext, {
        expectationId,
        action: asString(body.action) as ManagerDecisionAction,
        reasonCode: asNullableString(body.reasonCode),
        note: asNullableString(body.note),
        idempotencyKey: requireIdempotencyKey(request.headers["idempotency-key"]),
        receivedAt: clock(),
      });
      const item = (await clinicalBackend.listManagerClosures(managerContext))
        .find((candidate) => candidate.expectationId === expectationId);
      if (!item) throw new DomainError("EXPECTATION_NOT_FOUND", "Manager item was not found after decision.");
      sendJson(response, 201, item);
      return;
    }
    sendJson(response, 201, store.submitManagerDecision(managerContext, {
      workflowId: asString(body.workflowId),
      action: asString(body.action) as ManagerDecisionAction,
      reasonCode: asNullableString(body.reasonCode),
      note: asNullableString(body.note),
      now: clock(),
    }));
    return;
  }
  if (method === "GET" && path === "/api/manager/decisions") {
    if (clinicalBackend) {
      sendJson(response, 409, {
        error: "NOT_AVAILABLE_IN_POSTGRES_PREVIEW",
        message: "Decision history is not exposed by this hybrid preview.",
      });
      return;
    }
    sendJson(
      response,
      200,
      store.managerDecisionHistory(
        managerContext,
        asString(url.searchParams.get("workflowId")),
      ),
    );
    return;
  }
  sendJson(response, 404, { error: "NOT_FOUND", message: "Preview route not found." });
}

async function handleExamReportExtraction(
  request: IncomingMessage,
  response: ServerResponse,
  employeeContext: ActorContext,
  clinicalBackend: ClinicalPreviewBackend | undefined,
  bodyTimeoutMs: number,
  operationTimeoutMs: number,
): Promise<void> {
  try {
    assertActorAccess(employeeContext, employeeContext.clinicId, "EMPLOYEE");
    if (typeof clinicalBackend?.submitExamReportConsequence !== "function") {
      throw new DomainError("PERSISTED_TRANSPORT_UNAVAILABLE", "Persisted extraction transport is not configured.");
    }
    requireJsonContentType(request.headers["content-type"]);
    const body = parseExtractionBody(await readBody(request, bodyTimeoutMs));
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey !== body.requestId) {
      throw new DomainError("IDEMPOTENCY_KEY_MISMATCH", "Idempotency-Key must equal requestId.");
    }
    const command = extractionCommand(employeeContext, body);
    const result = await withDeadline(
      clinicalBackend.submitExamReportConsequence(employeeContext, command),
      operationTimeoutMs,
    );
    sendJson(response, 200, projectExtractionResult(result));
  } catch (error) {
    const mapped = mapExtractionError(error);
    if (!response.writableEnded && !response.destroyed) sendJson(response, mapped.status, mapped.body);
  }
}

async function handleEvidenceObjectUpload(
  request: IncomingMessage,
  response: ServerResponse,
  employeeContext: ActorContext,
  clinicalBackend: ClinicalPreviewBackend | undefined,
  bodyTimeoutMs: number,
  directIngestion?: EvidenceObjectIngestionService,
): Promise<void> {
  let staging: StagedUpload | undefined;
  try {
    assertActorAccess(employeeContext, employeeContext.clinicId, "EMPLOYEE");
    const contentType = requireMultipartContentType(request.headers["content-type"]);
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const ingestion = directIngestion ?? (clinicalBackend?.uploadEvidenceObject
      ? { ingest: (context: ActorContext, input: EvidenceObjectIngestionInput) => clinicalBackend.uploadEvidenceObject!(context, input) }
      : undefined);
    if (!ingestion) throw new DomainError("PERSISTED_UPLOAD_UNAVAILABLE", "Persisted evidence upload is not configured.");
    staging = await stageUpload(request, bodyTimeoutMs);
    if (request.aborted) throw new DomainError("UPLOAD_TIMEOUT", "Upload request was interrupted.");
    const parsed = parseMultipart(staging.bytes, contentType.boundary);
    const ref = await ingestion.ingest(employeeContext, {
      idempotencyKey,
      mediaType: parsed.mediaType,
      bytes: parsed.bytes,
    });
    const publicRef = safePublicObjectRef(ref);
    const cleanupError = await cleanupUpload(staging);
    staging = undefined;
    if (cleanupError) throw cleanupError;
    sendJson(response, 201, {
      status: "STORED",
      objectRef: {
        objectId: publicRef.objectId,
        contentSha256: publicRef.contentSha256,
        sizeBytes: publicRef.sizeBytes,
        mediaType: publicRef.mediaType,
      },
    });
  } catch (error) {
    if (staging) {
      const cleanupError = await cleanupUpload(staging);
      if (cleanupError) error = cleanupError;
    }
    const mapped = mapUploadError(error);
    if (!response.writableEnded && !response.destroyed) sendJson(response, mapped.status, mapped.body);
  }
}

async function handleUploadError(response: ServerResponse, error: unknown): Promise<void> {
  const mapped = mapUploadError(error);
  if (!response.writableEnded && !response.destroyed) sendJson(response, mapped.status, mapped.body);
}

type StagedUpload = { directory: string; file: string; bytes: Buffer };
type MultipartContentType = { boundary: string };
type ParsedMultipart = { mediaType: "image/png" | "image/jpeg" | "application/pdf"; bytes: Uint8Array };

function requireMultipartContentType(value: string | string[] | undefined): MultipartContentType {
  if (typeof value !== "string") throw new DomainError("UNSUPPORTED_CONTENT_TYPE", "Content-Type is not supported.");
  const match = /^multipart\/form-data;[ \t]*boundary=(?:"([^"\\\r\n]{1,70})"|([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70}))$/i.exec(value);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || Buffer.byteLength(boundary, "utf8") > MAX_UPLOAD_BOUNDARY_BYTES) {
    throw new DomainError("INVALID_UPLOAD", "Upload multipart body is invalid.");
  }
  return { boundary };
}

async function stageUpload(request: IncomingMessage, timeoutMs: number): Promise<StagedUpload> {
  rejectUploadAuthorityHeaders(request);
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    if (!/^\d+$/.test(contentLength) || contentLength.length > 12) {
      throw new DomainError("INVALID_UPLOAD", "Upload request length is invalid.");
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > MAX_UPLOAD_BODY_BYTES) {
      throw new DomainError("UPLOAD_TOO_LARGE", "Upload request is too large.");
    }
  } else if (Array.isArray(contentLength)) {
    throw new DomainError("INVALID_UPLOAD", "Upload request length is invalid.");
  }
  let directory: string | undefined;
  let file: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let ended = false;
  try {
    directory = await mkdtemp(join(tmpdir(), "clinic-os-upload-"));
    await chmod(directory, 0o700);
    file = join(directory, "body");
    handle = await open(file, "wx", 0o600);
    const chunks: Buffer[] = [];
    let total = 0;
    let cancelled = false;
    let pendingWrite: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
      reject(new DomainError("UPLOAD_TIMEOUT", "Upload request timed out."));
      }, timeoutMs);
    });
    const consume = (async () => {
      for await (const chunk of request) {
        if (cancelled) break;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > MAX_UPLOAD_BODY_BYTES) throw new DomainError("UPLOAD_TOO_LARGE", "Upload request is too large.");
        chunks.push(bytes);
        pendingWrite = handle!.write(bytes);
        await pendingWrite;
        pendingWrite = undefined;
      }
      if (request.aborted || request.complete === false) {
        throw new DomainError("UPLOAD_TIMEOUT", "Upload request was interrupted.");
      }
      ended = true;
    })();
    let abortHandler: (() => void) | undefined;
    let errorHandler: (() => void) | undefined;
    const interruption = new Promise<never>((_, reject) => {
      const abort = () => reject(new DomainError("UPLOAD_TIMEOUT", "Upload request was interrupted."));
      abortHandler = abort;
      errorHandler = abort;
      request.once("aborted", abort);
      request.once("error", abort);
      consume.finally(() => {
        request.off("aborted", abort);
        request.off("error", abort);
      }).catch(() => undefined);
    });
    try {
      await Promise.race([consume, interruption, timeout]);
    } catch (error) {
      if (timer) clearTimeout(timer);
      cancelled = true;
      request.resume();
      await pendingWrite?.catch(() => undefined);
      consume.catch(() => undefined);
      throw error;
    }
    if (timer) clearTimeout(timer);
    if (abortHandler) request.off("aborted", abortHandler);
    if (errorHandler) request.off("error", errorHandler);
    return { directory, file, bytes: Buffer.concat(chunks, total) };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: false });
      } catch {
        throw new DomainError("UPLOAD_CLEANUP_FAILED", "Upload cleanup failed.");
      }
    }
    throw error instanceof DomainError ? error : new DomainError("INTERNAL_UPLOAD_ERROR", "Upload failed.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function rejectUploadAuthorityHeaders(request: IncomingMessage): void {
  const authorityHeaders = [
    "x-clinic-id", "x-actor-id", "x-role", "x-source-employee-id", "x-object-id",
    "x-content-sha256", "x-size-bytes", "x-media-type", "x-object-ref", "x-provider",
    "x-filesystem-path", "x-artifact-id", "x-fact-card-id", "x-workflow-id", "x-expectation-id",
  ];
  if (authorityHeaders.some((name) => request.headers[name] !== undefined)) {
    throw new DomainError("INVALID_UPLOAD", "Upload request is invalid.");
  }
}

function parseMultipart(body: Buffer, boundary: string): ParsedMultipart {
  const opening = Buffer.from(`--${boundary}\r\n`, "ascii");
  if (!body.subarray(0, opening.length).equals(opening)) throw invalidUpload();
  const headerStart = opening.length;
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n", "ascii"), headerStart);
  if (headerEnd < 0 || headerEnd - headerStart > MAX_UPLOAD_HEADER_BYTES) throw invalidUpload();
  const headers = parsePartHeaders(body.subarray(headerStart, headerEnd).toString("latin1"));
  const dataStart = headerEnd + 4;
  const marker = Buffer.from(`\r\n--${boundary}`, "ascii");
  let markerAt = body.indexOf(marker, dataStart);
  while (markerAt >= 0) {
    const suffix = markerAt + marker.length;
    if (body.subarray(suffix, suffix + 2).equals(Buffer.from("--", "ascii"))) {
      const end = suffix + 2;
      if (end !== body.length && !body.subarray(end, end + 2).equals(Buffer.from("\r\n", "ascii"))) throw invalidUpload();
      if (end + 2 !== body.length) throw invalidUpload();
      const bytes = body.subarray(dataStart, markerAt);
      return validateUploadedPart(headers, bytes);
    }
    if (body.subarray(suffix, suffix + 2).equals(Buffer.from("\r\n", "ascii"))) throw invalidUpload();
    markerAt = body.indexOf(marker, markerAt + 1);
  }
  throw invalidUpload();
}

function parsePartHeaders(text: string): { filename: string; mediaType: ParsedMultipart["mediaType"] } {
  const lines = text.split("\r\n");
  if (lines.length !== 2 || lines.some((line) => line.length === 0 || /[^\x20-\x7e]/.test(line))) throw invalidUpload();
  const disposition = /^Content-Disposition: form-data; name="file"; filename="([^"\r\n]{1,255})"$/i.exec(lines[0]);
  const type = /^Content-Type: ([^\r\n]+)$/i.exec(lines[1]);
  if (!disposition || !type) throw invalidUpload();
  const mediaType = type[1].toLowerCase();
  if (!(mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "application/pdf")) {
    throw new DomainError("UNSUPPORTED_CONTENT_TYPE", "Evidence media type is not supported.");
  }
  const filename = disposition[1];
  if (filename.includes("/") || filename.includes("\\") || /[\x00-\x1f\x7f]/.test(filename) || filename === "." || filename === "..") throw invalidUpload();
  return { filename, mediaType: mediaType as ParsedMultipart["mediaType"] };
}

function validateUploadedPart(headers: { filename: string; mediaType: ParsedMultipart["mediaType"] }, bytes: Buffer): ParsedMultipart {
  if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024) throw new DomainError("UPLOAD_TOO_LARGE", "Upload file is too large.");
  const signatures: Record<ParsedMultipart["mediaType"], Buffer> = {
    "image/png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "image/jpeg": Buffer.from([255, 216, 255]),
    "application/pdf": Buffer.from("%PDF-", "ascii"),
  };
  if (!bytes.subarray(0, signatures[headers.mediaType].length).equals(signatures[headers.mediaType])) throw invalidUpload();
  return { mediaType: headers.mediaType, bytes: new Uint8Array(bytes) };
}

function invalidUpload(): DomainError {
  return new DomainError("INVALID_UPLOAD", "Upload multipart body is invalid.");
}

async function cleanupUpload(staging: StagedUpload): Promise<DomainError | undefined> {
  try {
    await rm(staging.directory, { recursive: true, force: false });
    return undefined;
  } catch {
    return new DomainError("UPLOAD_CLEANUP_FAILED", "Upload cleanup failed.");
  }
}

function mapUploadError(error: unknown): { status: number; body: { error: string; message: string } } {
  const code = error instanceof DomainError ? error.code : "INTERNAL_UPLOAD_ERROR";
  if (code === "PERSISTED_UPLOAD_UNAVAILABLE") return publicError(503, code, "Persisted evidence upload is unavailable.");
  if (code === "FORBIDDEN" || code === "ROLE_SCOPE_VIOLATION" || code === "TENANT_SCOPE_VIOLATION" || code === "INVALID_ACTOR_CONTEXT") return publicError(403, "FORBIDDEN", "The request is not permitted.");
  if (code === "INVALID_IDEMPOTENCY_KEY") return publicError(400, code, "Idempotency-Key is invalid.");
  if (code === "UNSUPPORTED_CONTENT_TYPE") return publicError(415, code, "Content-Type is not supported.");
  if (code === "UPLOAD_TOO_LARGE" || code === "OBJECT_TOO_LARGE") return publicError(413, "UPLOAD_TOO_LARGE", "Upload is too large.");
  if (code === "UPLOAD_TIMEOUT") return publicError(408, code, "Upload timed out; retry the exact request.");
  if (code === "OBJECT_ID_CONFLICT") return publicError(409, "UPLOAD_CONFLICT", "Upload conflicts with an existing object.");
  if (["OBJECT_STORE_PROVIDER_FAILED", "OBJECT_STORE_IO_FAILED", "INVALID_OBJECT_STORE_RESPONSE", "UPLOAD_CLEANUP_FAILED"].includes(code)) return publicError(503, "UPLOAD_UNAVAILABLE", "Evidence storage is unavailable.");
  if (["INVALID_UPLOAD", "INVALID_OBJECT_INGESTION_INPUT", "INVALID_OBJECT_BYTES"].includes(code)) return publicError(400, "INVALID_UPLOAD", "Upload request is invalid.");
  return publicError(500, "INTERNAL_UPLOAD_ERROR", "Unexpected upload error.");
}

function safePublicObjectRef(value: unknown): {
  objectId: string;
  contentSha256: string;
  sizeBytes: number;
  mediaType: "image/png" | "image/jpeg" | "application/pdf";
} {
  try {
    const ref = structuredClone(value) as Record<string, unknown>;
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 5 ||
        typeof ref.clinicId !== "string" || typeof ref.objectId !== "string" ||
        !/^upload-[a-f0-9]{64}$/.test(ref.objectId) || typeof ref.contentSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(ref.contentSha256) || typeof ref.sizeBytes !== "number" ||
        !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes <= 0 || ref.sizeBytes > 25 * 1024 * 1024 ||
        typeof ref.mediaType !== "string" || !["image/png", "image/jpeg", "application/pdf"].includes(ref.mediaType)) throw new Error();
    return {
      objectId: ref.objectId as string,
      contentSha256: ref.contentSha256 as string,
      sizeBytes: ref.sizeBytes as number,
      mediaType: ref.mediaType as "image/png" | "image/jpeg" | "application/pdf",
    };
  } catch {
    throw new DomainError("INVALID_OBJECT_STORE_RESPONSE", "Evidence object storage returned an invalid reference.");
  }
}

type ExtractionBody = {
  artifactId: string;
  attachedAt: string;
  createdAt: string;
  evaluatedAt: string;
  expectationId: string;
  factCardId: string;
  identityAnchor: string;
  objectRef: {
    objectId: string;
    contentSha256: string;
    sizeBytes: number;
    mediaType: string;
  };
  occurredAt: string | null;
  occurredAtSource: "source" | "employee_confirmed" | "unknown";
  requestId: string;
};

function extractionCommand(context: ActorContext, body: ExtractionBody): ProcessGoldenPathCommand {
  return structuredClone({
    extraction: {
      requestId: body.requestId,
      artifactId: body.artifactId,
      factCardId: body.factCardId,
      objectRef: {
        clinicId: context.clinicId,
        objectId: body.objectRef.objectId,
        contentSha256: body.objectRef.contentSha256,
        sizeBytes: body.objectRef.sizeBytes,
        mediaType: body.objectRef.mediaType,
      },
      kind: "EXAM_REPORT",
      occurredAt: body.occurredAt,
      occurredAtSource: body.occurredAtSource,
      identityAnchor: body.identityAnchor,
      createdAt: body.createdAt,
    },
    operation: {
      kind: "CONSEQUENCE",
      expectationId: body.expectationId,
      attachedAt: body.attachedAt,
      evaluatedAt: body.evaluatedAt,
    },
  });
}

function parseExtractionBody(text: string): ExtractionBody {
  let value: unknown;
  try {
    assertNoDuplicateJsonKeys(text);
    value = JSON.parse(text);
  } catch {
    throw new DomainError("INVALID_REQUEST", "Request body is invalid.");
  }
  if (!isPlainRecord(value) || !exactKeys(value, BODY_KEYS) ||
      !isPlainRecord(value.objectRef) || !exactKeys(value.objectRef, OBJECT_REF_KEYS)) {
    throw new DomainError("INVALID_REQUEST", "Request body is invalid.");
  }
  const body = value as ExtractionBody;
  const attachedAt = parseStrictIsoInstant(body.attachedAt);
  const evaluatedAt = parseStrictIsoInstant(body.evaluatedAt);
  const occurredAt = body.occurredAt === null ? null : parseStrictIsoInstant(body.occurredAt);
  if (![body.requestId, body.artifactId, body.factCardId, body.expectationId].every(isBoundedId) ||
      !isBoundedString(body.identityAnchor, 256) ||
      !["source", "employee_confirmed", "unknown"].includes(body.occurredAtSource) ||
      ![body.createdAt, body.attachedAt, body.evaluatedAt].every(isInstant) ||
      (body.occurredAt !== null && !isInstant(body.occurredAt)) ||
      (body.occurredAt === null) !== (body.occurredAtSource === "unknown") ||
      attachedAt === null || evaluatedAt === null || attachedAt > evaluatedAt ||
      (occurredAt !== null && occurredAt > evaluatedAt) ||
      !isObjectId(body.objectRef.objectId) || !/^[a-f0-9]{64}$/.test(body.objectRef.contentSha256) ||
      !Number.isSafeInteger(body.objectRef.sizeBytes) || body.objectRef.sizeBytes <= 0 ||
      body.objectRef.sizeBytes > 25 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "application/pdf"].includes(body.objectRef.mediaType)) {
    throw new DomainError("INVALID_REQUEST", "Request body is invalid.");
  }
  return body;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && parseStrictIsoInstant(value) !== null;
}

function requireJsonContentType(value: string | string[] | undefined): void {
  if (typeof value !== "string" || value.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new DomainError("UNSUPPORTED_CONTENT_TYPE", "Content-Type must be application/json.");
  }
}

function readBody(request: IncomingMessage, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let ended = false;
    const timer = setTimeout(() => finish(new DomainError("REQUEST_TIMEOUT", "Request timed out.")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      request.off("close", onClose);
    };
    const finish = (error?: DomainError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        request.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_EXTRACTION_BODY_BYTES) {
        finish(new DomainError("REQUEST_TOO_LARGE", "Request body is too large."));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => { ended = true; finish(); };
    const onError = () => finish(new DomainError("REQUEST_TIMEOUT", "Request was interrupted."));
    const onAborted = () => finish(new DomainError("REQUEST_TIMEOUT", "Request was interrupted."));
    const onClose = () => { if (!ended) finish(new DomainError("REQUEST_TIMEOUT", "Request was interrupted.")); };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
    request.on("close", onClose);
  });
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DomainError("REQUEST_TIMEOUT", "Operation timed out.")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => {
      clearTimeout(timer); reject(error);
    });
  });
}

function projectExtractionResult(value: unknown): Record<string, unknown> {
  let result: ProcessGoldenPathResult;
  try {
    result = structuredClone(value) as ProcessGoldenPathResult;
    validateApplicationResult(result);
  } catch {
    throw new DomainError("INVALID_APPLICATION_RESULT", "Application returned an invalid result.");
  }
  const artifactId = result.extraction.artifact.id;
  if (result.status === "REVIEW_REQUIRED") {
    return {
      status: "REVIEW_REQUIRED",
      reviewStage: result.reviewStage,
      artifactId,
      workflowId: null,
      expectationId: null,
      expectationState: null,
      verificationStatus: null,
      reasonCodes: result.reviewStage === "EXTRACTION"
        ? [...result.extraction.reasonCodes]
        : ["MATCHING_AMBIGUITY"],
    };
  }
  return {
    status: "COMPLETED",
    reviewStage: null,
    artifactId,
    workflowId: result.goldenPath.attachment.workflow.id,
    expectationId: result.goldenPath.expectation.expectation.id,
    expectationState: result.goldenPath.expectation.expectation.state,
    verificationStatus: result.goldenPath.verification.result.status,
    reasonCodes: [],
  };
}

function validateApplicationResult(result: ProcessGoldenPathResult): void {
  if (!isPlainRecord(result) || !exactKeys(result, ["extraction", "goldenPath", "reviewStage", "status"])) throw new Error();
  const extraction = result.extraction;
  if (!isPlainRecord(extraction) || !exactKeys(extraction, ["artifact", "candidate", "factCard", "lineage", "reasonCodes", "status"]) ||
      !isPlainRecord(extraction.artifact) || typeof extraction.artifact.id !== "string" || extraction.artifact.id.length > 256 ||
      !Array.isArray(extraction.reasonCodes) || extraction.reasonCodes.some((code) => typeof code !== "string" || code.length > 64)) throw new Error();
  if (result.status === "COMPLETED") {
    if (result.reviewStage !== null || extraction.status !== "READY" || !isPlainRecord(result.goldenPath) ||
        result.goldenPath.status !== "COMPLETED" || !isPlainRecord(result.goldenPath.attachment) ||
        !isPlainRecord(result.goldenPath.attachment.workflow) || typeof result.goldenPath.attachment.workflow.id !== "string" ||
        !isPlainRecord(result.goldenPath.expectation) || !isPlainRecord(result.goldenPath.expectation.expectation) ||
        typeof result.goldenPath.expectation.expectation.id !== "string" ||
        !["OPEN", "MET", "UNMET", "VOIDED"].includes(result.goldenPath.expectation.expectation.state as string) ||
        !isPlainRecord(result.goldenPath.verification) || !isPlainRecord(result.goldenPath.verification.result) ||
        !["PENDING", "VERIFIED", "CONFLICT"].includes(result.goldenPath.verification.result.status as string)) throw new Error();
    return;
  }
  if (result.status !== "REVIEW_REQUIRED" || !["EXTRACTION", "COMPOSITION"].includes(result.reviewStage as string) ||
      (result.reviewStage === "EXTRACTION" && extraction.status !== "REVIEW_REQUIRED") ||
      (result.reviewStage === "COMPOSITION" && extraction.status !== "READY") ||
      (result.goldenPath !== null && !isPlainRecord(result.goldenPath))) throw new Error();
}

function mapExtractionError(error: unknown): { status: number; body: { error: string; message: string } } {
  const code = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
  if (code === "UNSUPPORTED_CONTENT_TYPE") return publicError(415, code, "Content-Type is not supported.");
  if (code === "REQUEST_TOO_LARGE") return publicError(413, code, "Request body is too large.");
  if (code === "REQUEST_TIMEOUT") return publicError(504, code, "Request timed out; retry the exact command.");
  if (code === "INVALID_IDEMPOTENCY_KEY") return publicError(400, code, "Idempotency-Key is invalid.");
  if (code === "IDEMPOTENCY_KEY_MISMATCH") return publicError(400, code, "Idempotency-Key does not match requestId.");
  if (code === "PERSISTED_TRANSPORT_UNAVAILABLE") return publicError(503, code, "Persisted extraction transport is unavailable.");
  if (["OBJECT_NOT_FOUND", "OBJECT_INTEGRITY_FAILED", "EVIDENCE_UNAVAILABLE", "STORED_OBJECT_REF_CONFLICT"].includes(code)) {
    return publicError(422, "EVIDENCE_UNAVAILABLE", "Referenced evidence is unavailable.");
  }
  if (["EXTRACTION_REQUEST_CONFLICT", "REQUEST_CONFLICT", "ARTIFACT_ID_CONFLICT", "FACT_CARD_ID_CONFLICT"].includes(code)) {
    return publicError(409, "REQUEST_CONFLICT", "The request conflicts with an existing operation.");
  }
  if (["ROLE_SCOPE_VIOLATION", "TENANT_SCOPE_VIOLATION", "INVALID_ACTOR_CONTEXT", "FORBIDDEN"].includes(code)) {
    return publicError(403, "FORBIDDEN", "The request is not permitted.");
  }
  if (["MALFORMED_JSON", "INVALID_REQUEST", "INVALID_EXTRACTION_COMMAND", "INVALID_CONSEQUENCE_OPERATION"].includes(code)) {
    return publicError(400, "INVALID_REQUEST", "Request body is invalid.");
  }
  return publicError(500, "INTERNAL_ERROR", "Unexpected extraction error.");
}

function publicError(status: number, error: string, message: string) {
  return { status, body: { error, message } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error("INVALID_PREVIEW_TIMEOUT");
  }
  return value;
}

/** Parse JSON with the platform parser while separately rejecting duplicate keys. */
function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index += 1; };
  const string = () => {
    if (text[index] !== '"') throw new Error();
    const start = index;
    index += 1;
    for (;;) {
      const char = text[index++];
      if (char === undefined) throw new Error();
      if (char === "\\") { if (text[index++] === undefined) throw new Error(); continue; }
      if (char === '"') return JSON.parse(text.slice(start, index)) as string;
      if (char < " ") throw new Error();
    }
  };
  const value = () => {
    whitespace();
    const char = text[index];
    if (char === "{") {
      index += 1; whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") { index += 1; return; }
      for (;;) {
        const key = string();
        if (keys.has(key)) throw new Error();
        keys.add(key); whitespace();
        if (text[index++] !== ":") throw new Error();
        value(); whitespace();
        const next = text[index++];
        if (next === "}") return;
        if (next !== ",") throw new Error();
        whitespace();
      }
    }
    if (char === "[") {
      index += 1; whitespace();
      if (text[index] === "]") { index += 1; return; }
      for (;;) {
        value(); whitespace();
        const next = text[index++];
        if (next === "]") return;
        if (next !== ",") throw new Error();
        whitespace();
      }
    }
    if (char === '"') { string(); return; }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
    if (start === index || !["true", "false", "null"].includes(text.slice(start, index)) &&
        !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text.slice(start, index))) throw new Error();
  };
  value(); whitespace();
  if (index !== text.length) throw new Error();
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("INVALID_PREVIEW_INPUT", "Expected a string value.");
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}

function rejectUnexpectedKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new DomainError(
      code,
      `Authority and application fields are server-controlled: ${unexpected.join(", ")}.`,
    );
  }
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 64_000) {
      throw new DomainError("REQUEST_TOO_LARGE", "Preview request body is too large.");
    }
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new DomainError("MALFORMED_JSON", "Request body must be a JSON object.");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Uint8Array,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

if (import.meta.main) {
  const host = process.env.PREVIEW_HOST ?? "127.0.0.1";
  const port = Number(process.env.PREVIEW_PORT ?? 3000);
  const server = createConfiguredPreviewServer();
  server.listen(port, host, () => {
    console.log(`Employee: http://${host}:${port}/employee`);
    console.log(`Manager:  http://${host}:${port}/manager`);
  });
}
