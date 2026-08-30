import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DomainError } from "../domain/errors.ts";
import type { ActorContext, ManagerDecisionAction } from "../domain/contracts.ts";
import { assertActorAccess, assertActorContext } from "../domain/access-context.ts";
import { createNodePgPool } from "../persistence/node-pg-pool.ts";
import { PreviewStore, type EmployeeStatus } from "./preview-store.ts";
import type { ClinicalPreviewBackend } from "./clinical-preview-backend.ts";
import { PostgresClinicalPreviewBackend, requireIdempotencyKey } from "./clinical-preview-backend.ts";

const PUBLIC_FILES = new Map([
  ["/app.css", { file: "public/app.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "public/app.js", type: "text/javascript; charset=utf-8" }],
]);
const INDEX_FILE = fileURLToPath(new URL("./public/index.html", import.meta.url));

export function createPreviewServer(options: {
  store?: PreviewStore;
  clock?: () => string;
  employeeContext?: ActorContext;
  managerContext?: ActorContext;
  clinicalBackend?: ClinicalPreviewBackend;
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
  const pool = createNodePgPool(env.DATABASE_URL);
  const server = createPreviewServer({ clinicalBackend: new PostgresClinicalPreviewBackend(pool) });
  server.once("close", () => { void pool.close(); });
  return server;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  store: PreviewStore,
  clock: () => string,
  employeeContext: ActorContext,
  managerContext: ActorContext,
  clinicalBackend?: ClinicalPreviewBackend,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

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
    const result = await clinicalBackend.submitWorkUpdate(employeeContext, {
      kind: input.kind,
      identityAnchor: input.identityAnchor,
      workflowFamily: "EYE_EXAM",
      occurredAt: input.occurredAt,
      text: input.text,
      expectationId: body.expectationId === undefined ? undefined : asString(body.expectationId),
      idempotencyKey: requireIdempotencyKey(request.headers["idempotency-key"]),
      receivedAt: input.now,
    });
    store.appendWorkUpdateResult(
      employeeContext,
      input,
      `${result.workflowId ?? "REVIEW_REQUIRED"} · ${result.expectationState ?? result.status}`,
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
