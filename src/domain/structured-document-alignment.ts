import { DomainError } from "./errors.ts";
import { EYE_EXAM_FLOW_KINDS, type EyeExamFlowKind } from "./eye-exam-flow-policy.ts";
import { types } from "node:util";

/** A deliberately small, transport-neutral projection of an immutable document. */
export const STRUCTURED_DOCUMENT_SCHEMA_VERSION = "clinic-os/structured-document/v1";
export const STRUCTURED_DOCUMENT_WORKFLOW_FAMILY = "EYE_EXAM";

const FIELDS = [
  "schemaVersion",
  "sourceKind",
  "kind",
  "identityAnchor",
  "occurredAt",
  "workflowFamily",
] as const;

const ALIGNMENT_REASON_ORDER = [
  "INVALID_DOCUMENT",
  "KIND_CONFLICT",
  "MISSING_REGISTRATION",
  "MISSING_PRESCRIPTION",
  "MISSING_EXAM_REPORT",
  "MISSING_PAYMENT",
  "DUPLICATE_DOCUMENT",
  "IDENTITY_CONFLICT",
  "WORKFLOW_FAMILY_CONFLICT",
  "TIME_ORDER_CONFLICT",
] as const;

export type StructuredDocumentAlignmentReason = typeof ALIGNMENT_REASON_ORDER[number];

export interface StructuredDocument {
  readonly schemaVersion: typeof STRUCTURED_DOCUMENT_SCHEMA_VERSION;
  /** The immutable Artifact kind supplied by the trusted capture/persistence path. */
  readonly sourceKind: EyeExamFlowKind;
  /** The kind claimed by the bounded structured projection. */
  readonly kind: EyeExamFlowKind;
  readonly identityAnchor: string;
  readonly occurredAt: string;
  readonly workflowFamily: typeof STRUCTURED_DOCUMENT_WORKFLOW_FAMILY;
}

export interface StructuredDocumentAlignment {
  readonly status: "ALIGNED" | "MISSING" | "CONFLICT";
  readonly reasonCodes: readonly StructuredDocumentAlignmentReason[];
  readonly documents: readonly StructuredDocument[];
}

function isFlowKind(value: string): value is EyeExamFlowKind {
  return (EYE_EXAM_FLOW_KINDS as readonly string[]).includes(value);
}

/**
 * Reads only own data descriptors.  In particular, it never evaluates a
 * supplied getter.  Proxy traps or any other reflective failure are rejected
 * as an invalid shape before a projection is constructed.
 */
function ownDataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has an invalid shape.");
  }
  // Node can identify proxies without consulting their user-controlled traps.
  if (types.isProxy(value)) {
    throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has an invalid shape.");
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has an invalid shape.");
    }
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key as typeof FIELDS[number]))) {
      throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has an invalid shape.");
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const field of FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has an invalid shape.");
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has an invalid shape.");
  }
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function strictInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseStructuredDocument(input: unknown): StructuredDocument {
  const record = ownDataRecord(input);
  if (record.schemaVersion !== STRUCTURED_DOCUMENT_SCHEMA_VERSION) {
    throw new DomainError("UNSUPPORTED_DOCUMENT_SCHEMA", "Document schema version is not supported.");
  }
  if (typeof record.sourceKind !== "string" || typeof record.kind !== "string" ||
    !isFlowKind(record.sourceKind) || !isFlowKind(record.kind)) {
    throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has an invalid kind.");
  }
  if (record.sourceKind !== record.kind) {
    throw new DomainError("DOCUMENT_KIND_CONFLICT", "Document projection kind conflicts with its source document.");
  }
  if (!boundedText(record.identityAnchor) || !strictInstant(record.occurredAt) ||
    record.workflowFamily !== STRUCTURED_DOCUMENT_WORKFLOW_FAMILY) {
    throw new DomainError("INVALID_STRUCTURED_DOCUMENT", "Document projection has invalid bounded fields.");
  }
  return Object.freeze({
    schemaVersion: STRUCTURED_DOCUMENT_SCHEMA_VERSION,
    sourceKind: record.sourceKind,
    kind: record.kind,
    identityAnchor: record.identityAnchor,
    occurredAt: record.occurredAt,
    workflowFamily: STRUCTURED_DOCUMENT_WORKFLOW_FAMILY,
  });
}

function missingReason(kind: EyeExamFlowKind): StructuredDocumentAlignmentReason {
  return `MISSING_${kind}` as StructuredDocumentAlignmentReason;
}

/**
 * Pure, read-only alignment.  It creates no Artifact, FactCard, expectation
 * or decision: callers may use this bounded result only as review evidence.
 */
export function alignStructuredDocuments(inputs: readonly unknown[]): StructuredDocumentAlignment {
  const reasons = new Set<StructuredDocumentAlignmentReason>();
  const documents: StructuredDocument[] = [];
  for (const input of inputs) {
    try {
      documents.push(parseStructuredDocument(input));
    } catch (error) {
      reasons.add(error instanceof DomainError && error.code === "DOCUMENT_KIND_CONFLICT"
        ? "KIND_CONFLICT"
        : "INVALID_DOCUMENT");
    }
  }

  for (const kind of EYE_EXAM_FLOW_KINDS) {
    const count = documents.filter((document) => document.kind === kind).length;
    if (count === 0) reasons.add(missingReason(kind));
    if (count > 1) reasons.add("DUPLICATE_DOCUMENT");
  }

  if (documents.length > 1) {
    if (new Set(documents.map((document) => document.identityAnchor)).size > 1) reasons.add("IDENTITY_CONFLICT");
    if (new Set(documents.map((document) => document.workflowFamily)).size > 1) reasons.add("WORKFLOW_FAMILY_CONFLICT");
  }

  const ordered = EYE_EXAM_FLOW_KINDS.map((kind) => documents.find((document) => document.kind === kind));
  if (ordered.every((document): document is StructuredDocument => document !== undefined)) {
    for (let index = 1; index < ordered.length; index += 1) {
      if (Date.parse(ordered[index - 1].occurredAt) >= Date.parse(ordered[index].occurredAt)) {
        reasons.add("TIME_ORDER_CONFLICT");
        break;
      }
    }
  }

  const conflict = reasons.has("INVALID_DOCUMENT") || reasons.has("KIND_CONFLICT") ||
    reasons.has("DUPLICATE_DOCUMENT") || reasons.has("IDENTITY_CONFLICT") ||
    reasons.has("WORKFLOW_FAMILY_CONFLICT") || reasons.has("TIME_ORDER_CONFLICT");
  return Object.freeze({
    status: conflict ? "CONFLICT" : reasons.size > 0 ? "MISSING" : "ALIGNED",
    reasonCodes: Object.freeze(ALIGNMENT_REASON_ORDER.filter((reason) => reasons.has(reason))),
    documents: Object.freeze([...documents]),
  });
}
