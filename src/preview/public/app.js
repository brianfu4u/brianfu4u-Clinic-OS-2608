const strings = {
  ja: {
    product: "Clinic OS · ローカル運用プレビュー", employee: "スタッフ業務", manager: "店長ダッシュボード",
    newTopic: "新しいトピック", state: "勤務状態", onDuty: "勤務中", onBreak: "休憩中", offDuty: "退勤",
    conversation: "会話", work: "業務を記録", send: "記録する", sendMessage: "送信", topicTitle: "トピック名", currentTask: "現在の業務", topics: "トピック",
    message: "メッセージ", kind: "種類", anchor: "合成ID（DEMO-）", family: "ワークフロー",
    occurredAt: "発生日時", synthetic: "認証なしのローカル非本番画面です。実データを入力しないでください。",
    all: "すべて", review: "要確認", open: "進行中", complete: "完了", refresh: "更新", alignment: "文書照合", attentionGaps: "要確認の照合",
    noItems: "表示するワークフローはありません。", needsReview: "要確認", quiet: "確認不要",
    action: "店長アクション", reason: "理由コード", note: "任意メモ", decide: "決定を記録", latest: "最新決定",
    expectation: "予期", verification: "S2検証", guidance: "ローカルガイダンス", guidanceUnavailable: "ローカルガイダンスは利用できません。", demoWalkthrough: "合成デモの見どころ", normalCompletion: "標準完了", openWork: "未完了の作業", overdueWork: "期限超過の作業", attentionReview: "要確認", idempotentReplay: "同一操作の再実行",
    hybrid: "PostgreSQL臨床チェーンは永続化・会話と勤務状態は再起動で消去",
    evidenceFile: "証拠画像（PNG/JPEG）", evidenceHelp: "画像はローカル OCR で認識され、安全な構造化結果のみが表示されます。PDF は現在認識できません。",
    evidenceUnavailable: "永続化された証拠アップロードはこの合成プレビューでは利用できません。",
    missingExpectation: "処理する未完了の検査レポートを選択してください。",
    expectationSelect: "未完了の検査レポート", expectationLoading: "未完了の検査レポートを読み込み中…", expectationEmpty: "選択できる未完了の検査レポートはありません。",
    chooseEvidence: "PNG または JPEG 画像を選択してください。PDF は現在認識できません。",
    registrationRecorded: "受付登録を記録しました。次に処方を記録してください。", prescriptionRecorded: "処方を記録しました。次に未完了の検査レポートを選択してください。", paymentRecorded: "会計完了を記録しました。店長が標準クローズできます。",
    evidenceCompleted: "証拠を処理しました", extractionReview: "証拠の抽出に確認が必要です。", compositionReview: "ワークフロー照合に確認が必要です。", ocrResult: "ローカル OCR 構造化結果", reportType: "帳票種別", missingFields: "不足項目", confidence: "認識信頼度", noMissingFields: "なし", ocrReviewQueue: "OCR 確認待ち",
    employeeIntro: "この担当に割り当てられた業務だけを記録します。", receptionWorkspace: "受付：登録", doctorWorkspace: "医師：処方", examWorkspace: "検査：レポート", cashierWorkspace: "会計：支払い完了", registrationStep: "1. 受付登録", prescriptionStep: "2. 処方", reportStep: "3. 検査レポート", paymentStep: "4. 会計完了", managerIntro: "未完了の患者フローと、店長確認が必要な項目を確認します。", total: "全フロー", verified: "検証済み", attention: "要確認", commandCenter: "運用コマンドセンター", closureQueue: "閉鎖キュー", walkthrough: "デモ確認",
    networkError: "プレビューサービスに接続できませんでした。もう一度お試しください。",
  },
  zh: {
    product: "Clinic OS · 本地运营预览", employee: "员工工作台", manager: "店长运营看板",
    newTopic: "新主题", state: "工作状态", onDuty: "在岗", onBreak: "休息", offDuty: "下班",
    conversation: "对话", work: "记录业务", send: "提交记录", sendMessage: "发送", topicTitle: "主题名称", currentTask: "当前业务", topics: "主题",
    message: "消息", kind: "类型", anchor: "合成编号（DEMO-）", family: "工作流",
    occurredAt: "发生时间", synthetic: "这是未经认证的本地非生产预览。请勿输入真实数据。",
    all: "全部", review: "需复核", open: "进行中", complete: "完成", refresh: "刷新", alignment: "文件对齐", attentionGaps: "需关注的对齐项",
    noItems: "暂无工作流。", needsReview: "需要复核", quiet: "无需复核",
    action: "店长操作", reason: "原因代码", note: "可选备注", decide: "记录决定", latest: "最近决定",
    expectation: "预期状态", verification: "S2验证", guidance: "本地建议", guidanceUnavailable: "本地建议暂不可用。", demoWalkthrough: "合成演示观察点", normalCompletion: "标准完成", openWork: "未完成工作", overdueWork: "超期工作", attentionReview: "需复核", idempotentReplay: "相同操作重放",
    hybrid: "PostgreSQL临床链持久化；对话和工作状态重启后清空",
    evidenceFile: "证据图片（PNG/JPEG）", evidenceHelp: "图片将由本机 OCR 识别；页面只显示安全的结构化结果。PDF 目前不能识别。",
    evidenceUnavailable: "合成预览不提供持久化证据上传。",
    missingExpectation: "请选择要处理的未完成检查报告。",
    expectationSelect: "待处理检查报告", expectationLoading: "正在读取待处理检查报告…", expectationEmpty: "没有可选择的待处理检查报告。",
    chooseEvidence: "请选择PNG或JPEG图片。PDF目前不能识别。",
    registrationRecorded: "登记已记录。请接着记录处方。", prescriptionRecorded: "处方已记录。请接着选择待处理检查报告。", paymentRecorded: "收费完成已记录。店长现在可以标准关闭。",
    evidenceCompleted: "证据已处理", extractionReview: "证据抽取需要复核。", compositionReview: "工作流匹配需要复核。", ocrResult: "本机 OCR 结构化结果", reportType: "报告类型", missingFields: "缺失字段", confidence: "识别置信度", noMissingFields: "无", ocrReviewQueue: "OCR 待复核",
    employeeIntro: "只记录分配给当前岗位的业务。", receptionWorkspace: "前台：登记", doctorWorkspace: "医生：处方", examWorkspace: "检查：报告", cashierWorkspace: "收费：付款完成", registrationStep: "第一步：前台登记", prescriptionStep: "第二步：医生处方", reportStep: "第三步：上传检查报告", paymentStep: "第四步：收费完成", managerIntro: "查看未闭环的患者流程，以及需要店长确认的项目。", total: "全部流程", verified: "已验证", attention: "需关注", commandCenter: "运营指挥中心", closureQueue: "闭环队列", walkthrough: "演示观察",
    networkError: "无法连接预览服务，请重试。",
  },
  en: {
    product: "Clinic OS · Local operations preview", employee: "Staff workspace", manager: "Manager dashboard",
    newTopic: "New topic", state: "Work status", onDuty: "On duty", onBreak: "On break", offDuty: "Off duty",
    conversation: "Conversation", work: "Record work", send: "Save record", sendMessage: "Send", topicTitle: "Topic title", currentTask: "Current task", topics: "Topics",
    message: "Message", kind: "Kind", anchor: "Synthetic ID (DEMO-)", family: "Workflow",
    occurredAt: "Occurred at", synthetic: "Unauthenticated local non-production preview. Do not enter real data.",
    all: "All", review: "Needs review", open: "Open", complete: "Complete", refresh: "Refresh", alignment: "Document alignment", attentionGaps: "Alignment attention",
    noItems: "No workflows to display.", needsReview: "Needs review", quiet: "No review needed",
    action: "Manager action", reason: "Reason code", note: "Optional note", decide: "Record decision", latest: "Latest decision",
    expectation: "Expectation", verification: "S2 verification", guidance: "Local guidance", guidanceUnavailable: "Local guidance is unavailable.", demoWalkthrough: "Synthetic demo walkthrough", normalCompletion: "Normal completion", openWork: "Open work", overdueWork: "Overdue work", attentionReview: "Attention review", idempotentReplay: "Idempotent replay",
    hybrid: "PostgreSQL clinical chain is durable; chat and work status reset on restart",
    evidenceFile: "Evidence image (PNG/JPEG)", evidenceHelp: "Images are recognized by local OCR; only a safe structured result is shown. PDF is not currently supported.",
    evidenceUnavailable: "Durable evidence upload is unavailable in the synthetic preview.",
    missingExpectation: "Select an open exam report expectation first.",
    expectationSelect: "Open exam report", expectationLoading: "Loading open exam reports…", expectationEmpty: "No selectable open exam reports.",
    chooseEvidence: "Choose a PNG or JPEG image. PDF is not currently supported.",
    registrationRecorded: "Registration recorded. Record the prescription next.", prescriptionRecorded: "Prescription recorded. Select an open exam report next.", paymentRecorded: "Payment completion recorded. The manager can now close the flow.",
    evidenceCompleted: "Evidence processed", extractionReview: "Evidence extraction needs review.", compositionReview: "Workflow matching needs review.", ocrResult: "Local OCR structured result", reportType: "Report type", missingFields: "Missing fields", confidence: "Recognition confidence", noMissingFields: "None", ocrReviewQueue: "OCR review queue",
    employeeIntro: "Record only the work assigned to this workspace.", receptionWorkspace: "Reception: registration", doctorWorkspace: "Doctor: prescription", examWorkspace: "Exam: report", cashierWorkspace: "Cashier: payment completion", registrationStep: "1. Reception registration", prescriptionStep: "2. Prescription", reportStep: "3. Upload exam report", paymentStep: "4. Payment completion", managerIntro: "Review incomplete patient flows and items requiring a manager decision.", total: "All flows", verified: "Verified", attention: "Needs attention", commandCenter: "Operations command center", closureQueue: "Closure queue", walkthrough: "Demo walkthrough",
    networkError: "The preview service could not be reached. Please try again.",
  },
};

let language = localStorage.getItem("clinic-os-language") || "zh";
let bootstrap = null;
let activeTopicId = null;
let managerItems = [];
let managerAttentionItems = [];
let managerAttentionGuidance = [];
let managerDemoScenarios = [];
let managerOcrReviews = [];
let managerFilter = "all";
let openExpectations = [];
let expectationLoadEpoch = 0;
const pendingDecisionKeys = new Map();
let postgresClinical = false;
let evidenceStatus = null;
let stageStatus = null;
let composerMode = "work";
let composerKind = "REGISTRATION";
let employeeWorkspace = "RECEPTION";
const app = document.querySelector("#app");
const t = (key) => strings[language][key];
const previewNotice = () => `${t("synthetic")}${postgresClinical ? ` ${t("hybrid")}` : ""}`;

function validateWorkspace(value) {
  if (!["RECEPTION", "DOCTOR", "EXAM", "CASHIER"].includes(value)) throw new Error(t("networkError"));
  return value;
}

function kindForWorkspace(workspace) {
  return workspace === "RECEPTION" ? "REGISTRATION" : workspace === "DOCTOR" ? "PRESCRIPTION" : workspace === "EXAM" ? "EXAM_REPORT" : "PAYMENT";
}

function workspaceTitleKey(workspace) {
  return workspace === "RECEPTION" ? "receptionWorkspace" : workspace === "DOCTOR" ? "doctorWorkspace" : workspace === "EXAM" ? "examWorkspace" : "cashierWorkspace";
}

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
    REGISTRATION_CONFLICT: "This stage conflicts with an existing operation.",
    PRESCRIPTION_NOT_CURRENT: "The prescription is no longer current for this flow.", PAYMENT_NOT_CURRENT: "Payment is no longer current for this flow.",
    INVALID_REGISTRATION_REQUEST: "The registration request could not be accepted.",
    INVALID_UPLOAD: "The selected evidence could not be accepted.",
    UNSUPPORTED_CONTENT_TYPE: "请选择 PNG 或 JPEG 图片。PDF 目前不能识别。",
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
  employeeWorkspace = validateWorkspace(bootstrap.workspace);
  composerKind = kindForWorkspace(employeeWorkspace);
  activeTopicId ||= bootstrap.topics.at(-1)?.id || null;
  renderEmployee();
}

function renderEmployee() {
  app.innerHTML = `<div class="employee-shell"><aside class="employee-sidebar" aria-label="${escapeHtml(t("employee"))}">
      <a class="brand" href="/employee">${escapeHtml(t("product"))}</a>
      <label class="sidebar-status">${t("state")}<select data-employee-status aria-label="${escapeHtml(t("state"))}">
        ${[["ON_DUTY", "onDuty"], ["ON_BREAK", "onBreak"], ["OFF_DUTY", "offDuty"]].map(([value, key]) => `<option value="${value}"${bootstrap.status === value ? " selected" : ""}>${escapeHtml(t(key))}</option>`).join("")}
      </select></label>
      <nav class="workspace-functions" aria-label="${escapeHtml(t("employee"))}">
        <button type="button" data-composer-mode="conversation" aria-pressed="${composerMode === "conversation"}">${t("conversation")}</button>
        <button type="button" data-composer-mode="work" aria-pressed="${composerMode === "work"}">${t("work")}</button>
      </nav>
      <div class="sidebar-topic-heading"><h2>${t("topics")}</h2><button type="button" class="new-topic" data-new-topic>${t("newTopic")}</button></div>
      <ul class="topics">${topicList() || `<li class="muted">${escapeHtml(t("noItems"))}</li>`}</ul>
    </aside><main class="main workspace employee-main"><div class="topbar"><div><p class="eyebrow">${t("product")}</p><h1>${t("employee")}</h1></div><div class="top-actions"><a href="/manager">${t("manager")}</a>${languageButtons()}</div></div>
      <p class="notice">${previewNotice()}</p>
      ${stageStatus ? `<p class="evidence-status success" role="status">${t(stageStatus)}</p>` : ""}
      ${evidenceStatus ? evidenceStatusMarkup() : ""}
      <section class="workspace-intro current-task"><p class="eyebrow">${t("currentTask")}</p><h2>${t(workspaceTitleKey(employeeWorkspace))}</h2><p>${t("employeeIntro")}</p></section>
      ${conversationThread()}
      ${composer()}
    </main></div>`;
  bindLanguage();
  bindEmployeeShell();
  bindComposer();
}

function topicList() {
  let previousDate = "";
  return bootstrap.topics.map((item) => {
    const date = new Date(item.createdAt);
    const dateLabel = date.toLocaleDateString(language);
    const heading = dateLabel === previousDate ? "" : `<li class="topic-date">${escapeHtml(dateLabel)}</li>`;
    previousDate = dateLabel;
    return `${heading}<li><button type="button" data-topic="${escapeHtml(item.id)}" aria-pressed="${activeTopicId === item.id}">${escapeHtml(item.title)}<br><small>${escapeHtml(date.toLocaleTimeString(language))}</small></button></li>`;
  }).join("");
}

function conversationThread() {
  const messages = bootstrap.messages.filter((message) => message.topicId === activeTopicId);
  const title = bootstrap.topics.find((topic) => topic.id === activeTopicId)?.title || t("newTopic");
  return `<section class="conversation-panel" aria-label="${escapeHtml(t("conversation"))}"><header><p class="eyebrow">${t("conversation")}</p><h2>${escapeHtml(title)}</h2></header>
    <div class="thread" aria-live="polite">${messages.length ? messages.map((message) => `<p class="message ${message.role === "EMPLOYEE" ? "employee" : "system"}">${escapeHtml(message.text)}</p>`).join("") : `<p class="empty">${escapeHtml(t("newTopic"))}</p>`}</div></section>`;
}

function bindEmployeeShell() {
  document.querySelectorAll("[data-topic]").forEach((button) => button.addEventListener("click", () => {
    activeTopicId = button.dataset.topic || null;
    renderEmployee();
  }));
  document.querySelectorAll("[data-composer-mode]").forEach((button) => button.addEventListener("click", () => {
    composerMode = button.dataset.composerMode === "conversation" ? "conversation" : "work";
    renderEmployee();
  }));
  document.querySelector("[data-new-topic]")?.addEventListener("click", async () => {
    try {
      const topic = await api("/api/employee/topics", { method: "POST", body: JSON.stringify({ title: t("newTopic") }) });
      if (!isPlainObject(topic) || !isBoundedId(topic.id)) throw new Error(t("networkError"));
      activeTopicId = topic.id;
      await loadEmployee();
    } catch {
      showEmployeeShellError();
    }
  });
  document.querySelector("[data-employee-status]")?.addEventListener("change", async (event) => {
    const select = event.currentTarget;
    try {
      await api("/api/employee/status", { method: "PUT", body: JSON.stringify({ status: select.value }) });
      await loadEmployee();
    } catch {
      showEmployeeShellError();
    }
  });
}

function showEmployeeShellError() {
  const error = document.querySelector("#form-error");
  if (error) error.textContent = t("networkError");
}

function composer() {
  if (composerMode === "conversation") {
    return `<form class="composer chat-composer" id="composer"><input type="hidden" name="mode" value="conversation">
      <label class="sr-only" for="conversation-text">${t("message")}</label>
      <textarea id="conversation-text" name="text" maxlength="2000" required placeholder="${escapeHtml(t("message"))}"></textarea>
      <button class="primary" type="submit">${t("sendMessage")}</button><p id="form-error" role="alert"></p>
    </form>`;
  }
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return `<form class="composer operational-composer" id="composer"><input type="hidden" name="mode" value="work">
    <div class="work-fields">
      <input type="hidden" name="kind" value="${composerKind}">
      <p class="workspace-task">${escapeHtml(composerKind)}</p>
      <label>${t("anchor")}<input name="identityAnchor" value="DEMO-001" required></label>
      <label>${t("family")}<input name="workflowFamily" value="EYE_EXAM" readonly></label>
      <label>${t("occurredAt")}<input name="occurredAt" type="datetime-local" value="${local}" required></label>
      <div class="evidence-control" data-evidence-control hidden>
        <label for="expectation-select">${t("expectationSelect")}</label>
        <select id="expectation-select" name="expectationId" required disabled><option value="">${t("expectationLoading")}</option></select>
        <label for="evidence-file">${t("evidenceFile")}</label>
        <input id="evidence-file" name="evidenceFile" type="file" accept="image/png,image/jpeg" disabled>
        <p class="muted" data-evidence-help></p>
      </div>
    </div>
    <input name="text" value="Local operational record" hidden>
    <button class="primary" type="submit">${t("send")}</button><p id="form-error" role="alert"></p>
  </form>`;
}

function bindComposer() {
  const form = document.querySelector("#composer");
  if (!form) return;
  form.elements.identityAnchor.addEventListener("change", () => { stageStatus = null; updateEvidenceControl(form); });
  form.addEventListener("input", () => { delete form.dataset.idempotencyKey; });
  form.addEventListener("change", () => { delete form.dataset.idempotencyKey; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      if (data.get("mode") === "conversation") {
        if (!activeTopicId) throw new Error(t("networkError"));
        await api("/api/employee/messages", { method: "POST", body: JSON.stringify({ topicId: activeTopicId, text: data.get("text") }) });
        await loadEmployee();
        return;
      }
      if (data.get("mode") === "work") {
        const identityAnchor = data.get("identityAnchor");
        const kind = data.get("kind");
        if (kind === "EXAM_REPORT") {
          await submitExamReport(form, data, identityAnchor);
          return;
        }
        form.dataset.idempotencyKey ||= crypto.randomUUID();
        const stagePath = kind === "PRESCRIPTION" ? "/api/employee/prescription-trigger" : kind === "PAYMENT" ? "/api/employee/payment-trigger" : "/api/employee/registration-trigger";
        const result = await api(postgresClinical ? stagePath : "/api/employee/work-updates", { method: "POST", headers: {
          "idempotency-key": form.dataset.idempotencyKey,
        }, body: JSON.stringify(postgresClinical
          ? { identityAnchor, occurredAt: new Date(data.get("occurredAt")).toISOString() }
          : { topicId: activeTopicId, kind, identityAnchor, workflowFamily: data.get("workflowFamily"), occurredAt: new Date(data.get("occurredAt")).toISOString(), text: data.get("text") }) });
        if (postgresClinical) {
          const stage = validateStageProjection(result);
          stageStatus = stage.status === "COMPLETED" ? (kind === "PRESCRIPTION" ? "prescriptionRecorded" : kind === "PAYMENT" ? "paymentRecorded" : "registrationRecorded") : null;
        }
        delete form.dataset.idempotencyKey;
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
  const report = form.elements.kind.value === "EXAM_REPORT";
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

function validateStageProjection(value) {
  if (!isPlainObject(value)) throw new Error(t("networkError"));
  if (value.status === "REVIEW_REQUIRED" && exactKeys(value, ["status"])) return { status: "REVIEW_REQUIRED" };
  if (value.status === "COMPLETED" && exactKeys(value, ["expectationId", "expectationState", "status", "verificationStatus"]) &&
      isBoundedId(value.expectationId) &&
      ((["OPEN", "UNMET"].includes(value.expectationState) && value.verificationStatus === "PENDING") ||
       (value.expectationState === "MET" && value.verificationStatus === "VERIFIED"))) {
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
    if (epoch !== expectationLoadEpoch || composerKind !== "EXAM_REPORT") return;
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
  throw new Error(t("chooseEvidence"));
}

function validateUploadProjection(value) {
  if (!isPlainObject(value) || exactKeys(value, ["objectRef", "status"]) === false || value.status !== "STORED" ||
      !isPlainObject(value.objectRef) || !exactKeys(value.objectRef, ["contentSha256", "mediaType", "objectId", "sizeBytes"]) ||
      !/^upload-[a-f0-9]{64}$/.test(value.objectRef.objectId) || !/^[a-f0-9]{64}$/.test(value.objectRef.contentSha256) ||
      !Number.isSafeInteger(value.objectRef.sizeBytes) || value.objectRef.sizeBytes <= 0 || value.objectRef.sizeBytes > 25 * 1024 * 1024 ||
      !["image/png", "image/jpeg"].includes(value.objectRef.mediaType)) {
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
  if (!isPlainObject(value) || !exactKeys(value, ["artifactId", "expectationId", "expectationState", "ocr", "reasonCodes", "reviewStage", "status", "verificationStatus", "workflowId"]) ||
      !["COMPLETED", "REVIEW_REQUIRED"].includes(value.status) ||
      !Array.isArray(value.reasonCodes) || value.reasonCodes.length > 16 || value.reasonCodes.some((reason) => typeof reason !== "string" || reason.length > 64) ||
      (value.artifactId !== null && !isBoundedId(value.artifactId))) {
    throw new Error(t("networkError"));
  }
  const ocr = validateOcrProjection(value.ocr);
  if (value.status === "COMPLETED") {
    if (value.reviewStage !== null || !isBoundedId(value.workflowId) || !isBoundedId(value.expectationId) ||
        !["OPEN", "MET", "UNMET", "VOIDED"].includes(value.expectationState) ||
        !["PENDING", "VERIFIED", "CONFLICT"].includes(value.verificationStatus)) throw new Error(t("networkError"));
    return { status: "COMPLETED", expectationState: value.expectationState, verificationStatus: value.verificationStatus, ocr };
  }
  if (!["EXTRACTION", "COMPOSITION"].includes(value.reviewStage) || value.workflowId !== null || value.expectationId !== null ||
      value.expectationState !== null || value.verificationStatus !== null) throw new Error(t("networkError"));
  return { status: "REVIEW_REQUIRED", reviewStage: value.reviewStage, reasonCodes: [...value.reasonCodes], ocr };
}

function validateOcrProjection(value) {
  if (!isPlainObject(value) || !exactKeys(value, ["confidenceBasisPoints", "missingFields", "reportType"]) ||
      ![null, "EYE_EXAM", "FUNDUS"].includes(value.reportType) || !Array.isArray(value.missingFields) ||
      value.missingFields.length > 1 || value.missingFields.some((field) => field !== "reportType") ||
      !Number.isSafeInteger(value.confidenceBasisPoints) || value.confidenceBasisPoints < 0 || value.confidenceBasisPoints > 10_000) {
    throw new Error(t("networkError"));
  }
  return { reportType: value.reportType, missingFields: [...value.missingFields], confidenceBasisPoints: value.confidenceBasisPoints };
}

function evidenceStatusMarkup() {
  const ocr = `<span class="ocr-summary">${t("ocrResult")} · ${t("reportType")}: <strong>${escapeHtml(evidenceStatus.ocr.reportType || "—")}</strong> · ${t("missingFields")}: <strong>${escapeHtml(evidenceStatus.ocr.missingFields.join(", ") || t("noMissingFields"))}</strong> · ${t("confidence")}: <strong>${escapeHtml((evidenceStatus.ocr.confidenceBasisPoints / 100).toFixed(2))}%</strong></span>`;
  if (evidenceStatus.status === "COMPLETED") {
    return `<p class="evidence-status success" role="status">${t("evidenceCompleted")} · ${t("expectation")}: <strong>${escapeHtml(evidenceStatus.expectationState)}</strong> · ${t("verification")}: <strong>${escapeHtml(evidenceStatus.verificationStatus)}</strong><br>${ocr}</p>`;
  }
  const label = evidenceStatus.reviewStage === "EXTRACTION" ? t("extractionReview") : t("compositionReview");
  return `<p class="evidence-status review" role="status">${label}${evidenceStatus.reasonCodes.length ? ` · ${evidenceStatus.reasonCodes.map(escapeHtml).join(", ")}` : ""}<br>${ocr}</p>`;
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
  const [closures, attention, guidance, scenarios, ocrReviews] = await Promise.all([
    api("/api/manager/closures"),
    postgresClinical ? api("/api/manager/attention-gaps") : Promise.resolve([]),
    postgresClinical ? api("/api/manager/attention-guidance") : Promise.resolve([]),
    postgresClinical ? api("/api/manager/demo-scenarios") : Promise.resolve([]),
    postgresClinical ? api("/api/manager/ocr-reviews") : Promise.resolve([]),
  ]);
  managerItems = closures;
  managerAttentionItems = validateManagerAttentionItems(attention);
  managerAttentionGuidance = validateManagerAttentionGuidance(guidance, managerAttentionItems.length);
  managerDemoScenarios = validateManagerDemoScenarios(scenarios);
  managerOcrReviews = validateManagerOcrReviews(ocrReviews);
  renderManager();
}

function validateManagerDemoScenarios(value) {
  if (!Array.isArray(value)) throw new Error(t("networkError"));
  if (value.length === 0 && !postgresClinical) return [];
  const expected = ["NORMAL_COMPLETION", "OPEN_WORK", "OVERDUE_WORK", "ATTENTION_REVIEW", "IDEMPOTENT_REPLAY"];
  if (value.length !== expected.length || value.some((item, index) => !isPlainObject(item) ||
      !exactKeys(item, ["scenario", "status"]) || item.scenario !== expected[index] ||
      !["READY", "NOT_PREPARED"].includes(item.status))) throw new Error(t("networkError"));
  return value.map((item) => ({ scenario: item.scenario, status: item.status }));
}

function validateManagerOcrReviews(value) {
  if (!Array.isArray(value) || value.length > 50) throw new Error(t("networkError"));
  return value.map((item) => {
    if (!isPlainObject(item) || !exactKeys(item, ["artifactId", "confidenceBasisPoints", "missingFields", "reasonCodes", "reportType", "status"]) ||
        !isBoundedId(item.artifactId) || item.status !== "REVIEW_REQUIRED" || !Array.isArray(item.reasonCodes) ||
        item.reasonCodes.length > 16 || item.reasonCodes.some((code) => typeof code !== "string" || code.length > 64)) throw new Error(t("networkError"));
    return { ...validateOcrProjection(item), artifactId: item.artifactId, status: item.status, reasonCodes: [...item.reasonCodes] };
  });
}

function validateManagerAttentionGuidance(value, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength) throw new Error(t("networkError"));
  return value.map((item) => {
    if (!isPlainObject(item)) throw new Error(t("networkError"));
    if (item.status === "UNAVAILABLE" && exactKeys(item, ["status", "code"]) && item.code === "LOCAL_RECOMMENDATION_UNAVAILABLE") {
      return { status: "UNAVAILABLE" };
    }
    if (item.status !== "AVAILABLE" || !exactKeys(item, ["status", "suggestionCode", "reasonCodes"]) ||
        !["DOCUMENT_COMPLETENESS_REVIEW", "DOCUMENT_CONSISTENCY_REVIEW"].includes(item.suggestionCode) ||
        !Array.isArray(item.reasonCodes) || item.reasonCodes.length > 21 || item.reasonCodes.some((reason) => !isBoundedId(reason))) throw new Error(t("networkError"));
    return { status: "AVAILABLE", suggestionCode: item.suggestionCode, reasonCodes: [...item.reasonCodes] };
  });
}

function validateManagerAttentionItems(value) {
  if (!Array.isArray(value)) throw new Error(t("networkError"));
  return value.map((item) => {
    if (!isPlainObject(item) || !exactKeys(item, ["workflowId", "workflowFamily", "workflowStatus", "stage", "alignmentStatus", "reasonCodes"]) ||
        !isBoundedId(item.workflowId) || !isBoundedId(item.workflowFamily) || !["OPEN", "CLOSED", "VOIDED"].includes(item.workflowStatus) ||
        item.stage !== "STRUCTURED_ALIGNMENT" || !["MISSING", "CONFLICT"].includes(item.alignmentStatus) || !Array.isArray(item.reasonCodes) ||
        item.reasonCodes.length > 16 || item.reasonCodes.some((reason) => !isBoundedId(reason))) throw new Error(t("networkError"));
    return { workflowId: item.workflowId, workflowFamily: item.workflowFamily, workflowStatus: item.workflowStatus,
      stage: item.stage, alignmentStatus: item.alignmentStatus, reasonCodes: [...item.reasonCodes] };
  });
}

function renderManager() {
  const attentionOnly = managerFilter === "attention";
  const visible = managerItems.filter((item) => managerFilter === "all" ||
    (managerFilter === "review" && item.needsReview) ||
    (managerFilter === "open" && item.expectationState === "OPEN") ||
    (managerFilter === "complete" && (item.workflowStatus !== "OPEN" || item.expectationState === "MET")));
  const verified = managerItems.filter((item) => item.verificationStatus === "VERIFIED").length;
  const attention = managerAttentionItems.length;
  app.innerHTML = `<div class="manager-shell"><aside class="manager-sidebar" aria-label="${escapeHtml(t("manager"))}">
      <a class="brand" href="/manager">${escapeHtml(t("product"))}</a><p class="sidebar-label">${escapeHtml(t("commandCenter"))}</p>
      <nav class="workspace-functions" aria-label="${escapeHtml(t("manager"))}">
        <button type="button" data-filter="all" aria-pressed="${managerFilter === "all"}">${t("closureQueue")}</button>
        <button type="button" data-filter="attention" aria-pressed="${managerFilter === "attention"}">${t("attention")}</button>
        <button type="button" data-filter="review" aria-pressed="${managerFilter === "review"}">${t("review")}</button>
      </nav>
      <section class="sidebar-summary" aria-label="${escapeHtml(t("managerIntro"))}"><p><strong>${attention}</strong><span>${t("attention")}</span></p><p><strong>${verified}</strong><span>${t("verified")}</span></p></section>
    </aside><main class="main workspace manager-main"><div class="topbar"><div><p class="eyebrow">${t("product")}</p><h1>${t("manager")}</h1></div><div class="top-actions"><a href="/employee">${t("employee")}</a>${languageButtons()}</div></div>
    <p class="notice">${previewNotice()}</p><section class="workspace-intro"><h2>${t("managerIntro")}</h2><div class="metric-grid"><p><strong>${managerItems.length}</strong><span>${t("total")}</span></p><p><strong>${verified}</strong><span>${t("verified")}</span></p><p><strong>${attention}</strong><span>${t("attention")}</span></p></div></section><div class="filters" aria-label="${escapeHtml(t("closureQueue"))}">
      ${[["all", "all"], ["attention", "attention"], ["review", "review"], ["open", "open"], ["complete", "complete"]].map(([value, key]) => `<button type="button" data-filter="${value}" aria-pressed="${managerFilter === value}">${t(key)}</button>`).join("")}
      <button type="button" id="refresh">${t("refresh")}</button></div>
    ${managerDemoScenarios.length ? `<section class="workspace-intro demo-walkthrough"><h2>${t("walkthrough")}</h2><p>${t("demoWalkthrough")}</p><div class="metric-grid">${managerDemoScenarios.map((item) => `<p><strong>${escapeHtml(item.status)}</strong><span>${t(demoScenarioKey(item.scenario))}</span></p>`).join("")}</div></section>` : ""}
    ${managerOcrReviews.length ? `<section class="workspace-intro"><h2>${t("ocrReviewQueue")}</h2>${managerOcrReviews.map((item) => `<p>${t("reportType")}: <strong>${escapeHtml(item.reportType || "—")}</strong> · ${t("missingFields")}: <strong>${escapeHtml(item.missingFields.join(", ") || t("noMissingFields"))}</strong> · ${t("confidence")}: <strong>${escapeHtml((item.confidenceBasisPoints / 100).toFixed(2))}%</strong></p>`).join("")}</section>` : ""}
    <section class="cards" aria-label="${escapeHtml(t("closureQueue"))}">${attentionOnly ? managerAttentionItems.map((item, index) => attentionCard(item, managerAttentionGuidance[index])).join("") : visible.map((item) => `<article class="card ${item.needsReview ? "review" : ""}">
      <h2>${escapeHtml(item.identityAnchor)} · ${escapeHtml(item.workflowFamily)}</h2>
      <p>${t("expectation")}: <strong>${escapeHtml(item.expectationState)}</strong><br>${t("verification")}: <strong>${escapeHtml(item.verificationStatus)}</strong> ${item.verificationReasonCodes.map(escapeHtml).join(", ")}</p>
      <p>${item.needsReview ? t("needsReview") : t("quiet")}</p>
      <p class="muted">${t("expectation")}: ${escapeHtml(item.reasonCodes.map((code) => code.replaceAll("_", " ")).join(" · ") || "—")}</p>
      ${item.latestDecision ? `<p>${t("latest")}: ${escapeHtml(item.latestDecision.action)}${item.latestDecision.reasonCode ? ` · ${escapeHtml(item.latestDecision.reasonCode)}` : ""}</p>` : ""}
      ${decisionForm(item)}
    </article>`).join("") || `<p class="empty">${t("noItems")}</p>`}</section></main></div>`;
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

function demoScenarioKey(scenario) {
  return scenario === "NORMAL_COMPLETION" ? "normalCompletion" : scenario === "OPEN_WORK" ? "openWork" :
    scenario === "OVERDUE_WORK" ? "overdueWork" : scenario === "ATTENTION_REVIEW" ? "attentionReview" : "idempotentReplay";
}

function attentionCard(item, guidance) {
  return `<article class="card review"><h2>${escapeHtml(item.workflowFamily)}</h2>
    <p>${t("alignment")}: <strong>${escapeHtml(item.alignmentStatus)}</strong></p>
    <p>${t("attentionGaps")}: ${item.reasonCodes.map((code) => escapeHtml(code.replaceAll("_", " "))).join(" · ") || "—"}</p>
    <p>${t("guidance")}: ${guidance?.status === "AVAILABLE"
      ? `<strong>${escapeHtml(guidance.suggestionCode.replaceAll("_", " "))}</strong>${guidance.reasonCodes.length ? ` · ${guidance.reasonCodes.map((code) => escapeHtml(code.replaceAll("_", " "))).join(" · ")}` : ""}`
      : escapeHtml(t("guidanceUnavailable"))}</p>
  </article>`;
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
  if (location.pathname === "/") renderReadiness();
  else if (location.pathname === "/manager") renderManager();
  else renderEmployee();
}

async function renderReadiness() {
  const readiness = await api("/api/local-preview-readiness");
  const checks = validateLocalReadiness(readiness);
  app.innerHTML = `<main class="main workspace"><div class="topbar"><div><p class="eyebrow">Clinic OS</p><h1>${language === "zh" ? "本地预览就绪检查" : language === "ja" ? "ローカルプレビュー確認" : "Local preview readiness"}</h1></div>${languageButtons()}</div>
    <p class="notice">${t("synthetic")}</p><section class="cards">${checks.map((item) => `<article class="card"><h2>${escapeHtml(item.name.replaceAll("_", " "))}</h2><p><strong>${escapeHtml(item.status)}</strong></p></article>`).join("")}</section>
    <p><a class="primary-link" href="/employee">${t("employee")}</a> <a class="primary-link" href="/manager">${t("manager")}</a></p></main>`;
}

function validateLocalReadiness(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.checks) || !value.links || value.links.employee !== "/employee" || value.links.manager !== "/manager") throw new Error(t("networkError"));
  const names = ["DATABASE_SCHEMA", "OCR_ASSETS", "OCR_CHI_SIM_ASSET", "OCR_JPN_ASSET", "OCR_CHI_SIM_RELEASE", "OCR_JPN_RELEASE", "EXTERNAL_MODEL_VOLUME", "LOCAL_MODEL", "DEMO_WORKSPACE"];
  const states = ["READY", "AVAILABLE", "UNAVAILABLE", "NOT_CONFIGURED", "NOT_PREPARED"];
  if (value.status !== "READY" && value.status !== "DEGRADED") throw new Error(t("networkError"));
  if (value.checks.length !== names.length || value.checks.some((item, index) => !item || item.name !== names[index] || !states.includes(item.status))) throw new Error(t("networkError"));
  return value.checks;
}

api("/api/health").then((health) => {
  postgresClinical = health.mode === "hybrid-postgres-preview";
  return location.pathname === "/" ? renderReadiness() : location.pathname === "/manager" ? loadManager() : loadEmployee();
}).catch(showFatal);

function showFatal(error) {
  app.innerHTML = `<main class="main"><p role="alert">${escapeHtml(error.message)}</p></main>`;
}
