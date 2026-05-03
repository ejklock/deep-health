# Architecture Review — 2026-05-02 (Cycle 3)

## Introduction

Third-cycle architecture deepening candidates surfaced on 2026-05-02, after all Cycle 2 candidates were implemented. Same goal: increase **Depth** (narrow Interfaces with more behaviour behind them), **Locality** (decisions live at their natural Module boundary), and **Leverage** (a change in one Module propagates correctly everywhere, tests narrow to the seam being tested).

Terms follow the project's architecture vocabulary (see `LANGUAGE.md`): **Module**, **Interface**, **Implementation**, **Depth**, **Seam**, **Adapter**, **Leverage**, **Locality**. Domain terms follow `CONTEXT.md`.

---

## Candidate 1 — Updater Transaction generico: eliminar 70% de boilerplate nos updaters

### Status: under investigation

### Files

- `src/modules/ecosystem/plugins/npm-updater.ts` (~191 loc)
- `src/modules/ecosystem/plugins/pip-updater.ts` (~240 loc)
- `src/modules/ecosystem/plugins/composer-updater.ts` (~278 loc)
- `src/modules/ecosystem/utils/updater-transaction.ts`

### Problem

The three updaters repeat the same skeleton: build skipped `ValidationEntry[]`, assemble base `UpdateResultJson`, handle dry-run, run fixer -> validations -> revert on failure -> return result. ~70% is copied boilerplate with cosmetic variations. When a shared contract changes (e.g. new field on `UpdateResultJson`), all three must be touched — and they diverge silently.

The current Updater Transaction module only owns backup/revert. The surrounding lifecycle (result scaffolding, dry-run gate, validation loop, error formatting) is duplicated across callers.

### Solution

Deepen the Updater Transaction module to absorb the full update lifecycle skeleton — not just backup/revert, but also result scaffolding, dry-run gate, and the validation->revert loop. Each updater passes only what is ecosystem-specific: the `FixerFn`, the `BootstrapSpec`, and any post-fixer logic. The Interface shrinks (less for callers to know); the Implementation grows (more **Leverage**).

### Benefits

- **Locality** — contract changes to the update lifecycle concentrate in one place.
- **Leverage** — adding a 4th ecosystem (e.g. Ruby/Bundler) requires only the ecosystem-specific parts, no 150-line boilerplate copy.
- Tests for the lifecycle skeleton live in one place; per-updater tests focus on ecosystem-specific logic only.

---

## Candidate 2 — Consolidar image resolvers: eliminar provisioner shallow wrappers

### Status: not started

### Files

- `src/infrastructure/provisioner/npm-runner.ts` (~23 loc)
- `src/infrastructure/provisioner/pip-runner.ts` (~28 loc)
- `src/infrastructure/provisioner/composer-runner.ts` (~27 loc)
- `src/infrastructure/provisioner/php-image-resolver.ts` (~42 loc)

### Problem

Each file is a trivial wrapper exposing a `resolve<Eco>DockerImage(version?) -> string` function. They fail the **deletion test**: deleting any of them just moves the same logic to the caller. They are **shallow** modules — the Interface is practically identical to the Implementation. As new ecosystems arrive, the pattern accumulates more wrappers with zero Depth.

### Solution

Consolidate all image resolvers into a single Module (`provisioner/image-resolvers.ts` or absorb into ecosystem-runtime `resolve.ts` which already does image resolution). A single function `resolveEcosystemImage(ecosystemId, version?)` with an internal lookup table. The three files disappear.

### Benefits

- **Locality** — all image resolution logic in one place.
- Fewer files to navigate. Zero impact on callers (external Interface gets *smaller*, not larger).
- Tests: a single test file covers all resolution variants.

---

## Candidate 3 — Extrair Phase Router do Orchestrator

### Status: not started

### Files

- `src/orchestration/orchestrator.ts` (~392 loc)

### Problem

The orchestrator mixes dispatch (its real responsibility) with auxiliary logic: `shouldRunPhase()` (phase filtering), `resolveOnFailure()` (policy lookup), pre-run snapshot management, and advisor scheduling interleaved with the ecosystem fix loop. Not critical today, but scales poorly — if pipeline variants are needed (e.g. "scan-only", "fix without scan", "re-fix from saved result"), the orchestrator would need forking or conditional bloat.

### Solution

Extract a Phase Router Module that resolves which phases run and in what order, given config and CLI flags. The orchestrator receives the plan and just executes. The orchestrator's Interface becomes cleaner (receives plan, executes); phase selection complexity gains its own **Locality**.

### Benefits

- **Leverage** — pipeline variants become different Phase Router compositions, without touching the orchestrator.
- **Locality** — filtering and priority rules for phases concentrate in a single Module.
- Tests: the router is pure (no I/O), testable with config fixtures.

---

## Candidate 4 — Reporting executive.ts: separar data preparation de template rendering

### Status: not started

### Files

- `src/reporting/executive.ts` (~371 loc)

### Problem

Largest file in reporting, generating the executive HTML report. At 371 lines, it likely mixes data transformation (business logic) with template rendering (presentation). If data transforms are inline, testing report logic requires going through the full rendering pipeline.

### Solution

If confirmed: extract a data preparation phase (`prepareReportData(results) -> ReportViewModel`) separate from template rendering (`renderReport(viewModel) -> HTML`). The report Module's Interface becomes: prepare data + render.

### Benefits

- **Locality** — metric calculation logic testable without Handlebars.
- **Leverage** — the same `ReportViewModel` can serve HTML, Markdown, JSON, or any future format.

---

## Candidate 5 — Scanner/Ecosystem registry bootstrap: side-effect registration -> explicit factory

### Status: not started

### Files

- `src/modules/scanner/index.ts` (~116 loc)
- `src/modules/ecosystem/index.ts`

### Problem

Both scanners and ecosystem plugins are registered via side-effects in `index.ts` (import -> register). Works, but makes bootstrap implicit — tests that import the registry get all real plugins, and there is no Seam to inject a partial or fake registry without monkey-patching.

### Solution

Make bootstrap explicit: a factory `createScannerRegistry(engines[])` and `createEcosystemRegistry(plugins[])`. The `index.ts` exports the default registry (backward-compatible), but tests and pipeline variants can construct custom registries.

### Benefits

- **Leverage** — orchestrator unit tests inject a registry with 1 fake plugin, without loading real npm/pip/composer.
- **Locality** — the list of registered plugins is declarative and visible, not an import side-effect.

---

## Summary of Exploration Findings

### Well-architected areas (green flags)

| Area | Assessment |
|------|-----------|
| **Core layer** | Strictly I/O-free. Zero leaks. Proper type safety with Zod + TypeScript. |
| **EcosystemRuntimeSpec** | Correct Seam identification. Plugin declares one spec; orchestrator/provisioner/executor unchanged. |
| **Config validation** | Zod schemas as source of truth. Migration detection, registry cross-validation, human-readable errors. |
| **Scanner Sweep** | Pure policy engine with injected dependencies. Declarative error handling. |
| **Gate validation** | Clear contracts (Gate A for scan, Ecosystem Gate for updates). Schema-driven. |
| **Fixer architecture** | Deep modules with real logic. Clean composition via `FixerCallResult`. |
| **LocalExecutor** | Deep module — minimal Interface (2 methods), rich Implementation (stdio, buffering, error recovery). |

### Friction points (red flags)

| Area | Issue | Candidate |
|------|-------|-----------|
| **Updater boilerplate** | 70% duplication across npm/pip/composer updaters | #1 |
| **Provisioner wrappers** | Shallow modules that fail the deletion test | #2 |
| **Orchestrator creep** | Phase filtering + policy + snapshots + advisors mixed with dispatch | #3 |
| **Reporting coupling** | Data transforms possibly inline with Handlebars rendering | #4 |
| **Registry side-effects** | Implicit bootstrap makes test isolation harder | #5 |

### Scaling implications

- **Adding a 4th ecosystem (Ruby/Bundler):** Easy for plugin + runtime spec. Friction in updater boilerplate (#1) and provisioner wrappers (#2).
- **Adding pipeline variants (scan-only, fix-only):** Hard without Phase Router (#3).
- **Adding a new scanner (Snyk):** Easy thanks to ScannerEngine + Scanner Sweep architecture.
- **Adding new report formats:** Blocked by data/rendering coupling (#4) if confirmed.
