import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../domain/errors.ts";
import type { ActorContext } from "../domain/contracts.ts";
import type {
  ObjectStoreProvider,
  ProviderGetRequest,
  ProviderGetResponse,
  ProviderPutRequest,
  StoredObjectRef,
} from "./contracts.ts";

const MAGIC = Buffer.from("CLINIC-OS-OBJECT-v1\n", "utf8");

export class LocalObjectStore implements ObjectStoreProvider {
  readonly kind = "LOCAL_OBJECT_STORE" as const;
  readonly #root: string;
  readonly #ready: Promise<string>;

  constructor(root: string) {
    if (typeof root !== "string" || !isAbsolute(root)) {
      throw new DomainError("INVALID_OBJECT_STORE_ROOT", "Local object store root must be absolute.");
    }
    const normalizedRoot = resolve(root);
    if (dirname(normalizedRoot) === normalizedRoot) {
      throw new DomainError("INVALID_OBJECT_STORE_ROOT", "Local object store root must not be a filesystem root.");
    }
    this.#root = normalizedRoot;
    this.#ready = this.#initialize();
  }

  async put(_context: ActorContext, request: ProviderPutRequest): Promise<StoredObjectRef> {
    const target = await this.#target(request.clinicId, request.objectId);
    const envelope = encodeEnvelope(request);
    const temporary = join(dirname(target), `.pending-${randomUUID()}`);
    try {
      await writeFile(temporary, envelope, { flag: "wx", mode: 0o600 });
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } catch (error) {
      throw safeStorageError(error);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await this.#read(target);
    if (!sameRef(stored.ref, request) || !Buffer.from(stored.bytes).equals(Buffer.from(request.bytes))) {
      throw new DomainError("OBJECT_ID_CONFLICT", "Object ID already contains different content.");
    }
    return structuredClone(stored.ref);
  }

  async get(_context: ActorContext, request: ProviderGetRequest): Promise<ProviderGetResponse> {
    const target = await this.#target(request.clinicId, request.objectId);
    const stored = await this.#read(target);
    if (stored.ref.clinicId !== request.clinicId || stored.ref.objectId !== request.objectId) {
      throw new DomainError("OBJECT_INTEGRITY_FAILED", "Stored object failed scope verification.");
    }
    return stored;
  }

  async #initialize(): Promise<string> {
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      return hardenDirectory(this.#root);
    } catch (error) {
      throw safeStorageError(error);
    }
  }

  async #target(clinicId: string, objectId: string): Promise<string> {
    const root = await this.#ready;
    const clinicDirectory = join(root, digest(`clinic:${clinicId}`));
    try {
      await mkdir(clinicDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw safeStorageError(error);
    }
    try {
      const currentRoot = await realpath(this.#root);
      const currentClinic = await hardenDirectory(clinicDirectory);
      const rel = relative(currentRoot, currentClinic);
      if (currentRoot !== root || rel === "" || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error("unsafe storage path");
      }
      return join(currentClinic, digest(`object:${objectId}`));
    } catch (error) {
      throw safeStorageError(error);
    }
  }

  async #read(target: string): Promise<ProviderGetResponse> {
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("not a regular file");
      const envelope = await handle.readFile();
      return decodeEnvelope(envelope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DomainError("OBJECT_NOT_FOUND", "Object was not found.");
      }
      if (error instanceof DomainError) throw error;
      throw safeStorageError(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

function encodeEnvelope(request: ProviderPutRequest): Buffer {
  const ref = {
    clinicId: request.clinicId,
    objectId: request.objectId,
    contentSha256: request.contentSha256,
    sizeBytes: request.sizeBytes,
    mediaType: request.mediaType,
  };
  const header = Buffer.from(JSON.stringify({
    ...ref,
    envelopeSha256: digest(Buffer.concat([Buffer.from(JSON.stringify(ref)), Buffer.from(request.bytes)])),
  }), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header, Buffer.from(request.bytes)]);
}

function decodeEnvelope(envelope: Buffer): ProviderGetResponse {
  try {
    if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error();
    const headerLength = envelope.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > 4096) throw new Error();
    const start = MAGIC.length + 4;
    const header = JSON.parse(envelope.subarray(start, start + headerLength).toString("utf8")) as StoredObjectRef & { envelopeSha256?: string };
    const { envelopeSha256, ...ref } = header;
    const bytes = new Uint8Array(envelope.subarray(start + headerLength));
    if (!ref || Object.keys(header).length !== 6 || Object.keys(ref).length !== 5 ||
      ref.sizeBytes !== bytes.byteLength || ref.contentSha256 !== digest(bytes) ||
      envelopeSha256 !== digest(Buffer.concat([Buffer.from(JSON.stringify(ref)), Buffer.from(bytes)]))) {
      throw new Error();
    }
    return structuredClone({ ref, bytes });
  } catch {
    throw new DomainError("OBJECT_INTEGRITY_FAILED", "Stored object failed integrity verification.");
  }
}

function sameRef(left: StoredObjectRef, right: StoredObjectRef): boolean {
  return left.clinicId === right.clinicId && left.objectId === right.objectId &&
    left.contentSha256 === right.contentSha256 && left.sizeBytes === right.sizeBytes &&
    left.mediaType === right.mediaType;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeStorageError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  return new DomainError("OBJECT_STORE_IO_FAILED", "Local object storage operation failed.");
}

async function hardenDirectory(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.chmod(0o700);
    const stat = await handle.stat();
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new Error("unsafe directory");
    return await realpath(path);
  } finally {
    await handle.close();
  }
}
