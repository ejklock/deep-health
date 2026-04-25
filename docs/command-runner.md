# CommandRunner — Interface & Security Model

## Overview

`CommandRunner` (`src/core/types/common.ts`) is the single abstraction through which every plugin, updater, and scanner executes shell commands. It has two methods with distinct semantics:

```ts
interface CommandRunner {
  run(command: string, options?: CommandRunnerOptions): Promise<CommandResult>;
  runArgs(file: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult>;
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv;  // 'docker' | 'local'
}
```

---

## `run()` vs `runArgs()` — when to use which

### `run(command)` — for static, trusted commands

`run()` executes via a shell (`shell: true` in `execa`). This means the entire `command` string is passed to `/bin/sh -c`. Shell features (pipes, redirects, variable expansion) work, but **any untrusted value embedded in the string can cause shell injection**.

**Use `run()` only when:**
- The command string is fully static (hard-coded)
- Or it is composed only from values that come from your own config schema (validated by Zod), not from external sources

```ts
// OK — fully static
await runner.run('composer --version', { cwd });

// OK — config-controlled value, Zod-validated
await runner.run(config.runtime.test_command, { cwd });

// NEVER — branch name from git output is untrusted
await runner.run(`git push origin ${branchName}`);  // shell injection risk
```

### `runArgs(file, args)` — for anything with untrusted values

`runArgs()` executes via `execFile` without a shell (`shell: false`). The `file` binary is invoked directly and `args` are passed as a proper `argv` array. Shell metacharacters in any `args` element are inert.

**Use `runArgs()` when:**
- Any argument contains a value from outside your process: branch names, OAuth tokens, user-supplied strings, environment-derived values
- You are constructing a command programmatically

```ts
// Safe — branchName cannot inject shell commands
await runner.runArgs('git', ['push', 'origin', branchName], { cwd });

// Safe — OAuth URL opened without shell
await runner.runArgs('open', [oauthUrl], {});

// Safe — package name from scan result (external data)
await runner.runArgs('npm', ['install', packageName, '--save'], { cwd });
```

---

## `dryRun` Flag

When `dryRun: true`, **every implementation must return immediately without executing anything**:

```ts
// LocalExecutor behavior in dry-run:
if (this.dryRun) {
  return { stdout: '', stderr: '', exitCode: 0, command, dryRun: true };
}
```

The flag propagates through the runner chain. When the orchestrator creates an `NpmContainerCommandRunner`, it passes `dryRun` from the base runner:

```
LocalExecutor (dryRun=true)
  └── NpmContainerCommandRunner (dryRun=true)
        └── NpmDockerRunner (never called — short-circuits at ContainerCommandRunner level)
```

**Consequences for plugin authors:**

- Never read `dryRun` from `config` — read it from `runner.dryRun`. The runner is the source of truth.
- In dry-run mode, emit `validations[0].status = 'skipped'`, not `'pass'`. No commands ran, so no validation happened.
- In dry-run mode, return `status: 'success'` (not `'error'`). A dry-run cannot fail because nothing was executed.

---

## Runner Chain (Container Strategy)

In production, the orchestrator wraps the base `LocalExecutor` with a per-ecosystem container runner:

```
LocalExecutor (base)
    ↓ wrapped by
NpmContainerCommandRunner
    ↓ delegates to
NpmDockerRunner
    ↓ executes inside
ephemeral Docker container (node:20-slim)
```

Each wrapper intercepts only the commands it owns (e.g. `npm install`, `npm audit fix`) and passes everything else to the `fallback` (base runner). This design means the plugin code does not need to know whether it is running in Docker or locally — it always calls `runner.run()` or `runner.runArgs()` and the runner handles the dispatch.

```ts
// From NpmContainerCommandRunner — simplified:
async run(command, options) {
  if (this.dryRun) return dryRunResult(command);
  if (isNpmCommand(command)) {
    return this.container.run(command, options); // → Docker
  }
  return this.fallback.run(command, options);    // → LocalExecutor
}
```

---

## Implementations

| Class | File | Used for |
|---|---|---|
| `LocalExecutor` | `infrastructure/executor/local-executor.ts` | Base runner; used in tests and local mode |
| `NpmContainerCommandRunner` | `infrastructure/executor/npm-container-runner.ts` | Routes npm commands to Docker |
| `PipContainerCommandRunner` | `infrastructure/executor/pip-container-runner.ts` | Routes pip commands to Docker |
| `ComposerContainerCommandRunner` | `infrastructure/executor/composer-container-runner.ts` | Routes composer/php commands to Docker |
| `OsvContainerCommandRunner` | `infrastructure/executor/osv-container-runner.ts` | Routes osv-scanner commands to Docker |

---

## `CommandRunnerOptions`

```ts
interface CommandRunnerOptions {
  cwd?: string;       // Working directory for the command
  timeout?: number;   // Milliseconds; no timeout if omitted
  env?: Record<string, string>;  // Merged with process.env
  stream?: boolean;   // Pipe stdout to parent process in real-time (for long-running commands)
}
```

Always pass `cwd` explicitly. Do not rely on the process working directory — the orchestrator may run commands against different project directories.

---

## `CommandResult`

```ts
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;   // The command string as dispatched (for logging)
  dryRun: boolean;   // true when the result was short-circuited by dryRun
}
```

**Never throw on non-zero exit codes.** Inspect `exitCode` and `stderr` in the caller. `LocalExecutor` catches all errors from `execa` and returns them as `CommandResult` with `exitCode: 1`. The only exceptions are:
- `ENOENT` — command not found → throws `EnvironmentError` (unrecoverable; the tool is not installed)
- Truly unexpected errors (not from the child process) → returned with `exitCode: 1, stderr: err.message`

---

## SEC-004 — Trust Boundary Summary

`deep-health` executes command strings that come from `project-config.yml`. The trust model is:

| Config field | Source | Shell method | Risk |
|---|---|---|---|
| `runtime.test_command` | repo owner (Zod-validated) | `run()` — shell | Trusted (repo owner controls the file) |
| `ecosystems[].validationCommands[].command` | repo owner | `run()` — shell | Trusted |
| `ecosystems[].advisors[].command` | repo owner | `run()` — shell | Trusted, informational only |
| OAuth URL (`cloud-setup`) | Google OAuth library | `runArgs()` — no shell | URL is a discrete argv element; metacharacters are inert |
| Branch names (git operations) | git output | `runArgs()` — no shell | External value; shell-safe by design |
| Package names (scan result) | OSV JSON | `runArgs()` — no shell | External value; shell-safe by design |

**The trust boundary is the repository owner.** An attacker who can modify `project-config.yml` already has write access to the repository. If you use `deep-health` in a context where `project-config.yml` is written by untrusted parties, treat those command strings as untrusted input and audit them before running the tool.

---

## Mocking `CommandRunner` in Tests

In tests, never use `LocalExecutor` directly — mock the interface:

```ts
function makeRunner(overrides: { dryRun?: boolean } = {}): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    runArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, command: '', dryRun: false }),
    dryRun: overrides.dryRun ?? false,
    environment: 'local',
  } as unknown as CommandRunner;
}
```

Asserting that a specific method was NOT called in dry-run is as important as asserting it WAS called in normal mode:

```ts
it('dry-run: never executes commands', async () => {
  const runner = makeRunner({ dryRun: true });
  await myPlugin.runUpdater({ runner, ... });
  expect(runner.run).not.toHaveBeenCalled();
  expect(runner.runArgs).not.toHaveBeenCalled();
});
```
