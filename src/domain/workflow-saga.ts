import type {
  Artifact,
  EvidenceFactCard,
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
}

export class WorkflowSaga {
  readonly #workflows = new Map<string, Workflow>();
  readonly #links = new Map<string, WorkflowArtifactLink>();
  readonly #beforeLinkCommit?: (link: WorkflowArtifactLink) => void;

  constructor(options: WorkflowSagaOptions = {}) {
    this.#beforeLinkCommit = options.beforeLinkCommit;
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
    assertAttachIdentity(factCard, workflow);
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
    assertAttachIdentity(factCard, workflow);
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

  #linkKey(workflowId: string, artifactId: string): string {
    return `${workflowId}\u0000${artifactId}`;
  }
}
