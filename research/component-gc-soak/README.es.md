# Arneses de resistencia del componente

La parte en Deno de la investigación sobre la recolección de basura del componente de GoForge. Nada
de esto forma parte del paquete publicado — `deno.json` excluye `research/` de JSR y del piso de
cobertura.

| Arnés                                            | Pregunta que responde                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [`soak.ts`](./soak.ts)                           | ¿El componente de componentize-go que se publica soporta despacho sostenido? |
| [`tinygo_soak.ts`](./tinygo_soak.ts)             | ¿Lo soporta la compilación con TinyGo del mismo mundo?                       |
| [`tinygo_parity.ts`](./tinygo_parity.ts)         | ¿La compilación con TinyGo devuelve resultados byte a byte idénticos?        |
| [`tinygo_throughput.ts`](./tinygo_throughput.ts) | ¿Cuánto cuesta por despacho la compilación con TinyGo?                       |
| [`tinygo_component.ts`](./tinygo_component.ts)   | Cargador compartido del artefacto de comparación TinyGo.                     |

## Por qué son arneses y no pruebas

El fallo de componentize-go es intermitente y su umbral varía mucho entre procesos en frío por lo
demás idénticos. Una aserción que lo esperara fallaría quizá el 30–90 % de las veces según la
sesión, lo que enseña a la gente a ignorar los fallos. La suite se mantiene determinista; el
fenómeno inestable se mide aquí, en muchos procesos en frío, como una tasa.

## Resultados

Misma carga, mismo host, mismo código de guest — solo cambia el compilador:

| Host                    | componentize-go 0.4.0 | TinyGo 0.41.1   |
| ----------------------- | --------------------- | --------------- |
| Deno 2.9.4 + jco 1.26.1 | 9 / 10 fallaron       | 0 / 10 fallaron |
| wasmtime 47.0.3         | 2 / 10 fallaron       | 0 / 10 fallaron |

Los 8 vectores compartidos y el manifiesto ABI canónico son idénticos entre ambas compilaciones.
TinyGo cuesta aproximadamente 2,3–3,5× más por despacho.

El análisis completo, incluido por qué el intercambio sigue valiendo la pena, está en el
[ADR 0012](../../../forge-go-private/openspec/changes/tinygo-wasip2-goforge-integration/adr/0012-tinygo-production-component-compiler.md).

## Cómo ejecutarlos

El arnés de componentize-go necesita el paquete de release de producción; los de TinyGo necesitan
que el artefacto de comparación se haya compilado y transpilado antes:

```bash
cd ../../../forge-go-private/component        && ./scripts/build.sh
cd ../research/component-tinygo              && ./scripts/build.sh && ./scripts/transpile.sh
cd ../../../forge-deno-private

deno run -A research/component-gc-soak/soak.ts --runs=10
deno run -A research/component-gc-soak/tinygo_soak.ts --runs=10
deno run -A research/component-gc-soak/tinygo_parity.ts
deno run -A research/component-gc-soak/tinygo_throughput.ts
```

Cada arnés imprime `SKIP` en lugar de fallar cuando su artefacto no está, de modo que un checkout
independiente sin el repositorio hermano de GoForge sigue siendo usable.

`--gogc=off` difiere la recolección del guest. Elimina el fallo y es solo diagnóstico: cambia el
crash por un crecimiento ilimitado de memoria del guest y nunca debe ser un ajuste de producción.

Consulta [README.md](./README.md) para la versión en inglés.
