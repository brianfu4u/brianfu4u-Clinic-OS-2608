import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("employee preview keeps chat and capture separate in an accessible sidebar workspace", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/preview/public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/preview/public/app.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /class="employee-sidebar"/);
  assert.match(source, /data-composer-mode="conversation"/);
  assert.match(source, /data-composer-mode="work"/);
  assert.match(source, /function topicList\(\)/);
  assert.match(source, /function conversationThread\(\)/);
  assert.match(source, /api\("\/api\/employee\/messages", \{ method: "POST", body: JSON\.stringify\(\{ topicId: activeTopicId, text: data\.get\("text"\) \}\) \}\)/);
  assert.match(source, /<input type="hidden" name="kind" value="\$\{composerKind\}">/);
  assert.match(source, /class="evidence-upload" data-evidence-upload/);
  assert.match(source, /uploadEvidence/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^)]*(?:workspace|role|topic|message|expectation|identity)/i);
  assert.doesNotMatch(source, /console\./);
  assert.match(css, /\.employee-shell/);
  assert.match(css, /\.chat-composer/);
  assert.match(css, /\.evidence-upload/);
  assert.match(css, /@media \(max-width: 760px\)/);
});
