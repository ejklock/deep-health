# ADR 0002 — Threat model and runtime hardening for ecosystem CLI execution

## Status

Accepted — 2026-04-25

## Context

`deep-health` executes user-authored shell commands from `project-config.yml`:

- `ecosystems[].validationCommands[].command` (e.g. `npm test`, `php artisan test --compact`, `pytest -x`)
- `ecosystems[].advisors[].command` (e.g. `npm audit --json`)
- `runtime.test_command` (legacy field, similar trust profile)

These are passed to the runner as **shell strings** (`shell: true` on host, `sh -lc` / `sh -c` inside containers). They are **not** sanitized — operators write them as if writing a shell script, which is intentional. The trust model assumes the repository owner authors `project-config.yml`.

[ADR-0001](./0001-docker-only-runtime.md) made Docker the only runtime for ecosystem CLIs, which materially reduced the blast radius of a hostile config — but did not eliminate it. After ADR-0001, malicious validation commands run inside an ephemeral container instead of on the host, but the container:

- Has `/project` mounted read-write (so package managers can update lockfiles)
- Has default Docker bridge networking (outbound internet reachable)
- Runs as root by default in `node:*`, `python:*`, `composer:*`, `php:*-cli` images
- Has no resource limits (CPU/RAM/disk) by default
- Has full Linux capabilities by default (`CAP_NET_RAW`, `CAP_SYS_PTRACE`, etc. — none needed by package managers)

The remaining attack surface from a hostile validation command:

- **Project tampering** — modify `.git/`, source files, lockfiles, planted backdoors, generated build output
- **Project secret exfiltration** — read `.env`, `.npmrc`, `.composer/auth.json`, anything in the project tree
- **Outbound C2 / data exfiltration** — beacon to attacker-controlled server, leak project contents over HTTP
- **Resource abuse** — fork bombs, disk fill via `dd if=/dev/urandom`
- **Privilege escalation inside the container** — setuid binaries, container-internal kernel exploits

The point: **Docker is isolation from the host, not a sandbox of the project**. Documenting this explicitly matters more than the cap-drop hardening on its own — operators should not have a false sense of security from "it's in Docker".

## Decision

Three actions, all narrow:

### 1. Document the threat model explicitly

Update `docs/command-runner.md` SEC-004 section with:
- Per-row execution-context column in the trust-boundary table
- A new subsection "What Docker-only protects against (and what it doesn't)" listing the residual risks above

This is the highest-leverage action — it sets accurate expectations for operators reading the docs.

### 2. Apply `--cap-drop=ALL` and `--security-opt=no-new-privileges` to every ephemeral container invocation

Add both flags to `EphemeralEcosystemContainer._buildBaseArgs()` so they apply to `run`, `runStreaming`, and `runShell` uniformly. Defense in depth.

- **`--cap-drop=ALL`** drops every Linux capability. Package managers (npm, pip, composer, php) do not need any capability — they only do file I/O and network connect. A hostile command loses the ability to use raw sockets, ptrace, mount filesystems, change ownership, etc.
- **`--security-opt=no-new-privileges`** prevents setuid binaries inside the container from escalating. Even if the image ships a setuid binary (rare in alpine/slim variants), a hostile command cannot leverage it.

These flags are inert for legitimate workloads but block a meaningful class of attacks if the trust boundary is breached.

### 3. Defer more aggressive mitigations

The following were considered but **not** adopted in this ADR:

- **`--network=none` for validation commands** — would break legitimate cases (e.g. integration tests that hit a service in `host.docker.internal`, or tests that pull additional fixtures over HTTP). Could be opt-in via config in a future ADR.
- **`--read-only` root filesystem with explicit `/tmp` tmpfs** — composer's `COMPOSER_BOOTSTRAP` writes to `/usr/local/bin/composer`, which would break. Could be ecosystem-conditional in a future ADR.
- **`--memory=` / `--cpus=` resource limits** — sensible default values are workload-dependent. Defer until a concrete OOM or runaway-process incident makes the right limits clear.
- **Schema-level validation of validation commands** — restricting to `^[a-zA-Z0-9 ./_-]+$` would block legitimate commands like `npm test -- --coverage`. Allowlists are too brittle.
- **Cap-drop on `OsvDockerRunner` and other non-ecosystem containers** — out of scope for this ADR. OSV is read-only mount and runs only `osv-scanner scan`, not user-authored strings, so the threat surface is materially narrower. Worth applying as a separate change but not blocking this one.

## Consequences

### Positive

- The threat model is documented. "It's in Docker, it must be safe" is no longer an unstated assumption.
- Capability drops + `no-new-privileges` close known privilege-escalation paths inside the container.
- The hardening is universal: applies to all three ecosystems via the unified `EphemeralEcosystemContainer` (this is a benefit of the ADR-0001 deepening).
- Tests already pass with the hardening — no behavioral regression for legitimate package-manager workloads.

### Negative

- A future tool that legitimately needs an elevated capability (e.g. a security scanner using `CAP_NET_RAW` for ICMP) would be blocked and would require an opt-out mechanism.
- Two extra flags per `docker run` invocation in logs. Cosmetic.

### Future reconsideration triggers

Revisit this ADR — rather than silently relax the hardening — if any of the following arise:

- A legitimate user case requires elevated capabilities. Document the specific capability needed, the use case, and the mitigation (allow-list rather than drop-all).
- A `--network=none` opt-in becomes worth implementing for high-trust validation environments (e.g., CI runs that enforce no exfiltration).
- A new container runtime backend (Podman, containerd) needs equivalent flags ported.
- Resource exhaustion becomes a real incident — at that point the right `--memory` / `--cpus` defaults will be obvious from the data.

## Related

- [ADR-0001](./0001-docker-only-runtime.md) — docker-only runtime; prerequisite for this hardening to apply universally.
