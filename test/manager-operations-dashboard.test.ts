import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manager dashboard reuses safe attention and guidance projections without adding a decision path", async () => {
  const source = await readFile(new URL("../src/preview/public/app.js", import.meta.url), "utf8");

  assert.match(source, /postgresClinical \? api\("\/api\/manager\/attention-gaps"\) : Promise\.resolve\(\[\]\)/);
  assert.match(source, /managerAttentionItems = validateManagerAttentionItems\(attention\)/);
  assert.match(source, /managerAttentionGuidance = validateManagerAttentionGuidance\(guidance, managerAttentionItems\.length\)/);
  assert.match(source, /postgresClinical \? api\("\/api\/manager\/attention-guidance"\) : Promise\.resolve\(\[\]\)/);
  assert.match(source, /const attention = managerAttentionItems\.length/);
  assert.match(source, /attentionOnly \? managerAttentionItems\.map\(\(item, index\) => attentionCard\(item, managerAttentionGuidance\[index\]\)\)/);
  assert.match(source, /function attentionCard\(item, guidance\)/);
  const attentionCard = source.slice(source.indexOf("function attentionCard"), source.indexOf("function decisionForm"));
  assert.doesNotMatch(attentionCard, /<form|decisionForm|\/api\/manager\/decisions/);
  assert.doesNotMatch(attentionCard, /workflowId|identityAnchor|modelId|endpoint/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*attention/i);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*guidance/i);
});
