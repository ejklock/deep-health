# Architecture Review — 2026-05-02

## Introduction

This document records the second-cycle architecture deepening candidates surfaced on 2026-05-02.

The first cycle produced ADR-0003 and resolved five structural candidates (Updater Transaction revert semantics, `fix.ts` pipeline-exit control flow, OSV container-adapter collapse, per-plugin `resolveEffectiveFixer` hook, and OSV residual-verify runner promotion), plus a follow-up that moved the `osv-then-audit` partial-revert closure into the Fixer where it belongs. Those are considered closed.

These seven candidates are the next structural layer — surfaced after all ADR-0003 work landed. The goal is the same: increase **Depth** (narrow Interfaces with more behaviour behind them), **Locality** (decisions live at their natural Module boundary), and **Leverage** (a change in one Module propagates correctly everywhere, tests narrow to the seam being tested). None are committed work; they are surfaced opportunities for the architect to triage.

---

## Candidate 1 — `runAllEngines` is a hidden state machine inside the Orchestrator

### Files

`src/orchestration/orchestrator.ts` (lines 163–276, ~115 lines)

### Problem

`runAllEngines` builds a Listr2 task list, swallows `ListrError` in a bare `catch {}`, populates a `Map<engineId, Result|Error>`, and then iterates the engines a **second time** to apply `on_failure` policy. Four responsibilities are interleaved in one block: primary-vs-secondary classification, `on_failure` resolution (`warn` vs `fail`), warning accumulation, and `status='error'` filtering. The Listr2 visual ceremony is inseparable from the failure-policy logic.

Every Orchestrator test must mock Listr2 just to exercise failure policy — the visual Adapter is load-bearing in the test path, which is a Seam smell: Depth is leaking outward.

### Solution

Extract an **Engine Run Plan Module** with a narrow Interface:

```ts
interface EngineRunPlan {
  execute(engines, ctx, renderer): Promise<{ engineEntries: EngineEntry[]; warnings: string[] }>;
}
```

Visual presentation (Listr2) becomes a pluggable **Adapter** implementing a `RendererAdapter` Interface. Tests inject a sequential silent Adapter. The Orchestrator collapses to:

```ts
const { engineEntries, warnings } = await engineRunPlan.execute(engines, ctx, silentRenderer);
```

Failure policy (primary must throw; secondary applies `on_failure`) lives in a single table inside the Module.

### Benefits

- **Locality**: primary-vs-secondary classification and `on_failure` resolution live in one file, not tangled with Listr2 ceremony.
- **Leverage**: the Orchestrator loses ~115 lines; adding a new secondary Scanner Engine does not touch `orchestrator.ts`.
- **Seam clarity**: the renderer Seam is explicit — one Listr2 Adapter, one silent test Adapter; tests exercise failure policy directly without any Listr2 mock.

---

## Candidate 2 — Composer pre-flight env-check is an unnamed Seam

### Files

`src/modules/ecosystem/plugins/composer-updater.ts`; future `pip-updater.ts`

### Problem

`composer-updater.ts` runs `composer install --no-interaction --no-scripts` **before** opening the Updater Transaction purely to validate that the environment can install dependencies. ADR-0003 Refinement 3 explicitly carved this out of the **BootstrapSpec** — but then left the check as loose code at the head of the Updater. When pip grows an analogous pre-flight (likely `pip install --dry-run`), the pattern duplicates.

Two Adapters doing the same conceptual thing, with no shared Interface, is the canonical signal of an unnamed Seam.

### Solution

Name the concept — proposed: **EcosystemEnvironmentProbe** — with Interface:

```ts
interface EcosystemEnvironmentProbe {
  probe(runner: CommandRunner, cwd: string): Promise<{ ok: true } | { ok: false; error: string }>;
}
```

Each **Ecosystem Plugin** declares its probe (composer → `install --no-scripts`; pip → `install --dry-run`; npm → optional no-op). The Updater consults `plugin.environmentProbe?.probe(runner, cwd)` before opening the transaction. Failure returns `UpdateResultJson` with `status: 'error'` and a standardised prefix (e.g. `'Ecosystem environment mismatch:'`).

### Benefits

- **Leverage**: every future Updater inherits pre-flight for free; the error prefix is standardised across all Ecosystem Plugins (today each Updater invents its own).
- **Locality**: the behaviour "verify the environment is healthy before mutating" lives in the Plugin declaration, not scattered across three Updater bodies.
- **Test surface**: Updater tests drop the `composer install --dry-run` mock; the Probe gets its own narrow unit test.

---

## Candidate 3 — `runFixPipeline` orchestrates four post-pipeline concerns inline

### Files

`src/app/commands/fix.ts` (310 lines; pipeline body ends ~line 190)

### Problem

`runFixPipeline` does, sequentially and unconditionally: call Orchestrator → emit unauthorized-breaking warnings → resolve output dirs → write JSON → generate executive markdown → generate SonarQube HTML → write audit trail → propagate exit code. Each output format adds a parallel `if (formatEnabled) { saveReport(...) }` sibling block. Adding PDF, SARIF, or another sink means editing `fix.ts` again.

The unnamed concept here is a **Post-Fix Artifact Pipeline** — an ordered, declarative set of report writers. Today it is an unstructured cascade of conditionals, not a Module with a Seam.

### Solution

Extract a **`ReportArtifactWriter` Module** that takes `OrchestratorResult + config` and iterates a declarative registry:

```ts
type ArtifactAdapter = {
  format: string;
  enabled: (config) => boolean;
  generate: (result, opts) => Promise<void>;
};
```

`runFixPipeline` collapses to:

```ts
const result = await orchestrator();
await artifactWriter.writeAll(result, opts);
return computeExitCode(result);
```

Cloud-upload policy (`require_upload`, error propagation) moves into the corresponding Adapter.

### Benefits

- **Locality**: the two duplicated cloud-upload `if` blocks (one for markdown, one for SonarQube HTML) collapse into a table in the writer.
- **Leverage**: adding a new output format means registering an Adapter, not editing `fix.ts`.
- **Test surface**: one test per Adapter, one test for the writer-loop; `fix.ts` tests no longer need to simulate all output-format combinations.

---

## Candidate 4 — `osvFixOutcome` + last-writer-wins dedup leaks the Fixer into the Updater

### Files

`src/modules/ecosystem/plugins/npm-updater.ts` (lines 178–197); `src/orchestration/run-ecosystem-fix.ts` (lines 95–155, 174); `src/modules/ecosystem/types.ts` (line 28); `src/modules/ecosystem/fixers/osv-fixer.ts`

### Problem

`run-ecosystem-fix.ts` runs OSV staging, captures `osvFixOutcome`, and injects it into the Updater context as a **side-channel parameter**. The Updater then merges `osvFixOutcome.packagesUpdated` with `fixerResult.packagesUpdated` via a last-writer-wins `Map`, with a strategy-conditional branch (`if fixerStrategy === 'osv-then-audit'`). `FixerCallResult` should carry this evidence itself, but does not — so the Updater becomes the join point and must remain aware of the active **Fixer Strategy**.

ADR-0003 Candidate 4 eliminated `plugin.id === 'npm'` special-cases from the orchestration layer. This is the same class of problem at the Updater boundary: strategy-awareness that belongs in the Fixer leaking into the Updater.

### Solution

Move the evidence into the **Fixer**. `run-ecosystem-fix.ts` passes `osvFixOutcome` only to the Fixer. Each Fixer (`osv-fixer`, `osv-then-audit-fixer`) returns a `packagesUpdated` already consolidated through its own dedup logic. The Updater becomes strategy-agnostic:

```ts
return tx.success({ packages_updated: fixerResult.packagesUpdated, ... });
```

### Benefits

- **Locality**: the policy "how to count updated packages when OSV and audit collide" lives in the corresponding Fixer, alongside the strategy it implements.
- **Leverage**: adding a new hybrid Fixer Strategy does not require editing `npm-updater.ts`.
- **Test surface**: the Updater drops dedup tests; the Fixer gains them at the natural level. The side-channel `osvFixOutcome` parameter disappears from the Updater contract.

---

## Candidate 5 — `osvVerifyMode === 'local'` is an escape hatch surviving ADR-0001

### Files

`src/orchestration/run-ecosystem-fix.ts` (lines 217–223); `src/infrastructure/ecosystem-runtime/resolve-osv.ts`

### Problem

Line 218 of `run-ecosystem-fix.ts`:

```ts
const osvVerifyMode = config.scanners?.osv?.runner ?? 'docker';
if (osvVerifyMode === 'local') { ... }
```

ADR-0001 established Docker-only as the OSV execution model. The `runner: 'local' | 'docker'` flag survives in the config schema, and the orchestration layer still branches on it — solely to emit a different log message. `resolveOsvRuntime()` already encapsulates the local-vs-docker decision; the branch in `run-ecosystem-fix.ts` is a **leaking Seam**: the orchestration layer re-implements a routing decision that the infrastructure Module already owns. (Relates to **ADR-0001 — Docker-only OSV**.)

### Solution

`resolveOsvRuntime` should also return the chosen mode label (`'local' | 'docker'`), and the orchestration layer simply calls `logger.tagged('osv', ..., chosen.label)` — no branch. The stronger fix is to close the escape hatch entirely: remove `runner: 'local'` from the config schema, consistent with ADR-0001 and the direction taken throughout the second-cycle review.

### Benefits

- **Locality**: the decision "how to run `osv-scanner`" lives exclusively in `resolve-osv.ts`.
- **Leverage is low** but the outcome is a positive **deletion test**: removing the branch leaves zero complexity in the consumer. The Seam is clean, and ADR-0001 is unambiguously binding.

---

## Candidate 6 — Executive report section builders are private functions without a Seam

### Files

`src/reporting/executive.ts` (619 lines)

### Problem

`executive.ts` mixes `dedupVulns`, `buildSonarQubeExecSection`, `buildAdvisorExecSection`, evidence-section construction, Summary aggregation, and finally a Handlebars render — all as private functions in a single 619-line Module. Adding a new section (e.g. detailed residual verification, expanded advisors, a new secondary Scanner Engine) means editing the monolith. There is no **`ExecutiveReportSection` Seam**.

Testing the SonarQube section today requires assembling the full executive input; there is no way to test it in isolation.

### Solution

Define an Interface:

```ts
interface ExecutiveReportSection {
  id: string;
  build(input: ExecutiveReportInput): SectionData;
}
```

Convert each builder into an **Adapter** implementing the Interface. `generateExecutiveReport` becomes a loop assembling `Record<sectionId, SectionData>` to feed the Handlebars template declaratively via ordered sections.

### Benefits

- **Locality**: each section is isolated and independently testable; i18n for each section lives next to its builder Adapter.
- **Leverage**: adding a new section means registering an Adapter, not editing the 619-line monolith.
- **Test surface**: granular — one test file per section Adapter, replacing the current monolithic integration tests.

---

## Candidate 7 — `src/orchestration/` houses utilities that do not orchestrate

### Files

`src/orchestration/dry-run-preview.ts`; `src/orchestration/lockfile-inspect.ts`

### Problem

Both are **pure** — formatters/inspectors with no dependency on the Orchestrator and no side effects. Their location in `orchestration/` implies coupling that does not exist and dilutes the semantic meaning of the folder. This is a relocation rather than a deepening, but it supports the same goal: `orchestration/` should contain only what orchestrates — `orchestrator.ts`, `run-ecosystem-fix.ts`, and `osv-fix-applier.ts`.

### Solution

Move `dry-run-preview.ts` to `src/reporting/` (or adjacent to the logger, depending on the final dependency review). Complete the `lockfile-inspect.ts` migration — it has already partially moved to `src/modules/ecosystem/utils/lockfile-utils.ts`; finish removing the re-export shim from `orchestration/`.

### Benefits

- **Semantic Locality**: `orchestration/` ends up containing only what orchestrates. Navigating the folder gives an accurate mental model.
- Low-risk relocation with no behaviour change; callers update their import paths and the re-export shim disappears.
