const strings = {
  ja: {
    product: "Clinic OS · 合成データプレビュー", employee: "スタッフ", manager: "店長画面",
    newTopic: "新しいトピック", state: "勤務状態", onDuty: "勤務中", onBreak: "休憩中", offDuty: "退勤",
    conversation: "会話", work: "業務更新として記録", send: "送信", topicTitle: "トピック名",
    message: "メッセージ", kind: "種類", anchor: "合成ID（DEMO-）", family: "ワークフロー",
    occurredAt: "発生日時", synthetic: "認証なしのローカル非本番画面です。実データを入力しないでください。",
    all: "すべて", review: "要確認", open: "進行中", complete: "完了", refresh: "更新",
    noItems: "表示するワークフローはありません。", needsReview: "要確認", quiet: "確認不要",
    action: "店長アクション", reason: "理由コード", note: "任意メモ", decide: "決定を記録", latest: "最新決定",
  },
  zh: {
    product: "Clinic OS · 合成数据预览", employee: "员工端", manager: "店长端",
    newTopic: "新主题", state: "工作状态", onDuty: "在岗", onBreak: "休息", offDuty: "下班",
    conversation: "对话", work: "记录为工作更新", send: "发送", topicTitle: "主题名称",
    message: "消息", kind: "类型", anchor: "合成编号（DEMO-）", family: "工作流",
    occurredAt: "发生时间", synthetic: "这是未经认证的本地非生产预览。请勿输入真实数据。",
    all: "全部", review: "需复核", open: "进行中", complete: "完成", refresh: "刷新",
    noItems: "暂无工作流。", needsReview: "需要复核", quiet: "无需复核",
    action: "店长操作", reason: "原因代码", note: "可选备注", decide: "记录决定", latest: "最近决定",
  },
  en: {
    product: "Clinic OS · Synthetic preview", employee: "Employee", manager: "Manager",
    newTopic: "New topic", state: "Work status", onDuty: "On duty", onBreak: "On break", offDuty: "Off duty",
    conversation: "Conversation", work: "Record as work update", send: "Send", topicTitle: "Topic title",
    message: "Message", kind: "Kind", anchor: "Synthetic ID (DEMO-)", family: "Workflow",
    occurredAt: "Occurred at", synthetic: "Unauthenticated local non-production preview. Do not enter real data.",
    all: "All", review: "Needs review", open: "Open", complete: "Complete", refresh: "Refresh",
    noItems: "No workflows to display.", needsReview: "Needs review", quiet: "No review needed",
    action: "Manager action", reason: "Reason code", note: "Optional note", decide: "Record decision", latest: "Latest decision",
  },
};

let language = localStorage.getItem("clinic-os-language") || "ja";
let bootstrap = null;
let activeTopicId = null;
let managerItems = [];
let managerFilter = "all";
const app = document.querySelector("#app");
const t = (key) => strings[language][key];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error);
  return body;
}

function languageButtons() {
  return `<div class="language" aria-label="Language">
    ${["ja", "zh", "en"].map((code) => `<button type="button" data-language="${code}" aria-pressed="${language === code}">${code.toUpperCase()}</button>`).join("")}
  </div>`;
}

function bindLanguage() {
  document.querySelectorAll("[data-language]").forEach((button) => button.addEventListener("click", () => {
    language = button.dataset.language;
    localStorage.setItem("clinic-os-language", language);
    render();
  }));
}

async function loadEmployee() {
  bootstrap = await api("/api/employee/bootstrap");
  activeTopicId ||= bootstrap.topics.at(-1)?.id || null;
  renderEmployee();
}

function renderEmployee() {
  const topic = bootstrap.topics.find(({ id }) => id === activeTopicId);
  const messages = bootstrap.messages.filter(({ topicId }) => topicId === activeTopicId);
  app.innerHTML = `<div class="shell">
    <aside class="rail"><h1>${t("product")}</h1><p><a href="/manager">${t("manager")}</a></p>
      <label for="employee-state">${t("state")}</label>
      <select id="employee-state"><option value="ON_DUTY">${t("onDuty")}</option><option value="ON_BREAK">${t("onBreak")}</option><option value="OFF_DUTY">${t("offDuty")}</option></select>
      <button type="button" id="new-topic">＋ ${t("newTopic")}</button>
      <ul class="topics">${topicList()}</ul>
    </aside>
    <main class="main"><div class="topbar"><h2>${escapeHtml(topic?.title || t("employee"))}</h2>${languageButtons()}</div>
      <p class="notice">${t("synthetic")}</p>
      <section class="thread" aria-label="Message thread">${messages.map((message) => `<div class="message ${message.role === "EMPLOYEE" ? "employee" : ""}">${escapeHtml(message.text)}</div>`).join("") || `<p class="empty">${t("newTopic")}</p>`}</section>
      ${topic ? composer() : ""}
    </main></div>`;
  document.querySelector("#employee-state").value = bootstrap.status;
  document.querySelector("#employee-state").addEventListener("change", async (event) => {
    await api("/api/employee/status", { method: "PUT", body: JSON.stringify({ status: event.target.value }) });
    await loadEmployee();
  });
  document.querySelector("#new-topic").addEventListener("click", async () => {
    const title = prompt(t("topicTitle"));
    if (!title) return;
    const topic = await api("/api/employee/topics", { method: "POST", body: JSON.stringify({ title }) });
    activeTopicId = topic.id;
    await loadEmployee();
  });
  document.querySelectorAll("[data-topic]").forEach((button) => button.addEventListener("click", () => {
    activeTopicId = button.dataset.topic;
    renderEmployee();
  }));
  bindLanguage();
  bindComposer();
}

function topicList() {
  let previousDate = "";
  return bootstrap.topics.map((item) => {
    const date = new Date(item.createdAt);
    const dateLabel = date.toLocaleDateString(language);
    const heading = dateLabel === previousDate ? "" : `<li class="topic-date">${escapeHtml(dateLabel)}</li>`;
    previousDate = dateLabel;
    return `${heading}<li><button type="button" data-topic="${item.id}">${escapeHtml(item.title)}<br><small>${date.toLocaleTimeString(language)}</small></button></li>`;
  }).join("");
}

function composer() {
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return `<form class="composer" id="composer"><div class="mode">
    <label><input type="radio" name="mode" value="conversation" checked> ${t("conversation")}</label>
    <label><input type="radio" name="mode" value="work"> ${t("work")}</label></div>
    <div class="work-fields" hidden>
      <label>${t("kind")}<select name="kind"><option value="REGISTRATION">REGISTRATION</option><option value="EXAM_REPORT">EXAM_REPORT</option></select></label>
      <label>${t("anchor")}<input name="identityAnchor" value="DEMO-001" required></label>
      <label>${t("family")}<input name="workflowFamily" value="EYE_EXAM" readonly></label>
      <label>${t("occurredAt")}<input name="occurredAt" type="datetime-local" value="${local}" required></label>
    </div>
    <label for="message-text">${t("message")}</label><textarea id="message-text" name="text" required></textarea>
    <button class="primary" type="submit">${t("send")}</button><p id="form-error" role="alert"></p>
  </form>`;
}

function bindComposer() {
  const form = document.querySelector("#composer");
  if (!form) return;
  form.querySelectorAll('[name="mode"]').forEach((radio) => radio.addEventListener("change", () => {
    form.querySelector(".work-fields").hidden = form.elements.mode.value !== "work";
  }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      if (data.get("mode") === "work") {
        await api("/api/employee/work-updates", { method: "POST", body: JSON.stringify({
          topicId: activeTopicId, kind: data.get("kind"), identityAnchor: data.get("identityAnchor"),
          workflowFamily: data.get("workflowFamily"), occurredAt: new Date(data.get("occurredAt")).toISOString(), text: data.get("text"),
        }) });
      } else {
        await api("/api/employee/messages", { method: "POST", body: JSON.stringify({ topicId: activeTopicId, text: data.get("text") }) });
      }
      await loadEmployee();
    } catch (error) {
      form.querySelector("#form-error").textContent = error.message;
    }
  });
}

async function loadManager() {
  managerItems = await api("/api/manager/closures");
  renderManager();
}

function renderManager() {
  const visible = managerItems.filter((item) => managerFilter === "all" ||
    (managerFilter === "review" && item.needsReview) ||
    (managerFilter === "open" && item.expectationState === "OPEN") ||
    (managerFilter === "complete" && (item.workflowStatus !== "OPEN" || item.expectationState === "MET")));
  app.innerHTML = `<main class="main"><div class="topbar"><div><h1>${t("manager")}</h1><a href="/employee">${t("employee")}</a></div>${languageButtons()}</div>
    <p class="notice">${t("synthetic")}</p><div class="filters">
      ${[["all", "all"], ["review", "review"], ["open", "open"], ["complete", "complete"]].map(([value, key]) => `<button type="button" data-filter="${value}" aria-pressed="${managerFilter === value}">${t(key)}</button>`).join("")}
      <button type="button" id="refresh">${t("refresh")}</button></div>
    <section class="cards">${visible.map((item) => `<article class="card ${item.needsReview ? "review" : ""}">
      <h2>${escapeHtml(item.identityAnchor)} · ${escapeHtml(item.workflowFamily)}</h2>
      <p><strong>${escapeHtml(item.expectationState)}</strong> · ${item.needsReview ? t("needsReview") : t("quiet")}</p>
      <p class="muted">Workflow: ${escapeHtml(item.workflowId)}<br>Evidence: ${item.evidenceArtifactIds.map(escapeHtml).join(", ") || "—"}<br>Reasons: ${item.reasonCodes.map(escapeHtml).join(", ") || "—"}</p>
      ${item.latestDecision ? `<p>${t("latest")}: ${escapeHtml(item.latestDecision.action)}${item.latestDecision.reasonCode ? ` · ${escapeHtml(item.latestDecision.reasonCode)}` : ""}</p>` : ""}
      ${decisionForm(item)}
    </article>`).join("") || `<p class="empty">${t("noItems")}</p>`}</section></main>`;
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    managerFilter = button.dataset.filter;
    renderManager();
  }));
  document.querySelector("#refresh").addEventListener("click", loadManager);
  document.querySelectorAll("[data-decision-form]").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await api("/api/manager/decisions", { method: "POST", body: JSON.stringify({
        workflowId: form.dataset.workflowId,
        action: data.get("action"),
        reasonCode: data.get("reasonCode") || null,
        note: data.get("note") || null,
      }) });
      await loadManager();
    } catch (error) {
      form.querySelector('[role="alert"]').textContent = error.message;
    }
  }));
  bindLanguage();
}

function decisionForm(item) {
  if (item.workflowStatus !== "OPEN") return "";
  const actions = item.expectationState === "MET"
    ? ["CLOSE_STANDARD", "VOID"]
    : item.expectationState === "UNMET"
      ? ["CLOSE_EXCEPTION", "KEEP_OPEN", "VOID"]
      : ["KEEP_OPEN", "VOID"];
  const reasons = ["LEGITIMATE_DEVIATION", "MISSING_EXTERNAL_RECORD", "DUPLICATE_WORKFLOW", "PATIENT_CANCELLED", "NEEDS_MORE_EVIDENCE"];
  return `<form class="decision-form" data-decision-form data-workflow-id="${escapeHtml(item.workflowId)}">
    <label>${t("action")}<select name="action">${actions.map((action) => `<option>${action}</option>`).join("")}</select></label>
    <label>${t("reason")}<select name="reasonCode"><option value="">—</option>${reasons.map((reason) => `<option>${reason}</option>`).join("")}</select></label>
    <label>${t("note")}<input name="note" maxlength="500"></label>
    <button class="primary" type="submit">${t("decide")}</button><p role="alert"></p>
  </form>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function render() {
  document.documentElement.lang = language;
  if (location.pathname === "/manager") renderManager();
  else renderEmployee();
}

if (location.pathname === "/manager") loadManager().catch(showFatal);
else loadEmployee().catch(showFatal);

function showFatal(error) {
  app.innerHTML = `<main class="main"><p role="alert">${escapeHtml(error.message)}</p></main>`;
}
