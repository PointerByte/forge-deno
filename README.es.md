# DenoForge

Un conjunto de herramientas modular para aplicaciones orientadas a servicios en **Deno**, con
criptografía, logging estructurado, seguridad/JWT, jobs y workers en segundo plano y utilidades HTTP
incluidas.

DenoForge está construido sobre la **Web Crypto API** y la **librería estándar de Deno**, por lo que
funciona prácticamente sin dependencias externas en tiempo de ejecución (solo BLAKE3 se delega, ver
[Notas](#notas)). Cada capacidad vive en su propio módulo que puedes importar de forma
independiente.

> 🇬🇧 [English version](./README.md)

## Módulos

| Módulo                    | Especificador de import                          | Qué te aporta                                                                  |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `encrypt`                 | `@pointerbyte/denoforge/encrypt`                 | AES-GCM, RSA-OAEP, ECDH, firmas Ed25519/RSA, HMAC, SHA-256, BLAKE3             |
| `encrypt/aws-kms`         | `@pointerbyte/denoforge/encrypt/aws-kms`         | cifrado/firma + ciclo de vida de claves con AWS KMS                            |
| `encrypt/azure-key-vault` | `@pointerbyte/denoforge/encrypt/azure-key-vault` | criptografía + ciclo de vida con Azure Key Vault                               |
| `encrypt/gcp-kms`         | `@pointerbyte/denoforge/encrypt/gcp-kms`         | criptografía + ciclo de vida con Google Cloud KMS                              |
| `logger`                  | `@pointerbyte/denoforge/logger`                  | logging por niveles con formato GoForge, sanitizador, middleware HTTP + gRPC   |
| `security`                | `@pointerbyte/denoforge/security`                | JWT (HS256/RS256/PS256/EdDSA), auth por cookie, middleware HTTP + gRPC         |
| `tools`                   | `@pointerbyte/denoforge/tools`                   | jobs por intervalo/cron, bucle de workers acotado, flag de modo test           |
| `config`                  | `@pointerbyte/denoforge/config`                  | cliente REST `fetch`, servidor HTTP nativo `Deno.serve`, cliente/servidor gRPC |
| `config/http`             | `@pointerbyte/denoforge/config/http`             | entrada HTTP enfocada sin runtime gRPC opcional                                |
| `config/grpc`             | `@pointerbyte/denoforge/config/grpc`             | cliente/servidor gRPC, cargador proto y contratos de interceptores             |
| `wasm`                    | `@pointerbyte/denoforge/wasm`                    | ABI de componente verificado, pool acotado y adaptadores nativos               |

## Guías

| Guía                                                  | Cubre                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Arquitectura](./docs/architecture.es.md)             | Cómo encajan GoForge y DenoForge, y las tres rutas de ejecución                |
| [Migración](./docs/migration.es.md)                   | Pasar de GoForge a DenoForge, y cuánto conservar                               |
| [Compatibilidad](./docs/compatibility.es.md)          | Versiones fijadas, garantías, pisos de cobertura y puertas de deriva           |
| [Seguridad](./docs/security.es.md)                    | Modelo de amenazas, frontera de capacidades, integridad, debilidades conocidas |
| [Solución de problemas](./docs/troubleshooting.es.md) | Fallos concretos, sus causas reales y qué hacer                                |
| [Runtime de componentes](./wasm/README.es.md)         | Manifiestos, factoría, reintentos, pool y el adaptador nativo                  |

## Requisitos

- [Deno](https://deno.com/) **2.x** (desarrollado con la 2.9).

## Instalación

DenoForge se puede consumir **localmente** desde otros proyectos Deno, con o sin publicación en un
registro.

### Opción A — import map con ruta local (recomendado para uso local)

En el `deno.json` de tu proyecto, apunta un alias a la carpeta de DenoForge:

```json
{
  "imports": {
    "@denoforge/": "../DenoForge/"
  }
}
```

Y luego importa por módulo:

```ts
import { newLocalProvider } from "@denoforge/encrypt/mod.ts";
import { createService } from "@denoforge/security/mod.ts";
```

### Opción B — import relativo directo

```ts
import { newLocalProvider } from "../DenoForge/encrypt/mod.ts";
```

### Opción C — como paquete JSR

El paquete está configurado para JSR (`name`/`exports` en `deno.json`). Una vez publicado puedes
hacer `deno add jsr:@pointerbyte/denoforge` e importar con los especificadores de la tabla anterior.

## Inicio rápido

```ts
import { encrypt, security } from "@pointerbyte/denoforge";

const enc = encrypt.newLocalProvider();
const key = await enc.generateSymmetricKeys({ size: encrypt.SizeSymmetricKey.Key256Bits });
const cipher = await enc.encryptAES({ secretKey: key.keyRef, value: "hola" });

const jwt = security.createService({ algorithm: "HS256", hmacSecret: "s3cr3t" });
const token = await jwt.sign({ sub: "user-1" });
```

> El punto de entrada raíz usa espacios de nombres por módulo (`encrypt`, `logger`, `security`,
> `tools`, `config`, `wasm`) para que los nombres que se repiten entre módulos —`Service`,
> `Middleware`, `Handler`— nunca colisionen. Usa los especificadores enfocados cuando quieras un
> grafo de dependencias más pequeño; en particular, `config/http`, `logger` y `security` no
> resuelven los paquetes opcionales del runtime gRPC.

## Uso

### `encrypt`

Proveedor criptográfico local sobre Web Crypto, organizado en repositorios enfocados: simétrico,
asimétrico, hashing, firmas y gestión de claves.

```ts
import {
  CurveAsymmetricKey,
  newLocalProvider,
  SizeAsymmetricKey,
  SizeSymmetricKey,
} from "@pointerbyte/denoforge/encrypt";

const enc = newLocalProvider();

// AES-GCM (128/256 bits), con AAD; el nonce se antepone al texto cifrado.
const sym = await enc.generateSymmetricKeys({ size: SizeSymmetricKey.Key256Bits });
const ct = await enc.encryptAES({ secretKey: sym.keyRef, value: "secreto", additional: "aad" });
const pt = await enc.decryptAES({ secretKey: sym.keyRef, cipherValue: ct, additional: "aad" });

// RSA-OAEP, cifrado híbrido ECDH, firmas Ed25519 / RSA-PSS / RSA-PKCS1v15.
const rsa = await enc.generateRSAKeys({ size: SizeAsymmetricKey.Key2048Bits });
const ec = await enc.generateECDHCurveKeys({ curve: CurveAsymmetricKey.CurveP256 });
const ed = await enc.generateEd25519Keys();

// Hashing: HMAC-SHA256, SHA-256 hex, BLAKE3.
await enc.sha256Hex("abc");
```

Las claves se intercambian como **DER en Base64** (SPKI para públicas, PKCS#8 para privadas; bytes
crudos para simétricas) mediante el modelo `KeyData`. Cada operación acepta un `signal`
(`AbortSignal`) opcional para cancelación.

#### Proveedores de Cloud KMS

Para claves que nunca salen de un HSM gestionado, los proveedores `aws-kms`, `azure-key-vault` y
`gcp-kms` implementan un `CloudKmsRepository` común (encrypt/decrypt, sign/verify y ciclo de vida:
get/rotate/deactivate). Cada uno carga su SDK de nube **de forma perezosa en el primer uso**, así
que no añaden nada a tu grafo hasta que los importas.

```ts
import { newAwsKmsProvider } from "@pointerbyte/denoforge/encrypt/aws-kms";

const kms = newAwsKmsProvider({ region: "us-east-1" }); // requiere @aws-sdk/client-kms + credenciales AWS
const ciphertext = await kms.encrypt({ keyId: "alias/app", plaintext: "secreto" });
const plaintext = await kms.decrypt({ keyId: "alias/app", ciphertext });
const signature = await kms.sign({ keyId: "alias/signing", message: "payload" });
const ok = await kms.verify({ keyId: "alias/signing", message: "payload", signature });
```

Los tres aceptan un `api` inyectado (la interfaz `KmsApi`) para poder probar la lógica del proveedor
sin acceso a la nube. Paquetes peer requeridos: `@aws-sdk/client-kms`, `@azure/keyvault-keys` (+
`@azure/identity`), `@google-cloud/kms`.

### `logger`

Logging por niveles que emite el **formato de log de GoForge**, con **sanitizador** de valores
sensibles y middleware HTTP/gRPC. Cada entrada sigue el esquema de GoForge
`{level, timestamp, traceID, message, details, process, method, line, latency}`, donde `method` y
`line` ubican el punto de llamada y `details.system` proviene de `service.name`.

```ts
import { initLogger, LogLevel } from "@pointerbyte/denoforge/logger";

const log = initLogger({
  level: LogLevel.Debug,
  formatter: "json", // "json", "text"/"txt"/"" (por defecto: texto) o una plantilla
  formatDate: "2006-01-02T15:04:05.000", // layout estilo Go; este es el default
  service: { name: "api", version: "1.0.0" },
});
log.info("user.login", { userId: 1, password: "x" }); // password -> [REDACTED]
```

El formato de salida se elige con `formatter`, igual que la clave `logger.formatter` de GoForge:

- `text`, `txt` o la cadena vacía (el **default**) producen el layout de texto:

  ```text
  [2026-06-22T10:30:00.000] [INFO] [a1b2c3d4] handler:42 - request completed latency=12ms | details={system=api, method=GET, path=/api/v1/orders}
  ```

- `json` produce el layout JSON estructurado:

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

- cualquier otra cadena se trata como plantilla sobre los campos de la entrada, con los helpers
  `json`, `buildDetails` y `buildServices` (p. ej.
  `"{{.Level}} | {{.Message}} | {{json (buildServices .Process)}}"`). Como en GoForge, una plantilla
  cuya salida es JSON válido se re-normaliza a las claves estándar, así que las plantillas no pueden
  renombrarlas.

Los atributos reconocidos (`method`, `path`, `headers`, `request`, `response`, `client`, `protocol`,
`system`, más `traceID`, `latency` y `services` de nivel superior) se mapean a su lugar canónico del
esquema; el resto se fusiona dentro de `details`.

La dependencia no contiene ninguna política embebida de claves sensibles. Igual que
`logger.sensibleKeys` de GoForge, el logger predeterminado lee la lista exacta desde
`LOGGER_SENSIBLEKEYS`. Acepta un valor separado por comas o un arreglo JSON:

```bash
LOGGER_SENSIBLEKEYS=password,authorization,token \
  deno run --allow-env=LOGGER_SENSIBLEKEYS app.ts

LOGGER_SENSIBLEKEYS='["password","authorization","token"]' \
  deno run --allow-env=LOGGER_SENSIBLEKEYS app.ts
```

Una variable ausente o vacía significa que ningún campo se redacta. Leerla requiere
`--allow-env=LOGGER_SENSIBLEKEYS`; sin ese permiso, Deno rechaza la construcción del logger. Para
evitar la carga desde el entorno, pasa un `sanitizer` explícito, por ejemplo
`newSanitizer(["password"])`; su arreglo se usa exactamente y `newSanitizer([])` desactiva la
redacción.

El matching es por subcadena y sin distinguir mayúsculas, igual que GoForge. La dependencia no
rechaza valores cortos o genéricos, así que el operador debe configurar nombres precisos: un `id`
configurado también coincide con `provider`, mientras `id_token` tiene un efecto más acotado.

#### Destino a archivo y rotación

La salida va a un `Sink` configurable y por defecto usa stdout. Para replicar el tee rotativo a
stdout/archivo de GoForge:

```ts
const fileLog = initLogger({
  formatter: "json",
  dir: "./logs",
  // Por defecto "api.log"; usa fileName para conservar un nombre existente.
  service: { name: "api" },
  rotate: {
    enable: true,
    maxSize: 10, // MB
    maxBackups: 5, // 0 conserva todos
    maxAge: 30, // días; 0 desactiva el vencimiento
    compress: true,
  },
});
```

Usar `dir` requiere el permiso opcional `--allow-write`. El directorio y los archivos se crean con
permisos `0700` y `0600`. Un fallo del filesystem o de permisos nunca interrumpe el logging: degrada
a stdout y reporta una sola vez cada diagnóstico distinto. Los rotados usan
`<base>-<timestamp>.log`; gzip corre en segundo plano y la retención aplica primero la antigüedad y
después la cantidad de backups.

`rotate.enable` gobierna el destino a archivo completo al usar `initLogger`; sin él, la salida queda
solo en stdout. Llamar directamente a `newFileSink({ dir, fileName, rotate: { enable: false } })`
cubre el caso de archivo sin rotación. Su `tee` usa stdout por defecto; pasa `tee: false` para
escribir solo al archivo. Un `LoggerOptions.sink` explícito siempre gana sobre
`dir`/`fileName`/`rotate`. No apuntes varios procesos al mismo archivo porque los contadores de
rotación son locales a cada proceso.

Los logs HTTP pueden seguir emitiéndose automáticamente. Las exclusiones `string` coinciden
exactamente con el pathname, las expresiones regulares soportan rutas montadas o dinámicas e
`includeHeaders` conserva `true` como valor predeterminado:

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

Para que `method` y `line` apunten al handler, construye la entrada sin un logger e invócalo
directamente dentro del handler. El builder no consume bodies ni cambia la respuesta o el error:

```ts
const response = Response.json(result);
const entry = buildHttpLogEntry(request, { response }, logOptions);
if (entry?.level === "error") logger.error(entry.message, entry.details);
else if (entry) logger.info(entry.message, entry.details);
return response;
```

### `security`

Firma/verificación de JWT (`HS256`, `RS256`, `PS256`, `EdDSA` y una estrategia personalizada),
autenticación por cookie y middleware HTTP (`securityHeaders`, `jwtMiddleware`, `cookieMiddleware`).
`setRequestContext`/`getRequestContext` asocian estado genérico de la aplicación al `Request` exacto
mediante un `WeakMap`; este estado es independiente de los claims.

```ts
import { createService, getClaims, jwtMiddleware } from "@pointerbyte/denoforge/security";

const jwt = createService({ algorithm: "HS256", hmacSecret: "s3cr3t" });
const token = await jwt.sign({ sub: "u1", role: "admin" });
const auth = jwtMiddleware(jwt); // responde 401 si falta un Bearer válido
```

### `tools`

**Jobs por intervalo/cron** en proceso y un **bucle de workers acotado**, más un flag compartido de
modo test que suprime el trabajo en segundo plano durante los tests.

`resetWorkers()` vacía las tareas en cola y restablece el límite configurado. Las tareas que ya
están en ejecución pueden terminar y siguen consumiendo capacidad, de modo que reiniciar
inmediatamente después del reset no puede superar el nuevo límite de concurrencia.

El timeout de un job informa que se venció el plazo, pero no puede detener por la fuerza trabajo
JavaScript arbitrario. Por eso el scheduler conserva la marca de ejecución hasta que la promesa
subyacente termina; los ticks posteriores nunca se solapan con ese trabajo.

```ts
import { addTask, job, runWorkers, startJobs } from "@pointerbyte/denoforge/tools";

runWorkers();
addTask(() => trabajoEnSegundoPlano());

const id = job(() => sondear(), 5000); // cada 5s
startJobs();
```

### `config`

Cliente REST basado en `fetch` y servidor HTTP nativo sobre `Deno.serve` con middleware, grupos de
rutas, endpoint `/health` configurable y apagado controlado.

Usa `config/http` para aplicaciones que solo necesitan HTTP. Esta entrada excluye `@grpc/grpc-js` y
`@grpc/proto-loader` del grafo resuelto. El agregado `config` existente mantiene todos los exports
HTTP y gRPC anteriores para conservar compatibilidad.

```ts
import { newClientHTTP, newHttpServer } from "@pointerbyte/denoforge/config/http";

const server = newHttpServer({ port: 8080 });
server.get("/api/ping", () => Response.json({ pong: true }));
server.group("/api/v1").get("/users", listarUsuarios);
server.listen();

const api = newClientHTTP({ baseUrl: "https://example.com", timeoutMs: 5000 });
const { data } = await api.get<{ id: number }>("/users/1");
```

Personaliza la única ruta health integrada mediante `healthHandler` (`healthPath: ""` continúa
deshabilitándola):

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

`httpContext` crea IDs por request y `traceparent`/`tracestate` W3C validados, registra el inicio
con tiempo monotónico y devuelve el request ID como header. Nunca copia headers completos, cookies,
authorization, tokens ni bodies al contexto:

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

El middleware comparte una única forma `(next) => (req) => Response` entre `logger`, `security` y
`config`, así que las piezas se componen libremente:

```ts
import { newHttpServer } from "@pointerbyte/denoforge/config/http";
import { httpLogger, initLogger } from "@pointerbyte/denoforge/logger";
import {
  createService,
  getClaims,
  jwtMiddleware,
  securityHeaders,
} from "@pointerbyte/denoforge/security";

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

Usa `config/grpc` para el cliente y servidor gRPC sobre `@grpc/grpc-js`, con el mismo modelo de
interceptores componibles. Esta entrada enfocada incluye intencionalmente `@grpc/grpc-js` y
`@grpc/proto-loader`. Los interceptores de servidor (logging, auth JWT) envuelven los handlers
unarios; el cliente promisifica las llamadas unarias e inyecta metadata. Las entradas de logger y
security exponen esos interceptores mediante contratos sin dependencias, por lo que importar
cualquiera de ellas por separado no carga el runtime gRPC.

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

La entrada dedicada ofrece un host perezoso y acotado para el ABI v1 canónico de GoForge. Los
envelopes JSON crudos usan `abi`, `id`, metadatos/errores snake_case y campos Base64 con padding
explícitos por operación. Verifica por separado el manifiesto portable y el bundle inmutable antes
de ejecutar una fábrica revisada. Incluye cancelación, deadlines, errores tipados, health, cierre,
observabilidad redactada y adaptadores nativos calificados por paridad. Un fallo del componente
nunca selecciona un adaptador automáticamente, tampoco en seguridad o criptografía.

Para quienes no pueden pagar el costo por llamada del componente, `createNativeGoforgeAdapter()`
implementa las mismas ocho operaciones de forma nativa. Solo se vuelve enrutable después de que
`qualifyNativeAdapter()` reproduzca byte a byte cada vector compartido de GoForge, así que una
implementación desviada no puede registrarse.

Consulta la [guía del runtime de componentes](./wasm/README.es.md) para conocer el manifiesto
estricto, integración de la fábrica, política de reintentos, permisos y contrato operativo.

## Herramientas de línea de comandos (`cmd/`)

DenoForge incluye un conjunto de CLIs, ejecutables con `deno run` o con las tareas incluidas:

- **`qdeno`** — genera un nuevo servicio DenoForge (HTTP o gRPC) en un directorio.

  ```sh
  deno task qdeno new http my-api
  deno task qdeno new grpc my-svc --dir ./services/my-svc
  ```

  Instálalo como comando global desde JSR:

  ```sh
  deno install -A -n qdeno jsr:@pointerbyte/denoforge/qdeno
  qdeno new http my-api
  ```

  O ejecútalo sin instalar:

  ```sh
  deno run -A jsr:@pointerbyte/denoforge/qdeno new http my-api
  ```

- **`deno-openssl`** — generación de pares de claves, certificados autofirmados y manejo de PEM,
  sobre Web Crypto (los certificados usan `@peculiar/x509`, cargado de forma perezosa).

  ```sh
  deno task deno-openssl keypair --algorithm ed25519 --out id
  deno task deno-openssl cert --name "CN=localhost" --days 365 --out localhost
  deno task deno-openssl pem-info id.key.pem
  ```

- **`example`** — una demo ejecutable que levanta un servidor HTTP **y** uno gRPC con logging +
  seguridad JWT y apagado controlado.

  ```sh
  deno task example
  ```

## Pruebas

```sh
deno task test       # ejecuta la suite
deno task cov        # ejecuta con cobertura e imprime la tabla
deno task cov:check  # crea un perfil nuevo; exige >=80% en líneas, ramas y funciones
deno task bench      # ejecuta baselines deterministas de cada dominio exportado
deno task bench:smoke # ejecuta el benchmark enfocado que usa CI
```

La suite cubre los round-trips de criptografía, auth JWT/cookie, el sanitizador, jobs y workers, el
cliente/servidor HTTP, los interceptores gRPC y un round-trip gRPC, además de los proveedores KMS
mediante un `KmsApi` falso inyectado — **~87% de cobertura de líneas**. Los adaptadores de los SDK
de nube se ejercitan a través de esa interfaz inyectable, no contra servicios reales.

Los benchmarks usan las mismas interfaces deterministas: no contactan proveedores cloud, no abren
puertos de red y no escriben scaffolds al disco. Los pull requests y pushes a `main` ejecutan gates
de formato, lint, tipos, tests, cobertura, aislamiento de dependencias y benchmark smoke sin
publicar. El repositorio versiona `deno.lock`; CI fija Deno 2.9.4 y verifica el lockfile en modo
frozen antes de ejecutar esos gates.

## Notas

- **BLAKE3** no tiene equivalente en Web Crypto, por lo que es la única primitiva delegada (vía
  `@noble/hashes`). Todo lo demás usa `crypto.subtle` de la plataforma.
- **La gestión de claves** (`rotateKey`, `getKey`, `deactivateKey`) depende del proveedor: el local
  lanza `UnsupportedOperationError`, mientras que `aws-kms`, `azure-key-vault` y `gcp-kms` la
  implementan contra su KMS en la nube.
- **La cancelación** se expresa con `AbortSignal` (el campo `signal` en las peticiones / el
  argumento `signal` en los helpers).

## Estructura del proyecto

```text
DenoForge/
├── deno.json              # import map, tareas, exports
├── mod.ts                 # barrel raíz con espacios de nombres
├── encrypt/               # criptografía (Web Crypto) + cloud KMS
│   ├── common/{enums,kms}.ts
│   ├── models/models.ts
│   ├── utilities/utilities.ts
│   ├── local/{interface,repository,mod}.ts
│   ├── aws-kms/{interface,repository,mod}.ts
│   ├── azure-key-vault/{interface,repository,mod}.ts
│   ├── gcp-kms/{interface,repository,mod}.ts
│   ├── errors.ts
│   └── mod.ts
├── logger/                # logging estructurado
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
├── tools/                 # jobs, workers, mode
│   ├── jobs/jobs.ts
│   ├── workers/workers.ts
│   ├── utilities/mode.ts
│   └── mod.ts
├── config/                # bootstrap de transporte (HTTP + gRPC)
│   ├── http/mod.ts        # entrada HTTP enfocada sin dependencias gRPC
│   ├── grpc/{mod,contracts}.ts # entrada gRPC + contratos sin dependencias
│   ├── client/http/{interface,models,client}.ts
│   ├── client/grpc/client.ts
│   ├── server/http/server.ts
│   ├── server/grpc/{server,interceptors}.ts
│   ├── proto/{methods.proto,loader.ts}
│   └── mod.ts
├── wasm/                  # ABI verificado, pool del runtime y adaptadores
│   ├── {contracts,codec,manifest,runtime,adapters}.ts
│   └── mod.ts
├── cmd/                   # herramientas de línea de comandos
│   ├── qdeno/               # generador de servicios
│   ├── deno-openssl/        # claves/certificados/PEM
│   └── example/           # demo ejecutable HTTP + gRPC
└── examples/              # demos enfocadas por módulo
```

## Desarrollo

```sh
deno task fmt:check      # verifica formato sin reescribir
deno task lint           # aplica lint al código, tests y benchmarks
deno task check          # verifica tipos de todos los entry points soportados
deno task check:deps     # verifica grafos de dependencias opcionales enfocados
deno task doc:lint       # verifica cada entrada declarada en el mapa de exports
deno task test           # ejecuta tests
deno task cov:check      # exige el mínimo de cobertura del 80%
deno task bench:smoke    # ejercita el arnés de benchmarks
deno task example:encrypt
deno task example:jwt
deno task example:logger
deno task example:server # sirve en :8080 (la tarea incluye --allow-net)
```

## Licencia

Apache-2.0. Ver [LICENSE](./LICENSE).

> El diseño y la organización de módulos de DenoForge están inspirados en el proyecto GoForge.
