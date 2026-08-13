#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
deno_cache="${TMPDIR:-/tmp}/goforge-wasip2-deno-cache"

(
  cd "${root}"
  DENO_DIR="${deno_cache}" deno task check
  DENO_DIR="${deno_cache}" deno task test
)
