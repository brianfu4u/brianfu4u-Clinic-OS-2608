import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runFivePatientUiAcceptance } from "../scripts/five-patient-ui-acceptance.ts";

test("five synthetic patient acceptance uses the employee and manager projections with bounded output", async () => {
  const summary = await runFivePatientUiAcceptance();
  assert.deepEqual(summary, {
    status: "PASSED",
    cases: [
      { case: "NORMAL_CLOSE", employee: "COMPLETE", manager: "CLOSED" },
      { case: "MISSING_REPORT", employee: "OPEN", manager: "ATTENTION" },
      { case: "LATE_REPORT", employee: "UNMET", manager: "ATTENTION" },
      { case: "CONFLICTING_REPORT", employee: "OPEN", manager: "ATTENTION" },
      { case: "EXACT_REPLAY", employee: "COMPLETE", manager: "CLOSED" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(summary), /DEMO-|path|object|ocr|model|note|artifact|workflow/i);
});

test("visible employee and manager pages retain the bounded API routes used by acceptance", async () => {
  const [page, server] = await Promise.all([
    readFile(new URL("../src/preview/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/preview/server.ts", import.meta.url), "utf8"),
  ]);
  for (const route of ["/api/employee/open-expectations", "/api/manager/closures", "/api/manager/attention-gaps"]) {
    assert.match(page + server, new RegExp(route));
  }
});
