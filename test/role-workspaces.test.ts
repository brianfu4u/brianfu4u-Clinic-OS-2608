import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";

import type { ClinicalPreviewBackend } from "../src/preview/clinical-preview-backend.ts";
import { createPreviewServer, type EmployeeWorkspace } from "../src/preview/server.ts";

const completed = { status: "COMPLETED" as const, expectationId: "expectation-safe", expectationState: "OPEN" as const, verificationStatus: "PENDING" as const };

function backend(): ClinicalPreviewBackend {
  return {
    async listOpenExamReportExpectations() {
      return { items: [{ expectationId: "expectation-safe", workflowFamily: "EYE_EXAM", consequenceKind: "EXAM_REPORT", dueAt: "2026-08-30T09:30:00.000Z", state: "OPEN" }], nextCursor: null };
    },
    async createRegistrationTrigger() { return completed; },
    async createPrescriptionTrigger() { return completed; },
    async createPaymentTrigger() { return { ...completed, expectationState: "MET" as const, verificationStatus: "VERIFIED" as const }; },
    async listManagerClosures() { return []; },
    async submitManagerDecision() { throw new Error("not used"); },
  };
}

async function withWorkspace(workspace: EmployeeWorkspace, run: (baseUrl: string) => Promise<void>) {
  const instance = createPreviewServer({
    employeeWorkspace: workspace,
    clinicalBackend: backend(),
    clock: () => "2026-08-30T09:10:00.000Z",
  });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  try { await run(baseUrl); }
  finally { await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())); }
}

async function json(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

function stageRequest(key: string): RequestInit {
  return {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ identityAnchor: "DEMO-001", occurredAt: "2026-08-30T09:00:00.000Z" }),
  };
}

test("server injects one bounded workspace and rejects cross-workspace commands before a backend call", async () => {
  const cases: Array<[EmployeeWorkspace, string]> = [
    ["RECEPTION", "/api/employee/registration-trigger"],
    ["DOCTOR", "/api/employee/prescription-trigger"],
    ["CASHIER", "/api/employee/payment-trigger"],
  ];
  for (const [workspace, allowedPath] of cases) {
    await withWorkspace(workspace, async (baseUrl) => {
      const bootstrap = await json(baseUrl, "/api/employee/bootstrap");
      assert.equal(bootstrap.body.workspace, workspace);
      assert.equal((await json(baseUrl, allowedPath, stageRequest(`allowed-${workspace}`))).response.status, 201);
      const denied = await json(baseUrl, "/api/employee/registration-trigger", stageRequest(`denied-${workspace}`));
      if (workspace === "RECEPTION") assert.equal(denied.response.status, 201);
      else {
        assert.equal(denied.response.status, 400);
        assert.equal(denied.body.error, "FORBIDDEN");
      }
    });
  }
});

test("exam workspace alone can read report work, and forwarding role-looking headers is rejected", async () => {
  await withWorkspace("EXAM", async (baseUrl) => {
    const open = await json(baseUrl, "/api/employee/open-expectations?limit=25");
    assert.equal(open.response.status, 200);
    assert.equal(open.body.items.length, 1);
    const spoofed = await json(baseUrl, "/api/employee/open-expectations?limit=25", { headers: { "x-workspace": "EXAM" } });
    assert.equal(spoofed.response.status, 400);
    assert.equal(spoofed.body.error, "FORBIDDEN");
  });
  await withWorkspace("DOCTOR", async (baseUrl) => {
    const denied = await json(baseUrl, "/api/employee/open-expectations?limit=25");
    assert.equal(denied.response.status, 400);
    assert.equal(denied.body.error, "FORBIDDEN");
  });
});

test("browser workspace is presentation-only: one fixed task, exam-only upload, and no workspace persistence", async () => {
  const source = await readFile(new URL("../src/preview/public/app.js", import.meta.url), "utf8");
  assert.match(source, /employeeWorkspace = validateWorkspace\(bootstrap\.workspace\)/);
  assert.match(source, /kindForWorkspace\(employeeWorkspace\)/);
  assert.match(source, /<input type="hidden" name="kind" value="\$\{composerKind\}">/);
  assert.doesNotMatch(source, /<select name="kind">/);
  assert.match(source, /const report = form\.elements\.kind\.value === "EXAM_REPORT"/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*(?:workspace|role|expectation|identity)/i);
});
