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
