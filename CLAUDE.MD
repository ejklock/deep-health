# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Identity

**Package name:** `security-scan`
**CLI binary:** `security-scan` (whitelabel-able via `CLI_NAME` env var)
**Language:** TypeScript (ESM, Node >= 26), built with `tsup`
**Test framework:** Vitest
**Domain vocabulary:** see `CONTEXT.md` for canonical terms (Pipeline, Ecosystem, Runtime, Scanner, etc.)

Security-focused CLI that scans PHP (Composer), Node.js (npm), and Python (pip) projects for known CVEs via OSV Scanner, applies safe patch/minor updates automatically inside Docker containers, and generates an executive HTML report.

---

## Commands

```bash
# Development
npm run dev -- <command> [args]     # Run CLI in dev mode via tsx (e.g. npm run dev -- scan --help)
npm run build                       # Build library + CLI binary to dist/
npm run build:sea                   # Build SEA (Single Executable Application) bundle to dist-sea/
npm run typecheck                   # TypeScript type check (tsc --noEmit)

# Tests
npm test                            # Unit + integration tests (dot reporter, silent)
npm run test:unit                   # Unit tests only
npm run test:integration            # Integration tests only
npm run test:smoke                  # Smoke tests (requires Docker running)
npm run test:coverage               # All tests with v8 coverage
npm run test:watch                  # Watch mode

# Run a single test file
npx vitest run tests/unit/path/to/file.test.ts

# Run tests matching a pattern
npx vitest run -t "pattern" tests/unit
```

---

## Source Architecture

```
src/
  app/           CLI commands (init, scan, fix, executive-report, cloud-setup) and I/O
  core/          Pure domain logic — no I/O, no Docker
    gates/       Zod gate validators (Gate A, Ecosystem Gate)
    policy/      safe-update classification (auto_safe | breaking | manual)
    types/       Shared TypeScript interfaces + Result<T, E> discriminated union
  infrastructure/
    brand.ts     Whitelabel constants (CLI_NAME, kill switch var, default paths)
    config/      YAML loader + Zod schema + config generator
    ecosystem-runtime/  Docker container lifecycle (image resolution, run modes, project image build)
    executor/    CommandRunner wrappers per ecosystem
    provisioner/ Docker container runners with retry
    storage/     Local + Google Drive report storage
    utils/       Logger, git, docker-platform, shutdown hooks
  modules/
    advisor/     Informational advisor runner (never blocks pipeline)
    ecosystem/   Plugin system: registry + per-ecosystem plugins (npm, composer, pip)
      fixers/    npm-audit-fixer, osv-fixer, osv-then-audit-fixer
      utils/     updater-lifecycle, updater-transaction, environment-probe, validation-runner
    scanner/     Scanner engine system: OSV (primary) + SonarQube (secondary)
  orchestration/ Pipeline coordinator: orchestrator, run-ecosystem-fix, osv-fix-applier, dry-run-preview
  reporting/     HTML report generation (Handlebars + i18n: en, pt-br)
```

---

## Key Design Patterns

### Registry Pattern
Ecosystem plugins and scanner engines are registered at startup via side-effects in `modules/ecosystem/index.ts` and `modules/scanner/index.ts`. The orchestrator iterates `registry.getAll()` — never hard-codes ecosystem names.

**To add a new ecosystem:** implement `EcosystemPlugin` from `modules/ecosystem/types.ts`, register it in `modules/ecosystem/index.ts`. No orchestrator changes needed.

### Gate Pattern (Zod validation between phases)
Every phase output is validated against a Zod schema before the next phase runs. `GateValidationError` on failure.
- **Gate A** — validates `ScanResultJson` from OSV
- **Ecosystem gates** — validates `UpdateResultJson` from each plugin (`validations` must be non-empty)

`core/gates/validator.ts` owns all gate schemas. Never bypass gates in tests — inject clean fixture data instead.

### Container-First Runner Strategy
Runtime image resolution precedence: explicit config override > `language_version` config > `plugin.inferVersion(cwd)` > built-in fallback.

Run modes: `direct-exec` (npm) vs `shell-wrap` with optional preamble (pip, composer).

### Updater Transaction
`beginUpdaterTransaction()` encapsulates the full lifecycle: backup snapshot at begin, success path (`tx.success()`), revert path (`tx.abortWithError()` — restore > bootstrap > restore-byte-identical > warn-only dirty-tree check).

### Updater Lifecycle
`runUpdaterLifecycle<T>()` generic skeleton: probe > dry-run gate > begin transaction > apply fix > pre-validation > run validations > partial-revert loop > success/abort > PhaseError wrap. Each updater provides an `UpdaterRecipe<TFixerResult>` with typed hooks.

### Result<T, E>
Canonical discriminated union in `core/types/result.ts`. Constructors: `ok(value)`, `err(error)`. Helpers: `isOk`, `isErr`, `map`, `flatMap`, `match`, `fromPromise`, `tryCatch`, `unwrap`, `unwrapOr`.

### Whitelabel / Brand System
All user-visible names derive from `CLI_NAME` in `src/infrastructure/brand.ts`. For SEA builds, `tsup.config.ts` bakes the value via esbuild `define`. Never hardcode `'security-scan'` in user-facing strings — use the brand constants.

---

## Important Invariants

- **OSV is always primary.** Gate A reads from the OSV engine result, regardless of registration order.
- **SonarQube is always secondary** (`on_failure: warn` by default). It never blocks the pipeline.
- **Kill switch:** `SECURITY_SCAN_NO_AUTO_FIX` env var skips all automated fixes after scan.
- **`preRunSnapshots`** are taken at orchestrator startup (before mutations) for dirty-tree detection. Do not take snapshots inside plugins.
- **Advisors never block the pipeline.** Their errors are swallowed.
- **`validations` array must never be empty** — gate schema enforces `min(1)`. Emit a `skipped` entry when tests are not run.

---

## Test Conventions

- Tests live in `tests/unit/` mirroring `src/`. Pattern: `<module>.test.ts` for happy-path, `<module>-branches.test.ts` for error/edge branches.
- Integration tests in `tests/integration/`, smoke tests in `tests/smoke/` (require Docker).
- Setup file `tests/helpers/silence-logger.ts` silences logger output in unit/integration tests.
- Smoke tests run sequentially (single fork) with 120s test timeout and Docker cleanup via `tests/helpers/docker-cleanup.ts`.
- Coverage thresholds: statements 100%, functions 100%, lines 100%, branches 88%.
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`.
- Path-based invocation for targeting: `vitest run tests/<dir>` (inline projects do NOT support `--project` CLI filtering in vitest 2.x).

---

## Conventions

- Path aliases: `@app/`, `@core/`, `@infra/`, `@modules/`, `@orchestration/`, `@reporting/` (defined in `tsconfig.json`)
- Prettier: single quotes enabled (`.prettierrc`)
- No comments in code unless the WHY is non-obvious. Gate schemas and policy rules are the exception.
- Exit codes: `0` clean, `1` vulns/errors, `2` gate/scanner failure, `3` config error
- ESM only (`"type": "module"` in package.json). SEA build uses CJS (Node.js SEA constraint).
- `googleapis` and `google-auth-library` are external/optional — loaded via dynamic import with try/catch.

---

## CI / Build

- **Bitbucket Pipelines** (`bitbucket-pipelines.yml`): tag-triggered pipeline — typecheck > test:unit + test:integration > build > build SEA binary (linux-x64) > publish to Bitbucket Downloads.
- **GitHub Actions** (`release.yml`): multi-platform SEA builds (linux-x64, arm64, macOS, Windows).
- SEA binaries support whitelabel via `CLI_NAME` and `NPM_DEFAULT_FIXER` env vars at build time.
- Docker dev environment via `compose.yml` — mounts source + Docker socket for ephemeral container spawning.
