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
    expectation: "予期", verification: "S2検証",
    hybrid: "PostgreSQL臨床チェーンは永続化・会話と勤務状態は再起動で消去",
    evidenceFile: "証拠ファイル（PNG/JPEG/PDF）", evidenceHelp: "このファイルはサーバーで保存・抽出されます。",
    evidenceUnavailable: "永続化された証拠アップロードはこの合成プレビューでは利用できません。",
    missingExpectation: "処理する未完了の検査レポートを選択してください。",
    expectationSelect: "未完了の検査レポート", expectationLoading: "未完了の検査レポートを読み込み中…", expectationEmpty: "選択できる未完了の検査レポートはありません。",
    chooseEvidence: "PNG、JPEG、またはPDFファイルを選択してください。",
    registrationRecorded: "受付登録を記録しました。次に未完了の検査レポートを選択してください。",
    evidenceCompleted: "証拠を処理しました", extractionReview: "証拠の抽出に確認が必要です。", compositionReview: "ワークフロー照合に確認が必要です。",
    networkError: "プレビューサービスに接続できませんでした。もう一度お試しください。",
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
    expectation: "预期状态", verification: "S2验证",
    hybrid: "PostgreSQL临床链持久化；对话和工作状态重启后清空",
    evidenceFile: "证据文件（PNG/JPEG/PDF）", evidenceHelp: "文件将由服务器保存并进行抽取。",
    evidenceUnavailable: "合成预览不提供持久化证据上传。",
    missingExpectation: "请选择要处理的未完成检查报告。",
    expectationSelect: "待处理检查报告", expectationLoading: "正在读取待处理检查报告…", expectationEmpty: "没有可选择的待处理检查报告。",
    chooseEvidence: "请选择PNG、JPEG或PDF文件。",
    registrationRecorded: "登记已记录。请接着选择待处理检查报告。",
    evidenceCompleted: "证据已处理", extractionReview: "证据抽取需要复核。", compositionReview: "工作流匹配需要复核。",
    networkError: "无法连接预览服务，请重试。",
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
    expectation: "Expectation", verification: "S2 verification",
    hybrid: "PostgreSQL clinical chain is durable; chat and work status reset on restart",
    evidenceFile: "Evidence file (PNG/JPEG/PDF)", evidenceHelp: "The server will store and extract this file.",
    evidenceUnavailable: "Durable evidence upload is unavailable in the synthetic preview.",
    missingExpectation: "Select an open exam report expectation first.",
    expectationSelect: "Open exam report", expectationLoading: "Loading open exam reports…", expectationEmpty: "No selectable open exam reports.",
    chooseEvidence: "Choose a PNG, JPEG, or PDF evidence file.",
    registrationRecorded: "Registration recorded. Select an open exam report next.",
    evidenceCompleted: "Evidence processed", extractionReview: "Evidence extraction needs review.", compositionReview: "Workflow matching needs review.",
    networkError: "The preview service could not be reached. Please try again.",
  },
};

let language = localStorage.getItem("clinic-os-language") || "ja";
let bootstrap = null;
let activeTopicId = null;
let managerItems = [];
let managerFilter = "all";
let openExpectations = [];
let expectationLoadEpoch = 0;
const pendingDecisionKeys = new Map();
let postgresClinical = false;
let evidenceStatus = null;
let registrationStatus = null;
let composerMode = "conversation";
let composerKind = "REGISTRATION";
const app = document.querySelector("#app");
const t = (key) => strings[language][key];
const previewNotice = () => `${t("synthetic")}${postgresClinical ? ` ${t("hybrid")}` : ""}`;

async function api(path, options = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (options.body && !isFormData && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  let response;
  let body;
  try {
    response = await fetch(path, { ...options, headers });
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(t("networkError"));
  }
  if (!response.ok) throw new Error(safeServerError(body?.error, response.status));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(t("networkError"));
  return body;
}

function safeServerError(code, status) {
  const messages = {
    PERSISTED_UPLOAD_UNAVAILABLE: "Durable evidence upload is unavailable in this preview.",
    PERSISTED_TRANSPORT_UNAVAILABLE: "Durable evidence extraction is unavailable in this preview.",
    PERSISTED_REGISTRATION_UNAVAILABLE: "Durable registration is unavailable in this preview.",
    LEGACY_CLINICAL_COMMAND_DISABLED: "Use the explicit registration or evidence command.",
    REGISTRATION_CONFLICT: "This registration conflicts with an existing operation.",
    INVALID_REGISTRATION_REQUEST: "The registration request could not be accepted.",
    INVALID_UPLOAD: "The selected evidence could not be accepted.",
    UNSUPPORTED_CONTENT_TYPE: "Select a PNG, JPEG, or PDF evidence file.",
    UPLOAD_TOO_LARGE: "The selected evidence file is too large.",
    UPLOAD_TIMEOUT: "Evidence upload timed out. Please retry the exact operation.",
    UPLOAD_CONFLICT: "This evidence upload conflicts with an existing operation.",
    UPLOAD_UNAVAILABLE: "Evidence storage is temporarily unavailable.",
    INVALID_IDEMPOTENCY_KEY: "The operation could not be started. Please retry.",
    IDEMPOTENCY_KEY_MISMATCH: "The operation could not be started. Please retry.",
    INVALID_REQUEST: "The request could not be accepted.",
    REQUEST_TOO_LARGE: "The request is too large.",
    REQUEST_TIMEOUT: "The operation timed out. Please retry the exact operation.",
    REQUEST_CONFLICT: "This operation conflicts with an existing operation.",
    EVIDENCE_UNAVAILABLE: "The stored evidence is unavailable.",
    EXPECTATION_LIST_UNAVAILABLE: "Open expectations are temporarily unavailable.",
    FORBIDDEN: "This operation is not permitted.",
  };
  return messages[code] || (status >= 500 ? "The preview service is temporarily unavailable." : "The operation could not be completed.");
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
      <p class="notice">${previewNotice()}</p>
      ${registrationStatus ? `<p class="evidence-status success" role="status">${t("registrationRecorded")}</p>` : ""}
      ${evidenceStatus ? evidenceStatusMarkup() : ""}
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
    <label><input type="radio" name="mode" value="conversation" ${composerMode === "conversation" ? "checked" : ""}> ${t("conversation")}</label>
    <label><input type="radio" name="mode" value="work" ${composerMode === "work" ? "checked" : ""}> ${t("work")}</label></div>
    <div class="work-fields" ${composerMode === "work" ? "" : "hidden"}>
      <label>${t("kind")}<select name="kind"><option value="REGISTRATION" ${composerKind === "REGISTRATION" ? "selected" : ""}>REGISTRATION</option><option value="EXAM_REPORT" ${composerKind === "EXAM_REPORT" ? "selected" : ""}>EXAM_REPORT</option></select></label>
      <label>${t("anchor")}<input name="identityAnchor" value="DEMO-001" required></label>
      <label>${t("family")}<input name="workflowFamily" value="EYE_EXAM" readonly></label>
      <label>${t("occurredAt")}<input name="occurredAt" type="datetime-local" value="${local}" required></label>
      <div class="evidence-control" data-evidence-control hidden>
        <label for="expectation-select">${t("expectationSelect")}</label>
        <select id="expectation-select" name="expectationId" required disabled><option value="">${t("expectationLoading")}</option></select>
        <label for="evidence-file">${t("evidenceFile")}</label>
        <input id="evidence-file" name="evidenceFile" type="file" accept="image/png,image/jpeg,application/pdf" disabled>
        <p class="muted" data-evidence-help></p>
      </div>
    </div>
    <div data-message-field ${postgresClinical && composerMode === "work" ? "hidden" : ""}><label for="message-text">${t("message")}</label><textarea id="message-text" name="text" ${postgresClinical && composerMode === "work" ? "disabled" : "required"}></textarea></div>
    <button class="primary" type="submit">${t("send")}</button><p id="form-error" role="alert"></p>
  </form>`;
}

function bindComposer() {
  const form = document.querySelector("#composer");
  if (!form) return;
  form.querySelectorAll('[name="mode"]').forEach((radio) => radio.addEventListener("change", () => {
    composerMode = form.elements.mode.value;
    form.querySelector(".work-fields").hidden = form.elements.mode.value !== "work";
    updateEvidenceControl(form);
  }));
  form.elements.kind.addEventListener("change", () => { composerKind = form.elements.kind.value; registrationStatus = null; updateEvidenceControl(form); });
  form.elements.identityAnchor.addEventListener("change", () => { registrationStatus = null; updateEvidenceControl(form); });
  form.addEventListener("input", () => { delete form.dataset.idempotencyKey; });
  form.addEventListener("change", () => { delete form.dataset.idempotencyKey; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      if (data.get("mode") === "work") {
        const identityAnchor = data.get("identityAnchor");
        const kind = data.get("kind");
        if (kind === "EXAM_REPORT") {
          await submitExamReport(form, data, identityAnchor);
          return;
        }
        form.dataset.idempotencyKey ||= crypto.randomUUID();
        const result = await api(postgresClinical ? "/api/employee/registration-trigger" : "/api/employee/work-updates", { method: "POST", headers: {
          "idempotency-key": form.dataset.idempotencyKey,
        }, body: JSON.stringify(postgresClinical
          ? { identityAnchor, occurredAt: new Date(data.get("occurredAt")).toISOString() }
          : { topicId: activeTopicId, kind, identityAnchor, workflowFamily: data.get("workflowFamily"), occurredAt: new Date(data.get("occurredAt")).toISOString(), text: data.get("text") }) });
        if (postgresClinical) {
          validateRegistrationProjection(result);
          registrationStatus = result.status === "COMPLETED";
          if (result.status === "COMPLETED") await loadOpenExpectations(form);
        }
        delete form.dataset.idempotencyKey;
      } else {
        await api("/api/employee/messages", { method: "POST", body: JSON.stringify({ topicId: activeTopicId, text: data.get("text") }) });
      }
      await loadEmployee();
    } catch (error) {
      form.querySelector("#form-error").textContent = error instanceof Error ? error.message : t("networkError");
    }
  });
  updateEvidenceControl(form);
}

function updateEvidenceControl(form) {
  const control = form.querySelector("[data-evidence-control]");
  const file = form.elements.evidenceFile;
  const help = form.querySelector("[data-evidence-help]");
  const report = form.elements.kind.value === "EXAM_REPORT" && form.elements.mode.value === "work";
  const message = form.querySelector("[data-message-field]");
  const text = form.elements.text;
  message.hidden = postgresClinical && form.elements.mode.value === "work";
  text.disabled = postgresClinical && form.elements.mode.value === "work";
  text.required = !(postgresClinical && form.elements.mode.value === "work");
  control.hidden = !report;
  file.disabled = !report || !postgresClinical;
  const select = form.elements.expectationId;
  select.disabled = !report || !postgresClinical;
  help.textContent = report
    ? postgresClinical ? t("evidenceHelp") : t("evidenceUnavailable")
    : "";
  if (report && postgresClinical) void loadOpenExpectations(form);
  if (!report) {
    openExpectations = [];
  }
}

function validateRegistrationProjection(value) {
  if (!isPlainObject(value)) throw new Error(t("networkError"));
  if (value.status === "REVIEW_REQUIRED" && exactKeys(value, ["status"])) return { status: "REVIEW_REQUIRED" };
  if (value.status === "COMPLETED" && exactKeys(value, ["expectationId", "expectationState", "status", "verificationStatus"]) &&
      isBoundedId(value.expectationId) && ["OPEN", "UNMET"].includes(value.expectationState) && value.verificationStatus === "PENDING") {
    return { status: "COMPLETED", expectationState: value.expectationState };
  }
  throw new Error(t("networkError"));
}

async function loadOpenExpectations(form) {
  const epoch = ++expectationLoadEpoch;
  const select = form.elements.expectationId;
  openExpectations = [];
  select.innerHTML = `<option value="">${escapeHtml(t("expectationLoading"))}</option>`;
  select.disabled = true;
  try {
    const page = validateOpenExpectationPage(await api("/api/employee/open-expectations?limit=25"));
    if (epoch !== expectationLoadEpoch || form.elements.kind.value !== "EXAM_REPORT" || form.elements.mode.value !== "work") return;
    openExpectations = page.items;
    select.innerHTML = `<option value="">${escapeHtml(page.items.length ? t("expectationSelect") : t("expectationEmpty"))}</option>` +
      page.items.map((item) => `<option value="${escapeHtml(item.expectationId)}">${escapeHtml(`${item.workflowFamily} · ${item.consequenceKind} · ${new Date(item.dueAt).toLocaleString(language)}`)}</option>`).join("");
    select.disabled = page.items.length === 0;
  } catch {
    if (epoch !== expectationLoadEpoch) return;
    select.innerHTML = `<option value="">${escapeHtml(t("expectationEmpty"))}</option>`;
    select.disabled = true;
    openExpectations = [];
  }
}

async function submitExamReport(form, data, identityAnchor) {
  if (!postgresClinical) {
    throw new Error(t("evidenceUnavailable"));
  }
  const expectationId = data.get("expectationId");
  if (typeof expectationId !== "string" || !openExpectations.some((item) => item.expectationId === expectationId)) {
    throw new Error(t("missingExpectation"));
  }
  const file = data.get("evidenceFile");
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error(t("chooseEvidence"));
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  form.querySelector("#form-error").textContent = "";
  try {
    const uploadKey = `upload:${crypto.randomUUID()}`;
    const uploadBody = new FormData();
    uploadBody.append("file", file, safeUploadFilename(file));
    const uploaded = await api("/api/employee/evidence-objects", {
      method: "POST",
      headers: { "idempotency-key": uploadKey },
      body: uploadBody,
    });
    const objectRef = validateUploadProjection(uploaded);
    const requestId = `extract:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const occurredAt = new Date(data.get("occurredAt")).toISOString();
    const result = await api("/api/employee/extraction/exam-report", {
      method: "POST",
      headers: { "idempotency-key": requestId },
      body: JSON.stringify({
        requestId,
        artifactId: `artifact:${crypto.randomUUID()}`,
        factCardId: `fact:${crypto.randomUUID()}`,
        objectRef,
        occurredAt,
        occurredAtSource: "employee_confirmed",
        identityAnchor,
        createdAt: now,
        expectationId,
        attachedAt: now,
        evaluatedAt: now,
      }),
    });
    evidenceStatus = validateExtractionProjection(result);
    await loadEmployee();
  } finally {
    submit.disabled = false;
  }
}

function validateOpenExpectationPage(value) {
  if (!isPlainObject(value) || !exactKeys(value, ["items", "nextCursor"]) || !Array.isArray(value.items) || value.items.length > 50 ||
      !(value.nextCursor === null || (typeof value.nextCursor === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor)))) throw new Error(t("networkError"));
  const items = value.items.map((item) => {
    if (!isPlainObject(item) || !exactKeys(item, ["consequenceKind", "dueAt", "expectationId", "state", "workflowFamily"]) ||
        !isBoundedId(item.expectationId) || typeof item.workflowFamily !== "string" || item.workflowFamily.length < 1 || item.workflowFamily.length > 128 ||
        item.consequenceKind !== "EXAM_REPORT" || item.state !== "OPEN" || typeof item.dueAt !== "string" || Number.isNaN(Date.parse(item.dueAt))) throw new Error(t("networkError"));
    return { expectationId: item.expectationId, workflowFamily: item.workflowFamily, consequenceKind: "EXAM_REPORT", dueAt: item.dueAt, state: "OPEN" };
  });
  return { items, nextCursor: value.nextCursor };
}

function safeUploadFilename(file) {
  if (file.type === "image/png") return "evidence.png";
  if (file.type === "image/jpeg") return "evidence.jpg";
  return "evidence.pdf";
}

function validateUploadProjection(value) {
  if (!isPlainObject(value) || exactKeys(value, ["objectRef", "status"]) === false || value.status !== "STORED" ||
      !isPlainObject(value.objectRef) || !exactKeys(value.objectRef, ["contentSha256", "mediaType", "objectId", "sizeBytes"]) ||
      !/^upload-[a-f0-9]{64}$/.test(value.objectRef.objectId) || !/^[a-f0-9]{64}$/.test(value.objectRef.contentSha256) ||
      !Number.isSafeInteger(value.objectRef.sizeBytes) || value.objectRef.sizeBytes <= 0 || value.objectRef.sizeBytes > 25 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "application/pdf"].includes(value.objectRef.mediaType)) {
    throw new Error(t("networkError"));
  }
  return {
    objectId: value.objectRef.objectId,
    contentSha256: value.objectRef.contentSha256,
    sizeBytes: value.objectRef.sizeBytes,
    mediaType: value.objectRef.mediaType,
  };
}

function validateExtractionProjection(value) {
  if (!isPlainObject(value) || !exactKeys(value, ["artifactId", "expectationId", "expectationState", "reasonCodes", "reviewStage", "status", "verificationStatus", "workflowId"]) ||
      !["COMPLETED", "REVIEW_REQUIRED"].includes(value.status) ||
      !Array.isArray(value.reasonCodes) || value.reasonCodes.length > 16 || value.reasonCodes.some((reason) => typeof reason !== "string" || reason.length > 64) ||
      (value.artifactId !== null && !isBoundedId(value.artifactId))) {
    throw new Error(t("networkError"));
  }
  if (value.status === "COMPLETED") {
    if (value.reviewStage !== null || !isBoundedId(value.workflowId) || !isBoundedId(value.expectationId) ||
        !["OPEN", "MET", "UNMET", "VOIDED"].includes(value.expectationState) ||
        !["PENDING", "VERIFIED", "CONFLICT"].includes(value.verificationStatus)) throw new Error(t("networkError"));
    return { status: "COMPLETED", expectationState: value.expectationState, verificationStatus: value.verificationStatus };
  }
  if (!["EXTRACTION", "COMPOSITION"].includes(value.reviewStage) || value.workflowId !== null || value.expectationId !== null ||
      value.expectationState !== null || value.verificationStatus !== null) throw new Error(t("networkError"));
  return { status: "REVIEW_REQUIRED", reviewStage: value.reviewStage, reasonCodes: [...value.reasonCodes] };
}

function evidenceStatusMarkup() {
  if (evidenceStatus.status === "COMPLETED") {
    return `<p class="evidence-status success" role="status">${t("evidenceCompleted")} · ${t("expectation")}: <strong>${escapeHtml(evidenceStatus.expectationState)}</strong> · ${t("verification")}: <strong>${escapeHtml(evidenceStatus.verificationStatus)}</strong></p>`;
  }
  const label = evidenceStatus.reviewStage === "EXTRACTION" ? t("extractionReview") : t("compositionReview");
  return `<p class="evidence-status review" role="status">${label}${evidenceStatus.reasonCodes.length ? ` · ${evidenceStatus.reasonCodes.map(escapeHtml).join(", ")}` : ""}</p>`;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isBoundedId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
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
    <p class="notice">${previewNotice()}</p><div class="filters">
      ${[["all", "all"], ["review", "review"], ["open", "open"], ["complete", "complete"]].map(([value, key]) => `<button type="button" data-filter="${value}" aria-pressed="${managerFilter === value}">${t(key)}</button>`).join("")}
      <button type="button" id="refresh">${t("refresh")}</button></div>
    <section class="cards">${visible.map((item) => `<article class="card ${item.needsReview ? "review" : ""}">
      <h2>${escapeHtml(item.identityAnchor)} · ${escapeHtml(item.workflowFamily)}</h2>
      <p>${t("expectation")}: <strong>${escapeHtml(item.expectationState)}</strong><br>${t("verification")}: <strong>${escapeHtml(item.verificationStatus)}</strong> ${item.verificationReasonCodes.map(escapeHtml).join(", ")}</p>
      <p>${item.needsReview ? t("needsReview") : t("quiet")}</p>
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
    const resourceId = postgresClinical ? form.dataset.expectationId : form.dataset.workflowId;
    try {
      const idempotencyKey = pendingDecisionKeys.get(resourceId) || crypto.randomUUID();
      pendingDecisionKeys.set(resourceId, idempotencyKey);
      await api("/api/manager/decisions", { method: "POST", body: JSON.stringify({
        [postgresClinical ? "expectationId" : "workflowId"]: postgresClinical
          ? form.dataset.expectationId
          : form.dataset.workflowId,
        action: data.get("action"),
        reasonCode: data.get("reasonCode") || null,
        note: data.get("note") || null,
      }), headers: { "idempotency-key": idempotencyKey } });
      pendingDecisionKeys.delete(resourceId);
      await loadManager();
    } catch (error) {
      form.querySelector('[role="alert"]').textContent = error.message;
    }
  }));
  document.querySelectorAll("[data-decision-form]").forEach((form) => {
    const clear = () => pendingDecisionKeys.delete(postgresClinical ? form.dataset.expectationId : form.dataset.workflowId);
    form.addEventListener("input", clear);
    form.addEventListener("change", clear);
  });
  bindLanguage();
}

function decisionForm(item) {
  if (item.workflowStatus !== "OPEN" || !item.expectationId || !item.verificationStatus) return "";
  const actions = item.expectationState === "MET"
    ? item.verificationStatus === "VERIFIED" ? ["CLOSE_STANDARD", "VOID"] : ["VOID"]
    : item.expectationState === "UNMET"
      ? ["CLOSE_EXCEPTION", "KEEP_OPEN", "VOID"]
      : ["KEEP_OPEN", "VOID"];
  const reasons = ["LEGITIMATE_DEVIATION", "MISSING_EXTERNAL_RECORD", "DUPLICATE_WORKFLOW", "PATIENT_CANCELLED", "NEEDS_MORE_EVIDENCE"];
  return `<form class="decision-form" data-decision-form data-workflow-id="${escapeHtml(item.workflowId)}" data-expectation-id="${escapeHtml(item.expectationId)}">
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

api("/api/health").then((health) => {
  postgresClinical = health.mode === "hybrid-postgres-preview";
  return location.pathname === "/manager" ? loadManager() : loadEmployee();
}).catch(showFatal);

function showFatal(error) {
  app.innerHTML = `<main class="main"><p role="alert">${escapeHtml(error.message)}</p></main>`;
}
