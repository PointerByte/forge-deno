# Prueba de concepto del host WASIp2 para Deno

Estado: aprobada el 2026-08-01 con Deno exacto `2.9.4` y jco `1.26.1`.

El host transpila el componente TinyGo a JavaScript y módulos WebAssembly core mediante la
instanciación personalizada asíncrona de jco. Deno no carga directamente un binario del Modelo de
Componentes con `WebAssembly.instantiate`; jco implementa las conversiones ABI.

Las decisiones relacionadas están en
[component-host-options.md](../../openspec/changes/tinygo-wasip2-goforge-integration/research/component-host-options.md),
[typescript-bindings.md](../../openspec/changes/tinygo-wasip2-goforge-integration/research/typescript-bindings.md)
y
[permission-model.md](../../openspec/changes/tinygo-wasip2-goforge-integration/research/permission-model.md).

## Reproducción

```bash
./scripts/transpile.sh
./scripts/test.sh
DENO_DIR=/tmp/goforge-wasip2-deno-cache deno task bench
```

La transpilación fija `npm:@bytecodealliance/jco@1.26.1`, `--instantiation async`,
`--no-nodejs-compat` y `--strict`. `deno.lock` versión 5 conserva integridad npm para jco y para
preview2-shim `0.19.0`, usado solo por la comparación de Go estándar.

Resultado esperado:

```text
running 4 tests from ./host_test.ts
Deno invokes every canonical ABI shape and the host import ... ok
concurrent startup and calls are isolated ... ok
incompatible component version is rejected before instantiation ... ok
component, glue, and core checksum mismatches are rejected ... ok
ok | 4 passed | 0 failed
```

## Seguridad, permisos y ciclo de vida

Antes de instanciar se verifican el esquema de manifiesto `1`, la versión `0.1.0`, el paquete WIT, y
los SHA-256 del componente fuente, pegamento JavaScript y todos los módulos core. Solo se compilan
bytes ya verificados y se rechaza cualquier módulo no declarado.

El host principal no usa el preview2 shim genérico. `wasi.ts` entrega argumentos y entorno vacíos,
ningún preopen de archivos, streams cerrados, relojes, aleatoriedad criptográfica y la capacidad
explícita `annotate`. No hay interfaces de red en el componente.

La tarea de Deno permite lectura solo del manifiesto, bundle generado y artefacto Go. El código de
jco consulta `JCO_DEBUG`, por lo que se permite únicamente esa variable. No se conceden red,
escritura, subprocesos, FFI, información del sistema ni acceso general al entorno.

`close()` es idempotente, descarta la raíz exportada y las operaciones posteriores lanzan
`ComponentClosedError`. El mundo no exporta recursos; la memoria se libera finalmente mediante GC.

## Evidencia y límites

La ejecución cubrió todos los tipos ABI, ambos errores, la importación del host, 128 llamadas en
cuatro instancias, rechazo de versión y hashes, y cierre limpio.

Una medición orientativa, no un benchmark de producción, produjo:

```json
{
  "runtime": "2.9.4",
  "startupMs": 26.528459,
  "iterations": 10000,
  "invocationTotalMs": 741.3034190000001,
  "averageInvocationUs": 74.1303419,
  "checksum": 50005000
}
```

`deno task standard:smoke` también pasó con Go `1.25.12` y componentize-go `0.4.0`, que importan
WASI `0.2.12`. Ese smoke usa preview2-shim y `-A`; no es la política de permisos elegida.

- jco y su modo de instanciación siguen siendo experimentales.
- Las declaraciones generadas conservan claves versionadas, pero el runtime usa claves sin versión;
  `host.ts` aísla esta discrepancia.
- Las llamadas son síncronas después de instanciar; cuatro instancias no prueban reentrada.
- Cancelación, timeouts, workers, recursos y async WIT requieren PoCs separados.
- Producción debe firmar y distribuir componente y transpilado como bundle inmutable; queda una
  ventana TOCTOU local pequeña.
- `generated/` y `standard-generated/` se regeneran y están ignorados.

Las salidas desechables son `generated/` y `standard-generated/`; la caché está en
`/tmp/goforge-wasip2-deno-cache`.
