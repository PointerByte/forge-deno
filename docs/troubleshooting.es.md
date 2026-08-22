# Solución de problemas

Fallos concretos de la integración con forge-go, qué los causa realmente y qué hacer.

Todo fallo del runtime es una subclase de `WasmRuntimeError`, así que la clase te dice qué capa
falló antes de leer el mensaje.

## `RangeError: Maximum call stack size exceeded` bajo carga sostenida

**Causa:** un defecto conocido del componente publicado, no de tu código. El runtime de Go que lleva
dentro falla de forma intermitente durante la recolección de basura al llamar al reloj de WASI. La
pila del guest muestra
`runtime.morestack → runtime.badmorestackg0 → runtime.switchToCrashStack → runtime.usleep`. Bajo
wasmtime el mismo defecto aparece como un fallo en `clock_time_get`.

Es **intermitente** — se observaron umbrales entre 1.166 y 17.532 despachos en procesos en frío por
lo demás idénticos — así que una corrida exitosa no prueba nada.

**Qué hacer:** enruta el trabajo sostenido o sensible a la latencia por el adaptador nativo:

```ts
await runtime.invoke(operation, payload, {
  target: { kind: "native", adapter: GOFORGE_NATIVE_ADAPTER_NAME },
});
```

**Qué no hacer:** poner `GOGC=off`. Elimina el fallo desactivando la recolección por completo y lo
cambia por un crecimiento ilimitado de memoria del guest. Es solo un ajuste de diagnóstico.

**Estado:** aislado al compilador componentize-go. Una compilación con TinyGo del mismo código de
guest sobrevive la misma carga con 0/10 fallos y paridad total de vectores; el cambio del compilador
de producción está propuesto pero aún no aprobado. Ver
`forge-go-private/research/component-tinygo/`.

## `WasmIntegrityError`

**Causa:** un digest no coincidió. O `manifest.json` no genera el `manifestSha256` que aportaste, o
un artefacto no coincide con el digest que el manifiesto fija para él.

**Revisa, en este orden:**

1. ¿Recompilaste el componente? El digest cambia. Ojo: **no** es estable ante ediciones no
   relacionadas en otras partes del módulo `component` — editar un paquete que el guest
   demostrablemente no enlaza igual cambia el artefacto. Fija los digests a un commit exacto, no a
   "solo toqué una prueba".
2. ¿`manifestSha256` es el digest del _archivo_ de manifiesto, no del componente?
3. ¿El bundle se transfirió íntegro? Compara contra `artifacts/SHA256SUMS`.

Este error está haciendo su trabajo. No lo esquives releyendo el digest del bundle que estás
verificando — eso no verifica nada.

## `WasmCompatibilityError`

**Causa:** el bundle cargó bien pero no coincide con lo que declaraste. O `componentVersion` o
`witPackage` no concuerdan, o invocaste una operación que el manifiesto no declara.

**Revisa:** el `compatibility` de tus opciones de runtime contra `manifest.json`. Para una operación
desconocida, confirma que sea una de las ocho canónicas — `text.normalize`, `text.validate`,
`crypto.sha256`, `crypto.hmac-sha256`, `crypto.aes-gcm.encrypt`, `crypto.aes-gcm.decrypt`,
`encoding.base64.encode`, `encoding.base64.decode`.

## `WasmCapabilityDeniedError`

**Causa:** el guest intentó usar una capacidad WASI que el host retiene — archivos, flujos,
terminal, entorno o argumentos.

**No es un fallo que haya que rodear.** El núcleo portable no hace E/S; solo se conceden los relojes
y el CSPRNG. Una denegación significa o que el componente no es el que crees, o que se agregó al
guest algo que no corresponde a un núcleo portable. Investiga antes de ampliar `wasiImports`;
ampliarlo otorga autoridad que el contrato nunca pide.

## `WasmGuestError` con `invalid_base64`

**Causa:** la ABI exige Base64 **canónico, con padding y alfabeto estándar** (RFC 4648). Se
rechazan: valores sin padding, el alfabeto URL-safe (`-` y `_`) y bits finales no canónicos — `QR==`
decodifica al mismo byte que `QQ==` pero no es canónico, y tanto el núcleo Go como el adaptador
nativo vuelven a codificar y comparar precisamente para detectarlo.

**Arreglo:** usa `encodeAbiBase64` / `decodeAbiBase64` en vez de `btoa` o un codificador propio.

## `WasmGuestError` con `unknown_field` o `invalid_request`

**Causa:** la decodificación del payload es estricta. `unknown_field` significa que enviaste una
clave que la operación no declara; `invalid_request` con un `field` significa que falta una clave
obligatoria o es `null`.

El `field` del error nombra la ruta exacta (`payload.data`, `payload.rules`). Úsalo — el mensaje es
deliberadamente genérico y estable.

## `WasmGuestError` con `invalid_key` o `invalid_nonce`

**Causa:** los tamaños de clave y nonce se exigen, no se ajustan. Las claves HMAC deben tener al
menos 16 bytes. Las claves AES-GCM deben tener exactamente 16, 24 o 32 bytes y los nonces
exactamente 12.

## `WasmGuestError` con `authentication_failed`

**Causa:** falló el descifrado AES-GCM. Deliberadamente, el error no dice por qué — ciphertext, tag,
nonce y datos asociados producen el mismo fallo, así que un intento de falsificación no aprende
nada.

**Revisa:** que los datos asociados coincidan con los usados al cifrar. Un AAD cambiado es la causa
más común y se ve idéntico a una manipulación.

## `WasmDeadlineExceededError` / `WasmCancelledError`

**Causa:** venció el deadline o abortó la señal del caller. Nunca se reintentan, aunque pongas
`deadline_exceeded` o `cancellation_requested` en el allowlist de reintentos — reintentar algo que
el caller canceló está mal sin importar la configuración.

## `WasmPoolError`

**Causa:** todas las instancias del pool están ocupadas y se abandonó la espera.

**Revisa:** sube `poolSize`, o reconsidera si el componente es la ruta adecuada para este volumen de
llamadas. Un despacho por componente cuesta ~200–600 µs; el throughput sostenido pertenece al
adaptador nativo.

## No se encuentra el bundle / los arneses imprimen `SKIP`

**Causa:** el bundle de release se distribuye aparte del paquete JSR y se localiza mediante el
`WasmArtifactReader` inyectado.

**Arreglo:** constrúyelo, o apunta a él explícitamente:

```bash
cd forge-go-private/component && ./scripts/build.sh
export GOFORGE_COMPONENT_BUNDLE=/ruta/absoluta/a/component/artifacts/
```

Las pruebas y los arneses hacen skip en lugar de fallar cuando no está, para que un checkout
independiente siga siendo usable.

## Falla `deno task contract:check`

**Causa:** `wasm/generated/goforge-contract.ts` quedó obsoleto respecto del bundle de release de
forge-go — llegó un cambio de contrato aguas arriba.

**Arreglo:** `deno task contract` y luego ejecuta la suite. `generated_contract_test.ts` nombrará la
deriva exacta si la superficie escrita a mano en `contracts.ts` / `codec.ts` también necesita
actualizarse. No edites el archivo generado; se regenera desde el manifiesto.

## Falla la prueba de deriva de los vectores copiados

**Causa:** `wasm/testdata/vectors/v1.json` ya no coincide con la copia de forge-go. forge-go es el
dueño de esos bytes.

**Arreglo:** vuelve a copiar desde `forge-go-private/share/portable/testdata/vectors/v1.json`. Ten
en cuenta que `wasm/testdata` está excluido de `deno fmt` a propósito — si el formateo cambió el
archivo, restáuralo en vez de aceptar el reformateo.

Consulta [troubleshooting.md](./troubleshooting.md) para la versión en inglés.
