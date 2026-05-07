---
name: Binary build migrated from Bun to Node.js SEA
description: Bun standalone executables segfault on Windows 11. Migrated to Node.js SEA with postject injection. Node 26 SEA is still CJS-only (ESM SEA not stable as of 26.1), no cross-compilation, requires matrix runners in CI.
type: project
---

Bun `build --compile` produces binaries that segfault on Windows 11 (Bun v1.3.13, null pointer dereference at 0xD9C). The `--bytecode` removal (commit 49f1ca7) did not fix it — different crash, same root cause in Bun's standalone executable loader.

**Why:** Bun SEA runtime has an unresolved bug on Windows. Node.js SEA is the official approach and works reliably on all platforms.

**How to apply:**
- Binary builds now use Node.js SEA (tsup CJS bundle → `--experimental-sea-config` → postject injection)
- Project migrated to **Node 26** (2026-05-07). SEA is still **CJS-only** — ESM SEA not stable as of Node 26.1. Re-evaluate on Node 26.2+.
- `@types/node` stays at `^24.0.0` — no `@types/node@26` published yet (latest 25.6.0 as of 2026-05-07). Bump when available.
- No cross-compilation — GitHub Actions uses matrix runners (ubuntu, ubuntu-arm, macos-latest, windows-latest) + Alpine container (node:26-alpine) for musl
- Bitbucket Pipelines only builds linux-x64 (only Linux runners available)
- `postject` is in devDependencies for reliable CI
- Brand constants (CLI_NAME, NPM_DEFAULT_FIXER) baked via tsup `define` at bundle time
- googleapis/google-auth-library stay external (optional, dynamic import with try/catch)
