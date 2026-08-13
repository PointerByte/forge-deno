import { GoforgeComponentHost, loadManifest } from "./host.ts";

const manifest = await loadManifest();
const started = performance.now();
const host = await GoforgeComponentHost.load(manifest);
const loaded = performance.now();

const iterations = 10_000;
let checksum = 0;
for (let index = 0; index < iterations; index++) {
  checksum += host.operations.add(index, 1);
}
const finished = performance.now();
host.close();

console.log(JSON.stringify({
  runtime: Deno.version.deno,
  startupMs: loaded - started,
  iterations,
  invocationTotalMs: finished - loaded,
  averageInvocationUs: ((finished - loaded) * 1_000) / iterations,
  checksum,
}));
