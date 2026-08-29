import type {
  ActorContext,
  Artifact,
  EvidenceFactCard,
  Expectation,
  ManagerDecision,
  ManagerDecisionAction,
  ManagerClosureView,
  VerificationResult,
  Workflow,
} from "../domain/contracts.ts";
import { assertActorAccess, assertActorContext } from "../domain/access-context.ts";
import { DomainError } from "../domain/errors.ts";
import { evaluateExpectation } from "../domain/expectation.ts";
import {
  createInMemoryRepositories,
  runGoldenPath,
} from "../domain/golden-path.ts";
import { projectManagerClosure } from "../domain/manager-projection.ts";
import { verifyS2 } from "../domain/s2-verification.ts";

export type EmployeeStatus = "ON_DUTY" | "ON_BREAK" | "OFF_DUTY";

export interface PreviewTopic {
  id: string;
  clinicId: string;
  ownerEmployeeId: string;
  title: string;
  createdAt: string;
}

export interface PreviewMessage {
  id: string;
  clinicId: string;
  ownerEmployeeId: string;
  topicId: string;
  role: "EMPLOYEE" | "LOCAL_SYSTEM";
  type: "CONVERSATION" | "WORK_UPDATE" | "WORK_UPDATE_RESULT";
  text: string;
  createdAt: string;
}

export interface ManagerPreviewItem extends ManagerClosureView {
  identityAnchor: string;
  workflowFamily: string;
  verificationStatus: VerificationResult["status"];
  verificationReasonCodes: string[];
  latestDecision: Pick<ManagerDecision, "action" | "reasonCode" | "decidedAt"> | null;
}

interface StoredExpectation {
  expectation: Expectation;
  identityAnchor: string;
}

function requireTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new DomainError("INVALID_PREVIEW_TIME", `${label} must be a valid timestamp.`);
  }
  return value;
}

function requireText(value: string, label: string, maxLength = 2_000): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new DomainError("INVALID_PREVIEW_INPUT", `${label} is required and too long values are rejected.`);
  }
  return trimmed;
}

export class PreviewStore {
  readonly #repositories = createInMemoryRepositories();
  readonly #topics = new Map<string, PreviewTopic>();
  readonly #messages: PreviewMessage[] = [];
  readonly #expectations = new Map<string, StoredExpectation>();
  readonly #clinicId: string;
  readonly #statuses = new Map<string, EmployeeStatus>();
  #nextId = 1;

  constructor(clinicId: string) {
    assertActorContext({ clinicId, actorId: "preview-runtime", role: "MANAGER" });
    this.#clinicId = clinicId;
  }

  bootstrap(context: ActorContext): {
    employeeId: string;
    status: EmployeeStatus;
    topics: PreviewTopic[];
    messages: PreviewMessage[];
  } {
    this.#employee(context);
    return {
      employeeId: context.actorId,
      status: this.#statuses.get(context.actorId) ?? "OFF_DUTY",
      topics: structuredClone([...this.#topics.values()].filter((topic) =>
        topic.clinicId === context.clinicId && topic.ownerEmployeeId === context.actorId
      )),
      messages: structuredClone(this.#messages.filter((message) =>
        message.clinicId === context.clinicId && message.ownerEmployeeId === context.actorId
      )),
    };
  }

  setStatus(context: ActorContext, status: EmployeeStatus): EmployeeStatus {
    this.#employee(context);
    if (!["ON_DUTY", "ON_BREAK", "OFF_DUTY"].includes(status)) {
      throw new DomainError("INVALID_EMPLOYEE_STATUS", "Unknown employee status.");
    }
    this.#statuses.set(context.actorId, status);
    return status;
  }

  createTopic(context: ActorContext, title: string, now: string): PreviewTopic {
    this.#employee(context);
    const topic: PreviewTopic = {
      id: this.#id("topic"),
      clinicId: context.clinicId,
      ownerEmployeeId: context.actorId,
      title: requireText(title, "Topic title", 100),
      createdAt: requireTimestamp(now, "Topic createdAt"),
    };
    this.#topics.set(topic.id, topic);
    return structuredClone(topic);
  }

  addConversation(
    context: ActorContext,
    topicId: string,
    text: string,
    now: string,
  ): PreviewMessage[] {
    this.#employee(context);
    this.#requireTopic(context, topicId);
    const createdAt = requireTimestamp(now, "Message createdAt");
    const employeeMessage = this.#addMessage(
      context,
      topicId,
      "EMPLOYEE",
      "CONVERSATION",
      requireText(text, "Message"),
      createdAt,
    );
    const acknowledgement = this.#addMessage(
      context,
      topicId,
      "LOCAL_SYSTEM",
      "CONVERSATION",
      "ローカルメモとして保存しました。業務記録には登録されていません。",
      createdAt,
    );
    return structuredClone([employeeMessage, acknowledgement]);
  }

  submitWorkUpdate(context: ActorContext, input: {
    topicId: string;
    kind: "REGISTRATION" | "EXAM_REPORT";
    identityAnchor: string;
    workflowFamily: string;
    occurredAt: string;
    text: string;
    now: string;
  }): {
    artifactId: string;
    clinicId: string;
    sourceEmployeeId: string;
    workflowId: string;
    expectationState: Expectation["state"];
  } {
    this.#employee(context);
    this.#requireTopic(context, input.topicId);
    if (this.#statuses.get(context.actorId) !== "ON_DUTY") {
      throw new DomainError("EMPLOYEE_NOT_ON_DUTY", "Formal work updates require ON_DUTY status.");
    }
    if (!["REGISTRATION", "EXAM_REPORT"].includes(input.kind)) {
      throw new DomainError("INVALID_WORK_UPDATE_KIND", "Unsupported work update kind.");
    }
    const identityAnchor = requireText(input.identityAnchor, "Identity anchor", 100);
    if (!identityAnchor.startsWith("DEMO-")) {
      throw new DomainError(
        "SYNTHETIC_ANCHOR_REQUIRED",
        "Preview identity anchors must begin with DEMO-.",
      );
    }
    if (input.workflowFamily !== "EYE_EXAM") {
      throw new DomainError("INVALID_WORKFLOW_FAMILY", "Only EYE_EXAM is supported.");
    }
    const occurredAt = requireTimestamp(input.occurredAt, "Work update occurredAt");
    const now = requireTimestamp(input.now, "Work update receivedAt");
    const text = requireText(input.text, "Work update text");

    const prior = [...this.#expectations.entries()].find(
      ([workflowId, { identityAnchor: anchor }]) =>
        anchor === identityAnchor &&
        this.#repositories.workflows.getWorkflow(context.clinicId, workflowId)?.status === "OPEN",
    )?.[1];
    if (
      input.kind === "EXAM_REPORT" &&
      (!prior || Date.parse(occurredAt) < Date.parse(prior.expectation.triggeredAt))
    ) {
      throw new DomainError(
        "UNSUPPORTED_PREVIEW_SEQUENCE",
        "An EXAM_REPORT requires an earlier exact-anchor REGISTRATION.",
      );
    }

    const artifact: Artifact = {
      id: this.#id("artifact"),
      clinicId: context.clinicId,
      kind: input.kind,
      occurredAt,
      occurredAtSource: "employee_confirmed",
      sourceEmployeeId: context.actorId,
      identityAnchor,
      payload: { text, synthetic: true },
      createdAt: now,
    };
    const triggeredAt = prior?.expectation.triggeredAt ?? occurredAt;
    const dueAt = prior?.expectation.dueAt ?? new Date(Date.parse(occurredAt) + 15 * 60_000).toISOString();
    const expectationId = prior?.expectation.id ?? this.#id("expectation");
    const result = runGoldenPath(
      {
        artifact,
        parser: previewParser,
        expectation: {
          id: expectationId,
          triggerKind: "REGISTRATION",
          consequenceKind: "EXAM_REPORT",
          triggeredAt,
          dueAt,
        },
        now,
      },
      this.#repositories,
    );
    if (!result.workflow || !result.expectation) {
      throw new DomainError("PREVIEW_MATCHING_AMBIGUITY", "Preview workflow matching needs review.");
    }

    this.#expectations.set(result.workflow.id, {
      expectation: result.expectation,
      identityAnchor,
    });
    this.#addMessage(context, input.topicId, "EMPLOYEE", "WORK_UPDATE", text, now);
    this.#addMessage(
      context,
      input.topicId,
      "LOCAL_SYSTEM",
      "WORK_UPDATE_RESULT",
      `${result.workflow.id} · ${result.expectation.state}`,
      now,
    );
    return {
      artifactId: artifact.id,
      clinicId: context.clinicId,
      sourceEmployeeId: context.actorId,
      workflowId: result.workflow.id,
      expectationState: result.expectation.state,
    };
  }

  managerClosures(context: ActorContext, now: string): ManagerPreviewItem[] {
    this.#manager(context);
    const evaluatedAt = requireTimestamp(now, "Manager projection time");
    return [...this.#expectations.entries()].map(([workflowId, stored]) => {
      const current = this.#currentWorkflow(workflowId, evaluatedAt);
      const decisions = this.#repositories.workflows.listManagerDecisions(context.clinicId, workflowId);
      const latest = decisions.at(-1);
      return this.#managerItem(
        stored,
        current.workflow,
        current.expectation,
        current.verification,
        current.artifacts,
        latest,
      );
    });
  }

  submitManagerDecision(context: ActorContext, input: {
    workflowId: string;
    action: ManagerDecisionAction;
    reasonCode: string | null;
    note: string | null;
    now: string;
  }): { decision: ManagerDecision; managerItem: ManagerPreviewItem } {
    this.#manager(context);
    const now = requireTimestamp(input.now, "Manager decision time");
    const stored = this.#expectations.get(input.workflowId);
    if (!stored) throw new DomainError("WORKFLOW_NOT_FOUND", "Preview Workflow was not found.");
    const current = this.#currentWorkflow(input.workflowId, now);
    stored.expectation = current.expectation;
    const result = this.#repositories.workflows.recordManagerDecision(context, {
      id: this.#id("decision"),
      workflowId: input.workflowId,
      expectation: current.expectation,
      verification: current.verification,
      action: input.action,
      reasonCode: input.reasonCode,
      note: input.note,
      decidedAt: now,
    });
    return {
      decision: result.decision,
      managerItem: this.#managerItem(
        stored,
        result.workflow,
        current.expectation,
        current.verification,
        current.artifacts,
        result.decision,
      ),
    };
  }

  managerDecisionHistory(context: ActorContext, workflowId: string): ManagerDecision[] {
    this.#manager(context);
    if (!this.#expectations.has(workflowId)) {
      throw new DomainError("WORKFLOW_NOT_FOUND", "Preview Workflow was not found.");
    }
    return this.#repositories.workflows.listManagerDecisions(context.clinicId, workflowId);
  }

  debugCounts(context: ActorContext): { artifacts: number; workflows: number; expectations: number } {
    this.#manager(context);
    return {
      artifacts: this.#messages.filter(({ type }) => type === "WORK_UPDATE").length,
      workflows: this.#repositories.workflows.listOpenWorkflows(context.clinicId).length,
      expectations: this.#expectations.size,
    };
  }

  #requireTopic(context: ActorContext, topicId: string): PreviewTopic {
    const topic = this.#topics.get(topicId);
    if (
      !topic ||
      topic.clinicId !== context.clinicId ||
      topic.ownerEmployeeId !== context.actorId
    ) throw new DomainError("TOPIC_NOT_FOUND", "Preview topic was not found.");
    return topic;
  }

  #currentWorkflow(workflowId: string, now: string): {
    workflow: Workflow;
    expectation: Expectation;
    verification: VerificationResult;
    artifacts: Artifact[];
  } {
    const stored = this.#expectations.get(workflowId);
    const workflow = this.#repositories.workflows.getWorkflow(this.#clinicId, workflowId);
    if (!stored || !workflow) {
      throw new DomainError("WORKFLOW_NOT_FOUND", "Stored preview Workflow is unavailable.");
    }
    const artifacts = this.#repositories.workflows.listLinks(this.#clinicId, workflowId)
      .map((link) => this.#repositories.artifacts.get(this.#clinicId, link.artifactId))
      .filter((artifact): artifact is Artifact => artifact !== null);
    const expectation = evaluateExpectation(stored.expectation, artifacts, now);
    const verification = verifyS2({ workflow, expectation, linkedArtifacts: artifacts, now });
    stored.expectation = expectation;
    return { workflow, expectation, verification, artifacts };
  }

  #managerItem(
    stored: StoredExpectation,
    workflow: Workflow,
    expectation: Expectation,
    verification: VerificationResult,
    artifacts: readonly Artifact[],
    latestDecision?: ManagerDecision,
  ): ManagerPreviewItem {
    const terminal = workflow.status === "CLOSED" || workflow.status === "VOIDED";
    return {
      identityAnchor: stored.identityAnchor,
      workflowFamily: workflow.workflowFamily,
      verificationStatus: terminal && latestDecision
        ? latestDecision.verificationStatus
        : verification.status,
      verificationReasonCodes: terminal && latestDecision
        ? [...latestDecision.verificationReasonCodes]
        : [...verification.reasonCodes],
      latestDecision: latestDecision
        ? {
            action: latestDecision.action,
            reasonCode: latestDecision.reasonCode,
            decidedAt: latestDecision.decidedAt,
          }
        : null,
      ...projectManagerClosure({
        workflow,
        expectation,
        verification,
        evidenceArtifactIds: artifacts.map(({ id }) => id),
      }),
    };
  }

  #addMessage(
    context: ActorContext,
    topicId: string,
    role: PreviewMessage["role"],
    type: PreviewMessage["type"],
    text: string,
    createdAt: string,
  ): PreviewMessage {
    const message = {
      id: this.#id("message"),
      clinicId: context.clinicId,
      ownerEmployeeId: context.actorId,
      topicId,
      role,
      type,
      text,
      createdAt,
    };
    this.#messages.push(message);
    return message;
  }

  #id(prefix: string): string {
    return `${prefix}-${this.#nextId++}`;
  }

  #employee(context: ActorContext): void {
    assertActorAccess(context, this.#clinicId, "EMPLOYEE");
  }

  #manager(context: ActorContext): void {
    assertActorAccess(context, this.#clinicId, "MANAGER");
  }
}

function previewParser(artifact: Artifact): EvidenceFactCard & Record<string, unknown> {
  return {
    id: `fact:${artifact.id}`,
    clinicId: artifact.clinicId,
    artifactId: artifact.id,
    subjectType: "PATIENT",
    identityAnchor: artifact.identityAnchor,
    workflowFamily: "EYE_EXAM",
    occurredAt: artifact.occurredAt,
    fields: { synthetic: true },
    missingFields: [],
    confidence: 1,
    parserVersion: "preview-deterministic-1",
    lineageArtifactIds: [artifact.id],
  };
}
