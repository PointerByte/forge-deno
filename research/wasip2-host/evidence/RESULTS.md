# Deno host PoC evidence

Captured on 2026-08-01:

```text
deno 2.9.4 (stable, release, x86_64-unknown-linux-gnu)
v8 15.0.245.2-rusty
typescript 6.0.3
jco 1.26.1
```

Primary TinyGo round trip:

```text
4 passed | 0 failed
all ABI shapes: passed
typed error mapping: passed
host import: passed
128 calls / 4 instances: passed
version rejection: passed
component, glue, and core checksum rejection: passed
idempotent close and post-close rejection: passed
```

Standard-Go comparison:

```text
Go 1.25.12 component round trip: ok
WASI import baseline: 0.2.12
```
