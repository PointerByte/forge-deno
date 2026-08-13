# Seguridad

El modelo de amenazas de la integración con GoForge: qué se defiende, cómo y — sobre todo — qué no.

## Qué asume el diseño

- **El bundle de release puede ser manipulado en tránsito o en reposo.** Defendido.
- **El guest puede tener errores o ser hostil.** Defendido mediante denegación de capacidades.
- **El proceso host es confiable.** No defendido — si un atacante ejecuta código en tu proceso Deno,
  la cadena de integridad y la frontera de capacidades quedan sin efecto.
- **Se confía en que los callers elijan su target de ejecución.** No defendido; ver "Enrutamiento
  explícito".

## Integridad: nada sin verificar se ejecuta

La cadena se ancla en un digest que **tú** aportas fuera de banda:

1. `manifestSha256` se comprueba contra los bytes crudos de `manifest.json` _antes_ de analizar el
   JSON, así que un manifiesto malformado u hostil nunca llega al parser.
2. El manifiesto verificado fija digests SHA-256 del componente, del glue del host y de cada módulo
   core.
3. Cada artefacto se verifica contra su digest fijado.
4. La factoría entonces ejecuta **solo esos bytes verificados**: el glue se importa desde un blob en
   memoria construido con `bundle.glueBytes`, y los módulos core se compilan desde
   `bundle.coreModuleBytes`.

El paso 4 es el que cierra la ventana entre comprobación y uso. Nada se vuelve a leer del disco tras
la verificación, así que sustituir un archivo entre el chequeo de digest y la instanciación no
funciona.

Las rutas del manifiesto deben ser relativas al paquete, sin traversal, URL, query, fragmentos,
segmentos codificados ni duplicados.

**Nota operativa:** el digest del componente es reproducible desde un árbol idéntico pero _no_ es
estable ante ediciones no relacionadas en otras partes del módulo `component`. Editar un paquete que
el guest demostrablemente no enlaza igual cambia el artefacto. Fija los digests a un commit exacto.

## Mínima autoridad: el guest no recibe casi nada

El núcleo portable no hace E/S, así que `createDeniedWasiImports()` proporciona las dieciocho
interfaces WASI importadas en su forma denegada:

| Grupo de interfaces          | Concedido                                  |
| ---------------------------- | ------------------------------------------ |
| `wasi:clocks/*`              | **Sí** — el planificador de Go lo necesita |
| `wasi:random/random`         | **Sí** — CSPRNG del host                   |
| `wasi:filesystem/*`          | No — todos los puntos de entrada se niegan |
| `wasi:io/*`, `wasi:cli/std*` | No — flujos cerrados                       |
| `wasi:cli/terminal-*`        | No — sin terminal asociada                 |
| `wasi:cli/environment`       | No — argumentos y entorno vacíos           |

Cada denegación está fijada por una prueba. `WasmCapabilityDeniedError` informa cualquier intento de
exceder la frontera.

Pasar tus propias `wasiImports` está soportado y es una **decisión de seguridad**. Reemplazar un
stub denegado otorga al guest autoridad que el contrato portable nunca pide; un guest que necesita
el sistema de archivos no es un núcleo portable.

## Controles de ejecución que fallan cerrado

Los deadlines y la cancelación no son consultivos. Cruzan la frontera WIT como un registro explícito
cuyas banderas `clock-checked` y `cancellation-checked` indican si el host realmente aportó el
control. Un guest al que se le pide respetar un deadline sin reloj comprobado se niega en lugar de
continuar a ciegas.

`control.deadline` y `control.cancellation` se declaran como capacidades _del host_ por la misma
razón: el guest no puede satisfacerlas solo, y el contrato lo dice en vez de fingir lo contrario.

## Enrutamiento explícito: sin degradación silenciosa

**Un fallo del componente nunca selecciona un adaptador nativo.** Es la propiedad de seguridad más
importante del runtime, porque las operaciones incluyen criptografía. Un fallback automático
significaría que un fallo transitorio del guest mueve en silencio el manejo de claves a otra
implementación — la forma exacta de un incidente real.

Deben cumplirse tres condiciones independientes antes de que corra un adaptador nativo:

1. El caller lo nombra explícitamente como target de esa invocación.
2. El **manifiesto del release** lo lista bajo `nativeAdapters` para esa operación.
3. El adaptador lleva `parityQualified: true`, obtenible solo reproduciendo byte a byte cada vector
   compartido de GoForge.

Los reintentos están igual de acotados: exigen opt-in, una declaración `retrySafe` en el release, un
error reintentable del catálogo y una entrada coincidente en el allowlist. Nunca se reintentan
traps, salida inválida, fallos de integridad, incompatibilidad, deadlines ni cancelaciones, sin
importar la configuración.

## Los mensajes de error no filtran nada

El catálogo de errores es inmutable y sus mensajes son estables y genéricos. En particular,
`authentication_failed` se devuelve idéntico para una clave incorrecta, un nonce incorrecto, datos
asociados alterados, un ciphertext truncado y un tag falsificado — un intento de falsificación no
aprende nada de la respuesta.

Los eventos del observador llevan solo metadatos de ciclo de vida: nunca payloads, resultados,
mensajes del guest, campos de error ni secretos.

## Cadena de suministro

Verificado en la auditoría de la Fase 0 y aplicado en CI:

- `govulncheck` en cada módulo Go; análisis estático con `gosec`; `gitleaks` sobre todo el historial
  y el árbol de trabajo.
- `deno audit` para el grafo de dependencias de Deno.
- Cada GitHub Action está fijada por SHA; `wasm-tools` se verifica por checksum tras extraerlo.
- Se probó firmar/verificar/manipular con Cosign y el rollback offline por digest en un PoC.

**Deliberadamente ausentes:** empaquetado de release, firma y publicación de procedencia. Atestiguar
el bundle actual pondría una firma sobre un artefacto que falla de forma intermitente bajo carga
sostenida. Esas puertas se agregan cuando ese defecto se cierre — no antes. Está declarado en ambos
workflows de CI.

## Debilidades conocidas

- **El componente publicado no es apto para carga sostenida de producción.** Falla de forma
  intermitente durante la recolección de basura. Es un defecto de disponibilidad, no de
  confidencialidad, pero un componente criptográfico que se cae sigue siendo un problema. Ver
  [solución de problemas](./troubleshooting.es.md).
- **`GOGC=off` nunca debe usarse en producción.** Elimina el fallo desactivando la recolección y lo
  sustituye por crecimiento ilimitado de memoria.
- **Las garantías del adaptador nativo son tan fuertes como los vectores compartidos.** La
  calificación prueba la coincidencia en los casos que GoForge publicó más los casos frontera de la
  suite diferencial. Es evidencia fuerte, no una prueba de equivalencia total.

## Relacionado

- [Arquitectura](./architecture.es.md) · [Compatibilidad](./compatibility.es.md) ·
  [Solución de problemas](./troubleshooting.es.md)

Consulta [security.md](./security.md) para la versión en inglés.
