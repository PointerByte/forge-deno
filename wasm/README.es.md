# Runtime de componentes forge-go

La entrada pública `@pointerbyte/denoforge/wasm` es el host de Deno con cierre seguro para la lógica
portable de forge-go. Importarla o construirla no realiza E/S. La primera llamada verifica el bundle
inmutable del release antes de entregar bytes a la fábrica. Cada instancia nueva también debe
devolver el manifiesto portable canónico de forge-go antes de poder despachar peticiones.

Este directorio es código de producción y nunca importa una implementación de investigación.

## ABI v1 canónica

forge-go es la fuente de verdad del contrato. Las peticiones usan `abi`, `id`, `operation`,
`metadata` opcional y un `payload` JSON crudo específico de la operación:

```json
{
  "abi": "goforge.abi.v1",
  "id": "sha-1",
  "operation": "crypto.sha256",
  "metadata": {
    "deadline_unix_ms": 2000,
    "cancellation_token": "call-1",
    "required_capabilities": ["crypto.sha256"]
  },
  "payload": { "data": "YWJj" }
}
```

Las respuestas usan `abi`, `id` y `ok`, seguidos exactamente por un `result` o un `error`:

```json
{
  "abi": "goforge.abi.v1",
  "id": "sha-1",
  "ok": true,
  "result": { "digest": "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=" }
}
```

```json
{
  "abi": "goforge.abi.v1",
  "id": "sha-1",
  "ok": false,
  "error": {
    "code": "invalid_base64",
    "message": "value is not canonical standard padded Base64",
    "retryable": false,
    "field": "payload.data"
  }
}
```

No existe un wrapper genérico `$type` para bytes. Los campos definidos por forge-go—`data`, `key`,
`nonce`, `aad`, `plaintext`, `ciphertext`, `digest` y `mac`—son strings Base64 RFC 4648 con alfabeto
estándar y padding obligatorio. Usa explícitamente `encodeAbiBase64` y `decodeAbiBase64`. Se
rechazan bytes crudos, Base64 sin padding o URL-safe, códigos en mayúsculas, campos desconocidos,
campos duplicados en respuestas, IDs distintos y mensajes fuera del catálogo.

ABI v1 contiene exactamente estas operaciones:

- `text.normalize` y `text.validate`
- `crypto.sha256` y `crypto.hmac-sha256`
- `crypto.aes-gcm.encrypt` y `crypto.aes-gcm.decrypt`
- `encoding.base64.encode` y `encoding.base64.decode`

El gate compartido lee directamente `forge-go-private/share/portable/testdata/vectors/v1.json` y
demuestra envelopes byte a byte equivalentes y paridad de respuestas para las ocho operaciones.

## Dos manifiestos intencionalmente distintos

`goforge.manifest.v1` lo exporta forge-go y describe ABI, límites, capacidades, operaciones y
errores. `goforge.bundle-manifest.v1` contiene solo metadatos del release para verificar los digests
del componente, glue y módulos core. El runtime verifica ambos y rechaza cualquier desacuerdo.

El bundle usa esta raíz distinta y debe describir las ocho operaciones canónicas:

```json
{
  "schema": "goforge.bundle-manifest.v1",
  "abi": "goforge.abi.v1",
  "componentVersion": "0.1.0",
  "witPackage": "pointerbyte:goforge@0.1.0",
  "source": { "path": "goforge.component.wasm", "sha256": "<64 hex minúsculas>" },
  "glue": { "path": "host/goforge.js", "sha256": "<64 hex minúsculas>" },
  "coreModules": {
    "goforge.core.wasm": {
      "path": "host/goforge.core.wasm",
      "sha256": "<64 hex minúsculas>"
    }
  },
  "capabilities": ["crypto.sha256"],
  "operations": {
    "crypto.sha256": {
      "capability": "crypto.sha256",
      "retrySafe": true,
      "securitySensitive": false
    }
  }
}
```

Las rutas deben ser relativas al paquete, sin traversal, URL, query, fragmentos, segmentos
codificados ni rutas duplicadas. El SHA-256 confiable se verifica antes de analizar JSON.

## Hospedaje del glue revisado

El runtime no ejecuta jco, npm, subprocesos ni la red. Una fábrica del release adapta los bindings
revisados a los exports exactos del componente Go:

```ts
import {
  createFileArtifactReader,
  decodeAbiBase64,
  encodeAbiBase64,
  GoforgeWasmRuntime,
  type WasmComponentFactory,
} from "@pointerbyte/denoforge/wasm";

declare const fabricaRevisada: WasmComponentFactory;

const runtime = new GoforgeWasmRuntime({
  bundle: {
    manifestPath: "manifest.json",
    manifestSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  compatibility: {
    componentVersion: "0.1.0",
    witPackage: "pointerbyte:goforge@0.1.0",
  },
  readArtifact: createFileArtifactReader(new URL("./component/", import.meta.url)),
  factory: fabricaRevisada,
  poolSize: 4,
});

const resultado = await runtime.invoke<{ digest: string }>(
  "crypto.sha256",
  { data: encodeAbiBase64(new TextEncoder().encode("abc")) },
  { timeoutMs: 500, requiredCapabilities: ["crypto.sha256"] },
);
const digest = decodeAbiBase64(resultado.digest);
await runtime.close();
```

Cada instancia ofrece `manifest()` y `dispatch(requestJson, executionState)`. El estado se mapea
directamente a `clockChecked`, `nowUnixMilliseconds`, `cancellationChecked`, `cancellationToken` y
`cancellationRequested` de forge-go. Así los controles quedan fuera del payload de negocio, pero son
explícitos y fallan de forma cerrada.

## La factoría de producción y su frontera de capacidades

`createGeneratedComponentFactory()` es la factoría admitida para los paquetes construidos por
`forge-go-private/share/component/scripts/build.sh`. Solo ejecuta bytes que el runtime ya verificó:
el glue generado se importa desde un blob en memoria construido con `bundle.glueBytes`, y cada
módulo core se compila desde `bundle.coreModuleBytes`. Nada se vuelve a leer del disco después de su
comprobación de digest, así que un archivo sustituido entre la verificación y la instanciación no
puede ejecutarse.

```ts
import {
  createFileArtifactReader,
  createGeneratedComponentFactory,
  GoforgeWasmRuntime,
} from "@pointerbyte/denoforge/wasm";

const runtime = new GoforgeWasmRuntime({
  bundle: { manifestPath: "manifest.json", manifestSha256: trustedDigest },
  compatibility: { componentVersion: "0.1.0", witPackage: "pointerbyte:goforge@0.1.0" },
  readArtifact: createFileArtifactReader(new URL("./artifacts/", import.meta.url)),
  factory: createGeneratedComponentFactory(),
});
```

Las importaciones WASI provienen de `createDeniedWasiImports()`. El núcleo portable de forge-go no
hace E/S, por lo que el host proporciona las dieciocho interfaces que el componente declara en su
forma **denegada**: argumentos y entorno vacíos, flujos estándar cerrados, sin terminal asociada y
cada punto de entrada del sistema de archivos devuelve `not-permitted`. Solo dos capacidades son
reales: los relojes, que necesita el planificador de Go, y `wasi:random/random`, respaldado por el
CSPRNG del host. Cada denegación está fijada por una prueba.

Reemplazar cualquier stub denegado otorga al guest autoridad que el contrato portable nunca pide.
Pasar tus propias `wasiImports` es posible y es una decisión de seguridad que exige justificación.

### Limitación conocida: carga sostenida

El componente falla de forma intermitente durante la recolección de basura de Go bajo carga
sostenida de dispatch, manifestándose como `RangeError: Maximum call stack size exceeded`. La
corrección está probada — el núcleo Go en WebAssembly reproduce exactamente todos los vectores
compartidos nativos — pero la resistencia no. No pongas todavía esta ruta en una vía de producción
crítica. `research/component-gc-soak/soak.ts` lo reproduce y lo mide.

Desde entonces el defecto se aisló al compilador **componentize-go**, no a WebAssembly ni a este
host: se reproduce bajo wasmtime sin JavaScript de por medio, y una compilación con TinyGo del mismo
código de guest sobrevive la misma carga con 0/10 fallos y paridad total de vectores. El cambio de
compilador de producción está propuesto pero aún no aprobado, así que el bundle publicado sigue
afectado. Mientras tanto, usa {@linkcode createNativeGoforgeAdapter} para trabajo sostenido o
sensible a la latencia.

## Ciclo de vida, reintentos y adaptadores

El runtime comparte una verificación perezosa y usa un pool FIFO acotado. Una llamada cancelada o
vencida conserva su lease hasta que termina la promesa generada y luego descarta la instancia. El
cierre aborta callers activos, drena el pool, cierra adaptadores y es idempotente.

Los reintentos exigen `allowRetry: true`, `retrySafe` en el release, un error reintentable del
catálogo Go y un código en minúsculas incluido en el allowlist. Se conserva el mismo ID. Nunca se
reintentan traps, salida inválida, fallos de integridad, deadlines, cancelación ni incompatibilidad,
aunque el caller incluya un código de deadline o cancelación en el allowlist.

El routing nativo siempre es explícito. `NativeAdapterRegistry` exige aprobación del release, la
operación exacta y `parityQualified: true`. Un fallo del componente nunca cambia el target; una
operación de seguridad no puede degradarse en silencio.

## El adaptador nativo portable

`createNativeGoforgeAdapter()` implementa las ocho operaciones portables directamente sobre Web
Crypto y las primitivas de cadenas de Deno. Existe porque el componente cuesta 23–966× más por
llamada que el código nativo con el mismo envelope, así que las rutas calientes necesitan otra
salida.

Es el único lugar de forge-deno que reimplementa reglas portables, y solo se permite porque la
equivalencia se verifica por máquina en vez de afirmarse:

```ts
const vectors = JSON.parse(await Deno.readTextFile("wasm/testdata/vectors/v1.json")).vectors;
const adapters = new NativeAdapterRegistry();
adapters.register(await qualifyNativeAdapter(createNativeGoforgeAdapter(), vectors));

await runtime.invoke("crypto.sha256", { data }, {
  target: { kind: "native", adapter: GOFORGE_NATIVE_ADAPTER_NAME },
});
```

`createNativeGoforgeAdapter` devuelve `parityQualified: false`, y el registro se niega a enrutar a
eso. Solo `qualifyNativeAdapter` — que reproduce todos los vectores de forge-go y los compara byte a
byte, y lanza un error si alguna operación no tiene vector que la cubra — puede producir un
adaptador calificado. Una implementación desviada, por tanto, no puede registrarse.

Más allá de los vectores, `native_test.ts` ejecuta una suite diferencial que compara el adaptador
contra el **componente real** en entradas vacías, fronteras Unicode, orden de las reglas de
validación y todas las rutas de fallo. Ambos deben coincidir exactamente, incluidos los códigos de
error y la atribución de campo.

Dos comportamientos son deliberadamente los de Go y no los de JavaScript, porque el contrato es el
de Go: no se usa `String.prototype.trim` (elimina U+FEFF, que Go no considera espacio, y conserva
U+0085, que Go sí), y el Base64 se vuelve a codificar y comparar para rechazar bits finales no
canónicos igual que lo hace `base64.StdEncoding.Strict()`.

El adaptador no es un fallback. Enrutar hacia él es una decisión del caller en cada invocación, y un
fallo del componente nunca redirige hacia él.

Los eventos contienen metadatos de ciclo de vida, nunca payloads, resultados, mensajes, campos ni
secretos. `health()` no fuerza la carga y `preload()` verifica sin crear instancias.

Consulta [README.md](./README.md) para la versión en inglés.
