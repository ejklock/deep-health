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

The flag propagates through the runner chain. When the orchestrator creates an `EcosystemContainerCommandRunner`, it passes `dryRun` from the host runner:

```
LocalExecutor (dryRun=true)
  └── EcosystemContainerCommandRunner (dryRun=true)
        └── EphemeralEcosystemContainer (never called — short-circuits at command runner level)
```

**Consequences for plugin authors:**

- Never read `dryRun` from `config` — read it from `runner.dryRun`. The runner is the source of truth.
- In dry-run mode, emit `validations[0].status = 'skipped'`, not `'pass'`. No commands ran, so no validation happened.
- In dry-run mode, return `status: 'success'` (not `'error'`). A dry-run cannot fail because nothing was executed.

---

## Runner Chain (Ecosystem Runtime Container)

In production, the orchestrator wraps `LocalExecutor` with a containerized runner resolved via `resolveEcosystemRuntime()` from `@infra/ecosystem-runtime`:

```
LocalExecutor (host)
    ↓ passed as hostRunner to
EcosystemContainerCommandRunner
    ↓ delegates ecosystem commands to
EphemeralEcosystemContainer
    ↓ executes inside
ephemeral Docker container (node:20, python:3.11-slim, composer:2, etc.)
```

`EcosystemContainerCommandRunner` is parameterized by an `EcosystemRuntimeSpec` (declared on the plugin). It routes each command based on the spec:

| Command shape | Destination |
|---|---|
| First token matches `spec.containerBinaries` | Container (`run` / `runStreaming`) |
| Other CLI command, not host-only | Container via `runShell()` |
| Host-only command (`git`, `gh`, `open`) | `hostRunner` |

Plugin code does not need to know whether it is running in Docker or on the host — it always calls `runner.run()` or `runner.runArgs()` and the runner handles dispatch. See `docs/architecture.md#ecosystem-runtime-container` for the full module diagram and `RunMode` semantics.

```ts
// EcosystemContainerCommandRunner — simplified:
async runArgs(file, args, options) {
  if (this.dryRun) return dryRunResult();
  if (matchesContainerBinary(file, spec.containerBinaries)) {
    return this._runContainer(...);  // → Docker
  }
  if (hasRunShell(this.container) && !isHostOnly(file)) {
    return this.container.runShell([file, ...args].join(' '));  // → Docker via shell
  }
  return this.hostRunner.runArgs(file, args, options);  // → host
}
```

---

## Implementations

| Class | File | Used for |
|---|---|---|
| `LocalExecutor` | `infrastructure/executor/local-executor.ts` | Host runner; passed as `hostRunner` to ecosystem container runners |
| `EcosystemContainerCommandRunner` | `infrastructure/ecosystem-runtime/command-runner.ts` | Unified container runner for npm, pip, composer (parameterized by `EcosystemRuntimeSpec`) |
| `EphemeralEcosystemContainer` | `infrastructure/ecosystem-runtime/ephemeral-container.ts` | Underlying Docker container — `run`/`runStreaming`/`runShell` parameterized by `RunMode` |
| `OsvContainerCommandRunner` | `infrastructure/executor/osv-container-runner.ts` | Routes `osv-scanner` commands to Docker (separate seam — read-only mount, no shell wrap) |

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

| Config field | Source | Shell method | Execution context | Risk |
|---|---|---|---|---|
| `runtime.test_command` | repo owner (Zod-validated) | `run()` — shell | Ecosystem container (per ADR-0001) | Trusted; container-bounded blast radius |
| `ecosystems[].validationCommands[].command` | repo owner | `run()` → `runShell()` | Ecosystem container | Trusted; container-bounded blast radius |
| `ecosystems[].advisors[].command` | repo owner | `run()` — shell | Host runner | Trusted, informational only |
| OAuth URL (`cloud-setup`) | Google OAuth library | `runArgs()` — no shell | Host runner | URL is a discrete argv element; metacharacters are inert |
| Branch names (git operations) | git output | `runArgs()` — no shell | Host runner | External value; shell-safe by design |
| Package names (scan result) | OSV JSON | `runArgs()` — no shell | Ecosystem container | External value; shell-safe by design |

**The trust boundary is the repository owner.** An attacker who can modify `project-config.yml` already has write access to the repository (they could equally modify `package.json`, `.github/workflows/`, etc.). If you use `deep-health` in a context where `project-config.yml` is written by untrusted parties, treat those command strings as untrusted input and audit them before running the tool.

### What Docker-only protects against (and what it doesn't)

After [ADR-0001](./adr/0001-docker-only-runtime.md) (docker-only) and [ADR-0002](./adr/0002-threat-model-and-runtime-hardening.md) (cap-drop hardening), validation and updater commands run inside ephemeral Docker containers with all Linux capabilities dropped (`--cap-drop=ALL`) and setuid escalation blocked (`--security-opt=no-new-privileges`). This **materially reduces the blast radius** of a hostile config compared to the legacy `mode: 'local'` path that ran on the host.

**Docker-only DOES protect against:**

- Reading the host's `$HOME` (SSH keys, AWS credentials, `.npmrc` tokens, shell history)
- Modifying anything outside `/project` on the host filesystem
- Privilege escalation via setuid binaries inside the container
- Raw network sockets, kernel module loading, mount operations, ownership changes (capability-gated operations)
- Persisting beyond the container lifetime — the container is `--rm` (destroyed after each command)

**Docker-only DOES NOT protect against:**

- **Reading or modifying anything inside `/project`** — including `.env`, `.npmrc`, `.composer/auth.json`, source code, `.git/`, lockfiles, generated output. The mount is read-write because package managers must update lockfiles; a hostile command can plant backdoors or steal secrets that already live in the project tree.
- **Outbound network requests** — the container has default Docker bridge networking. A hostile command can exfiltrate project contents to an attacker-controlled server or beacon to a C2.
- **Resource exhaustion** — no `--memory` or `--cpus` limits by default. Fork bombs and disk-fill are not blocked.
- **Container escape via Docker daemon vulnerabilities** — keeping Docker on the host current is the best defense.

**The container is defense in depth, not a sandbox.** If your threat model includes any of the "DOES NOT" items, do not run `deep-health` against untrusted configs. See [ADR-0002](./adr/0002-threat-model-and-runtime-hardening.md) for the full rationale and deferred-mitigations list.

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
