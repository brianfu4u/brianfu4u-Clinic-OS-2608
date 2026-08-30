import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { deriveEvidenceObjectId, EvidenceObjectIngestionService } from "../src/application/evidence-object-ingestion.ts";

const CONTEXT: ActorContext = { clinicId: "clinic-service", actorId: "employee-service", role: "EMPLOYEE" };
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function fakeStore() {
  const calls: unknown[] = [];
  return {
    calls,
    async put(context: ActorContext, command: { objectId: string; mediaType: string; bytes: Uint8Array }) {
      calls.push({ context, command });
      return {
        clinicId: context.clinicId,
        objectId: command.objectId,
        contentSha256: createHash("sha256").update(command.bytes).digest("hex"),
        sizeBytes: command.bytes.byteLength,
        mediaType: command.mediaType,
      };
    },
  };
}

test("service derives scoped object identity and snapshots the request", async () => {
  const store = fakeStore();
  const service = new EvidenceObjectIngestionService(store);
  const original = new Uint8Array(BYTES);
  const expected = new Uint8Array(original);
  const input = { idempotencyKey: "service-key-1", mediaType: "image/png", bytes: original };
  const pending = service.ingest(CONTEXT, input);
  input.bytes.fill(0);
  const ref = await pending;
  assert.equal(ref.objectId, deriveEvidenceObjectId(CONTEXT, "service-key-1"));
  assert.equal(ref.sizeBytes, BYTES.byteLength);
  assert.equal(store.calls.length, 1);
  const called = store.calls[0] as any;
  assert.deepEqual(called.context, CONTEXT);
  assert.deepEqual(called.command.bytes, expected);
  called.command.bytes.fill(0);
  assert.notEqual((await service.ingest(CONTEXT, { ...input, bytes: BYTES })).objectId, undefined);
});

test("service rejects authority fields, wrong role, unsupported media and bad keys before storage", async () => {
  const store = fakeStore();
  const service = new EvidenceObjectIngestionService(store);
  await assert.rejects(service.ingest(CONTEXT, { idempotencyKey: "short", mediaType: "image/png", bytes: BYTES }), hasCode("INVALID_IDEMPOTENCY_KEY"));
  await assert.rejects(service.ingest(CONTEXT, { idempotencyKey: "service-key-2", mediaType: "text/plain", bytes: BYTES }), hasCode("UNSUPPORTED_CONTENT_TYPE"));
  await assert.rejects(service.ingest(CONTEXT, { idempotencyKey: "service-key-3", mediaType: "image/png", bytes: new Uint8Array() }), hasCode("INVALID_OBJECT_BYTES"));
  await assert.rejects(service.ingest({ ...CONTEXT, role: "MANAGER" }, { idempotencyKey: "service-key-4", mediaType: "image/png", bytes: BYTES }), hasCode("ROLE_SCOPE_VIOLATION"));
  await assert.rejects(service.ingest(CONTEXT, { idempotencyKey: "service-key-5", mediaType: "image/png", bytes: BYTES, objectId: "client" } as never), hasCode("INVALID_OBJECT_INGESTION_INPUT"));
  assert.equal(store.calls.length, 0);
});

test("service rejects malformed provider references without exposing provider detail", async () => {
  const service = new EvidenceObjectIngestionService({
    async put() { return { clinicId: "other", objectId: "client", contentSha256: "secret", sizeBytes: 1, mediaType: "image/png" }; },
  });
  await assert.rejects(
    service.ingest(CONTEXT, { idempotencyKey: "service-key-6", mediaType: "image/png", bytes: BYTES }),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_OBJECT_STORE_RESPONSE" && !/secret|path/i.test(error.message),
  );
});

function hasCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}
