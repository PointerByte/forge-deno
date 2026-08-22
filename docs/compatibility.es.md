# Compatibilidad

Qué versiones están fijadas, qué se garantiza entre ellas y cómo se detecta la deriva.

## Versiones del contrato

| Elemento                        | Versión                      | Cambiarlo implica                                                               |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| ABI del puente JSON             | `goforge.abi.v1`             | Un nuevo identificador de ABI; el runtime rechaza los que no coinciden          |
| Paquete WIT                     | `pointerbyte:goforge@0.1.0`  | Una nueva versión de componente y un fallo de compatibilidad con bundles viejos |
| Esquema del manifiesto portable | `goforge.manifest.v1`        | Regenerar el contrato TypeScript                                                |
| Esquema del bundle de release   | `goforge.bundle-manifest.v1` | Independiente del contrato portable; solo metadatos de release                  |

Los dos manifiestos son documentos deliberadamente distintos. `goforge.manifest.v1` es el contrato
de forge-go — ABI, límites, capacidades, operaciones, errores. `goforge.bundle-manifest.v1` son
metadatos de release para verificar digests. El runtime valida ambos y rechaza cualquier desacuerdo.

## Versiones fijadas del toolchain

| Herramienta                 | Versión | Notas                                                                                             |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| Piso del lenguaje Go        | 1.26.0  | El contrato público de compatibilidad; la directiva `go` de cada módulo                           |
| Toolchain de compilación Go | 1.26.7  | La línea de parches con la que se compilan los releases; coincide con el pin de todo el workspace |
| componentize-go             | 0.4.0   | Compilador de producción actual — **afectado por el defecto de GC**                               |
| TinyGo                      | 0.41.1  | Compilación de comparación; reemplazo propuesto, aún no aprobado                                  |
| wit-bindgen                 | 0.58.0  | Bindings del guest                                                                                |
| wasm-tools                  | 1.255.0 | Validación y extracción de WIT; verificado por checksum en CI                                     |
| jco                         | 1.26.1  | `--instantiation async --no-nodejs-compat --strict`                                               |
| WASI                        | 0.2.12  | Las compilaciones con TinyGo enlazan 0.2.0 en su lugar                                            |
| Deno                        | 2.9.4   | Runtime exacto de toda la evidencia publicada                                                     |

El piso del lenguaje y el compilador de compilación resuelven problemas distintos: los consumidores
obtienen el contrato de compatibilidad Go 1.26.0, los releases obtienen las correcciones de la línea
de parches soportada. Un salto de parche no mueve el piso; moverlo requiere un ADR.

> El piso pasó de 1.25.0 a 1.26.0 cuando forge-go subió la directiva `go` en los 14 módulos. El ADR
> que ese movimiento requiere aún no se ha escrito, y no se añadió directiva `toolchain` que fije la
> línea de parches en `go.mod`. El resultado de govulncheck para 1.26.7 no se ha vuelto a medir.

## Requisitos de ejecución

- **Deno 2.x.** No se usa capa de compatibilidad con Node; `--no-nodejs-compat` mantiene el paquete
  npm `@bytecodealliance/preview2-shim` completamente fuera del grafo de dependencias.
- **El runtime en sí no requiere permisos.** Importar o construir `GoforgeWasmRuntime` no hace E/S.
  Leer el bundle necesita lo que necesite tu `WasmArtifactReader` inyectado — `--allow-read` para el
  lector de archivos.
- **El bundle de release no está en el paquete JSR.** Se distribuye aparte y se localiza mediante el
  lector inyectado, con `GOFORGE_COMPONENT_BUNDLE` sobrescribiendo la ruta por defecto al
  repositorio hermano.

## Representación de la API

Las **891** APIs públicas de Go catalogadas están representadas: **298 (33,4 %)** por una
coincidencia nativa a nivel de nombre, y las **588** restantes por una excepción documentada con
ruta de migración.

Esto es **cobertura de representación, no una afirmación de paridad semántica**. La paridad
semántica solo está probada donde existen vectores compartidos — actualmente las ocho operaciones
portables, verificadas byte a byte entre Go nativo, Go en WebAssembly y el adaptador nativo de Deno.

Clases de portabilidad WASM: A=140, B=171, C=75, D=331, E=174.

## Reglas de compatibilidad hacia atrás

- Las APIs públicas, **incluidos los nombres Go heredados mal escritos**, no se eliminan ni
  renombran sin evidencia de consumidores y una ruta de migración. La corrección de nombres va a los
  contratos ABI generados y versionados en lugar de romper el código Go.
- Las deprecaciones se publican con el reemplazo disponible en el mismo release.
- El **orden** del catálogo de errores es contractual, no solo su contenido: el manifiesto del guest
  se compara posición por posición.

## Detección de deriva

Cuatro puertas fallan ruidosamente en vez de dejar que los dos repositorios diverjan en silencio:

| Puerta                                       | Detecta                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `deno task contract:check`                   | El contrato TypeScript generado está obsoleto frente al bundle de forge-go |
| `generated_contract_test.ts`                 | La superficie pública escrita a mano no concuerda con la generada          |
| `vectors_test.ts`                            | Los vectores compartidos copiados difieren de la copia de forge-go         |
| `deno task inventory:check` / `matrix:check` | El inventario de API pública o la matriz de cobertura están obsoletos      |

Las cuatro corren en CI. El contrato generado se regenera, nunca se edita a mano.

**Estado actual — dos de las cuatro no están verificando nada:**

| Puerta                             | Estado                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vectors_test.ts`                  | **Viva.** Compara contra `forge-go-private/share/portable/testdata/vectors/v1.json`                                                              |
| `generated_contract_test.ts`       | **Viva.**                                                                                                                                        |
| `contract:check`                   | **No-op** hasta que se ejecute `share/component/scripts/build.sh` — `share/component/artifacts/` es salida de build ignorada por git y no existe |
| `inventory:check` / `matrix:check` | **Rota.** Sus entradas `go-api-inventory.json` / `deno-api-inventory.json` fueron borradas de los `openspec/` de ambos repos                     |

Restaurar las dos últimas requiere regenerar la evidencia (o retirar las tareas), no un arreglo de
rutas.

## Pisos de cobertura

- **forge-go:** sin regresión por módulo respecto de la línea base de la Fase 0 — raíz 91,0 %,
  logger 94,8 %, encrypt 89,7 %, security 91,8 %, qgo 87,6 %, go-openssl 83,9 %, portable 92,2 %. Lo
  aplica `scripts/check-coverage.sh`.
- **forge-deno:** ≥80 % global, aplicado por `deno task cov:check` sobre un perfil nuevo.

## Relacionado

- [Arquitectura](./architecture.es.md) · [Migración](./migration.es.md) ·
  [Seguridad](./security.es.md)

Consulta [compatibility.md](./compatibility.md) para la versión en inglés.
