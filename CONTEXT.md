# CONTEXT

Domain vocabulary for `osv-security-cli` (deep-health). Terms here should be used consistently across code, comments, commits, PRs, and architectural discussion.

When a new domain concept stabilizes during design work, add it here. When a term gets sharpened, update the entry rather than creating synonyms.

---

## Pipeline

**Orchestrator** — `runOrchestrator()` in `src/orchestration/orchestrator.ts`. Owns the full `fix` pipeline: scan → Gate A → per-ecosystem fix → Ecosystem Gate → result aggregation. After Candidate 2's deepening, the per-ecosystem body is delegated to `runEcosystemFix`; the orchestrator only filters phases, runs advisors, dispatches, and aggregates.

**Per-Ecosystem Fix Flow** — `runEcosystemFix()` in `src/orchestration/run-ecosystem-fix.ts`. Encapsulates the per-plugin sub-pipeline: has-updates gate → effective runner resolution → OSV staging-fix → updater → breaking-install → OSV residual verification → ecosystem gate. Returns a tagged outcome (`skipped` / `success` / `error`) for the orchestrator to aggregate. Throws `GateValidationError` when the ecosystem gate rejects.

**Phase** — one of: `scan`, an ecosystem id (`npm`, `pip`, `composer`), or `report`. The `--phases` CLI flag selects a subset.

**Gate A** — Zod-validated schema check on the primary engine's `ScanResultJson`. Failure is fatal.

**Ecosystem Gate** — Zod-validated schema check on a per-ecosystem `UpdateResultJson`. Failure is fatal for that ecosystem.

---

## Ecosystem

**Ecosystem** — a package manager universe: `npm`, `pip`, `composer`. Identified by a canonical id used in the registry, config, and reports.

**Ecosystem Plugin** — implementation of the `EcosystemPlugin` interface (`src/modules/ecosystem/types.ts`), one per supported ecosystem. Carries metadata (lockfiles, OSV ecosystems, label, supported fixers) and behavior (`runUpdater`, `installBreakingPackages`, `inferVersion`).

**Fixer Strategy** — how vulnerabilities are remediated for an ecosystem: `osv`, `npm-audit`, `osv-then-audit`, `composer-update`. Selected via `ecosystems[].fixer` in config or the plugin's first supported fixer as default. For npm, if the configured strategy is `osv` or `osv-then-audit` and `package-lock.json` has `lockfileVersion: 1` (npm 6 / Node ≤12), `runEcosystemFix` auto-demotes to `npm-audit` at runtime (osv-scanner cannot patch v1 lockfiles in-place).

**Native Deps** — OS-level system packages (e.g. `libvips-dev`, `libpq-dev`) declared under `scanners.<id>.native_deps` in config. `resolveEcosystemRuntime` synthesizes an `apt-get install` preamble from the list and injects it into the run mode before passing the container to the ecosystem CLI. Ensures native npm/pip/composer addons that require system libraries can compile during `npm ci` / `pip install` / `composer install` inside ephemeral containers.

**Updater** — the function each plugin runs (`runNpmUpdater`, `runPipUpdater`, `runComposerUpdater`) that applies the fixer, runs validations, and reverts on failure. The shared revert/result-building skeleton lives in the **Updater Transaction** primitive.

**Updater Transaction** — `beginUpdaterTransaction()` in `src/modules/ecosystem/utils/updater-transaction.ts`. Returns `{ backups, success, abortWithError }`. Each updater opens a transaction (snapshotting backup files or adopting caller-provided backups), then calls `tx.success(...)` on the happy path or `tx.abortWithError({ error, validations, revert })` on failure. The transaction lets revert errors propagate — the swallow-or-throw decision lives in the ecosystem-specific revert helper. Concentrates the duplicated "build error UpdateResultJson + run revert" pattern that previously lived in three places.

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

**Run Mode Preamble** — optional function `(image) => string | undefined` carried by either run mode. Returns shell commands to inject before the main command, separated by `&&`. Used by composer to install composer on-the-fly on bare `php:*-cli` images (`shell-wrap`), and by `resolveEcosystemRuntime` to inject `apt-get install` for OS-level native deps when `native_deps` is configured (`direct-exec`). When both a plugin preamble and a `native_deps` preamble are present they are composed: native deps fire first so the plugin's bootstrap has its dependencies available.

**Host-Only Command** — `git`, `gh`, `open`. These never enter the ecosystem container and route to the host runner regardless of which ecosystem is active.

**Host Runner** — the `CommandRunner` (typically `LocalExecutor`) that handles host-only commands. Passed into the container command runner; replaces what the legacy code called `fallback`.

**Image Source** — config axis (`scanners.<id>.image_source: 'pull' | 'dockerfile'`) that selects how the ecosystem runner image is provisioned. `'pull'` (default) uses the existing registry-image resolution chain. `'dockerfile'` delegates to `buildProjectImage()` to build a stable local image from a project-owned Dockerfile. Mutually exclusive with `image`; requires `dockerfile_path`. Validated by schema `superRefine` at load time.

**Project Image Build** — `buildProjectImage()` in `src/infrastructure/ecosystem-runtime/build-project-image.ts`. Reads a project-owned Dockerfile, derives a stable local tag via SHA-256 of the file contents, probes the local Docker daemon cache (`docker image inspect`), and only rebuilds when the tag is absent. Returns `{ image, entrypointOverride: "" }`. The `entrypointOverride` MUST be forwarded to `EphemeralEcosystemContainer` so `--entrypoint ""` is injected into every `docker run`, preventing the image's ENTRYPOINT from hijacking the ecosystem CLI binary. Emits a warning when the build context exceeds 50 MB. Build happens lazily on first use inside `resolveEcosystemRuntime` — the orchestrator is not modified.

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
