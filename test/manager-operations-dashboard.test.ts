import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manager dashboard reuses safe attention projection without adding a decision path", async () => {
  const source = await readFile(new URL("../src/preview/public/app.js", import.meta.url), "utf8");

  assert.match(source, /postgresClinical \? api\("\/api\/manager\/attention-gaps"\) : Promise\.resolve\(\[\]\)/);
  assert.match(source, /managerAttentionItems = validateManagerAttentionItems\(attention\)/);
  assert.match(source, /const attention = managerAttentionItems\.length/);
  assert.match(source, /attentionOnly \? managerAttentionItems\.map\(attentionCard\)/);
  assert.match(source, /function attentionCard\(item\)/);
  const attentionCard = source.slice(source.indexOf("function attentionCard"), source.indexOf("function decisionForm"));
  assert.doesNotMatch(attentionCard, /<form|decisionForm|\/api\/manager\/decisions/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*attention/i);
});
