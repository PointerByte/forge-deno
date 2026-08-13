// Copyright 2026 PointerByte Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Project templates emitted by the scaffolder. Each template returns a map of
 * relative path -> file contents for a given project name.
 *
 * @module
 */

/** Service kinds the scaffolder can generate. */
export type ServiceKind = "http" | "grpc";

const FRAMEWORK = "@pointerbyte/denoforge";

function denoJson(name: string): string {
  return JSON.stringify(
    {
      name,
      version: "0.1.0",
      tasks: { dev: "deno run -A main.ts" },
      imports: { [FRAMEWORK]: `jsr:${FRAMEWORK}` },
    },
    null,
    2,
  ) + "\n";
}

function httpMain(name: string): string {
  return `// ${name} — DenoForge HTTP service
import { newHttpServer } from "${FRAMEWORK}/config";
import { httpLogger, initLogger } from "${FRAMEWORK}/logger";
import { securityHeaders } from "${FRAMEWORK}/security";

const log = initLogger({ service: { name: "${name}" } });

const server = newHttpServer({ port: 8080 })
  .use(httpLogger(log))
  .use(securityHeaders());

server.get("/api/hello", () => Response.json({ message: "hello from ${name}" }));

log.info("server.start", { port: 8080 });
server.listen();
`;
}

function grpcMain(name: string): string {
  return `// ${name} — DenoForge gRPC service
import { GrpcServer, loadProto } from "${FRAMEWORK}/config";
import { grpcLogger, initLogger } from "${FRAMEWORK}/logger";

const log = initLogger({ service: { name: "${name}" } });

const proto = loadProto(new URL("./service.proto", import.meta.url));
// deno-lint-ignore no-explicit-any
const Service = (proto as any).${name.replace(/[^a-zA-Z0-9]/g, "")}.v1.Service;

const server = new GrpcServer({ interceptors: [grpcLogger(log)] });
server.addService(Service.service, {
  Ping: () => ({ message: "pong" }),
});

const port = await server.listen("127.0.0.1:50051");
log.info("grpc.start", { port });
`;
}

function grpcProto(name: string): string {
  const pkg = name.replace(/[^a-zA-Z0-9]/g, "");
  return `syntax = "proto3";

package ${pkg}.v1;

service Service {
  rpc Ping(PingRequest) returns (PingResponse);
}

message PingRequest {}
message PingResponse {
  string message = 1;
}
`;
}

function readme(name: string, kind: ServiceKind): string {
  return `# ${name}

A DenoForge ${kind.toUpperCase()} service scaffolded with \`qdeno\`.

\`\`\`sh
deno task dev
\`\`\`
`;
}

/** Returns the files for a scaffolded project keyed by relative path. */
export function templateFiles(kind: ServiceKind, name: string): Record<string, string> {
  const files: Record<string, string> = {
    "deno.json": denoJson(name),
    "README.md": readme(name, kind),
  };
  if (kind === "http") {
    files["main.ts"] = httpMain(name);
  } else {
    files["main.ts"] = grpcMain(name);
    files["service.proto"] = grpcProto(name);
  }
  return files;
}
