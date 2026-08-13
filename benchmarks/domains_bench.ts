// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic performance baselines for every exported DenoForge domain.
 *
 * Cloud, transport and filesystem capabilities use their injectable seams so
 * this suite never binds a port, contacts a provider or writes to disk.
 *
 * @module
 */

import { newAwsKmsProvider } from "../encrypt/aws-kms/mod.ts";
import { newAzureKeyVaultProvider } from "../encrypt/azure-key-vault/mod.ts";
import type { KmsApi } from "../encrypt/common/kms.ts";
import { newGcpKmsProvider } from "../encrypt/gcp-kms/mod.ts";
import { newLocalProvider } from "../encrypt/mod.ts";
import { newFormatter, newSanitizer } from "../logger/mod.ts";
import type { LogFormat } from "../logger/mod.ts";
import { createService } from "../security/mod.ts";
import {
  addTask,
  matchesTrigger,
  resetWorkers,
  runWorkers,
  setWorkersLimit,
} from "../tools/mod.ts";
import { newHttpServer } from "../config/http/mod.ts";
import { status, unary } from "../config/grpc/mod.ts";
import { scaffold } from "../cmd/qdeno/code/scaffold.ts";
import type { Filesystem } from "../cmd/qdeno/code/scaffold.ts";

const payload = "denoforge-benchmark-".repeat(64);
const local = newLocalProvider();

Deno.bench("encrypt/local: SHA-256 1 KiB", async () => {
  await local.sha256Hex(payload);
});

const fakeKmsApi: KmsApi = {
  encrypt: (_keyId, plaintext) => Promise.resolve(plaintext),
  decrypt: (ciphertext) => Promise.resolve(ciphertext),
  sign: (_keyId, message) => Promise.resolve(message),
  verify: () => Promise.resolve(true),
  describeKey: (keyId) => Promise.resolve({ keyId, keyRef: keyId }),
  disableKey: () => Promise.resolve(),
  rotateKey: () => Promise.resolve(),
};
const cloudProviders = [
  newAwsKmsProvider({ api: fakeKmsApi }),
  newAzureKeyVaultProvider({ api: fakeKmsApi }),
  newGcpKmsProvider({ api: fakeKmsApi }),
];

Deno.bench("encrypt/cloud: injected AWS, Azure and GCP KMS seams", async () => {
  await Promise.all(
    cloudProviders.map((provider) =>
      provider.encrypt({ keyId: "benchmark-key", plaintext: payload })
    ),
  );
});

const sanitizer = newSanitizer(["password", "authorization", "token"]);
const formatter = newFormatter("json");
const logEntry: LogFormat = {
  level: "INFO",
  timestamp: "2026-07-29T12:00:00.000",
  traceID: "0123456789abcdef",
  message: "benchmark.request",
  details: {
    system: "bench",
    method: "POST",
    path: "/v1/items",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    request: { user: "alice", password: "secret", items: [1, 2, 3] },
  },
  process: [],
  method: "domains_bench.ts",
  line: 1,
  latency: 12,
};

Deno.bench("logger: sanitize and format canonical JSON", () => {
  const details = sanitizer.details(logEntry.details);
  formatter.format({
    ...logEntry,
    details: { ...details, system: String(details.system ?? "") },
  });
});

const jwt = createService({
  algorithm: "HS256",
  hmacSecret: "deterministic-benchmark-secret-with-at-least-32-bytes",
});

Deno.bench("security/JWT: HS256 sign and verify", async () => {
  const token = await jwt.sign({ sub: "benchmark-user", role: "reader", iat: 1_700_000_000 });
  await jwt.verify(token);
});

const triggerDate = new Date(2026, 6, 29, 10, 30, 15);
const trigger = { year: 2026, month: 7, day: 29, hour: 10, minute: 30, second: 15 };
let matchedTriggers = 0;

Deno.bench("tools/jobs: exact cron trigger match", () => {
  matchedTriggers += Number(matchesTrigger(triggerDate, trigger));
  if (matchedTriggers === Number.MAX_SAFE_INTEGER) matchedTriggers = 0;
});

Deno.bench("tools/workers: dispatch one bounded task", async () => {
  resetWorkers();
  setWorkersLimit(1);
  runWorkers();
  await new Promise<void>((resolve) => addTask(resolve));
  resetWorkers();
});

const httpServer = newHttpServer({ healthPath: "" });
httpServer.get("/bench/:id", (request) => {
  const id = new URL(request.url).pathname.split("/").at(-1);
  return Response.json({ id, ok: true });
});
const httpHandler = httpServer.handler();

Deno.bench("config/http: route an in-memory request", async () => {
  const response = await httpHandler(new Request("http://localhost/bench/42"));
  await response.body?.cancel();
});

const grpcHandler = unary<{ value: number }, { value: number }>(
  (request) => ({ value: request.value + 1 }),
  async (_context, next) => await next(),
);
const grpcCall = {
  request: { value: 41 },
  metadata: {},
  getPath: () => "/denoforge.bench/Increment",
};

Deno.bench(
  "config/grpc: compose an in-memory unary call",
  () =>
    new Promise<void>((resolve, reject) => {
      grpcHandler(
        grpcCall as never,
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          if (response?.value !== 42 || status.OK !== 0) {
            reject(new Error("unexpected gRPC benchmark response"));
            return;
          }
          resolve();
        },
      );
    }),
);

const memoryFs: Filesystem = {
  mkdir: () => Promise.resolve(),
  writeFile: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
};

Deno.bench("qdeno/CLI: scaffold HTTP files through memory seam", async () => {
  await scaffold({ kind: "http", name: "benchmark-service" }, memoryFs);
});
