import assert from "node:assert/strict";
import test from "node:test";

import {
  alignStructuredDocuments,
  parseStructuredDocument,
  STRUCTURED_DOCUMENT_SCHEMA_VERSION,
} from "../src/domain/structured-document-alignment.ts";
import { DomainError } from "../src/domain/errors.ts";

const START = Date.parse("2026-08-31T09:00:00.000Z");

function document(kind: string, offsetMinutes: number, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: STRUCTURED_DOCUMENT_SCHEMA_VERSION,
    sourceKind: kind,
    kind,
    identityAnchor: "DEMO-001",
    occurredAt: new Date(START + offsetMinutes * 60_000).toISOString(),
    workflowFamily: "EYE_EXAM",
    ...overrides,
  };
}

function chain(overrides: Record<number, Record<string, unknown>> = {}) {
  return [
    document("REGISTRATION", 0, overrides[0]),
    document("PRESCRIPTION", 5, overrides[1]),
    document("EXAM_REPORT", 10, overrides[2]),
    document("PAYMENT", 15, overrides[3]),
  ];
}

test("each bounded clinical document projection parses exactly and is immutable", () => {
  for (const input of chain()) {
    const result = parseStructuredDocument(input);
    assert.equal(result.kind, input.kind);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("the four-document sequence aligns only with exact identity, family and forward time", () => {
  assert.deepEqual(alignStructuredDocuments(chain()), {
    status: "ALIGNED", reasonCodes: [], documents: chain(),
  });
});

test("missing document and duplicate document stay bounded and explainable", () => {
  const missing = alignStructuredDocuments(chain().slice(0, 3));
  assert.equal(missing.status, "MISSING");
  assert.deepEqual(missing.reasonCodes, ["MISSING_PAYMENT"]);

  const duplicate = alignStructuredDocuments([...chain(), document("PAYMENT", 16)]);
  assert.equal(duplicate.status, "CONFLICT");
  assert.deepEqual(duplicate.reasonCodes, ["DUPLICATE_DOCUMENT"]);
});

test("reversed time, near identity and source-kind mismatch require review", () => {
  assert.deepEqual(alignStructuredDocuments(chain({ 2: { occurredAt: "2026-08-31T09:04:00.000Z" } })).reasonCodes,
    ["TIME_ORDER_CONFLICT"]);
  assert.deepEqual(alignStructuredDocuments(chain({ 3: { identityAnchor: "DEMO-001 " } })).reasonCodes,
    ["IDENTITY_CONFLICT"]);
  assert.deepEqual(alignStructuredDocuments(chain({ 1: { sourceKind: "REGISTRATION" } })).reasonCodes,
    ["KIND_CONFLICT", "MISSING_PRESCRIPTION"]);
});

test("missing, unknown, accessor and proxy-shaped documents are rejected without executing values", () => {
  assert.throws(() => parseStructuredDocument({}),
    (error) => error instanceof DomainError && error.code === "INVALID_STRUCTURED_DOCUMENT");
  assert.throws(() => parseStructuredDocument(document("REGISTRATION", 0, { extra: "no" })),
    (error) => error instanceof DomainError && error.code === "INVALID_STRUCTURED_DOCUMENT");

  let getterCalled = false;
  const accessor = document("REGISTRATION", 0);
  Object.defineProperty(accessor, "identityAnchor", { enumerable: true, get() { getterCalled = true; return "DEMO-001"; } });
  assert.throws(() => parseStructuredDocument(accessor),
    (error) => error instanceof DomainError && error.code === "INVALID_STRUCTURED_DOCUMENT");
  assert.equal(getterCalled, false);

  let proxyGetCalled = false;
  const hostile = new Proxy(document("REGISTRATION", 0), { get() { proxyGetCalled = true; throw new Error("must not read"); } });
  assert.throws(() => parseStructuredDocument(hostile),
    (error) => error instanceof DomainError && error.code === "INVALID_STRUCTURED_DOCUMENT");
  assert.equal(proxyGetCalled, false);
});

test("invalid inputs are report-only conflicts and never become alignment documents", () => {
  const result = alignStructuredDocuments([document("REGISTRATION", 0), { untrusted: true }]);
  assert.equal(result.status, "CONFLICT");
  assert.deepEqual(result.reasonCodes, [
    "INVALID_DOCUMENT", "MISSING_PRESCRIPTION", "MISSING_EXAM_REPORT", "MISSING_PAYMENT",
  ]);
  assert.equal(result.documents.length, 1);
});
