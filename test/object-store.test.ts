import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { RuntimeManifest } from "../src/runtime/contracts.ts";
import type {
  ObjectStoreProvider,
  ProviderGetRequest,
  ProviderGetResponse,
  ProviderPutRequest,
  StoredObjectRef,
} from "../src/storage/contracts.ts";
import { MAX_OBJECT_SIZE_BYTES } from "../src/storage/contracts.ts";
import { LocalObjectStore } from "../src/storage/local-object-store.ts";
import { ObjectStoreGateway } from "../src/storage/object-store-gateway.ts";

const CONTEXT: ActorContext = { clinicId: "clinic-1", actorId: "employee-1", role: "EMPLOYEE" };
const BYTES = new TextEncoder().encode("synthetic evidence");

function strict(): RuntimeManifest {
  return {
    profile: "ON_PREM_STRICT", databaseProvider: "LOCAL_POSTGRES",
    fileProvider: "LOCAL_OBJECT_STORE", inferenceProvider: "DISABLED",
    backupProvider: "LOCAL_ENCRYPTED_BACKUP", externalInferenceAuthorized: false,
    manifestVersion: "manifest-1",
  };
}

function cloud(): RuntimeManifest {
  return {
    profile: "CLOUD", databaseProvider: "CLOUD_SQL_POSTGRES",
    fileProvider: "CLOUD_OBJECT_STORE", inferenceProvider: "DISABLED",
    backupProvider: "CLOUD_MANAGED_BACKUP", externalInferenceAuthorized: false,
    manifestVersion: "manifest-1",
  };
}

class MemoryFixture implements ObjectStoreProvider {
  kind: ObjectStoreProvider["kind"];
  invocations = 0;
  mutate?: (ref: StoredObjectRef) => StoredObjectRef;
  readonly values = new Map<string, ProviderGetResponse>();

  constructor(kind: ObjectStoreProvider["kind"]) { this.kind = kind; }

  async put(_context: ActorContext, request: ProviderPutRequest): Promise<StoredObjectRef> {
    this.invocations += 1;
    const key = `${request.clinicId}:${request.objectId}`;
    const existing = this.values.get(key);
    if (existing && existing.ref.contentSha256 !== request.contentSha256) {
      throw new DomainError("OBJECT_ID_CONFLICT", "Object ID conflict.");
    }
    const ref = { clinicId: request.clinicId, objectId: request.objectId,
      contentSha256: request.contentSha256, sizeBytes: request.sizeBytes, mediaType: request.mediaType };
    this.values.set(key, structuredClone({ ref, bytes: request.bytes }));
    return this.mutate ? this.mutate(ref) : structuredClone(ref);
  }

  async get(_context: ActorContext, request: ProviderGetRequest): Promise<ProviderGetResponse> {
    this.invocations += 1;
    const value = this.values.get(`${request.clinicId}:${request.objectId}`);
    if (!value) throw new DomainError("OBJECT_NOT_FOUND", "Object was not found.");
    return structuredClone(value);
  }
}

async function localGateway(): Promise<{ root: string; gateway: ObjectStoreGateway }> {
  const root = await mkdtemp(join(tmpdir(), "clinic-os-object-"));
  return { root, gateway: new ObjectStoreGateway(strict(), new LocalObjectStore(root)) };
}

test("local put/get round trip snapshots and detaches bytes", async (t) => {
  const { root, gateway } = await localGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = new Uint8Array(BYTES);
  const pending = gateway.put(CONTEXT, { objectId: "report-1", mediaType: "image/png", bytes: input });
  input.fill(0);
  const ref = await pending;
  ref.objectId = "changed";
  const got = await gateway.get(CONTEXT, { objectId: "report-1" });
  assert.deepEqual(got.bytes, BYTES);
  got.bytes.fill(0);
  assert.deepEqual((await gateway.get(CONTEXT, { objectId: "report-1" })).bytes, BYTES);
});

test("exact replay is idempotent and conflicting replay never overwrites", async (t) => {
  const { root, gateway } = await localGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = { objectId: "same", mediaType: "application/pdf", bytes: BYTES };
  assert.deepEqual(await gateway.put(CONTEXT, command), await gateway.put(CONTEXT, command));
  await assert.rejects(gateway.put(CONTEXT, { ...command, bytes: new Uint8Array([9]) }), hasCode("OBJECT_ID_CONFLICT"));
  assert.deepEqual((await gateway.get(CONTEXT, { objectId: "same" })).bytes, BYTES);
});

test("identical IDs are isolated by exact clinic scope", async (t) => {
  const { root, gateway } = await localGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = { ...CONTEXT, clinicId: "clinic-2" };
  await gateway.put(CONTEXT, { objectId: "shared", mediaType: "image/png", bytes: BYTES });
  await gateway.put(other, { objectId: "shared", mediaType: "image/png", bytes: new Uint8Array([2]) });
  assert.deepEqual((await gateway.get(CONTEXT, { objectId: "shared" })).bytes, BYTES);
  assert.deepEqual((await gateway.get(other, { objectId: "shared" })).bytes, new Uint8Array([2]));
});

test("concurrent same content converges and conflicting content cannot overwrite", async (t) => {
  const { root, gateway } = await localGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { objectId: "race", mediaType: "audio/wav" };
  const equal = await Promise.all([gateway.put(CONTEXT, { ...base, bytes: BYTES }), gateway.put(CONTEXT, { ...base, bytes: BYTES })]);
  assert.deepEqual(equal[0], equal[1]);
  const results = await Promise.allSettled([
    gateway.put(CONTEXT, { ...base, objectId: "race-2", bytes: new Uint8Array([1]) }),
    gateway.put(CONTEXT, { ...base, objectId: "race-2", bytes: new Uint8Array([2]) }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
});

test("invalid commands, traversal, empty and oversize bytes fail before provider", async () => {
  const provider = new MemoryFixture("LOCAL_OBJECT_STORE");
  const gateway = new ObjectStoreGateway(strict(), provider);
  const invalid: unknown[] = [
    { objectId: "../escape", mediaType: "image/png", bytes: BYTES },
    { objectId: "/absolute", mediaType: "image/png", bytes: BYTES },
    { objectId: "good", mediaType: "image/png; charset=x", bytes: BYTES },
    { objectId: "good", mediaType: "image/png", bytes: new Uint8Array() },
    { objectId: "good", mediaType: "image/png", bytes: new Uint8Array(MAX_OBJECT_SIZE_BYTES + 1) },
    { objectId: "good", clinicId: "clinic-2", mediaType: "image/png", bytes: BYTES },
  ];
  for (const command of invalid) await assert.rejects(gateway.put(CONTEXT, command as never));
  assert.equal(provider.invocations, 0);
});

test("symlink tenant escape fails without writing outside root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clinic-os-root-"));
  const outside = await mkdtemp(join(tmpdir(), "clinic-os-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const tenant = digest(`clinic:${CONTEXT.clinicId}`);
  await symlink(outside, join(root, tenant));
  const gateway = new ObjectStoreGateway(strict(), new LocalObjectStore(root));
  await assert.rejects(gateway.put(CONTEXT, { objectId: "escape", mediaType: "image/png", bytes: BYTES }), hasCode("OBJECT_STORE_IO_FAILED"));
  assert.deepEqual(await readFileNames(outside), []);
});

test("on-disk truncation is detected on get", async (t) => {
  const { root, gateway } = await localGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  await gateway.put(CONTEXT, { objectId: "damaged", mediaType: "image/png", bytes: BYTES });
  const file = join(root, digest(`clinic:${CONTEXT.clinicId}`), digest("object:damaged"));
  await truncate(file, 5);
  await assert.rejects(gateway.get(CONTEXT, { objectId: "damaged" }), hasCode("OBJECT_INTEGRITY_FAILED"));
});

test("manifest mismatch, Strict cloud provider and identity mutation fail closed", async () => {
  const cloudProvider = new MemoryFixture("CLOUD_OBJECT_STORE");
  assert.throws(() => new ObjectStoreGateway(strict(), cloudProvider), hasCode("REMOTE_OBJECT_STORE_FORBIDDEN"));
  assert.throws(() => new ObjectStoreGateway(cloud(), new MemoryFixture("LOCAL_OBJECT_STORE")), hasCode("OBJECT_STORE_PROVIDER_KIND_MISMATCH"));
  const provider = new MemoryFixture("LOCAL_OBJECT_STORE");
  const gateway = new ObjectStoreGateway(strict(), provider);
  provider.kind = "CLOUD_OBJECT_STORE";
  await assert.rejects(gateway.put(CONTEXT, { objectId: "x", mediaType: "image/png", bytes: BYTES }), hasCode("OBJECT_STORE_PROVIDER_IDENTITY_CHANGED"));
  assert.equal(provider.invocations, 0);
});

test("malformed provider refs fail without receipt", async () => {
  for (const mutate of [
    (ref: StoredObjectRef) => ({ ...ref, clinicId: "other" }),
    (ref: StoredObjectRef) => ({ ...ref, objectId: "other" }),
    (ref: StoredObjectRef) => ({ ...ref, contentSha256: "0".repeat(64) }),
    (ref: StoredObjectRef) => ({ ...ref, sizeBytes: ref.sizeBytes + 1 }),
    (ref: StoredObjectRef) => ({ ...ref, mediaType: "audio/wav" }),
  ]) {
    const provider = new MemoryFixture("LOCAL_OBJECT_STORE");
    provider.mutate = mutate;
    const gateway = new ObjectStoreGateway(strict(), provider);
    await assert.rejects(gateway.put(CONTEXT, { objectId: "bad", mediaType: "image/png", bytes: BYTES }), hasCode("INVALID_OBJECT_STORE_RESPONSE"));
    assert.deepEqual(gateway.listReceipts(CONTEXT), []);
  }
});

test("local and cloud fixture share the gateway contract", async (t) => {
  const { root, gateway: local } = await localGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cloudGateway = new ObjectStoreGateway(cloud(), new MemoryFixture("CLOUD_OBJECT_STORE"));
  for (const gateway of [local, cloudGateway]) {
    const ref = await gateway.put(CONTEXT, { objectId: "contract", mediaType: "application/pdf", bytes: BYTES });
    assert.equal(ref.contentSha256, digest(BYTES));
    assert.deepEqual((await gateway.get(CONTEXT, { objectId: "contract" })).bytes, BYTES);
  }
});

test("receipts and errors contain no bytes or filesystem paths", async (t) => {
  const { root, gateway } = await localGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  await gateway.put(CONTEXT, { objectId: "receipt", mediaType: "image/png", bytes: BYTES });
  const serialized = JSON.stringify(gateway.listReceipts(CONTEXT));
  assert.equal(serialized.includes("synthetic evidence"), false);
  assert.equal(serialized.includes(root), false);
  await assert.rejects(gateway.get(CONTEXT, { objectId: "missing" }), (error: unknown) => {
    const message = String((error as Error).message);
    return !message.includes(root) && !message.includes("missing");
  });
});

test("provider surface exposes only kind, put and get authority", () => {
  const methods = Object.getOwnPropertyNames(LocalObjectStore.prototype).filter((name) => name !== "constructor").sort();
  assert.deepEqual(methods, ["get", "put"]);
  assert.equal("delete" in LocalObjectStore.prototype, false);
  assert.equal("list" in LocalObjectStore.prototype, false);
  assert.equal("rename" in LocalObjectStore.prototype, false);
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readFileNames(path: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}
