# forge-deno

A modular toolkit for **Deno** service-oriented applications, with batteries-included cryptography,
structured logging, security/JWT, background jobs & workers and HTTP tooling.

forge-deno is built on the **Web Crypto API** and the **Deno standard library**, so it runs with
essentially zero external runtime dependencies (only BLAKE3 is delegated, see [Notes](#notes)). Each
capability lives in its own module that you can import independently.

> 🇪🇸 [Versión en español](./README.es.md)

## Modules

| Module                    | Import specifier                                 | What it gives you                                                        |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `encrypt`                 | `@pointerbyte/denoforge/encrypt`                 | AES-GCM, RSA-OAEP, ECDH, Ed25519/RSA signatures, HMAC, SHA-256, BLAKE3   |
| `encrypt/aws-kms`         | `@pointerbyte/denoforge/encrypt/aws-kms`         | AWS KMS-backed encrypt/decrypt/sign/verify + key lifecycle               |
| `encrypt/azure-key-vault` | `@pointerbyte/denoforge/encrypt/azure-key-vault` | Azure Key Vault-backed crypto + key lifecycle                            |
| `encrypt/gcp-kms`         | `@pointerbyte/denoforge/encrypt/gcp-kms`         | Google Cloud KMS-backed crypto + key lifecycle                           |
| `logger`                  | `@pointerbyte/denoforge/logger`                  | forge-go log format, sensitive-value sanitizer, HTTP + gRPC middleware   |
| `security`                | `@pointerbyte/denoforge/security`                | JWT (HS256/RS256/PS256/EdDSA), cookie auth, security + gRPC middleware   |
| `tools`                   | `@pointerbyte/denoforge/tools`                   | interval/cron jobs, a bounded worker loop, config loader, test-mode flag |
| `config`                  | `@pointerbyte/denoforge/config`                  | `fetch` REST client, native `Deno.serve` HTTP server, gRPC client/server |
| `config/http`             | `@pointerbyte/denoforge/config/http`             | focused HTTP client/server entry with no optional gRPC runtime           |
| `config/grpc`             | `@pointerbyte/denoforge/config/grpc`             | focused gRPC client/server, proto loader and interceptor contracts       |
| `wasm`                    | `@pointerbyte/denoforge/wasm`                    | verified forge-go component ABI, bounded host pool and native adapters   |

## Guides

| Guide                                        | Covers                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [Architecture](./docs/architecture.md)       | How forge-go and forge-deno fit together, and the three execution paths |
| [Migration](./docs/migration.md)             | Moving from forge-go to forge-deno, and how much of it to keep          |
| [Compatibility](./docs/compatibility.md)     | Version pins, guarantees, coverage floors and drift gates               |
| [Security](./docs/security.md)               | Threat model, capability boundary, integrity chain, known weaknesses    |
| [Troubleshooting](./docs/troubleshooting.md) | Concrete failures, their real causes and what to do                     |
| [Component runtime](./wasm/README.md)        | Manifests, factory, retries, pool and the native adapter                |

## Requirements

- [Deno](https://deno.com/) **2.x** (developed against 2.9).

## Installation

forge-deno can be consumed **locally** from other Deno projects, with or without publishing to a
registry.

### Option A — local path import map (recommended for local use)

In your project's `deno.json`, point an import alias at the forge-deno folder:

```json
{
  "imports": {
    "@denoforge/": "../forge-deno/"
  }
}
```

Then import per module:

```ts
import { newLocalProvider } from "@denoforge/encrypt/mod.ts";
import { createService } from "@denoforge/security/mod.ts";
```

### Option B — direct relative import

```ts
import { newLocalProvider } from "../forge-deno/encrypt/mod.ts";
```

### Option C — as a JSR package

The package is configured for JSR (`deno.json` `name`/`exports`). Once published you can
`deno add jsr:@pointerbyte/denoforge` and import via the specifiers in the table above.

## Quick start

```ts
import { encrypt, security } from "@pointerbyte/denoforge";

const enc = encrypt.newLocalProvider();
const key = await enc.generateSymmetricKeys({ size: encrypt.SizeSymmetricKey.Key256Bits });
const cipher = await enc.encryptAES({ secretKey: key.keyRef, value: "hello" });

const jwt = security.createService({ algorithm: "HS256", hmacSecret: "s3cr3t" });
const token = await jwt.sign({ sub: "user-1" });
```

> The root entry namespaces every module (`encrypt`, `logger`, `security`, `tools`, `config`,
> `wasm`) so names that repeat across modules — `Service`, `Middleware`, `Handler` — never collide.
> Prefer the focused specifiers when you want a smaller dependency graph; in particular,
> `config/http`, `logger` and `security` do not resolve the optional gRPC runtime packages.

## Usage

### `encrypt`

A local cryptographic provider backed by Web Crypto, organized into focused repositories: symmetric,
asymmetric, hashing, signatures and key management.

```ts
import {
  CurveAsymmetricKey,
  newLocalProvider,
  SizeAsymmetricKey,
  SizeSymmetricKey,
} from "@pointerbyte/denoforge/encrypt";

const enc = newLocalProvider();

// AES-GCM (128/256-bit), AAD supported, nonce prepended to ciphertext.
const sym = await enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
const ct = await enc.encryptAES({ secretKey: sym.keyRef, value: "secret", additional: "aad" });
const pt = await enc.decryptAES({ secretKey: sym.keyRef, cipherValue: ct, additional: "aad" });

// RSA-OAEP, ECDH hybrid encryption, Ed25519 / RSA-PSS / RSA-PKCS1v15 signatures.
const rsa = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
const ec = await enc.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });
const ed = await enc.generateEd25519Keys();

// Hashing: HMAC-SHA256, SHA-256 hex, BLAKE3.
await enc.sha256Hex("abc");
```

Keys are exchanged as **Base64-encoded DER** (SPKI for public, PKCS#8 for private; raw bytes for
symmetric keys) via the `KeyData` model. Every operation accepts an optional `signal`
(`AbortSignal`) for cancellation.

#### Cloud KMS providers

For keys that never leave a managed HSM, the `aws-kms`, `azure-key-vault` and `gcp-kms` providers
implement a shared `CloudKmsRepository` (encrypt/decrypt, sign/verify, and key lifecycle:
get/rotate/deactivate). Each loads its cloud SDK **lazily on first use**, so they add nothing to
your graph until you import them.

```ts
import { newAwsKmsProvider } from "@pointerbyte/denoforge/encrypt/aws-kms";

const kms = newAwsKmsProvider({ region: "us-east-1" }); // needs @aws-sdk/client-kms + AWS creds
const ciphertext = await kms.encrypt({ keyId: "alias/app", plaintext: "secret" });
const plaintext = await kms.decrypt({ keyId: "alias/app", ciphertext });
const signature = await kms.sign({ keyId: "alias/signing", message: "payload" });
const ok = await kms.verify({ keyId: "alias/signing", message: "payload", signature });
const meta = await kms.getKey({ keyId: "alias/app" });
```

All three accept an injected `api` (the `KmsApi` seam) so you can unit-test provider logic without
any cloud access. Required peer packages: `@aws-sdk/client-kms`, `@azure/keyvault-keys` (+
`@azure/identity`), `@google-cloud/kms`.

### `logger`

Leveled logging that emits the **forge-go log format**, with a sensitive-value **sanitizer** and
HTTP/gRPC middleware. Every entry follows the forge-go schema
`{level, timestamp, traceID, message, details, process, method, line, latency}`, where `method` and
`line` locate the call site and `details.system` comes from `service.name`.

```ts
import { initLogger, LogLevel } from "@pointerbyte/denoforge/logger";

const log = initLogger({
  level: LogLevel.Debug,
  formatter: "json", // "json", "text"/"txt"/"" (default: text) or a custom template
  formatDate: "2006-01-02T15:04:05.000", // Go-style layout, this is the default
  service: { name: "api", version: "1.0.0" },
});
log.info("user.login", { userId: 1, password: "x" }); // password -> [REDACTED]
```

The output format is selected with `formatter`, exactly like forge-go's `logger.formatter` key:

- `text`, `txt` or the empty string (the **default**) produce the text layout:

  ```text
  [2026-06-22T10:30:00.000] [INFO] [a1b2c3d4] handler:42 - request completed latency=12ms | details={system=api, method=GET, path=/api/v1/orders}
  ```

- `json` produces the structured JSON layout:

  ```json
  {
    "level": "INFO",
    "timestamp": "2026-06-22T10:30:00.000",
    "traceID": "a1b2c3d4",
    "message": "request completed",
    "details": { "system": "api", "method": "GET", "path": "/api/v1/orders" },
    "process": [],
    "method": "handler",
    "line": 42,
    "latency": 12
  }
  ```

- any other string is treated as a template over the entry fields, with the `json`, `buildDetails`
  and `buildServices` helpers (e.g.
  `"{{.Level}} | {{.Message}} | {{json (buildServices .Process)}}"`). As in forge-go, a template
  whose output is valid JSON is re-normalized to the standard keys, so custom templates cannot
  rename them.

Recognized attributes (`method`, `path`, `headers`, `request`, `response`, `client`, `protocol`,
`system`, plus top-level `traceID`, `latency` and `services`) map onto their canonical slot in the
schema; any other attribute is merged into `details`.

The dependency contains no built-in sensitive-key policy. Like forge-go's `logger.sensibleKeys`, the
default logger reads the exact list from `LOGGER_SENSIBLEKEYS`. It accepts a comma-separated value
or a JSON string array:

```bash
LOGGER_SENSIBLEKEYS=password,authorization,token \
  deno run --allow-env=LOGGER_SENSIBLEKEYS app.ts

LOGGER_SENSIBLEKEYS='["password","authorization","token"]' \
  deno run --allow-env=LOGGER_SENSIBLEKEYS app.ts
```

An absent or empty variable means no fields are redacted. Reading it requires
`--allow-env=LOGGER_SENSIBLEKEYS`; without that permission, Deno rejects logger construction. To
bypass environment loading, pass an explicit `sanitizer`, for example `newSanitizer(["password"])`;
its array is used exactly, and `newSanitizer([])` disables redaction.

Matching is case-insensitive and substring-based, matching forge-go. The dependency does not reject
short or generic values, so operators must configure precise names: a configured `id` also matches
`provider`, while `id_token` has a narrower effect.

#### File destination and rotation

Output goes to a pluggable `Sink` and defaults to stdout. To mirror forge-go's rotating stdout/file
tee:

```ts
const fileLog = initLogger({
  formatter: "json",
  dir: "./logs",
  // Defaults to "api.log"; set fileName to preserve an existing name.
  service: { name: "api" },
  rotate: {
    enable: true,
    maxSize: 10, // MB
    maxBackups: 5, // 0 keeps all
    maxAge: 30, // days; 0 disables expiry
    compress: true,
  },
});
```

Using `dir` requires the optional `--allow-write` permission. The directory and files are created
with `0700` and `0600` permissions. A filesystem or permission failure never aborts logging: it
falls back to stdout and reports each distinct diagnostic once. Rotated files use
`<base>-<timestamp>.log`; gzip runs in the background, and retention applies age before backup
count.

`rotate.enable` controls the entire file destination when using `initLogger`; without it, output
remains stdout-only. Calling `newFileSink({ dir, fileName, rotate: { enable: false } })` directly is
the unrotated-file use case. Its `tee` defaults to stdout; pass `tee: false` for file-only output.
An explicit `LoggerOptions.sink` always wins over `dir`/`fileName`/`rotate`. Do not point multiple
processes at the same file because rotation counters are process-local.

HTTP logs can still be emitted automatically. String exclusions match the pathname exactly, regular
expressions support mounted or dynamic paths, and `includeHeaders` defaults to `true` for backward
compatibility:

```ts
server.use(httpLogger(log, {
  requestIdHeader: "x-request-id",
  includeHeaders: false,
  skipPaths: [
    "/health",
    "/api/status/v1",
    "/api/container/v1/cmk/status",
    /(?:^|\/)api\/cmk\/status\/?$/,
  ],
  shouldLog: (_request, outcome) => "error" in outcome || outcome.response.status !== 404,
}));
```

To make `method` and `line` point to a handler, construct the entry without a logger and call the
logger directly in that handler. The builder does not consume bodies or change the response/error:

```ts
const response = Response.json(result);
const entry = buildHttpLogEntry(request, { response }, logOptions);
if (entry?.level === "error") logger.error(entry.message, entry.details);
else if (entry) logger.info(entry.message, entry.details);
return response;
```

### `security`

JWT signing/verification (`HS256`, `RS256`, `PS256`, `EdDSA`, plus a custom strategy), cookie
authentication, and HTTP middleware (`securityHeaders`, `jwtMiddleware`, `cookieMiddleware`).
`setRequestContext`/`getRequestContext` attach generic application state to the exact `Request`
through a `WeakMap`; this state is independent from claims.

```ts
import { createService, getClaims, jwtMiddleware } from "@pointerbyte/denoforge/security";

const jwt = createService({ algorithm: "HS256", hmacSecret: "s3cr3t" });
const token = await jwt.sign({ sub: "u1", role: "admin" });
const auth = jwtMiddleware(jwt); // 401s unless a valid Bearer token is present
```

### `tools`

In-process **interval/cron jobs** and a **bounded worker loop**, plus a shared test-mode flag that
suppresses background work during tests.

`resetWorkers()` drains queued tasks and resets the configured limit. Tasks already in flight are
allowed to finish and continue to consume capacity, so a reset followed by an immediate restart
cannot exceed the new concurrency limit.

A job timeout reports the missed deadline but cannot forcibly stop arbitrary JavaScript work. The
scheduler therefore keeps that job's running guard until the underlying promise settles; later ticks
never overlap the timed-out work.

```ts
import { addTask, job, runWorkers, startJobs } from "@pointerbyte/denoforge/tools";

runWorkers();
addTask(() => doBackgroundWork());

const id = job(() => poll(), 5000); // every 5s
startJobs();
```

#### Runtime configuration

`loadEnv` is the Deno port of forge-go's `utilities.LoadEnv`. It resolves the configuration
directory, merges every source in a fixed order and returns a `Config` to query. `getConfig()` hands
back whatever the last load produced, so modules further down the call tree do not need it passed
in.

```ts
import { getConfig, loadEnv } from "@pointerbyte/denoforge/tools";
import { newHttpServer } from "@pointerbyte/denoforge/config/http";

const config = await loadEnv(); // or loadEnv("./cmd/example")

const server = newHttpServer({
  port: config.getNumber("server.http.port", 8080),
  healthPath: config.getString("server.http.healthPath", "/health"),
});
for (const group of config.getStringList("server.http.groups")) server.group(group);

getConfig().getBoolean("jwt.enable"); // the same instance, anywhere
```

Sources are applied in this order, each one overriding the previous:

1. `application.yml`, `application.yaml`, or `application.json`
2. `default.ini`
3. `<app.name>.ini`
4. the files listed under `env.files`
5. process environment variables, derived from the key path (`server.http.port` reads
   `SERVER_HTTP_PORT`)

The directory is found the way forge-go finds it: a directory holding one of those files is used
as-is, otherwise the nearest `resources/` directory with one of them is looked up from the start
path upwards, so a binary started from `cmd/example` still finds the project configuration. Key
lookups are case-insensitive, and a key an earlier source declared keeps its type — an INI overlay
can refine a YAML list without turning it into a string.

`loadEnv` needs `--allow-read` for the configuration directory. `--allow-env` is optional: without
it, environment overrides are simply not applied. The YAML and `.env` parsers are imported lazily,
so an application configured through JSON and INI never resolves them.

#### INI files

Configuration can also be written as INI. Two optional files in the resolved directory refine the
application file: `default.ini`, the shared overlay, and `<app.name>.ini`, named after `app.name`. A
service created as `dragon-cmk` therefore reads `default.ini` first and `dragon-cmk.ini` second, so
the project-specific file always wins. `APP_NAME` selects the second file when it is set.

An application file is not required when a directory is configured through INI alone: a `resources/`
directory holding only `default.ini` is a valid configuration directory. A missing `.ini` is
ignored; a malformed one throws, naming the file and line, rather than leaving the application
half-configured.

```ini
; resources/default.ini
[app]
name = dragon-cmk
version = 0.0.1

[server.http]
port = 8080
groups = [/api/v1, /api/v2]

[server.http.rate]
limit = 1000
burst = 2000

[logger]
level = info
formatter = json

[traces]
SkipPaths = /health
SkipPaths = /metrics

[jwt]
enable = false
algorithm = EdDSA
```

Section headers and dotted keys build the same key path, so `[server.http]` with `port` and
`[server]` with `http.port` both set `server.http.port`, and an empty `[]` header returns to the
root. Values are typed as follows:

- a key an earlier source declares keeps its type, so `groups = /v2, /v3` stays a list and
  `limit = 2500` stays a number
- a new key is inferred: `true` and `false` become booleans, digits become numbers, anything else
  stays a string
- `[a, b, c]` declares a list explicitly, which is how a key no earlier source declares becomes a
  list, single-element ones included, such as `SkipPaths = [/health]`
- repeating a key appends to a list, so `SkipPaths` above yields two entries
- quoting with `"` or `'` keeps a value a string and preserves its spaces

Comments start with `;` or `#` at the beginning of a line, or after whitespace on an unquoted value;
a marker not preceded by whitespace is part of the value, so `password = abc#123` is read in full.

### `config`

A `fetch`-based REST client and a native `Deno.serve` HTTP server with middleware, route groups, a
configurable `/health` endpoint and graceful shutdown.

Use `config/http` for HTTP-only applications. It excludes both `@grpc/grpc-js` and
`@grpc/proto-loader` from the resolved graph. The existing `config` aggregate remains available with
every previous HTTP and gRPC export for backward compatibility.

```ts
import { newClientHTTP, newHttpServer } from "@pointerbyte/denoforge/config/http";

const server = newHttpServer({ port: 8080 });
server.get("/api/ping", () => Response.json({ pong: true }));
server.group("/api/v1").get("/users", listUsers);
server.listen();

const api = newClientHTTP({ baseUrl: "https://example.com", timeoutMs: 5000 });
const { data } = await api.get<{ id: number }>("/users/1");
```

Customize the one built-in health route with `healthHandler` (`healthPath: ""` still disables it):

```ts
const server = newHttpServer({
  healthPath: "/health",
  healthHandler: () =>
    Response.json(
      { status: "ok", service: "container" },
      { headers: { "cache-control": "no-store" } },
    ),
});
```

`httpContext` creates request-scoped IDs and validated W3C `traceparent`/`tracestate`, records a
monotonic start time, and returns the request ID as a response header. It never copies full headers,
cookies, authorization, tokens, or bodies into context:

```ts
import { httpContext, type HttpRequestContext } from "@pointerbyte/denoforge/config/http";
import { getRequestContext } from "@pointerbyte/denoforge/security";

server.use(httpContext({ requestIdHeader: "x-request-id" }));
server.get("/dashboard", (request) => {
  const context = getRequestContext<HttpRequestContext>(request)!;
  context.attributes.microfrontend = "dashboard";
  context.attributes.targetKind = "backend";
  context.process.push({ system: "permissions", process: "authorize", latency: 3 });
  context.skipLogging = false;
  return Response.json({ ok: true });
});
```

Middleware shares a single `(next) => (req) => Response` shape across `logger`, `security` and
`config`, so the pieces compose freely:

```ts
import { newHttpServer } from "@pointerbyte/denoforge/config/http";
import { httpLogger, initLogger } from "@pointerbyte/denoforge/logger";
import { createService, jwtMiddleware, securityHeaders } from "@pointerbyte/denoforge/security";

const log = initLogger({ service: { name: "api" } });
const jwt = createService({ algorithm: "HS256", hmacSecret: "s3cr3t" });

const server = newHttpServer({ port: 8080 })
  .use(httpLogger(log))
  .use(securityHeaders());

server.group("/api", jwtMiddleware(jwt))
  .get("/me", (req) => Response.json({ claims: getClaims(req) }));

server.listen();
```

#### gRPC

Use `config/grpc` for the gRPC client and server built on `@grpc/grpc-js`, with the same composable
interceptor model. This focused entry intentionally includes `@grpc/grpc-js` and
`@grpc/proto-loader`. Server interceptors (logging, JWT auth) wrap unary handlers; the client
promisifies unary calls and injects metadata. The logger and security entries expose those
interceptors through dependency-free contracts, so importing either one alone does not load the gRPC
runtime.

```ts
import { GrpcClient, GrpcServer, loadProto } from "@pointerbyte/denoforge/config/grpc";
import { grpcLogger, initLogger } from "@pointerbyte/denoforge/logger";
import { createService, grpcClaims, grpcJwtInterceptor } from "@pointerbyte/denoforge/security";

const log = initLogger({ service: { name: "svc" } });
const jwt = createService({ algorithm: "HS256", hmacSecret: "s3cr3t" });

const proto = loadProto(new URL("./proto/methods.proto", import.meta.url));
// deno-lint-ignore no-explicit-any
const Methods = (proto.denoforge as any).v1.Methods;

const server = new GrpcServer({ interceptors: [grpcLogger(log), grpcJwtInterceptor(jwt)] });
server.addService(Methods.service, {
  Echo: (req, ctx) => ({ message: `${grpcClaims(ctx)?.sub}: ${req.message}` }),
  Health: () => ({ status: "ok" }),
});
const port = await server.listen("127.0.0.1:50051");

const client = new GrpcClient(Methods, `127.0.0.1:${port}`);
const res = await client.unary("Echo", { message: "hi" }, {
  bearer: await jwt.sign({ sub: "u1" }),
});
```

### `wasm`

The dedicated component entry provides a lazy, bounded host for forge-go's canonical ABI v1. Raw
JSON envelopes use `abi`, `id`, snake_case metadata/errors, and explicit padded-Base64 operation
fields. It independently validates the portable contract manifest and immutable release bundle
before an injected reviewed factory can execute. Cancellation, deadlines, typed errors, health,
shutdown, redacted observability, and explicitly parity-qualified native adapters are built in.
Component failures never select an adapter automatically, including for security or crypto calls.

For callers who cannot pay the component's per-call cost, `createNativeGoforgeAdapter()` implements
the same eight operations natively. It only becomes routable after `qualifyNativeAdapter()` replays
every forge-go shared vector against it byte for byte, so a drifting implementation cannot be
registered.

See the [component runtime guide](./wasm/README.md) for its strict manifest, factory integration,
retry policy, permissions, and operational contract.

## Command-line tools (`cmd/`)

forge-deno ships a small set of CLIs, runnable with `deno run` or the bundled tasks:

- **`qdeno`** — scaffolds a new forge-deno service (HTTP or gRPC) into a directory.

  ```sh
  deno task qdeno new http my-api
  deno task qdeno new grpc my-svc --dir ./services/my-svc
  ```

  Install it as a global command from JSR:

  ```sh
  deno install -A -n qdeno jsr:@pointerbyte/denoforge/qdeno
  qdeno new http my-api
  ```

  Or run it without installing:

  ```sh
  deno run -A jsr:@pointerbyte/denoforge/qdeno new http my-api
  ```

- **`deno-openssl`** — key-pair generation, self-signed certificates and PEM handling, built on Web
  Crypto (certificates use `@peculiar/x509`, loaded lazily).

  ```sh
  deno task deno-openssl keypair --algorithm ed25519 --out id
  deno task deno-openssl cert --name "CN=localhost" --days 365 --out localhost
  deno task deno-openssl pem-info id.key.pem
  ```

- **`example`** — a runnable demo that boots an HTTP **and** a gRPC server wired with logging + JWT
  security and graceful shutdown.

  ```sh
  deno task example
  ```

## Testing

```sh
deno task test       # run the suite
deno task cov        # run with coverage and print the table
deno task cov:check  # collect a fresh profile; require >=80% lines, branches and functions
deno task bench      # run deterministic baselines across every exported domain
deno task bench:smoke # run the focused benchmark used by CI
```

The suite covers crypto round-trips, JWT/cookie auth, the sanitizer, jobs & workers, the HTTP
client/server, gRPC interceptors and a gRPC round-trip, plus the KMS providers via an injected fake
`KmsApi` — **~87% line coverage**. The cloud SDK adapters themselves are exercised through the
injectable seam rather than against live cloud services.

Benchmarks use the same deterministic seams: they do not contact a cloud provider, bind a network
listener or write scaffold files to disk. Pull requests and pushes to `main` run format, lint,
type-check, test, coverage, dependency-isolation and benchmark-smoke gates without publishing. The
repository tracks `deno.lock`; CI pins Deno 2.9.4 and verifies the lockfile in frozen mode before
running those gates.

## Notes

- **BLAKE3** has no Web Crypto equivalent, so it is the single delegated primitive (provided via
  `@noble/hashes`). Every other algorithm uses the platform `crypto.subtle`.
- **Key management** (`rotateKey`, `getKey`, `deactivateKey`) is provider-backed: the local provider
  throws `UnsupportedOperationError`, while the `aws-kms`, `azure-key-vault` and `gcp-kms` providers
  implement it against their cloud KMS.
- **Cancellation** is expressed with `AbortSignal` (the `signal` field on requests / the `signal`
  argument on helpers).

## Project structure

```text
forge-deno/
├── deno.json              # import map, tasks, exports
├── mod.ts                 # namespaced root barrel
├── encrypt/               # crypto (Web Crypto) + cloud KMS
│   ├── common/{enums,kms}.ts
│   ├── models/models.ts
│   ├── utilities/utilities.ts
│   ├── local/{interface,repository,mod}.ts
│   ├── aws-kms/{interface,repository,mod}.ts
│   ├── azure-key-vault/{interface,repository,mod}.ts
│   ├── gcp-kms/{interface,repository,mod}.ts
│   ├── errors.ts
│   └── mod.ts
├── logger/                # structured logging
│   ├── common/enums.ts
│   ├── formatter/format.ts
│   ├── sanitizer/sanitizer.ts
│   ├── sink/file.ts
│   ├── builder/builder.ts
│   ├── middlewares/http.ts
│   └── mod.ts
├── security/              # JWT + cookies + middleware
│   ├── auth/jwt/jwt.ts
│   ├── auth/cookies/cookies.ts
│   ├── middlewares/{context,headers,jwt,cookies}.ts
│   └── mod.ts
├── tools/                 # jobs, workers, configuration, mode
│   ├── jobs/jobs.ts
│   ├── workers/workers.ts
│   ├── utilities/{mode,config,ini,values}.ts
│   └── mod.ts
├── config/                # transport bootstrap (HTTP + gRPC)
│   ├── http/mod.ts        # focused dependency-free HTTP entry
│   ├── grpc/{mod,contracts}.ts # focused gRPC entry + dependency-free contracts
│   ├── client/http/{interface,models,client}.ts
│   ├── client/grpc/client.ts
│   ├── server/http/server.ts
│   ├── server/grpc/{server,interceptors}.ts
│   ├── proto/{methods.proto,loader.ts}
│   └── mod.ts
├── wasm/                  # verified component ABI, runtime pool and adapters
│   ├── {contracts,codec,manifest,runtime,adapters}.ts
│   └── mod.ts
├── cmd/                   # command-line tools
│   ├── qdeno/               # service scaffolder
│   ├── deno-openssl/        # key/cert/PEM tooling
│   └── example/           # runnable HTTP + gRPC demo
└── examples/              # focused per-module demos
```

## Development

```sh
deno task fmt:check      # verify formatting without rewriting
deno task lint           # lint source, tests and benchmarks
deno task check          # type-check all supported entry points
deno task check:deps     # verify focused optional-dependency graphs
deno task doc:lint       # lint every entry declared in the package export map
deno task test           # run tests
deno task cov:check      # enforce the 80% coverage floor
deno task bench:smoke    # exercise the benchmark harness
deno task example:encrypt
deno task example:jwt
deno task example:logger
deno task example:server # serves on :8080 (task includes --allow-net)
```

## License

Apache-2.0. See [LICENSE](./LICENSE).

> forge-deno's design and module layout are inspired by the forge-go project.
