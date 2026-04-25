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
        EXEC_WRAP["executor/<br/>Container runners"]
        PROV["provisioner/<br/>Docker runners"]
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
    ORCH --> OSV_FIX
    ORCH --> ADVISOR
    ECO_REG --> NPM_P
    ECO_REG --> COMP_P
    ECO_REG --> PIP_P
    SCAN_REG --> OSV_E
    SCAN_REG --> SONAR_E
    NPM_P --> POLICY
    COMP_P --> POLICY
    PIP_P --> POLICY
    ORCH --> EXEC_WRAP
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

    ADVISORS["Run advisors\n(informational, never blocks)"]
    ADVISORS --> HAS_UPDATES

    HAS_UPDATES{"auto_safe vulns > 0\nor breaking vulns + authorized?"}
    HAS_UPDATES -- no --> NEXT_PLUGIN
    HAS_UPDATES -- yes --> RESOLVE_RUNNER

    RESOLVE_RUNNER["Resolve container runner\n(npm-docker / pip-docker / composer-docker)"]
    RESOLVE_RUNNER --> OSV_STAGING

    OSV_STAGING["OSV staging-fix\n(if strategy=osv or osv-then-audit)"]
    OSV_STAGING --> DRY_PREVIEW

    DRY_PREVIEW["Dry-run preview\n(if --dry-run)"]
    DRY_PREVIEW --> RUN_UPDATER

    RUN_UPDATER["plugin.runUpdater()"]
    RUN_UPDATER --> BREAKING

    BREAKING{"authorizeBreaking\n+ plugin.installBreakingPackages?"}
    BREAKING -- yes --> INSTALL_BREAKING["Install breaking packages"]
    BREAKING -- no --> OSV_VERIFY
    INSTALL_BREAKING --> OSV_VERIFY

    OSV_VERIFY{"postUpdateOsvVerify\npolicy?"}
    OSV_VERIFY -- "always or osv-strategy-only\n(when strategy=osv)" --> RUN_VERIFY["Run OSV residual\nverification scan"]
    OSV_VERIFY -- never --> ECO_GATE
    RUN_VERIFY --> ECO_GATE

    ECO_GATE{"Ecosystem gate\nvalidation (Zod)"}
    ECO_GATE -- fail --> GATE_ERR2([throw GateValidationError])
    ECO_GATE -- pass --> CHECK_ERR

    CHECK_ERR{"updateResult.status\n= error?"}
    CHECK_ERR -- yes --> PIPELINE_STOP([stop pipeline, set overallStatus=error])
    CHECK_ERR -- no --> NEXT_PLUGIN

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
        +string? runtimeContainer
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
        +runtimeContainer = "npm-docker"
        +supportedFixers = ["osv", "npm-audit", "osv-then-audit"]
        +postUpdateOsvVerify = "osv-strategy-only"
    }

    class ComposerPlugin {
        +id = "composer"
        +runtimeContainer = "composer-docker"
        +supportedFixers = ["osv"]
        +postUpdateOsvVerify = "always"
    }

    class PipPlugin {
        +id = "pip"
        +runtimeContainer = "pip-docker"
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
2. Register it in `src/modules/ecosystem/index.ts`.
3. Add a Docker runner in `src/infrastructure/provisioner/` if needed.
4. Add a container executor in `src/infrastructure/executor/`.
5. Add the `runtimeContainer` tag resolution in `orchestrator.ts` (the `resolveXxxContainerRunner` pattern).

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
        +string id
        +string name
        +scan(ctx ScannerEngineContext) Promise~ScanResultJson~
    }

    class OsvScannerEngine {
        +id = "osv"
        +name = "OSV Scanner"
        +scan(ctx) Promise~ScanResultJson~
    }

    class SonarQubeEngine {
        +id = "sonarqube"
        +name = "SonarQube"
        +scan(ctx) Promise~ScanResultJson~
    }

    class ScannerEngineRegistry {
        -Map engines
        +register(engine) this
        +has(id) boolean
        +getAll() ScannerEngine[]
    }

    ScannerEngine <|-- OsvScannerEngine
    ScannerEngine <|-- SonarQubeEngine
    ScannerEngineRegistry o-- ScannerEngine
```

**Primary vs secondary engine:**

- **Primary** = engine with `id === 'osv'`. Its result drives Gate A. Any failure is fatal.
- **Secondary** = all other engines (e.g. SonarQube). Failures are governed by `on_failure: 'warn' | 'fail'` (default: `'warn'` for SonarQube, `'fail'` for unknown engines).

---

## Container Runner Resolution

```mermaid
flowchart LR
    PLUGIN["EcosystemPlugin\nruntimeContainer tag"]

    PLUGIN -- "npm-docker" --> NPM_RES["resolveNpmContainerRunner()"]
    PLUGIN -- "pip-docker" --> PIP_RES["resolvePipContainerRunner()"]
    PLUGIN -- "composer-docker" --> COMP_RES["resolveComposerContainerRunner()"]
    PLUGIN -- "undefined" --> BASE["LocalExecutor\n(base runner)"]

    NPM_RES --> NPM_VER["Version precedence:\n1. scanners.npm.image\n2. scanners.npm.runtime_version\n3. plugin.inferVersion()\n4. node:lts (fallback)"]
    NPM_VER --> NPM_DOCKER["NpmDockerRunner\n→ NpmContainerCommandRunner"]

    PIP_RES --> PIP_VER["Version precedence:\n1. scanners.pip.image\n2. scanners.pip.runtime_version\n3. plugin.inferVersion()\n4. python:3-slim (fallback)"]
    PIP_VER --> PIP_DOCKER["PipDockerRunner\n→ PipContainerCommandRunner"]

    COMP_RES --> COMP_VER["Version precedence:\n1. scanners.composer.image\n2. scanners.composer.runtime_version\n3. plugin.inferVersion()\n4. composer:2 (fallback)"]
    COMP_VER --> COMP_DOCKER["ComposerDockerRunner\n→ ComposerContainerCommandRunner"]
```

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

    USE_CONFIG --> FIXER
    PLUGIN_DEF --> FIXER

    FIXER{"Strategy?"}
    FIXER -- "osv" --> OSV_ONLY["OSV Scanner fix\n(in-place lockfile patch via staging copy)"]
    FIXER -- "npm-audit" --> NPM_AUDIT["npm audit fix"]
    FIXER -- "osv-then-audit" --> CHAIN["OSV fix first\nthen npm audit fix as fallback"]
    FIXER -- "composer-update" --> COMP_UPD["composer update <packages>"]

    OSV_ONLY --> POST_VERIFY{"postUpdateOsvVerify?"}
    CHAIN --> POST_VERIFY
    NPM_AUDIT --> POST_VERIFY
    COMP_UPD --> POST_VERIFY

    POST_VERIFY -- "always" --> RUN_OSV_VERIFY["Run OSV residual\nverification scan"]
    POST_VERIFY -- "osv-strategy-only\n+ strategy=osv" --> RUN_OSV_VERIFY
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
