import type {
  Artifact,
  EvidenceFactCard,
  Expectation,
  ManagerDecision,
  ManagerDecisionAction,
  ManagerClosureView,
  Workflow,
} from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { evaluateExpectation } from "../domain/expectation.ts";
import {
  createInMemoryRepositories,
  runGoldenPath,
} from "../domain/golden-path.ts";
import { projectManagerClosure } from "../domain/manager-projection.ts";

export type EmployeeStatus = "ON_DUTY" | "ON_BREAK" | "OFF_DUTY";

export interface PreviewTopic {
  id: string;
  title: string;
  createdAt: string;
}

export interface PreviewMessage {
  id: string;
  topicId: string;
  role: "EMPLOYEE" | "LOCAL_SYSTEM";
  type: "CONVERSATION" | "WORK_UPDATE" | "WORK_UPDATE_RESULT";
  text: string;
  createdAt: string;
}

export interface ManagerPreviewItem extends ManagerClosureView {
  identityAnchor: string;
  workflowFamily: string;
  latestDecision: Pick<ManagerDecision, "action" | "reasonCode" | "decidedAt"> | null;
}

interface StoredExpectation {
  expectation: Expectation;
  identityAnchor: string;
}

const CLINIC_ID = "demo-clinic";
const EMPLOYEE_ID = "demo-employee";
const MANAGER_ID = "demo-manager";

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
  #status: EmployeeStatus = "OFF_DUTY";
  #nextId = 1;

  bootstrap(): {
    employeeId: string;
    status: EmployeeStatus;
    topics: PreviewTopic[];
    messages: PreviewMessage[];
  } {
    return {
      employeeId: EMPLOYEE_ID,
      status: this.#status,
      topics: structuredClone([...this.#topics.values()]),
      messages: structuredClone(this.#messages),
    };
  }

  setStatus(status: EmployeeStatus): EmployeeStatus {
    if (!["ON_DUTY", "ON_BREAK", "OFF_DUTY"].includes(status)) {
      throw new DomainError("INVALID_EMPLOYEE_STATUS", "Unknown employee status.");
    }
    this.#status = status;
    return status;
  }

  createTopic(title: string, now: string): PreviewTopic {
    const topic: PreviewTopic = {
      id: this.#id("topic"),
      title: requireText(title, "Topic title", 100),
      createdAt: requireTimestamp(now, "Topic createdAt"),
    };
    this.#topics.set(topic.id, topic);
    return structuredClone(topic);
  }

  addConversation(topicId: string, text: string, now: string): PreviewMessage[] {
    this.#requireTopic(topicId);
    const createdAt = requireTimestamp(now, "Message createdAt");
    const employeeMessage = this.#addMessage(
      topicId,
      "EMPLOYEE",
      "CONVERSATION",
      requireText(text, "Message"),
      createdAt,
    );
    const acknowledgement = this.#addMessage(
      topicId,
      "LOCAL_SYSTEM",
      "CONVERSATION",
      "ローカルメモとして保存しました。業務記録には登録されていません。",
      createdAt,
    );
    return structuredClone([employeeMessage, acknowledgement]);
  }

  submitWorkUpdate(input: {
    topicId: string;
    kind: "REGISTRATION" | "EXAM_REPORT";
    identityAnchor: string;
    workflowFamily: string;
    occurredAt: string;
    text: string;
    now: string;
  }): { workflowId: string; expectationState: Expectation["state"] } {
    this.#requireTopic(input.topicId);
    if (this.#status !== "ON_DUTY") {
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
        this.#repositories.workflows.getWorkflow(CLINIC_ID, workflowId)?.status === "OPEN",
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
      clinicId: CLINIC_ID,
      kind: input.kind,
      occurredAt,
      occurredAtSource: "employee_confirmed",
      sourceEmployeeId: EMPLOYEE_ID,
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
    this.#addMessage(input.topicId, "EMPLOYEE", "WORK_UPDATE", text, now);
    this.#addMessage(
      input.topicId,
      "LOCAL_SYSTEM",
      "WORK_UPDATE_RESULT",
      `${result.workflow.id} · ${result.expectation.state}`,
      now,
    );
    return {
      workflowId: result.workflow.id,
      expectationState: result.expectation.state,
    };
  }

  managerClosures(now: string): ManagerPreviewItem[] {
    const evaluatedAt = requireTimestamp(now, "Manager projection time");
    return [...this.#expectations.entries()].map(([workflowId, stored]) => {
      const current = this.#currentWorkflow(workflowId, evaluatedAt);
      const decisions = this.#repositories.workflows.listManagerDecisions(CLINIC_ID, workflowId);
      const latest = decisions.at(-1);
      return this.#managerItem(stored, current.workflow, current.expectation, current.artifacts, latest);
    });
  }

  submitManagerDecision(input: {
    workflowId: string;
    action: ManagerDecisionAction;
    reasonCode: string | null;
    note: string | null;
    now: string;
  }): { decision: ManagerDecision; managerItem: ManagerPreviewItem } {
    const now = requireTimestamp(input.now, "Manager decision time");
    const stored = this.#expectations.get(input.workflowId);
    if (!stored) throw new DomainError("WORKFLOW_NOT_FOUND", "Preview Workflow was not found.");
    const current = this.#currentWorkflow(input.workflowId, now);
    stored.expectation = current.expectation;
    const result = this.#repositories.workflows.recordManagerDecision({
      id: this.#id("decision"),
      clinicId: CLINIC_ID,
      workflowId: input.workflowId,
      expectation: current.expectation,
      action: input.action,
      reasonCode: input.reasonCode,
      note: input.note,
      actorId: MANAGER_ID,
      actorRole: "MANAGER",
      decidedAt: now,
    });
    return {
      decision: result.decision,
      managerItem: this.#managerItem(
        stored,
        result.workflow,
        current.expectation,
        current.artifacts,
        result.decision,
      ),
    };
  }

  managerDecisionHistory(workflowId: string): ManagerDecision[] {
    if (!this.#expectations.has(workflowId)) {
      throw new DomainError("WORKFLOW_NOT_FOUND", "Preview Workflow was not found.");
    }
    return this.#repositories.workflows.listManagerDecisions(CLINIC_ID, workflowId);
  }

  debugCounts(): { artifacts: number; workflows: number; expectations: number } {
    return {
      artifacts: this.#messages.filter(({ type }) => type === "WORK_UPDATE").length,
      workflows: this.#repositories.workflows.listOpenWorkflows(CLINIC_ID).length,
      expectations: this.#expectations.size,
    };
  }

  #requireTopic(topicId: string): PreviewTopic {
    const topic = this.#topics.get(topicId);
    if (!topic) throw new DomainError("TOPIC_NOT_FOUND", "Preview topic was not found.");
    return topic;
  }

  #currentWorkflow(workflowId: string, now: string): {
    workflow: Workflow;
    expectation: Expectation;
    artifacts: Artifact[];
  } {
    const stored = this.#expectations.get(workflowId);
    const workflow = this.#repositories.workflows.getWorkflow(CLINIC_ID, workflowId);
    if (!stored || !workflow) {
      throw new DomainError("WORKFLOW_NOT_FOUND", "Stored preview Workflow is unavailable.");
    }
    const artifacts = this.#repositories.workflows.listLinks(CLINIC_ID, workflowId)
      .map((link) => this.#repositories.artifacts.get(CLINIC_ID, link.artifactId))
      .filter((artifact): artifact is Artifact => artifact !== null);
    const expectation = evaluateExpectation(stored.expectation, artifacts, now);
    stored.expectation = expectation;
    return { workflow, expectation, artifacts };
  }

  #managerItem(
    stored: StoredExpectation,
    workflow: Workflow,
    expectation: Expectation,
    artifacts: readonly Artifact[],
    latestDecision?: ManagerDecision,
  ): ManagerPreviewItem {
    return {
      identityAnchor: stored.identityAnchor,
      workflowFamily: workflow.workflowFamily,
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
        evidenceArtifactIds: artifacts.map(({ id }) => id),
      }),
    };
  }

  #addMessage(
    topicId: string,
    role: PreviewMessage["role"],
    type: PreviewMessage["type"],
    text: string,
    createdAt: string,
  ): PreviewMessage {
    const message = { id: this.#id("message"), topicId, role, type, text, createdAt };
    this.#messages.push(message);
    return message;
  }

  #id(prefix: string): string {
    return `${prefix}-${this.#nextId++}`;
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
