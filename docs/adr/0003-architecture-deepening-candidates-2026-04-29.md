# ADR-0003 — Architecture Deepening Candidates (2026-04-29)

**Status:** Proposed  
**Date:** 2026-04-29

---

## Context

A codebase architecture review was performed on 2026-04-29. Six deepening candidates were identified. This document records them in priority order as a living reference for future implementation tasks.

---

## Candidates

### Candidate 1 — Updater Transaction owns revert semantics *(HIGH)*

**Location:** `src/modules/ecosystem/utils/updater-transaction.ts`, all Updaters  
**Problem:** Each updater (`npm-updater`, `composer-updater`) hand-rolls a `revertXxxChanges` that performs the same double-restore dance: `restoreFiles → bootstrap → restoreFiles`. The double-restore exists because the bootstrap rewrites the lockfile. The Updater Transaction owns failure shape but not revert semantics, so the duplicated pattern lives in plugin code. `pip` will inherit the same shape.  
**Direction:** Deepen `beginUpdaterTransaction` to own a "bootstrap + verify byte-identical" revert phase. Bootstrap command is an opaque spec provided by the calling Updater. Revert aborts immediately on failure. Transaction builds the `UpdateResultJson` error payload. Pattern applied uniformly to all Updaters.

---

### Candidate 2 — fix.ts pipeline-exit control-flow smell *(MEDIUM)*

**Location:** `src/infrastructure/utils/git-commit.ts` (`createBranchAndCommit`), `fix.ts`  
**Problem:** `fix.ts` throws `Error('__pipeline_exit_N')` to bail out of `createBranchAndCommit` while preserving an exit code. The wrapper interface forces the body to either succeed (commit) or throw (rollback), with no clean third option for "pipeline finished with non-zero exit, rollback without crashing."  
**Direction:** Re-shape `createBranchAndCommit` so its body returns a typed outcome (`commit | rollback-and-return | propagate`). Remove `__pipeline_exit_N` throw convention.

---

### Candidate 3 — Collapse OSV container adapter onto Ecosystem Runtime *(MEDIUM)*

**Location:** `src/infrastructure/executor/OsvContainerCommandRunner`, `src/infrastructure/ecosystem-runtime/`  
**Problem:** Two parallel container `CommandRunner` adapters exist at the same seam with different fallback semantics: `EcosystemContainerCommandRunner` (modern, uses `hostRunner`) and `OsvContainerCommandRunner` (legacy, still calls its host-runner slot `fallback`, the name ADR-0001 renamed).  
**Direction:** Treat OSV as a runtime spec inside the Ecosystem Runtime Container module. Retire `OsvContainerCommandRunner`. Unify `hostRunner` naming.

---

### Candidate 4 — Per-plugin "resolve effective fixer" hook *(MEDIUM)*

**Location:** `src/orchestration/run-ecosystem-fix.ts`  
**Problem:** `runEcosystemFix` inlines fixer-strategy resolution including npm-only lockfile-v1 auto-demotion (`if plugin.id === 'npm' && lockfileVersion === 1 → npm-audit`). This is a plugin-specific concern living in orchestration.  
**Direction:** Add `EcosystemPlugin.resolveEffectiveFixer(configuredStrategy, context): FixerStrategy` hook. The npm plugin handles the v1 demotion internally. `runEcosystemFix` calls the hook and drives a generic strategy.

---

### Candidate 5 — OSV residual-verify runner as scanner-runtime spec *(LOW — follows Candidate 3)*

**Location:** `resolveOsvCommandRunner` at the bottom of `src/orchestration/run-ecosystem-fix.ts`  
**Problem:** A private `resolveOsvCommandRunner` factory lives inside the orchestration file and hand-builds an `OsvDockerRunner + OsvContainerCommandRunner`, shadowing the ecosystem runtime resolver with a parallel concept.  
**Direction:** Register OSV as a scanner-runtime spec (follows Candidate 3). Retire the private factory.

---

### Candidate 6 — Delete dead provisioner files *(CLEANUP)*

**Location:** `src/infrastructure/provisioner/npm-runner.ts`, `composer-runner.ts`, `pip-runner.ts`  
**Problem:** These files were superseded by the unified ephemeral-container after ADR-0001's deepening. If no callers remain, they carry dead complexity.  
**Direction:** Verify no callers; delete.

---

## Implementation Order (suggested)

1. **Candidate 1** — unblocks clean Updater refactors for pip and future ecosystems.  
2. **Candidate 6** — cheap cleanup, reduces noise for subsequent work.  
3. **Candidates 3 + 5** — tackle together; 5 depends on 3.  
4. **Candidate 4** — can be done independently after 1.  
5. **Candidate 2** — isolated; tackle when the git/PR workflow is next touched.

---

## Agreed Decisions — Candidate 1 (recorded 2026-04-29)

These decisions were made during the 2026-04-29 review session and must guide the implementation task.

### Contract

`beginUpdaterTransaction` receives a **bootstrap spec** — an opaque value containing the command and runner needed to reinstall dependencies. The calling Updater (npm, composer, pip) provides this spec; the transaction does not know what tool is being run.

### Revert phase (owned by the transaction)

1. Restore all backup files to the working tree (`restoreFiles`).
2. Run the bootstrap command from the spec (e.g. `npm ci`, `composer install --no-interaction --no-scripts`).
3. Restore backup files a second time — this second pass overwrites what the bootstrap rewrote to the lockfile, leaving the tree byte-identical to the pre-fix snapshot.
4. If any step fails, abort immediately and surface the error; do not swallow.

### Error payload

The transaction builds the `UpdateResultJson` error payload (status `'error'`, validations, error message). Individual updaters do not construct this payload themselves.

### Working-tree check

After the revert phase, the transaction verifies the working tree is clean (byte-identical backups). Any residual modification is itself treated as a failure.

### Runner

The transaction uses the same `CommandRunner` instance that was passed to `beginUpdaterTransaction`. No second runner is accepted.

### Scope

The pattern applies uniformly to **all** Updaters: npm, composer, and any future ecosystem (pip, etc.). Each updater's bootstrap spec differs; the transaction protocol is the same.

### Files to touch (implementation time)

| File | Change |
|---|---|
| `src/modules/ecosystem/utils/updater-transaction.ts` | Add `bootstrapSpec` to transaction options; implement revert phase; build error payload |
| `src/modules/ecosystem/npm/npm-updater.ts` | Remove hand-rolled `revertNpmChanges`; pass bootstrap spec to transaction |
| `src/modules/ecosystem/composer/composer-updater.ts` | Remove hand-rolled `revertComposerChanges`; pass bootstrap spec to transaction |
| `src/modules/ecosystem/pip/pip-updater.ts` *(if exists)* | Adopt same pattern on creation |

---

## Refinement — 2026-05-01

A grilling session on 2026-05-01 walked the implementation against the actual code and surfaced five points where the original "Agreed Decisions" did not survive contact with reality. The original decisions remain valid in spirit; the resolutions below sharpen them.

### Resolution 1 — `osv-then-audit` partial-revert is OUT of scope

The npm updater's `osv-then-audit` strategy has a *partial* revert path (restore intermediate backup → `npm ci` → restore again → re-run validation → either `tx.success` with OSV-only packages or fall through to full revert). This is not the standard restore→bootstrap→restore protocol — it can terminate in success.

**Decision:** the Updater Transaction does NOT cover this partial-revert. It remains hard-coded inside `npm-updater.ts` for now, marked with a `TODO: move into fixer` comment. A separate follow-up TaskEnvelope will move the partial-revert into the `osv-then-audit` fixer (`src/modules/ecosystem/fixers/`), so the npm updater sees the fixer as opaque.

### Resolution 2 — Working-tree dirty-tree check stays warn-only

The original ADR said "any residual modification is itself treated as a failure." Code reality (npm-updater.ts:60–77) treats dirty-tree as warn-only because external edits during a run are a legitimate cause and should not abort the pipeline.

**Decision:** the Updater Transaction performs the dirty-tree check as **warn-only**. This supersedes the original "Working-tree check" subsection which said dirty-tree is a failure.

### Resolution 3 — `bootstrapSpec` covers revert only, not pre-flight env-check

The composer updater runs `composer install --no-interaction --no-scripts` twice: once before the transaction begins (env-check), and once during revert. The original spec was ambiguous about whether `bootstrapSpec` should cover both.

**Decision:** `bootstrapSpec` describes the **revert** bootstrap only. The composer pre-flight env-check stays where it is (before `beginUpdaterTransaction`), unchanged. Inflating the spec to cover env-check would force npm and pip into env-check semantics they do not have.

### Resolution 4 — Module name remains "Updater Transaction"

No rename. The term is already in `CONTEXT.md` and the database-transaction analogy fits the begin → mutate → commit-or-rollback shape.

### Resolution 5 — Revert bootstrap failure ALWAYS throws

Today the three updaters diverge: npm throws on `npm ci` revert failure; pip logs and continues silently; composer does not check the exit code at all.

**Decision:** the Updater Transaction always throws when the revert bootstrap exits non-zero. This unifies behavior and surfaces ambiguous on-disk state. **Behavior change:** pip and composer move from silent-on-revert-failure to throw-on-revert-failure. Each updater's outer `try/catch` wraps the propagated error as `PhaseError`, preserving the existing error-surfacing contract at the orchestration boundary.

### Updated contract summary

```ts
export interface BootstrapSpec {
  binary: string;
  args: readonly string[];
  label: string;
}

export interface BeginUpdaterTransactionOptions {
  files: readonly string[];
  base: UpdateResultJson;
  cwd: string;
  runner: CommandRunner;
  bootstrapSpec: BootstrapSpec;
  preExistingBackups?: Map<string, string>;
  preRunSnapshots?: Map<string, string>;
}

export interface UpdaterTransaction {
  readonly backups: Map<string, string>;
  success(opts: { packages_updated: string[]; validations: ValidationEntry[] }): UpdateResultJson;
  abortWithError(opts: { error: string; validations: ValidationEntry[] }): Promise<UpdateResultJson>;
}
```

The transaction owns: backup capture, success-shape build, restore→bootstrap→restore-byte-identical revert protocol, warn-only dirty-tree check, error-shape build, throw-on-revert-failure.

The Updater owns: pre-flight checks (composer env-check), fixer invocation, validation orchestration, post-success package-list extraction, the `osv-then-audit` partial-revert (temporarily — see Resolution 1).

### Updated file change list

| File | Change |
|---|---|
| `src/modules/ecosystem/utils/updater-transaction.ts` | Add `BootstrapSpec`, accept `runner` + `bootstrapSpec` + `preRunSnapshots`; implement revert protocol; remove `revert` callback from `abortWithError` |
| `src/modules/ecosystem/plugins/npm-updater.ts` | Remove `revertNpmChanges`; pass `BootstrapSpec` for `npm ci`; `osv-then-audit` partial-revert remains, marked TODO |
| `src/modules/ecosystem/plugins/composer-updater.ts` | Remove `revertComposerChanges`; pass `BootstrapSpec` for `composer install …` (env-check stays) |
| `src/modules/ecosystem/plugins/pip-updater.ts` | Remove `revertPipChanges`; pass `BootstrapSpec` for `pip install -r requirements.txt`; **behavior change**: revert bootstrap failure now throws |

## Refinement 2026-05-02 — Candidate 5 resolved

`resolveOsvCommandRunner` (private factory in `run-ecosystem-fix.ts`) promoted to
`resolveOsvRuntime()` in `src/infrastructure/ecosystem-runtime/resolve-osv.ts`.

Resolutions:
1. The factory is lifted verbatim — logic unchanged, only location changes.
2. `run-ecosystem-fix.ts` imports `resolveOsvRuntime` from `@infra/ecosystem-runtime` barrel.
3. `osvRuntimeSpec` import removed from `run-ecosystem-fix.ts`; it is an internal detail of the helper.
4. `OsvDockerRunner` not touched — it serves the scan engine + fix-applier at a different abstraction level.
5. Barrel export added to `ecosystem-runtime/index.ts`.

## Refinement 2026-05-02 — `osv-then-audit` partial-revert moved into fixer

The TODO comment from Candidate 1 (Refinement 2026-05-01) is resolved. The inline `osv-then-audit` partial-revert block in `npm-updater.ts` is now a strategy-agnostic delegation through `FixerCallResult.partialRevert`.

### Changes

| File | Change |
|---|---|
| `src/modules/ecosystem/utils/updater-transaction.ts` | `revertWithBootstrap` exported (was internal). No logic change. |
| `src/modules/ecosystem/fixers/index.ts` | `FixerCallResult` gains `partialRevert?: (runner, cwd) => Promise<void>` |
| `src/modules/ecosystem/fixers/osv-then-audit-fixer.ts` | Imports `revertWithBootstrap`; builds `partialRevert` closure capturing `bootstrapSpec` + `intermediateBackup`; returns it in result |
| `src/modules/ecosystem/plugins/npm-updater.ts` | Replaces `if (fixerStrategy === 'osv-then-audit' && fixerResult.intermediateBackup)` with strategy-agnostic `if (fixerResult.partialRevert)`; `restoreFiles` import removed |
| `tests/unit/plugins/osv-then-audit-fixer.test.ts` | New tests: `partialRevert` defined on success, invokes `revertWithBootstrap` with correct args, undefined on early-return paths |
| `tests/unit/plugins/npm-updater.test.ts` | Old inline-path tests updated; new `describe('partialRevert delegation (AC7)')` block: AC7a–AC7c + strategy-agnostic guard |

### Resolutions

1. `revertWithBootstrap` is exported without changing its signature or logic — the fixer captures the correct param order `(runner, bootstrapSpec, backups, cwd)`.
2. `FixerCallResult.intermediateBackup` is retained for test introspection; `partialRevert` is an additional optional field.
3. When `partialRevert` throws (bootstrap exits non-zero), `npm-updater.ts` does **not** fall back to full revert — the `PhaseError` propagates. Full revert is only triggered if `partialRevert` is absent or succeeds but re-validation still fails.
4. The `fixerStrategy === 'osv-then-audit'` special-case is entirely removed from the orchestration layer; the fixer itself decides whether to attach a `partialRevert`.
5. 1726 tests pass; `tsc --noEmit` clean.
