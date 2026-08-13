# Migración

Pasar de forge-go (Go) a forge-deno (Deno), y decidir cuánto de forge-go conservar.

## Decide primero: ¿qué ruta necesitas realmente?

La mayoría de los equipos no necesita el componente WebAssembly en absoluto.

| Si necesitas…                                         | Usa                                                                                                                 | Por qué                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Servicios Deno normales con las mismas capacidades    | **Dominios nativos** (`encrypt`, `logger`, `security`, `config/http`, `config/grpc`, `tools/jobs`, `tools/workers`) | Idiomático, rápido, sin bundle que distribuir                   |
| El comportamiento _exacto_ del núcleo Go como oráculo | **Componente**                                                                                                      | Mismos bytes, mismas reglas; fidelidad de contrato              |
| Operaciones portables en una ruta caliente            | **Adaptador nativo**                                                                                                | Calificado por vectores, ~25–1000× más barato que el componente |

Solo las ocho operaciones portables existen en las tres rutas. Todo lo demás — HTTP, gRPC, jobs,
workers, CLIs, KMS en la nube — es exclusivamente Deno nativo, porque son adaptadores de host que
nunca entran en un núcleo portable.

## Paso 1: mapea tu superficie de API en Go

La
[matriz de cobertura funcional](../openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/functional-coverage-matrix.md)
cataloga las 891 APIs públicas de Go con un estado en Deno, un símbolo representativo y una ruta de
migración. Busca las tuyas ahí primero.

Cada entrada es una de:

- **exact** — existe un equivalente en Deno a nivel de nombre (298 APIs, 33,4 %)
- **documented-exception** — no hay equivalente directo; la entrada nombra el enfoque de reemplazo
  (588)
- **contrato deprecado** — un nombre Go heredado conservado por compatibilidad

Fíjate en el encuadre honesto: la matriz prueba _representación_, no equivalencia semántica. La
paridad semántica solo está probada donde existen vectores compartidos.

## Paso 2: ten presentes las convenciones de nombres

Los nombres calificados por paquete de Go se colapsan al aplanarse en JavaScript, así que forge-deno
usa espacios de nombres por módulo (`encrypt`, `logger`, `security`, `wasm`) — los nombres que se
repiten entre módulos, como `Service`, `Middleware` y `Handler`, nunca colisionan. Importa desde el
punto de entrada específico en vez de la raíz cuando quieras esa claridad:

```ts
import { … } from "@pointerbyte/denoforge/encrypt";
import { … } from "@pointerbyte/denoforge/wasm";
```

Los nombres Go heredados mal escritos se conservan del lado de Go y se **corrigen** en los contratos
ABI generados. Si migras contra la ABI y no contra el código Go, espera la ortografía corregida.

## Paso 3: si usas el componente, conecta el bundle

El bundle no está en el paquete JSR. Constrúyelo y apunta el runtime hacia él:

```bash
cd forge-go-private/component && ./scripts/build.sh
```

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
  poolSize: 4,
});
```

`trustedDigest` debe venir de una fuente en la que confíes — una nota de release firmada, tu
configuración de despliegue — no del bundle que estás a punto de verificar.

**Antes de poner esto en una ruta de producción:** lee la limitación de carga sostenida en
[solución de problemas](./troubleshooting.es.md). El componente publicado falla de forma
intermitente bajo despacho sostenido.

## Paso 4: traduce la forma de la llamada

Go:

```go
dispatcher := portable.DefaultDispatcher()
response := dispatcher.DispatchJSON(requestJSON, portable.ExecutionState{})
```

Deno:

```ts
const result = await runtime.invoke<{ digest: string }>(
  "crypto.sha256",
  { data: encodeAbiBase64(new TextEncoder().encode("abc")) },
  { timeoutMs: 500, requiredCapabilities: ["crypto.sha256"] },
);
const digest = decodeAbiBase64(result.digest);
```

Tres cosas suelen dar problemas:

1. **Los campos binarios son cadenas Base64 con padding y alfabeto estándar**, nombradas por la
   operación. Usa `encodeAbiBase64` / `decodeAbiBase64`, no `btoa`.
2. **Los deadlines y la cancelación son opciones, no campos del payload.** Viajan fuera del payload
   de negocio y fallan de forma cerrada.
3. **Los fallos de dominio son respuestas, no excepciones, dentro del guest** — pero el runtime
   convierte una respuesta fallida en un `WasmGuestError` tipado, con `code`, `retryable` y `field`.

## Paso 5: opta por el adaptador nativo en rutas calientes

```ts
const vectors = JSON.parse(await Deno.readTextFile("wasm/testdata/vectors/v1.json")).vectors;
const adapters = new NativeAdapterRegistry();
adapters.register(await qualifyNativeAdapter(createNativeGoforgeAdapter(), vectors));

const runtime = new GoforgeWasmRuntime({ /* … */, adapters });

await runtime.invoke("crypto.sha256", payload, {
  target: { kind: "native", adapter: GOFORGE_NATIVE_ADAPTER_NAME },
});
```

El enrutamiento es por invocación y siempre explícito. El manifiesto del release además debe listar
el adaptador bajo `nativeAdapters` para esa operación — no basta con un adaptador calificado.

## Paso 6: ejecuta las puertas

```bash
deno task fmt:check && deno task lint && deno task check
deno task test && deno task cov:check
deno task contract:check && deno task inventory:check && deno task matrix:check
```

Si falla `contract:check`, llegó un cambio de contrato de forge-go — regenera con
`deno task contract` y deja que `generated_contract_test.ts` nombre cualquier superficie que también
necesite actualizarse.

## Relacionado

- [Arquitectura](./architecture.es.md) · [Compatibilidad](./compatibility.es.md) ·
  [Seguridad](./security.es.md) · [Solución de problemas](./troubleshooting.es.md)

Consulta [migration.md](./migration.md) para la versión en inglés.
