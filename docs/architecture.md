# Architecture — deep-health

## High-Level Architecture

```mermaid
graph TD
    CLI["CLI binary<br/>(bin/deep-health)"]

    subgraph app["app/ — Commands & I/O"]
        FIX["fix.ts"]
        SCAN["scan.ts"]
        INIT["init.ts"]
        EXEC_RPT["executive-report.ts"]
        CLOUD["cloud-setup.ts"]
    end

    subgraph orchestration["orchestration/"]
        ORCH["orchestrator.ts<br/>runOrchestrator()"]
        RUN_ECO_FIX["run-ecosystem-fix.ts<br/>runEcosystemFix()"]
        OSV_FIX["osv-fix-applier.ts"]
        DRY["dry-run-preview.ts"]
        LOCK_INS["lockfile-inspect.ts"]
    end

    subgraph modules["modules/"]
        subgraph ecosystem["ecosystem/"]
            ECO_REG["EcosystemRegistry<br/>(registry.ts)"]
            NPM_P["NpmPlugin"]
            COMP_P["ComposerPlugin"]
            PIP_P["PipPlugin"]
            UPDATER_TX["utils/updater-transaction.ts<br/>beginUpdaterTransaction()"]
            VAL_RUN["utils/validation-runner.ts"]
        end
        subgraph scanner["scanner/"]
            SCAN_REG["ScannerEngineRegistry<br/>(registry.ts)"]
            OSV_E["OsvScannerEngine<br/>(primary)"]
            SONAR_E["SonarQubeEngine<br/>(secondary)"]
        end
        ADVISOR["advisor/"]
    end

    subgraph core["core/ — Pure domain"]
        GATE["gates/validator.ts<br/>Gate A + Eco Gates"]
        POLICY["policy/safe-update.ts<br/>classifyPackage()"]
        TYPES["types/"]
    end

    subgraph infra["infrastructure/"]
        CONFIG["config/<br/>loader + schema"]
        ECO_RT["ecosystem-runtime/<br/>Unified container module"]
        EXEC_WRAP["executor/<br/>LocalExecutor + OSV runner"]
        PROV["provisioner/<br/>Image resolvers + OSV + Sonar"]
        STORAGE["storage/<br/>Local + GDrive"]
        UTILS["utils/<br/>logger, git, docker-platform"]
    end

    subgraph reporting["reporting/"]
        RPT["executive.ts<br/>generateExecutiveReport()"]
        SONAR_RPT["sonarqube-report.ts"]
        I18N["i18n/ (en, pt-br)"]
    end

    CLI --> app
    FIX --> ORCH
    FIX --> RPT
    SCAN --> SCAN_REG
    ORCH --> ECO_REG
    ORCH --> SCAN_REG
    ORCH --> GATE
    ORCH --> ADVISOR
    ORCH --> RUN_ECO_FIX
    RUN_ECO_FIX --> OSV_FIX
    RUN_ECO_FIX --> GATE
    NPM_P --> UPDATER_TX
    COMP_P --> UPDATER_TX
    PIP_P --> UPDATER_TX
    NPM_P --> VAL_RUN
    COMP_P --> VAL_RUN
    PIP_P --> VAL_RUN
    ECO_REG --> NPM_P
    ECO_REG --> COMP_P
    ECO_REG --> PIP_P
    SCAN_REG --> OSV_E
    SCAN_REG --> SONAR_E
    NPM_P --> POLICY
    COMP_P --> POLICY
    PIP_P --> POLICY
    ORCH --> ECO_RT
    ORCH --> EXEC_WRAP
    ECO_RT --> PROV
    EXEC_WRAP --> PROV
    RPT --> I18N
    FIX --> STORAGE
```

---

## Orchestrator Pipeline Flow

The `runOrchestrator()` function in `orchestration/orchestrator.ts` owns the full `fix` pipeline.

```mermaid
flowchart TD
    START([runOrchestrator called]) --> PRE_SNAP

    PRE_SNAP["Take pre-run snapshots\npackage.json + package-lock.json"]
    PRE_SNAP --> PHASE_CHECK

    PHASE_CHECK{"scan phase\nenabled?"}
    PHASE_CHECK -- no --> SKIP_SCAN([return: status=skipped])
    PHASE_CHECK -- yes --> ENGINES

    ENGINES["Run all scanner engines\n(OSV primary + SonarQube secondary)"]
    ENGINES --> GATE_A

    GATE_A{"Gate A\nvalidation\n(Zod)"}
    GATE_A -- fail --> GATE_ERR([throw GateValidationError])
    GATE_A -- pass --> KILL_SW

    KILL_SW{"DEEP_HEALTH_NO_AUTO_FIX\nenv var set?"}
    KILL_SW -- yes --> RETURN_SCAN([return scan result only])
    KILL_SW -- no --> PLUGINS

    PLUGINS["Iterate active ecosystem plugins\n(registration order: npm → composer → pip)"]
    PLUGINS --> PHASE_PLUGIN

    PHASE_PLUGIN{"plugin phase\nenabled?"}
    PHASE_PLUGIN -- no --> NEXT_PLUGIN
    PHASE_PLUGIN -- yes --> ADVISORS

    ADVISORS["Run advisors<br/>(informational, never blocks)"]
    ADVISORS --> RUN_ECO_FIX

    subgraph runEcosystemFix["runEcosystemFix() — src/orchestration/run-ecosystem-fix.ts"]
        direction TB
        RUN_ECO_FIX([runEcosystemFix called]) --> HAS_UPDATES

        HAS_UPDATES{"auto_safe vulns > 0<br/>or breaking vulns + authorized?"}
        HAS_UPDATES -- no --> SKIPPED([return: status=skipped])
        HAS_UPDATES -- yes --> RESOLVE_RUNNER

        RESOLVE_RUNNER["Resolve effective runner<br/>via Ecosystem Runtime Container<br/>(includes native_deps preamble)"]
        RESOLVE_RUNNER --> LOCK_DEMOTE

        LOCK_DEMOTE{"npm + osv/osv-then-audit<br/>+ lockfileVersion=1?"}
        LOCK_DEMOTE -- yes --> AUTO_DEMOTE["Auto-demote fixer → npm-audit\n(osv-scanner cannot patch v1 lockfiles)"]
        LOCK_DEMOTE -- no --> OSV_STAGING
        AUTO_DEMOTE --> OSV_STAGING

        OSV_STAGING["OSV staging-fix<br/>(if effective strategy=osv or osv-then-audit)"]
        OSV_STAGING --> DRY_PREVIEW

        DRY_PREVIEW["Dry-run preview<br/>(if --dry-run)"]
        DRY_PREVIEW --> RUN_UPDATER

        RUN_UPDATER["plugin.runUpdater()<br/>via beginUpdaterTransaction"]
        RUN_UPDATER --> BREAKING

        BREAKING{"authorizeBreaking<br/>+ plugin.installBreakingPackages?"}
        BREAKING -- yes --> INSTALL_BREAKING["Install breaking packages"]
        BREAKING -- no --> OSV_VERIFY
        INSTALL_BREAKING -- error --> ABORT_BREAKING([return: status=error])
        INSTALL_BREAKING -- ok --> OSV_VERIFY

        OSV_VERIFY{"postUpdateOsvVerify<br/>policy?"}
        OSV_VERIFY -- "always or osv-strategy-only<br/>(when strategy=osv)" --> RUN_VERIFY["Run OSV residual<br/>verification scan"]
        OSV_VERIFY -- never --> ECO_GATE
        RUN_VERIFY --> ECO_GATE

        ECO_GATE{"Ecosystem gate<br/>validation (Zod)"}
        ECO_GATE -- fail --> GATE_ERR2([throw GateValidationError])
        ECO_GATE -- pass --> SUCCESS_OR_ERR

        SUCCESS_OR_ERR{"updateResult.status<br/>= error?"}
        SUCCESS_OR_ERR -- yes --> RET_ERR([return: status=error])
        SUCCESS_OR_ERR -- no --> RET_SUCCESS([return: status=success])
    end

    SKIPPED --> NEXT_PLUGIN
    RET_SUCCESS --> NEXT_PLUGIN
    RET_ERR --> PIPELINE_STOP([stop pipeline, set overallStatus=error])
    ABORT_BREAKING --> PIPELINE_STOP

    NEXT_PLUGIN{more\nplugins?}
    NEXT_PLUGIN -- yes --> PHASE_PLUGIN
    NEXT_PLUGIN -- no --> PENDING

    PENDING["Check hasPendingVulns\n(breaking or manual vulns remain)"]
    PENDING --> DONE([return OrchestratorResult])
```

---

## Plugin System (EcosystemPlugin)

Each package manager is a plugin that implements the `EcosystemPlugin` interface (`modules/ecosystem/types.ts`).

```mermaid
classDiagram
    class EcosystemPlugin {
        +string id
        +string name
        +string[] lockfiles
        +string[] osvEcosystems
        +string reportLabel
        +FixerStrategyId[] supportedFixers
        +ValidationCommandConfig[] defaultValidationCommands
        +AdvisorConfig[] defaultAdvisors
        +EcosystemRuntimeSpec? runtimeSpec
        +OsvFixSpec? osvFixSpec
        +PostUpdateOsvVerify postUpdateOsvVerify
        +buildScanArgs() string[]
        +getProtectedPackages(config) ProtectedPackage[]
        +runUpdater(ctx) Promise~UpdateResultJson~
        +inferVersion?(cwd) Promise~string?~
        +installBreakingPackages?(args) Promise~Result?~
    }

    class NpmPlugin {
        +id = "npm"
        +runtimeSpec.runMode = direct-exec
        +supportedFixers = ["osv", "npm-audit", "osv-then-audit"]
        +postUpdateOsvVerify = "osv-strategy-only"
    }

    class ComposerPlugin {
        +id = "composer"
        +runtimeSpec.runMode = shell-wrap
        +supportedFixers = ["osv"]
        +postUpdateOsvVerify = "always"
    }

    class PipPlugin {
        +id = "pip"
        +runtimeSpec.runMode = shell-wrap
        +supportedFixers = ["osv"]
        +postUpdateOsvVerify = "always"
    }

    class EcosystemRegistry {
        -Map plugins
        +register(plugin) this
        +get(id) EcosystemPlugin?
        +getAll() EcosystemPlugin[]
        +findByOsvEcosystem(osv) EcosystemPlugin?
    }

    EcosystemPlugin <|-- NpmPlugin
    EcosystemPlugin <|-- ComposerPlugin
    EcosystemPlugin <|-- PipPlugin
    EcosystemRegistry o-- EcosystemPlugin
```

**Adding a new ecosystem:**

1. Create `src/modules/ecosystem/plugins/<name>.ts` implementing `EcosystemPlugin`.
2. Declare a `runtimeSpec: EcosystemRuntimeSpec` on the plugin object — see [Ecosystem Runtime Container](#ecosystem-runtime-container) for the spec shape.
3. Register the plugin in `src/modules/ecosystem/index.ts`.

No new files in `infrastructure/`, no orchestrator edits. The unified runtime module reads `runtimeSpec` and wires the entire container chain.

---

## Per-Ecosystem Fix Flow (`runEcosystemFix`)

`src/orchestration/run-ecosystem-fix.ts` encapsulates the per-plugin sub-pipeline that the orchestrator dispatches to once per active plugin. The orchestrator owns: phase filtering, advisors, fan-out across plugins, and result aggregation. Everything between "we're about to run plugin X" and "X returned an outcome" lives in `runEcosystemFix`.

```ts
export type RunEcosystemFixOutcome =
  | { status: 'skipped'; reason: 'no-updates' }
  | { status: 'success'; updateResult: UpdateResultJson; residualVerification?: ResidualVerification }
  | { status: 'error'; updateResult: UpdateResultJson };
```

**Why the seam exists:** before this extraction, the orchestrator's plugin loop body was ~193 lines mixing 15 distinct concerns. Tests of any single concern required full orchestrator setup (registry, scanner engines, Gate A wiring). After extraction, `runEcosystemFix` is testable directly with fake plugins — no scanner, no orchestrator. See `tests/unit/orchestration/run-ecosystem-fix.test.ts`.

**Throws** `GateValidationError` when the ecosystem gate fails. Otherwise always returns an outcome — including the breaking-install short-circuit, which returns `'error'` without running residual verification or gate validation (mirroring legacy semantics).

---

## Updater Transaction (`beginUpdaterTransaction`)

`src/modules/ecosystem/utils/updater-transaction.ts` concentrates the duplicated revert/result-building boilerplate that previously lived in three updaters (`npm-updater.ts`, `composer-updater.ts`, `pip-updater.ts`).

```ts
const tx = await beginUpdaterTransaction({
  files: NPM_FILES,        // backed up at start (or adopt preExistingBackups)
  base,                    // pre-built success-shaped UpdateResultJson
  cwd,
  preExistingBackups,      // optional — adopt caller-supplied backups (osv staging-fix)
});

// Happy path:
return tx.success({ packages_updated, validations: validationResult.entries });

// Failure path — runs revert, builds error result:
return tx.abortWithError({
  error: 'Validations failed after npm update — changes reverted',
  validations: validationResult.entries,
  revert: () => revertNpmChanges(runner, tx.backups, cwd, preRunSnapshots),
});
```

**Contract:** `abortWithError` lets revert errors propagate. The decision to swallow vs throw lives in the ecosystem-specific revert helper (pip/composer log-and-continue; npm throws on failed `npm ci` to surface ambiguous on-disk state). The outer `try/catch → PhaseError` in each updater catches propagated errors and wraps them. This preserves the original error-surfacing behavior while removing the duplicated `{ ...base, status: 'error', error, validations }` builder pattern.

**Why this seam:** three updaters each repeated ~25 lines of "build skipped entries + base UpdateResultJson + outer error-result spread" before the deepening. A bug in revert correctness (e.g. the npm "double-restore after `npm ci` lockfile-format normalization" trick) had three places to be remembered. After the deepening, the result-shaping invariant lives in one 60-line module.

---

## Safe-Update Classification

`core/policy/safe-update.ts:classifyPackage()` evaluates every vulnerable package against semver rules and the project's `protected_packages` config.

```mermaid
flowchart TD
    START([classifyPackage called]) --> NO_SAFE

    NO_SAFE{"safeVersion\nis null?"}
    NO_SAFE -- yes --> MANUAL_NO_VER([manual: No safe version available])
    NO_SAFE -- no --> IS_PROTECTED

    IS_PROTECTED{"package in\nprotected_packages?"}
    IS_PROTECTED -- yes --> SATISFIES

    SATISFIES{"safeVersion satisfies\nprotected constraint?"}
    SATISFIES -- no --> BREAKING_PROT([breaking: protected-constraint])
    SATISFIES -- yes --> PARSE

    IS_PROTECTED -- no --> PARSE

    PARSE{"semver.coerce\nsucceeds?"}
    PARSE -- no --> MANUAL_PARSE([manual: Cannot parse version])
    PARSE -- yes --> DOWNGRADE

    DOWNGRADE{"safeVersion\n< currentVersion?"}
    DOWNGRADE -- yes --> MANUAL_DOWN([manual: Downgrade — fix not available for major])
    DOWNGRADE -- no --> MAJOR

    MAJOR{"safe.major\n> current.major?"}
    MAJOR -- yes --> BREAKING_MAJOR([breaking: major-bump])
    MAJOR -- no --> AUTO([auto_safe])
```

---

## Scanner Engine System

```mermaid
classDiagram
    class ScannerEngine {
        <<interface>>
        +string id
        +string name
        +assertAvailable(ctx) Promise~void~
        +scan(ctx) Promise~ScanResultJson~
    }

    class ExternalScannerAdapter {
        <<abstract>>
        +abstract id string
        +abstract name string
        +abstract assertAvailable(ctx) Promise~void~
        +abstract fetchVulnerabilities(ctx) Promise~RawVulnerability[]~
        +scan(ctx) Promise~ScanResultJson~
        #buildScanResult(vulns, ctx) ScanResultJson
    }

    class OsvScannerEngine {
        +id = "osv"
        +name = "OSV Scanner"
    }

    class SonarQubeEngine {
        +id = "sonarqube"
        +name = "SonarQube"
    }

    class ScannerEngineRegistry {
        -Map engines
        +register(engine) this
        +has(id) boolean
        +getAll() ScannerEngine[]
    }

    ScannerEngine <|-- OsvScannerEngine
    ScannerEngine <|-- SonarQubeEngine
    ScannerEngine <|-- ExternalScannerAdapter
    ScannerEngineRegistry o-- ScannerEngine
```

**Primary vs secondary engine:**

- **Primary** = engine whose `id` matches `config.scanners.primary` (defaults to `'osv'` when not configured). Its result drives Gate A. Any failure is fatal.
- **Secondary** = all other registered engines. Failures are governed by `on_failure: 'warn' | 'fail'` (default: `'warn'` for SonarQube, `'fail'` for unknown engines).

---

## Ecosystem Runtime Container

`src/infrastructure/ecosystem-runtime/` is the unified seam through which a plugin's CLI runs in an ephemeral Docker container. One module replaces what used to be three triplicated runner trios (executor + resolver + provisioner). See [ADR-0001](./adr/0001-docker-only-runtime.md) for the docker-only decision.

```mermaid
flowchart LR
    PLUGIN["EcosystemPlugin<br/>runtimeSpec: EcosystemRuntimeSpec"]
    RESOLVE["resolveEcosystemRuntime()"]
    IMG["Image resolution<br/>scanners.&lt;id&gt;.image →<br/>scanners.&lt;id&gt;.runtime_version →<br/>plugin.inferVersion() →<br/>spec.defaultImage"]
    NATIVE["native_deps preamble synthesis<br/>(if scanners.&lt;id&gt;.native_deps is set)<br/>apt-get install … composed with<br/>any existing plugin preamble"]
    CONTAINER["EphemeralEcosystemContainer<br/>(runMode + preamble, image, projectDir, logPrefix)"]
    CMD["EcosystemContainerCommandRunner<br/>(container, hostRunner, spec)"]
    EFFECTIVE["effectiveRunner: CommandRunner"]

    PLUGIN --> RESOLVE
    RESOLVE --> IMG
    IMG --> NATIVE
    NATIVE --> CONTAINER
    CONTAINER --> CMD
    CMD --> EFFECTIVE
```

### EcosystemRuntimeSpec

Declarative description of how an ecosystem's CLI runs in a container. Lives on the plugin as `runtimeSpec`:

```ts
interface EcosystemRuntimeSpec {
  defaultImage: string;
  resolveImage: (version: string | undefined) => string;
  containerBinaries: readonly string[];
  runMode: RunMode;
}

type RunMode =
  | { kind: 'direct-exec'; binary: string; preamble?: (image: string) => string | undefined }
  | { kind: 'shell-wrap'; preamble?: (image: string) => string | undefined };
```

### Run Modes

| `runMode.kind` | Used by | Final docker invocation |
|---|---|---|
| `direct-exec` (no preamble) | npm | `docker run <image> <binary> <args...>` |
| `direct-exec` (with preamble) | npm + `native_deps` | `docker run <image> sh -lc '<preamble> && exec "$@"' -- <binary> <args...>` |
| `shell-wrap` | pip, composer | `docker run <image> sh -lc "[<preamble> && ]<args joined>"` |

Both run modes support an optional `preamble` function. It is consulted per invocation with the resolved image and may return `undefined` to skip injection for that specific image.

- **`shell-wrap` preamble** — used by composer to inject `COMPOSER_BOOTSTRAP` when the image is a bare `php:*-cli` that does not pre-install composer.
- **`direct-exec` preamble** — used when `native_deps` is configured in `scanners.npm` (or `pip`/`composer`). `resolveEcosystemRuntime` synthesizes an `apt-get install` preamble and injects it before the binary. When a preamble is present, the executor switches to `sh -lc '…' -- binary args`, preserving the SEC-004 trust boundary: original argv tokens remain independent shell word elements via `"$@"` and are never re-tokenized.

When both a `native_deps` preamble (from config) and a plugin preamble (from `runtimeSpec`) are present, `resolveEcosystemRuntime` composes them: `<native_deps_apt_cmd> && <plugin_preamble>`.

`runShell()` always uses `sh -c` (without `-l`), preserving legacy behavior for arbitrary user-supplied validation commands.

### Routing

`EcosystemContainerCommandRunner` routes commands by inspecting the binary against `spec.containerBinaries`:

| Command class | Example | Routed to |
|---|---|---|
| Spec-recognized binary | `runner.runArgs('npm', ['install'])` | Ephemeral container |
| Other CLI command | `runner.run('jest --coverage')` | Container via `runShell()` |
| Host-only command | `runner.runArgs('git', ['push'])` | Host runner |

**Host-only commands** are `git`, `gh`, `open`. They never enter the container regardless of which spec is active.

### Adding a new ecosystem (runtime side)

For a hypothetical `cargo` plugin:

```ts
// src/modules/ecosystem/plugins/cargo.ts
runtimeSpec: {
  defaultImage: 'rust:latest',
  resolveImage: (v) => v ? `rust:${v}` : 'rust:latest',
  containerBinaries: ['cargo'],
  runMode: { kind: 'direct-exec', binary: 'cargo' },
},
```

That declaration alone wires the entire runtime chain — no new provisioner class, no new executor class, no orchestrator edits.

---

## Gate System

```mermaid
flowchart TD
    SCAN_OUT["ScanResultJson\nfrom OSV engine"]
    GATE_A["Gate A\nvalidateGateA()\nZod: ScanResultSchema"]
    SCAN_OUT --> GATE_A

    GATE_A -- valid --> UPDATE
    GATE_A -- invalid --> ERR_A([throw GateValidationError gate=A])

    UPDATE["UpdateResultJson\nfrom plugin.runUpdater()"]
    ECO_GATE["Ecosystem Gate\nvalidateEcosystemGate(id, data)\nZod: UpdateResultSchema\nvalidations.min(1)"]
    UPDATE --> ECO_GATE

    ECO_GATE -- valid --> CONT([pipeline continues])
    ECO_GATE -- invalid --> ERR_ECO([throw GateValidationError gate=id])
    ECO_GATE -- "all validations skipped" --> WARN["logger.warn — no test coverage verified\n(pipeline continues)"]
```

**Key constraint:** `validations` array must always have at least one entry. When tests are not run (e.g., dry-run), emit a `{ name: ..., status: 'skipped' }` entry. An empty array fails the gate.

---

## Report Generation Flow

```mermaid
flowchart LR
    ORCH_RES["OrchestratorResult\n(scan, updates, advisorResults,\nresidualVerification)"]
    SCAN_AFTER["runScanner()\npost-fix snapshot"]

    ORCH_RES --> GEN_RPT
    SCAN_AFTER --> GEN_RPT

    GEN_RPT["generateExecutiveReport()\nreporting/executive.ts"]
    GEN_RPT --> HBS["Handlebars renderer\n(reporting/templates/executive.hbs.ts)"]
    HBS --> I18N["i18n loader\n(en / pt-br)"]
    I18N --> HTML["Executive HTML report"]

    HTML --> SAVE["saveReport()\napp/report-saver.ts"]
    SAVE --> LOCAL["Local file\n(outputs.dir)"]
    SAVE --> GDRIVE["Google Drive upload\n(cloud_storage)"]

    GEN_RPT --> SONAR_RPT["generateSonarQubeHtmlReport()\n(if SonarQube engine ran)"]
    SONAR_RPT --> SONAR_HTML["SonarQube HTML artifact"]
    SONAR_HTML --> SAVE
```

---

## Fixer Strategy Decision Tree

```mermaid
flowchart TD
    CONFIG{"ecosystems[id].fixer\nconfigured?"}
    CONFIG -- yes --> USE_CONFIG["Use config fixer"]
    CONFIG -- no --> PLUGIN_DEF["Use plugin.supportedFixers[0]"]

    USE_CONFIG --> DEMOTE_CHECK
    PLUGIN_DEF --> DEMOTE_CHECK

    DEMOTE_CHECK{"npm plugin AND\nstrategy = osv or osv-then-audit?"}
    DEMOTE_CHECK -- no --> FIXER
    DEMOTE_CHECK -- yes --> LOCK_VER{"lockfileVersion\nin package-lock.json?"}

    LOCK_VER -- "= 1 (npm 6 / Node ≤12)" --> DEMOTE["Auto-demote to npm-audit\n(osv-scanner cannot patch v1 in-place)\nlog WARN: auto-switching fixer"]
    LOCK_VER -- "≥ 2 or null" --> FIXER

    DEMOTE --> FIXER

    FIXER{"Effective strategy?"}
    FIXER -- "osv" --> OSV_ONLY["OSV Scanner fix\n(in-place lockfile patch via staging copy)"]
    FIXER -- "npm-audit" --> NPM_AUDIT["npm audit fix"]
    FIXER -- "osv-then-audit" --> CHAIN["OSV fix first\nthen npm audit fix as fallback"]
    FIXER -- "composer-update" --> COMP_UPD["composer update <packages>"]

    OSV_ONLY --> POST_VERIFY{"postUpdateOsvVerify?"}
    CHAIN --> POST_VERIFY
    NPM_AUDIT --> POST_VERIFY
    COMP_UPD --> POST_VERIFY

    POST_VERIFY -- "always" --> RUN_OSV_VERIFY["Run OSV residual\nverification scan"]
    POST_VERIFY -- "osv-strategy-only\n+ effective strategy=osv" --> RUN_OSV_VERIFY
    POST_VERIFY -- "never or not osv" --> SKIP_VERIFY([skip])
```

---

## Module Dependency Rules

```
app/         → orchestration, modules, core, infrastructure, reporting
orchestration → modules, core, infrastructure
modules/ecosystem → core, infrastructure
modules/scanner   → core, infrastructure
reporting    → core, infrastructure
infrastructure → core (types only — no business logic)
core/        → (no internal imports — pure domain)
```

`core/` is the dependency root. Nothing in `core/` imports from `infrastructure/`, `modules/`, `app/`, or `orchestration/`. This boundary is enforced by convention — any import from `@infra/` inside `@core/` is a contract violation.

---

## Adding an External Scanner Engine

### When to use `ExternalScannerAdapter` vs `ScannerEngine` directly

Implement `ScannerEngine` directly when:
- The engine produces a result that does not map cleanly to per-package vulnerability entries (e.g., SonarQube code quality gates).
- The engine has complex multi-phase logic that does not decompose into a simple `fetchVulnerabilities()` call.

Extend `ExternalScannerAdapter` when:
- The external source returns vulnerability records that can be normalized to `RawVulnerability[]`.
- You want the base class to handle `ScanResultJson` assembly, `classifyPackage()` calls, and ecosystem bucketing automatically.

This covers the common case: Snyk, WPScan, Patchstack, NVD, and similar CVE-feed tools.

### The 3 abstract members to implement

| Member | Type | Purpose |
|---|---|---|
| `id` | `readonly string` | Unique engine key used in registries, logs, and `result.agent` |
| `name` | `readonly string` | Human-readable display name |
| `assertAvailable(ctx)` | `async` method | Verify the tool/credentials exist; throw if not |
| `fetchVulnerabilities(ctx)` | `async` method | Return `RawVulnerability[]`; return `[]` on non-fatal failures |

### Minimal working example (SnykEngine)

```ts
// src/modules/scanner/snyk-engine.ts (example)
import { ExternalScannerAdapter } from './external-adapter';
import type { ScannerEngineContext } from './types';
import type { RawVulnerability } from './external-adapter';

export class SnykEngine extends ExternalScannerAdapter {
  readonly id = 'snyk';
  readonly name = 'Snyk';

  async assertAvailable(ctx: ScannerEngineContext): Promise<void> {
    const result = await ctx.runner.runArgs('snyk', ['--version'], { cwd: ctx.cwd });
    if (result.exitCode !== 0) {
      throw new Error('snyk CLI not found. Install with: npm install -g snyk');
    }
  }

  async fetchVulnerabilities(ctx: ScannerEngineContext): Promise<RawVulnerability[]> {
    const result = await ctx.runner.runArgs('snyk', ['test', '--json'], { cwd: ctx.cwd });
    // Parse Snyk JSON output → RawVulnerability[]
    return [];
  }
}
```

`buildScanResult()` on the base class handles the rest: it iterates `RawVulnerability[]`, calls `classifyPackage()` for each entry using protected packages from the matching ecosystem plugin, buckets results by ecosystem, and returns a fully populated `ScanResultJson`.

### Registering the engine

Pass the engine to the orchestrator via `OrchestratorOptions.scannerRegistry`:

```ts
const registry = new ScannerEngineRegistry();
registry.register(new OsvScannerEngine());
registry.register(new SnykEngine());

await runOrchestrator(runner, config, cwd, { scannerRegistry: registry });
```

Or call `registry.register()` directly on the default registry before running:

```ts
import { defaultScannerRegistry } from '@modules/scanner';
defaultScannerRegistry.register(new SnykEngine());
```

### Setting the engine as primary

In your project's `deep-health.config.json`:

```json
{
  "scanners": {
    "primary": "snyk"
  }
}
```

The `primary` value must match the engine's `id` property. When omitted, the default is `"osv"`. The primary engine's result drives Gate A — any failure is fatal to the pipeline.

---

## Git/PR Workflow

`src/infrastructure/utils/git-commit.ts` provides the transactional branch+commit wrapper used by `fix.ts` when `--create-branch` or `--open-pr` is requested.

```mermaid
flowchart TD
    START([fix --create-branch called]) --> DETECT
    DETECT["detectGitBranch()\nRecord original branch"]
    DETECT --> CREATE_BR
    CREATE_BR["git checkout -b fix/deep-health-<timestamp>\n(runArgs — no shell)"]
    CREATE_BR --> PIPELINE
    PIPELINE["runFixPipeline()\nScan + update + report"]
    PIPELINE -- success --> COMMIT
    PIPELINE -- failure --> ROLLBACK
    ROLLBACK["git checkout <original>\nRe-throw error"]
    COMMIT["git add -A\ngit commit -m 'fix: apply safe dependency updates'"]
    COMMIT --> OPEN_PR{--open-pr\nrequested?}
    OPEN_PR -- yes --> PUSH["git push origin <branch>"]
    PUSH --> PR["gh pr create --title ... --body ..."]
    PR --> URL["Print PR URL to stdout"]
    OPEN_PR -- no --> DONE([return 0])
    URL --> DONE
```

**Key invariant:** `git checkout -b <branchName>` always uses `runner.runArgs('git', ['checkout', '-b', branchName])` — never string interpolation — because branch names are external data that may contain shell metacharacters.

---

## Production Hardening

### Retry with backoff

`src/infrastructure/utils/retry.ts` exports `withRetry<T>(fn, opts)` — wraps all four Docker provisioner `run()` calls. Default: 3 attempts, 1s/2s/4s exponential backoff.

Retry triggers only on transient Docker errors (`docker pull`, `network timeout`, `connection refused`, `exit code 125`). Gate failures and business logic errors are never retried.

### Validation command timeouts

`ValidationCommandConfig.timeout_seconds` defaults to `300` (5 min) when not specified. Commands that hang past the limit are killed and reported as failed.

### Config versioning

`config_version: '1'` is an optional field in `project-config.yml`. Unsupported versions produce a user-friendly error:

```
Unsupported config_version "2". This version of deep-health supports config_version "1".
Run "deep-health init --force" to regenerate a compatible config.
```

### Optional googleapis

`googleapis` is in `optionalDependencies` and excluded from the bundle. Users who don't use Google Drive don't install it. `cloud-setup` and Drive upload show a clear install instruction if the package is absent.
