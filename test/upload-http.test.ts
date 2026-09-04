import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AddressInfo } from "node:net";
import type { ActorContext } from "../src/domain/contracts.ts";
import { EvidenceObjectIngestionService } from "../src/application/evidence-object-ingestion.ts";
import { createPreviewServer } from "../src/preview/server.ts";
import { LocalObjectStore } from "../src/storage/local-object-store.ts";
import { ObjectStoreGateway } from "../src/storage/object-store-gateway.ts";

const EMPLOYEE: ActorContext = { clinicId: "clinic-upload", actorId: "employee-upload", role: "EMPLOYEE" };
const RUNTIME = {
  profile: "ON_PREM_STRICT" as const,
  databaseProvider: "LOCAL_POSTGRES" as const,
  fileProvider: "LOCAL_OBJECT_STORE" as const,
  inferenceProvider: "DISABLED" as const,
  backupProvider: "LOCAL_ENCRYPTED_BACKUP" as const,
  externalInferenceAuthorized: false,
  manifestVersion: "upload-test-v1",
};

function multipart(boundary: string, mediaType: string, bytes: Uint8Array, filename = "report.bin"): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`, "ascii"),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`, "ascii"),
  ]);
}

async function withServer(run: (url: string, root: string) => Promise<void>, options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "clinic-upload-store-"));
  const objects = new ObjectStoreGateway(RUNTIME, new LocalObjectStore(root));
  const server = createPreviewServer({
    employeeContext: EMPLOYEE,
    managerContext: { clinicId: EMPLOYEE.clinicId, actorId: "manager-upload", role: "MANAGER" },
    evidenceObjectIngestion: new EvidenceObjectIngestionService(objects),
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(url, root); } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

async function upload(url: string, body: Buffer, key = "upload-key-0001", boundary = "clinic-boundary") {
  const response = await fetch(`${url}/api/employee/evidence-objects`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
      "idempotency-key": key,
    },
    body,
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

test("PNG and JPEG uploads return detached bounded references", async () => {
  await withServer(async (url) => {
    const cases = [
      ["image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])],
      ["image/jpeg", new Uint8Array([255, 216, 255, 1])],
    ] as const;
    for (const [mediaType, bytes] of cases) {
      const result = await upload(url, multipart("clinic-boundary", mediaType, bytes), `key-${mediaType.replace(/\W/g, "")}`);
      assert.equal(result.response.status, 201);
      assert.deepEqual(Object.keys(result.body).sort(), ["objectRef", "status"]);
      assert.equal(result.body.status, "STORED");
      const ref = result.body.objectRef as Record<string, unknown>;
      assert.deepEqual(Object.keys(ref).sort(), ["contentSha256", "mediaType", "objectId", "sizeBytes"]);
      assert.equal(ref.mediaType, mediaType);
      assert.equal(ref.sizeBytes, bytes.byteLength);
      assert.equal(ref.contentSha256, createHash("sha256").update(bytes).digest("hex"));
      assert.match(String(ref.objectId), /^upload-[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(result.body), /clinic|employee|filename|path|PHI/i);
    }
  });
});

test("same key is idempotent and changed replay conflicts without overwrite", async () => {
  await withServer(async (url, root) => {
    const firstBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const first = await upload(url, multipart("clinic-boundary", "image/png", firstBytes));
    const replay = await upload(url, multipart("clinic-boundary", "image/png", firstBytes));
    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 201);
    assert.deepEqual(replay.body, first.body);
    const conflict = await upload(url, multipart("clinic-boundary", "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 2])));
    assert.equal(conflict.response.status, 409);
    assert.deepEqual(conflict.body, { error: "UPLOAD_CONFLICT", message: "Upload conflicts with an existing object." });
    const files = await readdir(root, { recursive: true });
    assert.equal(files.filter((file) => String(file).endsWith("body")).length, 0);
  });
});

test("malformed, repeated, unsupported and authority-shaped multipart bodies fail before storage", async () => {
  await withServer(async (url) => {
    const valid = multipart("clinic-boundary", "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const cases: Array<[Buffer, string, number, string]> = [
      [Buffer.from("not multipart"), "bad-key-0001", 400, "INVALID_UPLOAD"],
      [multipart("clinic-boundary", "image/gif", new Uint8Array([71, 73, 70, 56])), "bad-key-0002", 415, "UNSUPPORTED_CONTENT_TYPE"],
      [multipart("clinic-boundary", "application/pdf", new TextEncoder().encode("%PDF-1.7\n")), "bad-key-0002a", 415, "UNSUPPORTED_CONTENT_TYPE"],
      [multipart("clinic-boundary", "image/jpeg", new Uint8Array([137, 80, 78, 71])), "bad-key-0003", 400, "INVALID_UPLOAD"],
      [Buffer.concat([valid.subarray(0, -2 - Buffer.byteLength("--clinic-boundary--\r\n")), Buffer.from("\r\n--clinic-boundary\r\n"), valid]), "bad-key-0004", 400, "INVALID_UPLOAD"],
      [multipart("clinic-boundary", "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "../secret.png"), "bad-key-0005", 400, "INVALID_UPLOAD"],
    ];
    for (const [body, key, status, error] of cases) {
      const result = await upload(url, body, key);
      assert.equal(result.response.status, status);
      assert.equal(result.body.error, error);
    }
    const injected = await upload(url, Buffer.concat([valid, Buffer.from("authority")]), "bad-key-0006");
    assert.equal(injected.response.status, 400);
  });
});

test("synthetic preview exposes no pretend upload storage", async () => {
  const server = createPreviewServer({ employeeContext: EMPLOYEE });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await upload(url, multipart("clinic-boundary", "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, { error: "PERSISTED_UPLOAD_UNAVAILABLE", message: "Persisted evidence upload is unavailable." });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
