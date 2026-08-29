export type IsoTimestamp = string;

export interface Artifact {
  id: string;
  clinicId: string;
  kind: string;
  occurredAt: IsoTimestamp | null;
  occurredAtSource: "source" | "employee_confirmed" | "unknown";
  sourceEmployeeId: string;
  identityAnchor: string | null;
  payload: unknown;
  createdAt: IsoTimestamp;
}

export interface EvidenceFactCard {
  id: string;
  clinicId: string;
  artifactId: string;
  subjectType: string;
  identityAnchor: string | null;
  workflowFamily: string;
  occurredAt: IsoTimestamp | null;
  fields: Record<string, unknown>;
  missingFields: string[];
  confidence: number;
  parserVersion: string;
  lineageArtifactIds: string[];
}

export interface Workflow {
  id: string;
  clinicId: string;
  subjectType: string;
  identityAnchor: string | null;
  workflowFamily: string;
  status: "OPEN" | "CLOSED" | "VOIDED";
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface WorkflowArtifactLink {
  id: string;
  clinicId: string;
  workflowId: string;
  artifactId: string;
  attachedAt: IsoTimestamp;
  decisionSource: "DETERMINISTIC" | "HUMAN";
  reasoningChain: string[];
}

export interface Expectation {
  id: string;
  clinicId: string;
  workflowId: string;
  triggerKind: string;
  consequenceKind: string;
  triggeredAt: IsoTimestamp;
  dueAt: IsoTimestamp;
  state: "OPEN" | "MET" | "UNMET" | "VOIDED";
  satisfiedByArtifactId: string | null;
  evaluatedAt: IsoTimestamp;
}

export interface ManagerClosureView {
  workflowId: string | null;
  workflowStatus: Workflow["status"] | null;
  expectationState: Expectation["state"] | null;
  evidenceArtifactIds: string[];
  needsReview: boolean;
  reasonCodes: string[];
}

export type ManagerDecisionAction =
  | "CLOSE_STANDARD"
  | "CLOSE_EXCEPTION"
  | "KEEP_OPEN"
  | "VOID";

export interface ManagerDecision {
  id: string;
  clinicId: string;
  workflowId: string;
  expectationId: string;
  action: ManagerDecisionAction;
  reasonCode: string | null;
  note: string | null;
  actorId: string;
  actorRole: "MANAGER";
  decidedAt: IsoTimestamp;
  evidenceArtifactIds: string[];
}

export type WorkflowResolution =
  | { kind: "ATTACH_EXISTING"; workflowId: string }
  | { kind: "CREATE_NEW" }
  | { kind: "REVIEW_REQUIRED"; candidateWorkflowIds: string[] };

export interface ExpectationSpec {
  id: string;
  triggerKind: string;
  consequenceKind: string;
  triggeredAt: IsoTimestamp;
  dueAt: IsoTimestamp;
  voided?: boolean;
}

export interface GoldenPathInput {
  artifact: Artifact;
  parser: (artifact: Artifact) => EvidenceFactCard & Record<string, unknown>;
  expectation: ExpectationSpec;
  now: IsoTimestamp;
}

export interface GoldenPathResult {
  artifact: Artifact;
  factCard: EvidenceFactCard;
  resolution: WorkflowResolution;
  workflow: Workflow | null;
  link: WorkflowArtifactLink | null;
  expectation: Expectation | null;
  managerView: ManagerClosureView;
}
