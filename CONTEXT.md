# CONTEXT

Domain vocabulary for `osv-security-cli` (deep-health). Terms here should be used consistently across code, comments, commits, PRs, and architectural discussion.

When a new domain concept stabilizes during design work, add it here. When a term gets sharpened, update the entry rather than creating synonyms.

---

## Pipeline

**Orchestrator** — `runOrchestrator()` in `src/orchestration/orchestrator.ts`. Owns the full `fix` pipeline: scan → Gate A → per-ecosystem fix → Ecosystem Gate → result aggregation.

**Phase** — one of: `scan`, an ecosystem id (`npm`, `pip`, `composer`), or `report`. The `--phases` CLI flag selects a subset.

**Gate A** — Zod-validated schema check on the primary engine's `ScanResultJson`. Failure is fatal.

**Ecosystem Gate** — Zod-validated schema check on a per-ecosystem `UpdateResultJson`. Failure is fatal for that ecosystem.

---

## Ecosystem

**Ecosystem** — a package manager universe: `npm`, `pip`, `composer`. Identified by a canonical id used in the registry, config, and reports.

**Ecosystem Plugin** — implementation of the `EcosystemPlugin` interface (`src/modules/ecosystem/types.ts`), one per supported ecosystem. Carries metadata (lockfiles, OSV ecosystems, label, supported fixers) and behavior (`runUpdater`, `installBreakingPackages`, `inferVersion`).

**Fixer Strategy** — how vulnerabilities are remediated for an ecosystem: `osv`, `npm-audit`, `osv-then-audit`, `composer-update`. Selected via `ecosystems[].fixer` in config or the plugin's first supported fixer as default.

**Updater** — the function each plugin runs (`runNpmUpdater`, `runPipUpdater`, `runComposerUpdater`) that applies the fixer, runs validations, and reverts on failure.

**OSV Fix Spec** — declarative struct on a plugin telling the orchestrator which lockfile `osv-scanner` can patch and which files to back up before patching.

**Post-Update OSV Verify** — policy on a plugin (`always` | `osv-strategy-only` | `never`) controlling residual vulnerability scanning after updates.

**Protected Package** — a package whose version is constrained by project policy. Constraint is a semver range. Vulnerabilities in protected packages whose `safeVersion` does not satisfy the constraint are classified `breaking: protected-constraint` and never installed automatically.

**Auto-Safe / Breaking / Manual** — classification of a vulnerable package's remediation path, computed by `classifyPackage()` in `src/core/policy/safe-update.ts`.

---

## Runtime

**Ecosystem Runtime Container** — the seam through which a plugin's CLI runs in an ephemeral Docker container. Owns image resolution, argv shaping, host vs container routing, retry on transient Docker errors, and streaming. Lives in `src/infrastructure/ecosystem-runtime/`.

**EcosystemRuntimeSpec** — declarative struct on a plugin describing how its CLI runs in a container: default image, image resolver, recognized binaries, run mode.

**Ephemeral Ecosystem Container** — implementation behind the runtime seam. One Docker `run --rm` per command, parameterized by an `EcosystemRuntimeSpec`.

**Run Mode** — tagged enum on the spec controlling how argv composes into `docker run`:
  - `direct-exec` — `docker run <image> <binary> <args...>` (no shell). Used by ecosystems whose CLI tolerates direct exec (npm).
  - `shell-wrap` — `docker run <image> sh -lc "<joined args>"` with optional image-conditional preamble. Used by ecosystems that need shell features or on-the-fly bootstrap (pip, composer).

**Run Mode Preamble** — optional function `(image) => string | undefined` carried by `shell-wrap` run mode. Returns shell commands to inject before the joined command, separated by `&&`. Used by composer to install composer on-the-fly when running on bare `php:*-cli` images.

**Host-Only Command** — `git`, `gh`, `open`. These never enter the ecosystem container and route to the host runner regardless of which ecosystem is active.

**Host Runner** — the `CommandRunner` (typically `LocalExecutor`) that handles host-only commands. Passed into the container command runner; replaces what the legacy code called `fallback`.

---

## Scanner

**Scanner Engine** — implementation of `ScannerEngine` that produces a `ScanResultJson`. `OSV Scanner Engine` is primary; `SonarQube Engine` is secondary.

**Primary Engine** — the engine whose id matches `config.scanners.primary` (default `osv`). Drives Gate A. Failure is fatal.

**Secondary Engine** — any other registered engine. Failures honor `on_failure: 'warn' | 'fail'`.

**Residual Verification** — post-update OSV scan that checks whether vulnerabilities remain. Result is a tagged union: `verified` (all clean), `unverified` (CVEs remain), `skipped` (not run).

---

## Reporting

**Executive Report** — Handlebars-rendered HTML summary saved per run. Driven by `OrchestratorResult` + post-fix scan. Internationalized via `i18n/` (en, pt-br).

**Audit Trail** — JSON record of each run (timestamp, CLI version, dry-run flag, scan, updates, status). Written by `writeAuditTrail()`.

**Cloud Storage** — optional Google Drive upload of generated reports. Local file is always written; Drive upload is additive.

---

## Config & Workflow

**Project Config** — `deep-health.config.json` / `project-config.yml`. Loaded and validated by `src/infrastructure/config/loader.ts`.

**Config Version** — `config_version: '1'`. Future incompatible schema changes bump this.

**Kill Switch** — `DEEP_HEALTH_NO_AUTO_FIX` env var. When set, the orchestrator runs the scan but skips all automated fixes and writes no files.

**Git/PR Workflow** — `--create-branch` + optional `--open-pr` orchestrate a branch creation, fix run, commit, push, and `gh pr create`. Lives in `src/infrastructure/utils/git-commit.ts`.
