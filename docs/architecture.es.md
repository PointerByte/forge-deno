# Arquitectura

Cómo encajan forge-go y forge-deno, y cuál de las tres rutas de ejecución toma una llamada.

## Dos repositorios, un contrato

forge-go (Go) es la **única fuente de verdad** de las reglas de negocio portables. forge-deno (Deno)
implementa las mismas capacidades para el ecosistema Deno. Son repositorios separados y ninguno
importa al otro en tiempo de ejecución.

Lo que los une es un contrato, no código compartido:

```
forge-go-private/share/portable/          el núcleo Go sin dependencias: 8 operaciones, catálogo de errores, límites
        │
        ├── testdata/vectors/v1.json ──► copiado a forge-deno como wasm/testdata/vectors/v1.json
        │                                (con prueba de deriva; forge-go sigue siendo el dueño)
        │
        ├── component/                   mundo WIT + bridge, compilado a un componente WebAssembly
        │     └── artifacts/             bundle de release: componente, glue, módulos core, manifiestos
        │
        └── goforge.abi.manifest.json ─► genera wasm/generated/goforge-contract.ts en forge-deno
                                         (deno task contract:check falla ante deriva)
```

El núcleo portable es deliberadamente libre de dependencias. Los SDK de nube, Gin, gRPC, Viper, el
acceso a archivos y procesos, OpenTelemetry y las terminales de CLI son **adaptadores de host** y
nunca entran en él.

## Tres rutas de ejecución

Un caller de forge-deno puede alcanzar las mismas ocho operaciones portables de tres formas. No son
intercambiables, y el runtime nunca cambia entre ellas por su cuenta.

| Ruta                 | Punto de entrada                                                 | Costo por llamada | Cuándo usarla                                                         |
| -------------------- | ---------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| **Componente**       | `runtime.invoke(op, payload)`                                    | ~200–600 µs       | Fidelidad de contrato: quieres el comportamiento exacto del núcleo Go |
| **Adaptador nativo** | `runtime.invoke(op, payload, { target: { kind: "native", … } })` | ~0,2–13 µs        | Rutas calientes, carga sostenida                                      |
| **Dominios nativos** | `encrypt`, `logger`, `security`, `config/http`, …                | nativo            | Trabajo ordinario de aplicación                                       |

El componente es 23–966× más lento que Deno nativo con el mismo envelope, y lo que domina ese costo
es el envelope JSON + Base64, no la criptografía. **El valor del componente es la fidelidad de
contrato, no la velocidad.**

### Los dominios nativos no son todos sin permisos

La mayoría de dominios nativos no necesitan permiso alguno — el proveedor local de `encrypt` es Web
Crypto, `logger` formatea cadenas. Dos grupos son distintos, y esa diferencia es justo lo que los
mantiene fuera de la ruta del componente:

- los proveedores de cloud KMS (`encrypt/aws-kms`, `encrypt/azure-key-vault`, `encrypt/gcp-kms`)
  alcanzan un endpoint de red;
- `encrypt/pkcs11` carga la librería PKCS#11 del fabricante con `Deno.dlopen`, así que necesita
  `--allow-ffi` y acceso de lectura a ese archivo.

Un componente WebAssembly no puede abrir una librería compartida ni un socket, y los imports WASI
denegados que se describen más abajo lo rechazarían si lo intentara. Por eso estos dominios
conservan una mitad portable —empaquetado del payload, derivación de claves, manejo de URI y DER—
junto a una mitad que solo corre en el host, que es lo que la matriz de cobertura registra como
clase E («componente híbrido y adaptador nativo»). Se alcanzan por sus propios especificadores de
import, nunca por `runtime.invoke`.

La verificación ocurre en el primer uso y no al construir, así que un proceso que nunca toca un
token nunca necesita el permiso: `newPkcs11Provider()` es inerte hasta que se ejecuta una operación,
y entonces lanza `Pkcs11UnavailableError` si la FFI no está disponible. forge-go traza la misma
línea en tiempo de compilación con su build tag `pkcs11` y `ErrUnavailable`.

### Por qué el enrutamiento es explícito

Un fallo del componente nunca selecciona un adaptador nativo automáticamente. Esa regla existe
porque las operaciones incluyen criptografía: una degradación silenciosa de un guest verificado a
una implementación del host, disparada por un fallo transitorio, tiene exactamente la forma de un
incidente de seguridad. El caller elige el target en cada invocación, y además
`NativeAdapterRegistry` exige que el manifiesto del release nombre al adaptador para esa operación.

### Por qué el adaptador nativo puede reimplementar reglas portables

Es el único lugar de forge-deno que lo hace, y la equivalencia se verifica por máquina en vez de
confiarse. `createNativeGoforgeAdapter()` devuelve `parityQualified: false`, y el registro se niega
a enrutar hacia eso. Solo `qualifyNativeAdapter()` — que reproduce byte a byte cada vector
compartido de forge-go y rechaza cualquier operación declarada sin vector que la cubra — puede
producir un adaptador calificado. Una suite diferencial además lo contrasta con el componente real
en fronteras Unicode, orden de validaciones y todas las rutas de fallo.

## La ABI canónica

Un solo envelope JSON cruza cada frontera:

```jsonc
// petición
{ "abi": "goforge.abi.v1", "id": "…", "operation": "crypto.sha256",
  "metadata": { "deadline_unix_ms": 0, "cancellation_token": "" },
  "payload": { "data": "<Base64 con padding>" } }

// respuesta — exactamente uno de result o error
{ "abi": "goforge.abi.v1", "id": "…", "ok": true, "result": { "digest": "…" } }
```

Estricto por construcción: se rechazan campos desconocidos, campos duplicados, Base64 sin padding o
URL-safe, códigos de error en mayúsculas, IDs que no coinciden y mensajes fuera del catálogo. Los
campos binarios los nombra la operación (`data`, `key`, `nonce`, `aad`, `plaintext`, `ciphertext`,
`digest`, `mac`) — no existe un wrapper genérico de bytes.

## Los controles de ejecución van fuera del payload

Los deadlines y la cancelación viajan como un registro `ExecutionState` explícito en la frontera
WIT, no como datos de negocio:

```
clock-checked · now-unix-milliseconds · cancellation-checked
cancellation-token · cancellation-requested
```

Las banderas `*-checked` hacen que los controles **fallen de forma cerrada**: un guest al que se le
pide respetar un deadline pero recibe `clock-checked: false` se niega en lugar de continuar sin
reloj. `control.deadline` y `control.cancellation` se declaran como capacidades _del host_
precisamente porque el guest no puede satisfacerlas por sí solo.

## La frontera de capacidades

El núcleo portable no hace E/S, así que el host proporciona cada interfaz WASI que el componente
importa en su forma **denegada**: argumentos y entorno vacíos, flujos estándar cerrados, sin
terminal asociada y cada punto de entrada del sistema de archivos negándose. Exactamente dos
capacidades son reales — los relojes, que necesita el planificador de Go, y `wasi:random/random`,
respaldado por el CSPRNG del host. Cada denegación está fijada por una prueba.

Reemplazar cualquier stub denegado otorga al guest autoridad que el contrato nunca pide. Pasar tus
propias `wasiImports` es posible y es una decisión de seguridad que exige justificación.

## Cadena de integridad

Nada se ejecuta antes de verificarse, y nada se vuelve a leer del disco después:

1. El caller aporta un SHA-256 confiable de `manifest.json`, que se comprueba **antes** de analizar
   el JSON.
2. El manifiesto fija los digests del componente, del glue del host y de cada módulo core.
3. La factoría importa el glue desde un blob en memoria construido con los bytes ya verificados y
   compila los módulos core desde bytes verificados.

Por eso un archivo sustituido entre la comprobación de digest y la instanciación no puede
ejecutarse.

## Relacionado

- [Compatibilidad](./compatibility.es.md) — versiones fijadas y qué se garantiza entre ellas
- [Migración](./migration.es.md) — pasar de forge-go a forge-deno
- [Seguridad](./security.es.md) — modelo de amenazas y qué _no_ está protegido
- [Solución de problemas](./troubleshooting.es.md) — fallos concretos y sus causas
- [Guía del runtime de componentes](../wasm/README.es.md) — manifiestos, factoría, reintentos, pool

Consulta [architecture.md](./architecture.md) para la versión en inglés.
