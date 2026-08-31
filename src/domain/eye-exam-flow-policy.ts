import { DomainError } from "./errors.ts";

export const EYE_EXAM_FLOW_KINDS = [
  "REGISTRATION",
  "PRESCRIPTION",
  "EXAM_REPORT",
  "PAYMENT",
] as const;

export type EyeExamFlowKind = typeof EYE_EXAM_FLOW_KINDS[number];

const NEXT: Readonly<Record<EyeExamFlowKind, EyeExamFlowKind | null>> = Object.freeze({
  REGISTRATION: "PRESCRIPTION",
  PRESCRIPTION: "EXAM_REPORT",
  EXAM_REPORT: "PAYMENT",
  PAYMENT: null,
});

const DUE_MINUTES: Readonly<Record<Exclude<EyeExamFlowKind, "PAYMENT">, number>> = Object.freeze({
  REGISTRATION: 15,
  PRESCRIPTION: 30,
  EXAM_REPORT: 20,
});

export function nextEyeExamExpectation(kind: EyeExamFlowKind, occurredAt: string): {
  triggerKind: EyeExamFlowKind;
  consequenceKind: EyeExamFlowKind;
  dueAt: string;
} | null {
  const next = NEXT[kind];
  if (next === null) return null;
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) {
    throw new DomainError("INVALID_FLOW_EVENT_TIME", "Flow event time must be an explicit instant.");
  }
  return Object.freeze({
    triggerKind: kind,
    consequenceKind: next,
    dueAt: new Date(timestamp + DUE_MINUTES[kind] * 60_000).toISOString(),
  });
}

export function isEyeExamFlowKind(value: unknown): value is EyeExamFlowKind {
  return typeof value === "string" && (EYE_EXAM_FLOW_KINDS as readonly string[]).includes(value);
}
