import assert from "node:assert/strict";
import test from "node:test";

import { assertActorContext } from "../src/domain/access-context.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { PreviewStore } from "../src/preview/preview-store.ts";

const AT = "2026-08-29T09:00:00.000Z";
const REPORT_AT = "2026-08-29T09:10:00.000Z";
const CLINIC_A = "clinic-a";
const EMPLOYEE_A: ActorContext = {
  clinicId: CLINIC_A,
  actorId: "employee-a",
  role: "EMPLOYEE",
};
const EMPLOYEE_B: ActorContext = {
  clinicId: CLINIC_A,
  actorId: "employee-b",
  role: "EMPLOYEE",
};
const MANAGER_A: ActorContext = {
  clinicId: CLINIC_A,
  actorId: "manager-a",
  role: "MANAGER",
};

function registration(topicId: string, overrides: Record<string, unknown> = {}) {
  return {
    topicId,
    kind: "REGISTRATION" as const,
    identityAnchor: "DEMO-SHARED",
    workflowFamily: "EYE_EXAM",
    occurredAt: AT,
    text: "synthetic registration",
    now: AT,
    ...overrides,
  };
}

function report(topicId: string) {
  return {
    ...registration(topicId),
    kind: "EXAM_REPORT" as const,
    occurredAt: REPORT_AT,
    text: "synthetic report",
    now: REPORT_AT,
  };
}

function readyStore(clinicId = CLINIC_A, employee = EMPLOYEE_A) {
  const store = new PreviewStore(clinicId);
  store.setStatus(employee, "ON_DUTY");
  const topic = store.createTopic(employee, "Owned topic", AT);
  return { store, topic };
}

test("invalid or empty ActorContext fails closed", () => {
  const invalid = [
    null,
    {},
    { clinicId: "", actorId: "employee", role: "EMPLOYEE" },
    { clinicId: "clinic", actorId: " ", role: "EMPLOYEE" },
    { clinicId: "clinic", actorId: "employee", role: "AGENT" },
  ];
  for (const context of invalid) {
    assert.throws(
      () => assertActorContext(context as ActorContext),
      (error) => error instanceof DomainError && error.code === "INVALID_ACTOR_CONTEXT",
    );
  }
});

test("employee status, topics and messages are exact-owner scoped", () => {
  const store = new PreviewStore(CLINIC_A);
  assert.equal(store.bootstrap(EMPLOYEE_A).status, "OFF_DUTY");
  assert.equal(store.bootstrap(EMPLOYEE_B).status, "OFF_DUTY");
  store.setStatus(EMPLOYEE_A, "ON_DUTY");
  assert.equal(store.bootstrap(EMPLOYEE_A).status, "ON_DUTY");
  assert.equal(store.bootstrap(EMPLOYEE_B).status, "OFF_DUTY");

  const topic = store.createTopic(EMPLOYEE_A, "A private topic", AT);
  const messages = store.addConversation(EMPLOYEE_A, topic.id, "A private sentinel", AT);
  assert.equal(topic.clinicId, CLINIC_A);
  assert.equal(topic.ownerEmployeeId, EMPLOYEE_A.actorId);
  assert.ok(messages.every((message) =>
    message.clinicId === CLINIC_A && message.ownerEmployeeId === EMPLOYEE_A.actorId
  ));
  assert.equal(store.bootstrap(EMPLOYEE_A).topics.length, 1);
  assert.equal(store.bootstrap(EMPLOYEE_A).messages.length, 2);
  assert.deepEqual(store.bootstrap(EMPLOYEE_B).topics, []);
  assert.deepEqual(store.bootstrap(EMPLOYEE_B).messages, []);
  assert.throws(
    () => store.addConversation(EMPLOYEE_B, topic.id, "intrusion", AT),
    (error) => error instanceof DomainError && error.code === "TOPIC_NOT_FOUND",
  );
});

test("cross-clinic contexts and wrong roles fail before store mutation", () => {
  const { store, topic } = readyStore();
  const otherEmployee: ActorContext = {
    clinicId: "clinic-b",
    actorId: "employee-a",
    role: "EMPLOYEE",
  };
  const otherManager: ActorContext = {
    clinicId: "clinic-b",
    actorId: "manager-b",
    role: "MANAGER",
  };
  for (const operation of [
    () => store.bootstrap(otherEmployee),
    () => store.setStatus(otherEmployee, "ON_DUTY"),
    () => store.addConversation(otherEmployee, topic.id, "intrusion", AT),
    () => store.managerClosures(otherManager, AT),
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof DomainError && error.code === "TENANT_SCOPE_VIOLATION",
    );
  }
  assert.throws(
    () => store.managerClosures(EMPLOYEE_A, AT),
    (error) => error instanceof DomainError && error.code === "ROLE_SCOPE_VIOLATION",
  );
  assert.throws(
    () => store.submitManagerDecision(EMPLOYEE_A, {
      workflowId: "unknown",
      action: "VOID",
      reasonCode: "PATIENT_CANCELLED",
      note: null,
      now: AT,
    }),
    (error) => error instanceof DomainError && error.code === "ROLE_SCOPE_VIOLATION",
  );
  assert.throws(
    () => store.setStatus(MANAGER_A, "OFF_DUTY"),
    (error) => error instanceof DomainError && error.code === "ROLE_SCOPE_VIOLATION",
  );
  assert.throws(
    () => store.bootstrap(MANAGER_A),
    (error) => error instanceof DomainError && error.code === "ROLE_SCOPE_VIOLATION",
  );
  assert.equal(store.bootstrap(EMPLOYEE_A).messages.length, 0);
});

test("Artifact and ManagerDecision authority derive only from ActorContext", () => {
  const { store, topic } = readyStore();
  const update = store.submitWorkUpdate(EMPLOYEE_A, {
    ...registration(topic.id),
    clinicId: "forged-clinic",
    sourceEmployeeId: "forged-employee",
    ownerEmployeeId: "forged-owner",
  });
  assert.equal(update.clinicId, CLINIC_A);
  assert.equal(update.sourceEmployeeId, EMPLOYEE_A.actorId);
  store.submitWorkUpdate(EMPLOYEE_A, report(topic.id));

  const result = store.submitManagerDecision(MANAGER_A, {
    workflowId: update.workflowId,
    action: "CLOSE_STANDARD",
    reasonCode: null,
    note: null,
    now: REPORT_AT,
  });
  assert.equal(result.decision.clinicId, MANAGER_A.clinicId);
  assert.equal(result.decision.actorId, MANAGER_A.actorId);
  assert.equal(result.decision.actorRole, "MANAGER");
  assert.equal(store.managerDecisionHistory(MANAGER_A, update.workflowId).length, 1);
  assert.throws(
    () => store.managerDecisionHistory({ ...MANAGER_A, clinicId: "clinic-b" }, update.workflowId),
    (error) => error instanceof DomainError && error.code === "TENANT_SCOPE_VIOLATION",
  );
});

test("two clinics with identical anchors remain fully isolated", () => {
  const employeeBClinic: ActorContext = {
    clinicId: "clinic-b",
    actorId: "employee-a",
    role: "EMPLOYEE",
  };
  const managerB: ActorContext = {
    clinicId: "clinic-b",
    actorId: "manager-a",
    role: "MANAGER",
  };
  const first = readyStore(CLINIC_A, EMPLOYEE_A);
  const second = readyStore("clinic-b", employeeBClinic);
  const firstRegistration = first.store.submitWorkUpdate(EMPLOYEE_A, registration(first.topic.id));
  const secondRegistration = second.store.submitWorkUpdate(
    employeeBClinic,
    registration(second.topic.id),
  );
  assert.notEqual(firstRegistration.workflowId, secondRegistration.workflowId);
  assert.equal(firstRegistration.clinicId, CLINIC_A);
  assert.equal(secondRegistration.clinicId, "clinic-b");
  assert.equal(first.store.managerClosures(MANAGER_A, AT).length, 1);
  assert.equal(second.store.managerClosures(managerB, AT).length, 1);
  first.store.submitWorkUpdate(EMPLOYEE_A, report(first.topic.id));
  second.store.submitWorkUpdate(employeeBClinic, report(second.topic.id));
  const firstDecision = first.store.submitManagerDecision(MANAGER_A, {
    workflowId: firstRegistration.workflowId,
    action: "CLOSE_STANDARD",
    reasonCode: null,
    note: null,
    now: REPORT_AT,
  }).decision;
  const secondDecision = second.store.submitManagerDecision(managerB, {
    workflowId: secondRegistration.workflowId,
    action: "CLOSE_STANDARD",
    reasonCode: null,
    note: null,
    now: REPORT_AT,
  }).decision;
  assert.equal(firstDecision.clinicId, CLINIC_A);
  assert.equal(secondDecision.clinicId, "clinic-b");
  assert.equal(first.store.managerDecisionHistory(MANAGER_A, firstRegistration.workflowId).length, 1);
  assert.equal(second.store.managerDecisionHistory(managerB, secondRegistration.workflowId).length, 1);
  assert.throws(
    () => first.store.managerClosures(managerB, AT),
    (error) => error instanceof DomainError && error.code === "TENANT_SCOPE_VIOLATION",
  );
  assert.throws(
    () => second.store.managerClosures(MANAGER_A, AT),
    (error) => error instanceof DomainError && error.code === "TENANT_SCOPE_VIOLATION",
  );
});
