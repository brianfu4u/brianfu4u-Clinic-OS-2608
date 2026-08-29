import type {
  Artifact,
  EvidenceFactCard,
  Expectation,
  ManagerDecision,
  ManagerDecisionAction,
  Workflow,
  WorkflowArtifactLink,
} from "./contracts.ts";
import { DomainError } from "./errors.ts";
import { assertAttachIdentity } from "./identity-gate.ts";

export interface SagaResult {
  workflow: Workflow;
  link: WorkflowArtifactLink;
}

export interface WorkflowSagaOptions {
  initialWorkflows?: readonly Workflow[];
  initialLinks?: readonly WorkflowArtifactLink[];
  beforeLinkCommit?: (link: WorkflowArtifactLink) => void;
  beforeDecisionCommit?: (decision: ManagerDecision, workflow: Workflow) => void;
}

export interface ManagerDecisionInput {
  id: string;
  clinicId: string;
  workflowId: string;
  expectation: Expectation;
  action: ManagerDecisionAction;
  reasonCode: string | null;
  note: string | null;
  actorId: string;
  actorRole: "MANAGER";
  decidedAt: string;
}

export interface DecisionSagaResult {
  workflow: Workflow;
  decision: ManagerDecision;
}

export const MANAGER_REASON_CODES = [
  "LEGITIMATE_DEVIATION",
  "MISSING_EXTERNAL_RECORD",
  "DUPLICATE_WORKFLOW",
  "PATIENT_CANCELLED",
  "NEEDS_MORE_EVIDENCE",
] as const;

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function nullableText(value: string | null, maxLength: number, code: string): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new DomainError(code, `Value cannot exceed ${maxLength} characters.`);
  }
  return trimmed;
}

export class WorkflowSaga {
  readonly #workflows = new Map<string, Workflow>();
  readonly #links = new Map<string, WorkflowArtifactLink>();
  readonly #decisions = new Map<string, ManagerDecision>();
  readonly #beforeLinkCommit?: (link: WorkflowArtifactLink) => void;
  readonly #beforeDecisionCommit?: (decision: ManagerDecision, workflow: Workflow) => void;

  constructor(options: WorkflowSagaOptions = {}) {
    this.#beforeLinkCommit = options.beforeLinkCommit;
    this.#beforeDecisionCommit = options.beforeDecisionCommit;
    for (const workflow of options.initialWorkflows ?? []) {
      this.#workflows.set(workflow.id, structuredClone(workflow));
    }
    for (const link of options.initialLinks ?? []) {
      this.#links.set(this.#linkKey(link.workflowId, link.artifactId), structuredClone(link));
    }
  }

  listOpenWorkflows(clinicId: string): Workflow[] {
    return [...this.#workflows.values()]
      .filter((workflow) => workflow.clinicId === clinicId && workflow.status === "OPEN")
      .map((workflow) => structuredClone(workflow));
  }

  getWorkflow(clinicId: string, workflowId: string): Workflow | null {
    const workflow = this.#workflows.get(workflowId);
    return workflow?.clinicId === clinicId ? structuredClone(workflow) : null;
  }

  listLinks(clinicId: string, workflowId: string): WorkflowArtifactLink[] {
    if (!this.getWorkflow(clinicId, workflowId)) return [];
    return [...this.#links.values()]
      .filter((link) => link.clinicId === clinicId && link.workflowId === workflowId)
      .map((link) => structuredClone(link));
  }

  listManagerDecisions(clinicId: string, workflowId: string): ManagerDecision[] {
    if (!this.getWorkflow(clinicId, workflowId)) return [];
    return [...this.#decisions.values()]
      .filter((decision) => decision.clinicId === clinicId && decision.workflowId === workflowId)
      .map((decision) => structuredClone(decision));
  }

  recordManagerDecision(input: ManagerDecisionInput): DecisionSagaResult {
    if (input.actorRole !== "MANAGER") {
      throw new DomainError("MANAGER_ROLE_REQUIRED", "Only a manager may decide a Workflow.");
    }
    if (!input.id || !input.actorId || !Number.isFinite(Date.parse(input.decidedAt))) {
      throw new DomainError("INVALID_MANAGER_DECISION", "Decision ID, actor and timestamp are required.");
    }
    if (!["CLOSE_STANDARD", "CLOSE_EXCEPTION", "KEEP_OPEN", "VOID"].includes(input.action)) {
      throw new DomainError("INVALID_MANAGER_ACTION", "Unknown manager action.");
    }
    const workflow = this.#workflows.get(input.workflowId);
    if (!workflow || workflow.clinicId !== input.clinicId) {
      throw new DomainError("WORKFLOW_NOT_FOUND", "Workflow is not readable in this clinic.");
    }
    if (
      input.expectation.clinicId !== input.clinicId ||
      input.expectation.workflowId !== input.workflowId ||
      !input.expectation.id
    ) {
      throw new DomainError("EXPECTATION_MISMATCH", "Expectation does not belong to this Workflow.");
    }

    const reasonCode = nullableText(input.reasonCode, 100, "INVALID_REASON_CODE");
    if (
      reasonCode !== null &&
      !(MANAGER_REASON_CODES as readonly string[]).includes(reasonCode)
    ) {
      throw new DomainError("INVALID_REASON_CODE", "Reason code is not controlled.");
    }
    const decision: ManagerDecision = {
      id: input.id,
      clinicId: input.clinicId,
      workflowId: input.workflowId,
      expectationId: input.expectation.id,
      action: input.action,
      reasonCode,
      note: nullableText(input.note, 500, "INVALID_DECISION_NOTE"),
      actorId: input.actorId,
      actorRole: "MANAGER",
      decidedAt: input.decidedAt,
      evidenceArtifactIds: this.listLinks(input.clinicId, input.workflowId)
        .map(({ artifactId }) => artifactId),
    };

    const existing = this.#decisions.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(decision)) {
        throw new DomainError(
          "DECISION_ID_CONFLICT",
          "Decision ID is already used by different content.",
        );
      }
      return { workflow: structuredClone(workflow), decision: structuredClone(existing) };
    }
    if (workflow.status !== "OPEN") {
      throw new DomainError("WORKFLOW_TERMINAL", "Closed and voided Workflows are terminal.");
    }

    this.#assertDecisionAllowed(input.action, input.expectation.state, reasonCode);
    const nextWorkflow: Workflow = {
      ...workflow,
      status: input.action === "VOID"
        ? "VOIDED"
        : input.action.startsWith("CLOSE_") ? "CLOSED" : "OPEN",
      updatedAt: input.decidedAt,
    };
    const storedDecision = freezeDeep(structuredClone(decision));
    this.#beforeDecisionCommit?.(storedDecision, structuredClone(nextWorkflow));
    this.#decisions.set(storedDecision.id, storedDecision);
    this.#workflows.set(nextWorkflow.id, nextWorkflow);
    return {
      workflow: structuredClone(nextWorkflow),
      decision: structuredClone(storedDecision),
    };
  }

  attachExisting(
    workflowId: string,
    artifact: Artifact,
    factCard: EvidenceFactCard,
    attachedAt: string,
  ): SagaResult {
    const workflow = this.#workflows.get(workflowId);
    if (!workflow || workflow.clinicId !== artifact.clinicId) {
      throw new DomainError("WORKFLOW_NOT_FOUND", "Workflow is not readable in this clinic.");
    }
    assertAttachIdentity(factCard, workflow, artifact);
    const existing = this.#links.get(this.#linkKey(workflowId, artifact.id));
    if (existing) {
      return { workflow: structuredClone(workflow), link: structuredClone(existing) };
    }

    const link = this.#makeLink(workflow, artifact, attachedAt);
    this.#beforeLinkCommit?.(link);
    this.#links.set(this.#linkKey(workflowId, artifact.id), link);
    return { workflow: structuredClone(workflow), link: structuredClone(link) };
  }

  createAndAttach(
    artifact: Artifact,
    factCard: EvidenceFactCard,
    attachedAt: string,
  ): SagaResult {
    const workflow: Workflow = {
      id: `wf:${artifact.clinicId}:${artifact.id}`,
      clinicId: artifact.clinicId,
      subjectType: factCard.subjectType,
      identityAnchor: factCard.identityAnchor,
      workflowFamily: factCard.workflowFamily,
      status: "OPEN",
      createdAt: attachedAt,
      updatedAt: attachedAt,
    };
    assertAttachIdentity(factCard, workflow, artifact);
    if (this.#workflows.has(workflow.id)) {
      throw new DomainError("WORKFLOW_ID_CONFLICT", "Generated Workflow ID already exists.");
    }

    const link = this.#makeLink(workflow, artifact, attachedAt);
    this.#beforeLinkCommit?.(link);
    this.#workflows.set(workflow.id, workflow);
    this.#links.set(this.#linkKey(workflow.id, artifact.id), link);
    return { workflow: structuredClone(workflow), link: structuredClone(link) };
  }

  #makeLink(
    workflow: Workflow,
    artifact: Artifact,
    attachedAt: string,
  ): WorkflowArtifactLink {
    return {
      id: `link:${workflow.id}:${artifact.id}`,
      clinicId: artifact.clinicId,
      workflowId: workflow.id,
      artifactId: artifact.id,
      attachedAt,
      decisionSource: "DETERMINISTIC",
      reasoningChain: ["exact_clinic", "exact_subject", "exact_identity", "exact_workflow_family"],
    };
  }

  #assertDecisionAllowed(
    action: ManagerDecisionAction,
    state: Expectation["state"],
    reasonCode: string | null,
  ): void {
    if (action === "CLOSE_STANDARD" && state !== "MET") {
      throw new DomainError("DECISION_NOT_ALLOWED", "Standard close requires a MET Expectation.");
    }
    if (action === "CLOSE_EXCEPTION" && (state !== "UNMET" || reasonCode === null)) {
      throw new DomainError(
        "DECISION_NOT_ALLOWED",
        "Exception close requires UNMET and a controlled reason.",
      );
    }
    if (action === "KEEP_OPEN" && !["OPEN", "UNMET"].includes(state)) {
      throw new DomainError("DECISION_NOT_ALLOWED", "Keep open requires OPEN or UNMET.");
    }
    if (action === "KEEP_OPEN" && state === "UNMET" && reasonCode === null) {
      throw new DomainError("DECISION_NOT_ALLOWED", "Keeping UNMET open requires a reason.");
    }
    if (action === "VOID" && reasonCode === null) {
      throw new DomainError("DECISION_NOT_ALLOWED", "Void requires a controlled reason.");
    }
  }

  #linkKey(workflowId: string, artifactId: string): string {
    return `${workflowId}\u0000${artifactId}`;
  }
}
