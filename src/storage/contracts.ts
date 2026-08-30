import type { ActorContext } from "../domain/contracts.ts";
import type { FileProviderKind } from "../runtime/contracts.ts";

export const MAX_OBJECT_SIZE_BYTES = 25 * 1024 * 1024;

export interface StoredObjectRef {
  clinicId: string;
  objectId: string;
  contentSha256: string;
  sizeBytes: number;
  mediaType: string;
}

export interface PutObjectCommand {
  objectId: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface GetObjectCommand {
  objectId: string;
}

export interface ProviderPutRequest extends StoredObjectRef {
  bytes: Uint8Array;
}

export interface ProviderGetRequest {
  clinicId: string;
  objectId: string;
}

export interface ProviderGetResponse {
  ref: StoredObjectRef;
  bytes: Uint8Array;
}

export interface ObjectStoreProvider {
  readonly kind: FileProviderKind;
  put(context: ActorContext, request: ProviderPutRequest): Promise<StoredObjectRef>;
  get(context: ActorContext, request: ProviderGetRequest): Promise<ProviderGetResponse>;
}

export interface ObjectStoreReceipt extends StoredObjectRef {
  operation: "PUT" | "GET";
}
