import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manager preview keeps its command center UI local, bounded and decision-controlled", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/preview/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/preview/public/app.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /class="manager-shell"/);
  assert.match(source, /class="manager-sidebar"/);
  assert.match(source, /class="sidebar-summary"/);
  assert.match(source, /data-filter="attention"/);
  assert.match(source, /function decisionForm\(item\)/);
  assert.match(source, /api\("\/api\/manager\/decisions", \{ method: "POST"/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*(?:manager|attention|closure|scenario|decision)/i);
  assert.doesNotMatch(source, /console\./);
  assert.match(css, /\.manager-shell/);
  assert.match(css, /\.manager-sidebar/);
  assert.match(css, /@media \(max-width: 760px\)/);
});
