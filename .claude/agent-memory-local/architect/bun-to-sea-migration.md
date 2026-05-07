---
name: Binary build migrated from Bun to Node.js SEA
description: Bun standalone executables segfault on Windows 11 (null pointer at 0xD9C in v1.3.13). Migrated to Node.js SEA with postject injection. Node 24 SEA is CJS-only, no cross-compilation, requires matrix runners in CI.
type: project
---

Bun `build --compile` produces binaries that segfault on Windows 11 (Bun v1.3.13, null pointer dereference at 0xD9C). The `--bytecode` removal (commit 49f1ca7) did not fix it — different crash, same root cause in Bun's standalone executable loader.

**Why:** Bun SEA runtime has an unresolved bug on Windows. Node.js SEA is the official approach and works reliably on all platforms.

**How to apply:**
- Binary builds now use Node.js SEA (tsup CJS bundle → `--experimental-sea-config` → postject injection)
- Node 24 SEA is **CJS-only** — no ESM support (that's Node 26+)
- No cross-compilation — GitHub Actions uses matrix runners (ubuntu, ubuntu-arm, macos-latest, macos-13, windows-latest) + Alpine container for musl
- Bitbucket Pipelines only builds linux-x64 (only Linux runners available)
- `postject` is in devDependencies for reliable CI
- Brand constants (CLI_NAME, NPM_DEFAULT_FIXER) baked via tsup `define` at bundle time
- googleapis/google-auth-library stay external (optional, dynamic import with try/catch)
