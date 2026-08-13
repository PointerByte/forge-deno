# forge-deno API Inventory

`api_inventory.ts` runs the exact local Deno parser over every entry in `deno.json#exports` and
normalizes its JSON documentation graph into deterministic JSON and Markdown catalogs.

From the repository root:

```bash
SOURCE_DATE_EPOCH=1785628800 deno run -A tools/api_inventory.ts \
  --json openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/deno-api-inventory.json \
  --markdown openspec/changes/tinygo-wasip2-goforge-integration/research/evidence/deno-api-inventory.md
```

The command needs read access to source/configuration, permission to execute the current Deno
binary, and write access to the requested artifacts. It does not need network access. The catalog
records each export specifier separately, so the root namespace and focused entrypoints remain
auditable even when they intentionally expose the same logical symbol.
