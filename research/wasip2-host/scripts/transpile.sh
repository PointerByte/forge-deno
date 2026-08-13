#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace=$(cd "${root}/../../.." && pwd)
component="${workspace}/forge-go-private/research/tinygo-wasip2/artifacts/goforge-poc.component.wasm"
standard_component="${workspace}/forge-go-private/research/go-component/artifacts/goforge-standard.component.wasm"
deno_cache="${TMPDIR:-/tmp}/goforge-wasip2-deno-cache"

test "$(deno --version | head -n 1)" = "deno 2.9.4 (stable, release, x86_64-unknown-linux-gnu)"
mkdir -p "${deno_cache}" "${root}/generated"
find "${root}/generated" -mindepth 1 -delete

DENO_DIR="${deno_cache}" deno run -A npm:@bytecodealliance/jco@1.26.1 \
  transpile "${component}" \
  --out-dir "${root}/generated" \
  --name goforge-poc \
  --instantiation async \
  --no-nodejs-compat \
  --strict

test "$(DENO_DIR="${deno_cache}" deno run -A npm:@bytecodealliance/jco@1.26.1 --version)" = "1.26.1"
sha256sum "${component}" "${root}"/generated/*.wasm

if [[ -f "${standard_component}" ]]; then
  mkdir -p "${root}/standard-generated"
  find "${root}/standard-generated" -mindepth 1 -delete
  DENO_DIR="${deno_cache}" deno run -A npm:@bytecodealliance/jco@1.26.1 \
    transpile "${standard_component}" \
    --out-dir "${root}/standard-generated" \
    --name goforge-standard \
    --instantiation async \
    --no-nodejs-compat \
    --strict
  sha256sum "${standard_component}" "${root}"/standard-generated/*.wasm
fi
