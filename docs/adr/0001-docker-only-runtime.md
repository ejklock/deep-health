# ADR 0001 — Docker-only runtime for ecosystem CLIs

## Status

Accepted — 2026-04-25

## Context

The orchestrator dispatches per-ecosystem CLI commands (`npm`, `pip`, `composer`, `php`) to fix vulnerabilities and run validations. Three runtime modes existed historically, controlled by `scanners.{npm,pip,composer}.mode` in project config:

- `mode: 'docker'` — run the CLI in an ephemeral Docker container with the project mounted at `/project`. The configured default.
- `mode: 'local'` — run the CLI directly on the host using whatever toolchain is installed. The resolver returned the base `CommandRunner` unchanged.
- `mode: 'auto'` — try Docker, fall back to local. Already marked deprecated.

Maintaining the `local` and `auto` modes had real costs:

- The three `resolveXxxContainerRunner` functions in `orchestrator.ts` each branched on mode (~30 lines), duplicated three times.
- The `*ContainerCommandRunner` adapters carried a `fallback: CommandRunner` parameter that conflated two concerns into one slot: "route host-only commands (`git`, `gh`, `open`) to the host" *and* "if mode=local, send everything to the host."
- `local` mode bypassed the security and reproducibility guarantees that Docker provides:
  - Postinstall scripts run during `npm install` and `composer install` execute arbitrary code with full host privileges (`$HOME`, SSH keys, credentials).
  - Toolchain drift between developer machines, CI runners, and clients defeats the auditability of generated PRs — the same fix can produce different lockfiles on different hosts.
  - Composer in particular requires PHP profile-aware image resolution (`src/infrastructure/provisioner/php-image-resolver.ts` + `php-profiles.ts`) that local PHP installs rarely match.
- The project is pre-production. Removing modes incurs no migration cost beyond a hard config-load error.

This ADR is paired with the deepening of the runtime container layer (collapsing three triplicated runners into one parameterized `Ecosystem Runtime Container`). Removing local/auto is a precondition for that deepening to work cleanly — the unified resolver should have one return path (a container-backed `CommandRunner`), not a branch.

## Decision

Drop `mode: 'local'` and `mode: 'auto'`. Remove the `mode` field from the config schema entirely. All ecosystem CLI commands run in ephemeral Docker containers via the unified `Ecosystem Runtime Container` module (`src/infrastructure/ecosystem-runtime/`).

Host-only commands (`git`, `gh`, `open`) continue to run on the host through a parameter renamed to `hostRunner` — its single, honest purpose now.

The config loader rejects `mode: 'local'` and `mode: 'auto'` with a clear error pointing to this ADR.

## Consequences

### Positive

- The runtime resolver has one return path. The deepening collapses cleanly.
- `hostRunner` has one purpose (route host-only commands). The dual-meaning of `fallback` goes away.
- Stronger isolation for postinstall scripts.
- Reproducible runs across dev, CI, and client environments.
- Smaller config surface — one less knob to misconfigure.

### Negative

- Docker is a hard dependency. Environments without Docker cannot run the tool. Acceptable for the tool's purpose (security-grade dependency updates) but worth flagging in install docs.
- Pre-existing configs with `mode: 'local'` or `mode: 'auto'` fail at config-load time. Pre-production, so blast radius is minimal.

### Future Reconsideration Triggers

Revisit this ADR — rather than silently re-introducing `mode: 'local'` — if any of the following arise:

- A concrete operator request to run without Docker (CI environment that forbids Docker-in-Docker, air-gapped hosts, etc.).
- A second runtime backend emerges (e.g., Podman, containerd) — the abstraction may need to widen.
- A bug or limitation in the Docker runtime that's only solvable by host fallback for specific commands.

Each of those would update this ADR's status (e.g., `Superseded by ADR-0XXX`) rather than be addressed by spreading mode branching back through the resolver.
