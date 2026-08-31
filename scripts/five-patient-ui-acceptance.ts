import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

import { DomainError } from "../src/domain/errors.ts";
import { createPreviewServer } from "../src/preview/server.ts";
import {
  createPersistedClosureHarness,
  type PersistedClosureHarness,
} from "./persisted-closure-demo.ts";

type Case = "NORMAL_CLOSE" | "MISSING_REPORT" | "LATE_REPORT" | "CONFLICTING_REPORT" | "EXACT_REPLAY";
type CaseSummary = { case: Case; employee: "COMPLETE" | "OPEN" | "UNMET"; manager: "CLOSED" | "ATTENTION" };

export type FivePatientUiAcceptanceSummary = {
  status: "PASSED";
  cases: readonly [CaseSummary, CaseSummary, CaseSummary, CaseSummary, CaseSummary];
};

export async function runFivePatientUiAcceptance(): Promise<FivePatientUiAcceptanceSummary> {
  return Object.freeze({
    status: "PASSED" as const,
    cases: [
      await normalClose(),
      await missingReport(),
      await lateReport(),
      await conflictingReport(),
      await exactReplay(),
    ] as const,
  });
}

async function normalClose(): Promise<CaseSummary> {
  return run("DEMO-FIVE-01", "five-normal", async (harness) => {
    await harness.register();
    await harness.prescribe();
    const report = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await harness.submit(report.expectationId, object);
    const payment = await harness.selectOpenPaymentExpectation();
    await harness.pay();
    await harness.close(payment.expectationId);
    const closures = await harness.backend.listManagerClosures(harness.manager);
    if (closures.length === 0 || closures.some((item) => item.workflowStatus !== "CLOSED") ||
        (await harness.backend.listManagerAttentionGaps!(harness.manager)).length !== 0) {
      fail("NORMAL_CLOSE");
    }
    return { case: "NORMAL_CLOSE", employee: "COMPLETE", manager: "CLOSED" };
  });
}

async function missingReport(): Promise<CaseSummary> {
  return run("DEMO-FIVE-02", "five-missing", async (harness) => {
    await harness.register();
    await harness.prescribe();
    await harness.selectOpenExpectation();
    await expectAttention(harness, "MISSING", "MISSING_EXAM_REPORT");
    return { case: "MISSING_REPORT", employee: "OPEN", manager: "ATTENTION" };
  });
}

async function lateReport(): Promise<CaseSummary> {
  return run("DEMO-FIVE-03", "five-late", async (harness) => {
    await harness.register();
    await harness.prescribe();
    const report = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await harness.markDue("2026-08-30T09:35:00.000Z");
    try {
      await harness.submit(report.expectationId, object, {
        occurredAt: "2026-08-30T09:36:00.000Z",
        createdAt: "2026-08-30T09:36:30.000Z",
        attachedAt: "2026-08-30T09:37:00.000Z",
        evaluatedAt: "2026-08-30T09:37:00.000Z",
      });
      fail("LATE_REPORT");
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "EXPECTATION_SELECTION_REQUIRED") throw error;
    }
    await expectAttention(harness, "MISSING", "EXPECTATION_UNMET");
    return { case: "LATE_REPORT", employee: "UNMET", manager: "ATTENTION" };
  });
}

async function conflictingReport(): Promise<CaseSummary> {
  return run("DEMO-FIVE-04", "five-conflict", async (harness) => {
    await harness.register();
    await harness.prescribe();
    const report = await harness.selectOpenExpectation();
    const object = await harness.upload();
    const result = await harness.submit(report.expectationId, object, { occurredAt: "2026-08-30T09:04:00.000Z" }) as {
      status: string; goldenPath: { verification: { result: { status: string } } };
    };
    if (result.status !== "COMPLETED" || result.goldenPath.verification.result.status !== "CONFLICT") fail("CONFLICTING_REPORT");
    await expectNoPayment(harness);
    await expectAttention(harness, "MISSING", "TIME_CONFLICT");
    return { case: "CONFLICTING_REPORT", employee: "OPEN", manager: "ATTENTION" };
  });
}

async function exactReplay(): Promise<CaseSummary> {
  return run("DEMO-FIVE-05", "five-replay", async (harness) => {
    await harness.register();
    await harness.prescribe();
    const report = await harness.selectOpenExpectation();
    const object = await harness.upload();
    await harness.submit(report.expectationId, object);
    const before = await harness.counts();
    await harness.submit(report.expectationId, object);
    const after = await harness.counts();
    if (JSON.stringify(before) !== JSON.stringify(after) || harness.provider.calls !== 1) fail("EXACT_REPLAY");
    const payment = await harness.selectOpenPaymentExpectation();
    await harness.pay();
    const paid = await harness.counts();
    await harness.pay();
    if (JSON.stringify(paid) !== JSON.stringify(await harness.counts())) fail("EXACT_REPLAY");
    await harness.close(payment.expectationId);
    const closed = await harness.counts();
    await harness.close(payment.expectationId);
    if (JSON.stringify(closed) !== JSON.stringify(await harness.counts())) fail("EXACT_REPLAY");
    return { case: "EXACT_REPLAY", employee: "COMPLETE", manager: "CLOSED" };
  });
}

async function run(anchor: string, keyPrefix: string, action: (harness: PersistedClosureHarness) => Promise<CaseSummary>): Promise<CaseSummary> {
  const harness = await createPersistedClosureHarness(undefined, { identityAnchor: anchor, keyPrefix });
  try {
    const summary = await action(harness);
    await expectHttpProjection(harness, summary);
    return summary;
  } finally {
    await harness.dispose();
  }
}

async function expectHttpProjection(harness: PersistedClosureHarness, summary: CaseSummary): Promise<void> {
  const projectionTime = summary.employee === "UNMET"
    ? "2026-08-30T09:37:00.000Z"
    : summary.employee === "COMPLETE" ? "2026-08-30T09:17:00.000Z" : "2026-08-30T09:11:00.000Z";
  const server = createPreviewServer({
    clock: () => projectionTime,
    employeeContext: harness.employee,
    managerContext: harness.manager,
    clinicalBackend: harness.backend,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const [employeePage, managerPage, employeeResponse, closureResponse, attentionResponse] = await Promise.all([
      fetch(`${baseUrl}/employee`),
      fetch(`${baseUrl}/manager`),
      fetch(`${baseUrl}/api/employee/open-expectations?limit=25`),
      fetch(`${baseUrl}/api/manager/closures`),
      fetch(`${baseUrl}/api/manager/attention-gaps`),
    ]);
    if (![employeePage, managerPage, employeeResponse, closureResponse, attentionResponse]
      .every((response) => response.status === 200)) fail("HTTP_PROJECTION");
    const [employeeHtml, managerHtml, employee, closures, attention] = await Promise.all([
      employeePage.text(), managerPage.text(), employeeResponse.json(), closureResponse.json(), attentionResponse.json(),
    ]) as [string, string, { items?: unknown[] }, Array<{ workflowStatus?: string }>, unknown[]];
    if (!employeeHtml.includes("app.js") || !managerHtml.includes("app.js") ||
        !Array.isArray(employee.items) || !Array.isArray(closures) || !Array.isArray(attention)) fail("HTTP_PROJECTION");
    const expectedOpen = summary.employee === "OPEN" ? 1 : 0;
    const expectedAttention = summary.manager === "ATTENTION" ? 1 : 0;
    if (employee.items.length !== expectedOpen || attention.length !== expectedAttention) fail(`${summary.case}_HTTP_PROJECTION`);
    if (summary.manager === "CLOSED" && !closures.some((item) => item.workflowStatus === "CLOSED")) fail(`${summary.case}_HTTP_PROJECTION`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function expectAttention(
  harness: PersistedClosureHarness,
  status: "MISSING" | "CONFLICT",
  reason: string,
): Promise<void> {
  const gaps = await harness.backend.listManagerAttentionGaps!(harness.manager);
  if (gaps.length !== 1 || gaps[0]?.alignmentStatus !== status || !gaps[0].reasonCodes.includes(reason)) fail("ATTENTION_PROJECTION");
}

async function expectNoPayment(harness: PersistedClosureHarness): Promise<void> {
  try {
    await harness.selectOpenPaymentExpectation();
  } catch (error) {
    if (error instanceof DomainError && error.code === "CLOSURE_DEMO_PAYMENT_SELECTION_FAILED") return;
  }
  fail("CONFLICTING_REPORT");
}

function fail(caseName: string): never {
  throw new DomainError("FIVE_PATIENT_ACCEPTANCE_FAILED", `Acceptance case failed: ${caseName}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFivePatientUiAcceptance().then(
    (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
    () => { process.stdout.write('{"status":"FAILED"}\n'); process.exitCode = 1; },
  );
}
