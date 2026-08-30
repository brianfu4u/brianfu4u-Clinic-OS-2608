import { createHash } from "node:crypto";

import { assertActorContext } from "../domain/access-context.ts";
import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { RuntimeManifest } from "../runtime/contracts.ts";
import { validateRuntimeManifest } from "../runtime/manifest-validator.ts";
import {
  MAX_OBJECT_SIZE_BYTES,
  type GetObjectCommand,
  type ObjectStoreProvider,
  type ObjectStoreReceipt,
  type ProviderGetResponse,
  type PutObjectCommand,
  type StoredObjectRef,
} from "./contracts.ts";

const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export class ObjectStoreGateway {
  readonly #manifest: Readonly<RuntimeManifest>;
  readonly #provider: ObjectStoreProvider;
  readonly #expectedKind: ObjectStoreProvider["kind"];
  readonly #receipts: ObjectStoreReceipt[] = [];

  constructor(manifest: RuntimeManifest, provider: ObjectStoreProvider) {
    this.#manifest = validateRuntimeManifest(manifest);
    if (!provider || typeof provider.kind !== "string" ||
      typeof provider.put !== "function" || typeof provider.get !== "function") {
      throw new DomainError("INVALID_OBJECT_STORE_PROVIDER", "Object store provider contract is invalid.");
    }
    if (this.#manifest.profile !== "CLOUD" && provider.kind === "CLOUD_OBJECT_STORE") {
      throw new DomainError("REMOTE_OBJECT_STORE_FORBIDDEN", "On-Prem profiles require local object storage.");
    }
    if (provider.kind !== this.#manifest.fileProvider) {
      throw new DomainError("OBJECT_STORE_PROVIDER_KIND_MISMATCH", "Provider kind must match RuntimeManifest.");
    }
    this.#provider = provider;
    this.#expectedKind = provider.kind;
  }

  async put(context: ActorContext, command: PutObjectCommand): Promise<StoredObjectRef> {
    assertActorContext(context);
    validateExactCommand(command, ["objectId", "mediaType", "bytes"]);
    validateObjectId(command.objectId);
    validateMediaType(command.mediaType);
    if (!(command.bytes instanceof Uint8Array) || command.bytes.byteLength === 0) {
      throw new DomainError("INVALID_OBJECT_BYTES", "Object bytes must be a non-empty Uint8Array.");
    }
    if (command.bytes.byteLength > MAX_OBJECT_SIZE_BYTES) {
      throw new DomainError("OBJECT_TOO_LARGE", "Object exceeds the configured size limit.");
    }
    const bytes = new Uint8Array(command.bytes);
    const expected: StoredObjectRef = {
      clinicId: context.clinicId,
      objectId: command.objectId,
      contentSha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: command.mediaType,
    };
    this.#assertProviderIdentity();
    let response: StoredObjectRef;
    try {
      response = await this.#provider.put(structuredClone(context), { ...expected, bytes });
    } catch {
      throw new DomainError("OBJECT_STORE_PROVIDER_FAILED", "Object store provider operation failed.");
    }
    this.#assertProviderIdentity();
    const ref = validateRef(response, expected);
    this.#receipts.push(Object.freeze({ ...ref, operation: "PUT" }));
    return structuredClone(ref);
  }

  async get(context: ActorContext, command: GetObjectCommand): Promise<ProviderGetResponse> {
    assertActorContext(context);
    validateExactCommand(command, ["objectId"]);
    validateObjectId(command.objectId);
    const clinicId = context.clinicId;
    const objectId = command.objectId;
    this.#assertProviderIdentity();
    let response: ProviderGetResponse;
    try {
      response = await this.#provider.get(structuredClone(context), { clinicId, objectId });
    } catch {
      throw new DomainError("OBJECT_STORE_PROVIDER_FAILED", "Object store provider operation failed.");
    }
    this.#assertProviderIdentity();
    if (!response || !(response.bytes instanceof Uint8Array) || response.bytes.byteLength === 0 ||
      response.bytes.byteLength > MAX_OBJECT_SIZE_BYTES) {
      throw new DomainError("INVALID_OBJECT_STORE_RESPONSE", "Provider get response is invalid.");
    }
    const bytes = new Uint8Array(response.bytes);
    const expected = {
      clinicId,
      objectId,
      contentSha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: response.ref?.mediaType,
    };
    const ref = validateRef(response.ref, expected);
    this.#receipts.push(Object.freeze({ ...ref, operation: "GET" }));
    return structuredClone({ ref, bytes });
  }

  listReceipts(context: ActorContext): ObjectStoreReceipt[] {
    assertActorContext(context);
    return structuredClone(this.#receipts.filter(({ clinicId }) => clinicId === context.clinicId));
  }

  #assertProviderIdentity(): void {
    if (this.#provider.kind !== this.#expectedKind || this.#provider.kind !== this.#manifest.fileProvider) {
      throw new DomainError("OBJECT_STORE_PROVIDER_IDENTITY_CHANGED", "Object store provider identity changed.");
    }
  }
}

function validateExactCommand(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new DomainError("INVALID_OBJECT_STORE_COMMAND", "Object store command must have the exact declared shape.");
  }
}

function validateObjectId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new DomainError("INVALID_OBJECT_ID", "Object ID is invalid.");
  }
}

function validateMediaType(value: unknown): asserts value is string {
  if (typeof value !== "string" || !MEDIA_TYPE.test(value)) {
    throw new DomainError("INVALID_MEDIA_TYPE", "Media type is invalid.");
  }
}

function validateRef(value: unknown, expected: StoredObjectRef): StoredObjectRef {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !["clinicId", "objectId", "contentSha256", "sizeBytes", "mediaType"].every((key) => Object.hasOwn(value, key))) {
    throw new DomainError("INVALID_OBJECT_STORE_RESPONSE", "Provider object reference is invalid.");
  }
  const ref = value as StoredObjectRef;
  if (ref.clinicId !== expected.clinicId || ref.objectId !== expected.objectId ||
    ref.contentSha256 !== expected.contentSha256 || ref.sizeBytes !== expected.sizeBytes ||
    ref.mediaType !== expected.mediaType || !MEDIA_TYPE.test(ref.mediaType) ||
    !/^[a-f0-9]{64}$/.test(ref.contentSha256)) {
    throw new DomainError("INVALID_OBJECT_STORE_RESPONSE", "Provider object reference does not match content.");
  }
  return Object.freeze({ ...ref });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
