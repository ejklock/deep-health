## Memory

You have persistent memory via agent-memory-store MCP tools.

**Before acting on any task:**

1. `search_context` with 2–3 queries related to the task. Check for prior decisions, conventions, and relevant outputs.
2. `get_state("project_tags")` to load the tag vocabulary. If empty, this is a new project — ask the user about stack, conventions, and structure, then persist them with `write_context` and `set_state`.

**After completing work:**

1. `write_context` to persist decisions (with rationale), outputs (with file paths), and discoveries (with impact).
2. Use short, lowercase tags consistent with the vocabulary: `auth`, `config`, `decision`, `output`, `discovery`.
3. Set `importance: "critical"` for decisions other agents depend on, `"high"` for outputs, `"medium"` for background context.

**Before every write:**

1. `search_context` for the same topic first. If a chunk exists, `delete_context` it, then write the updated version. One chunk per topic.

**Rules:**

- Never guess a fact that might be in memory — search first, it costs <10ms.
- Never store secrets — write references to where they live, not the values.
- `set_state` is for mutable values (current phase, counters). `write_context` is for searchable knowledge (decisions, outputs). Don't mix them.
- Use `search_mode: "semantic"` when exact terms don't match (e.g., searching "autenticação" when the chunk says "auth").

---

## Project Identity

**Package name:** `deep-health`
**CLI binary:** `deep-health`
**Language:** TypeScript (Node ≥ 22), built with `tsup`
**Test framework:** Vitest

This is a security-focused CLI that scans PHP (Composer), Node.js (npm), and Python (pip) projects for known CVEs via OSV Scanner, applies safe patch/minor updates automatically, and generates an executive HTML report — all without requiring local tool installations beyond Docker.

---

## Source Tree

```
src/
├── app/               # CLI entry points and I/O
│   ├── commands/      # One file per CLI command (fix, scan, init, …)
│   ├── audit-trail.ts # Writes .deep-health-audit.json after each fix run
│   ├── output-writer.ts
│   ├── report-saver.ts
│   └── run-context.ts # Shared RunContext (config + runner) passed to commands
│
├── core/              # Pure domain logic — no I/O, no Docker
│   ├── errors.ts      # GateValidationError and typed errors
│   ├── gates/
│   │   └── validator.ts   # validateGateA, validateEcosystemGate (Zod schemas)
│   ├── policy/
│   │   └── safe-update.ts # classifyPackage — auto_safe | breaking | manual
│   └── types/         # Shared TypeScript interfaces
│
├── infrastructure/    # I/O, Docker, config — never imported by core/
│   ├── config/        # YAML loader + Zod schema + config generator
│   ├── executor/      # CommandRunner wrappers per ecosystem (npm, pip, composer, osv)
│   ├── provisioner/   # Docker container runners (NpmDockerRunner, etc.)
│   ├── storage/       # Local + Google Drive report storage
│   └── utils/         # Logger, git, docker-platform, shutdown hooks
│
├── modules/
│   ├── advisor/       # Informational advisor runner (never blocks pipeline)
│   ├── ecosystem/     # Plugin system: registry + per-ecosystem plugins
│   │   ├── registry.ts          # EcosystemRegistry (Map-based)
│   │   ├── types.ts             # EcosystemPlugin interface
│   │   ├── index.ts             # defaultRegistry with registered plugins
│   │   ├── plugins/             # npm, composer, pip plugin implementations
│   │   ├── fixers/              # npm-audit-fixer, osv-fixer, osv-then-audit-fixer
│   │   └── utils/               # validation-runner
│   └── scanner/       # Scanner engine system: OSV + SonarQube
│       ├── registry.ts          # ScannerEngineRegistry
│       ├── index.ts             # defaultScannerRegistry + aggregateScanResults
│       ├── osv-engine.ts        # OSV Scanner engine implementation
│       └── sonarqube-engine.ts  # SonarQube engine (secondary, on_failure=warn)
│
├── orchestration/     # Main pipeline coordinator
│   ├── orchestrator.ts          # runOrchestrator() — owns the full fix pipeline
│   ├── osv-fix-applier.ts       # Staging-apply for OSV in-place fixes
│   ├── dry-run-preview.ts       # Dry-run planned-changes log
│   └── lockfile-inspect.ts      # npm lockfileVersion detection
│
├── reporting/         # HTML/Markdown report generation (Handlebars + i18n)
│   ├── executive.ts             # generateExecutiveReport()
│   ├── renderer.ts              # Handlebars render helper
│   ├── sonarqube-export.ts
│   ├── sonarqube-report.ts
│   └── i18n/                    # en + pt-br locale JSONs
│
└── index.ts           # Public API barrel export (used when imported as a library)
```

---

## Key Design Patterns

### 1. Registry Pattern (EcosystemPlugin + ScannerEngine)

Plugins and engines are registered at startup via side-effects in `modules/ecosystem/index.ts` and `modules/scanner/index.ts`. The orchestrator never hard-codes ecosystem names — it iterates `registry.getAll()`.

**To add a new ecosystem:** implement `EcosystemPlugin` from `modules/ecosystem/types.ts`, register it in `modules/ecosystem/index.ts`. No orchestrator changes required.

```
EcosystemPlugin interface
  id, name, lockfiles, osvEcosystems
  buildScanArgs(): string[]
  runUpdater(ctx): Promise<UpdateResultJson>
  runtimeContainer?  ← 'npm-docker' | 'pip-docker' | 'composer-docker'
  osvFixSpec?        ← declarative OSV staging-fix spec
  postUpdateOsvVerify← 'always' | 'osv-strategy-only' | 'never'
  inferVersion?()    ← reads project files to pick Docker image tag
```

### 2. Gate Pattern (Zod validation between phases)

Every phase output is validated against a Zod schema before the next phase runs. If validation fails, a `GateValidationError` is thrown and the pipeline stops.

- **Gate A** — validates `ScanResultJson` from OSV (shape + `status !== 'error'`)
- **Ecosystem gates** — validates `UpdateResultJson` from each plugin (`validations` must be non-empty)

`core/gates/validator.ts` owns all gate schemas. Never bypass gates in tests — inject clean fixture data instead.

### 3. Container-First Runner Strategy

The orchestrator resolves a per-ecosystem `CommandRunner` before calling `plugin.runUpdater()`:

```
runtimeContainer tag  →  Docker runner
'npm-docker'          →  NpmDockerRunner  → NpmContainerCommandRunner
'pip-docker'          →  PipDockerRunner  → PipContainerCommandRunner
'composer-docker'     →  ComposerDockerRunner → ComposerContainerCommandRunner
(none / local mode)   →  base LocalExecutor runner
```

Docker image resolution follows a precedence chain:
1. `scanners.<eco>.image` (explicit config override)
2. `scanners.<eco>.runtime_version` (version → image tag)
3. `plugin.inferVersion(cwd)` (reads `.nvmrc`, `package.json engines`, `composer.json`)
4. Built-in fallback (`node:lts`, `python:3-slim`, `composer:2`)

### 4. Safe-Update Classification

`core/policy/safe-update.ts:classifyPackage()` assigns every vulnerable package one of:

| Class | Condition |
|---|---|
| `auto_safe` | safe version satisfies constraint AND no major bump |
| `breaking` | major version bump required OR constraint violation |
| `manual` | no safe version available OR unparseable semver |

Only `auto_safe` packages are updated automatically. `breaking` requires `--authorize-breaking <id>`.

### 5. Fixer Strategies

Each plugin declares `supportedFixers` and the config can override with `ecosystems[].fixer`:

| Strategy | Description |
|---|---|
| `osv` | OSV Scanner `fix` command mutates the lockfile in-place (via staging copy) |
| `npm-audit` | `npm audit fix` |
| `osv-then-audit` | OSV fix first, then npm audit fix as fallback |

---

## Important Invariants

- **OSV is always primary.** Gate A reads from the OSV engine result, regardless of registration order.
- **SonarQube is always secondary** (`on_failure: warn` by default). It never blocks the pipeline.
- **`DEEP_HEALTH_NO_AUTO_FIX` env var** is a global kill-switch that skips all automated fixes after scan.
- **`preRunSnapshots`** are taken at orchestrator startup (before any mutations) for dirty-tree detection after revert. Do not take snapshots inside plugins.
- **Advisors never block the pipeline.** They run before `runUpdater()` and their errors are swallowed.
- **`validations` array must never be empty** — gate schema enforces `min(1)`. Emit a `skipped` entry when tests are not run.

---

## Conventions

- Path aliases: `@app/`, `@core/`, `@infra/`, `@modules/`, `@orchestration/`, `@reporting/` (defined in `tsconfig.json`)
- Tests live in `tests/unit/` mirroring `src/`. File name pattern: `<module>.test.ts` for happy-path, `<module>-branches.test.ts` for error/edge branches.
- No comments in code unless the WHY is non-obvious. Gate schemas and policy rules are the exception.
- Exit codes: `0` clean, `1` vulns/errors, `2` gate/scanner failure, `3` config error.
