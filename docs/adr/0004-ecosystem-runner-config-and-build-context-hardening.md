# ADR 0004 — Ecosystem runner config simplification and build context boundary hardening

## Status

Accepted — 2026-04-29

## Context

### Config proliferation: too many image paths

Before this ADR, each ecosystem runner config (npm, pip, composer) carried several overlapping fields that described how to obtain a Docker image:

- `image` — explicit image reference
- `language_version` — version hint for image resolution (was `runtime_version` before the `runners` block split)
- `image_source: 'pull' | 'dockerfile'` — axis introduced in a prior cycle
- `dockerfile_path` — path to Dockerfile
- `build_context` — Docker build context path
- `build_args` — build arguments
- `native_deps` — OS-level packages to install via apt-get (ephemeral path only)

For composer specifically, two additional deprecated fields lingered:

- `image_strategy: 'pull' | 'build'` — predates `image_source`; retained as a no-op
- `framework_profile: 'none' | 'laravel' | 'symfony' | 'wordpress'` — paired with `image_strategy='build'`; also retained as a no-op

The co-existence of `image_source` and `image_strategy` made the composer config surface confusing. A user reading `composer.image_strategy` had no obvious signal that the field was inert. The `framework_profile` field was similarly dead weight. Both were documented as deprecated and marked for removal — this ADR removes them.

More broadly, the fields across the three runners implied a richer customization surface than was actually present. In practice, there are exactly two paths to obtaining a Docker image for an ecosystem runner:

- **Ephemeral (pull)**: the CLI resolves a registry image (from `image`, `language_version`, or inference) and runs it directly. The user's only customization knobs are `language_version` and `native_deps` (OS packages injected at container start via preamble). This is the default and covers the large majority of use cases.
- **Dockerfile**: the user owns a Dockerfile; the CLI builds a local image from it and runs that. The user's customization knobs are `dockerfile_path`, `build_context`, and `build_args`. If a user needs more than what the ephemeral path offers, this is the escape hatch.

There is no third path. Codifying this as a two-path model in the schema and documentation eliminates ambiguity.

### Build context boundary: warn-only is exploitable

`src/infrastructure/ecosystem-runtime/build-project-image.ts` contained a warn-only check for the Docker build context boundary:

```typescript
// warn-only — does not block
if (
  contextDir !== resolvedProjectDir &&
  !contextDir.startsWith(resolvedProjectDir + path.sep)
) {
  logger.warn(`build_context "${buildContext}" resolves outside the project directory...`);
}
```

This check had two weaknesses:

1. **It only warned.** A config with `build_context: '../../'` would proceed silently after emitting a log line that may not be visible in CI output. The full parent directory tree would be sent to the Docker daemon as build context, potentially exposing `.env` files, SSH keys, credentials, and other sensitive files.

2. **There was no upper bound.** A monorepo legitimately needs the build context to reach the repository root (e.g., a PHP project in `app/` that references shared config at `../shared/`). But there is no reason for the context to escape the repository root. The warn-only check treated `../../../../../../` identically to `../` — both just warned.

The correct upper bound for the build context is the **git repository root** (resolved via `git rev-parse --show-toplevel`). When git is unavailable or the project is not inside a git repository, the fallback is `projectDir` itself, which is the most conservative safe default.

The current behavior should be replaced with an enforced boundary:

- Build context inside the allowed root: silent, proceed.
- Build context outside the allowed root, no explicit opt-out: throw with an actionable error.
- Build context outside the allowed root, `allow_build_context_escape: true` in the runner config: emit a security warning and proceed (explicit, logged opt-in).

This enforcement applies to **both** image paths — the ephemeral path does not use a custom build context today, but the same boundary assertion is applied defensively wherever `contextDir` is resolved, to prevent future regressions.

## Decision

### 1. Two-path model for all ecosystem runners

The config surface is defined as exactly two paths, consistent across npm, pip, and composer:

**Path A — Ephemeral (`image_source: 'pull'`, default)**

The CLI auto-builds an ephemeral container from a registry image. User-configurable fields:

| Field | Purpose |
|---|---|
| `language_version` | Node/Python/PHP version hint for image resolution |
| `native_deps` | OS packages installed via apt-get in the container preamble |

If deeper customization is needed (e.g., custom base image, additional build steps, private registry), the user switches to Path B.

**Path B — Dockerfile (`image_source: 'dockerfile'`)**

The user provides a Dockerfile. The CLI builds a local image from it. User-configurable fields:

| Field | Purpose |
|---|---|
| `dockerfile_path` | Path to Dockerfile, relative to project root (required) |
| `build_context` | Docker build context directory, relative to project root |
| `build_args` | `--build-arg KEY=VALUE` pairs forwarded to `docker build` |

`native_deps` is not applicable on Path B — the Dockerfile owns its own build steps.

The `image` field remains available on Path A as an explicit override (higher priority than `language_version`). It is mutually exclusive with `image_source: 'dockerfile'`, enforced by schema `superRefine`.

### 2. Remove deprecated composer fields — no backward compatibility

`image_strategy` and `framework_profile` are removed from:

- `ComposerRunnerConfig` interface (`src/core/types/config.ts`)
- `ComposerRunnerConfigSchema` Zod schema (`src/infrastructure/config/schema.ts`)
- `init.ts` interactive prompt (`src/app/commands/init.ts`)
- Config generator options (`src/infrastructure/config/generator.ts`)
- Handlebars template (`src/infrastructure/config/templates/project-config.hbs.ts`)
- `php-profiles.ts` comment references (`src/infrastructure/provisioner/php-profiles.ts`)

Existing config files that contain `image_strategy` or `framework_profile` under `runners.composer` will fail at schema load time with a clear error message. Because the schema uses `.strict()`, unknown fields are rejected. The error message should guide the user to remove the deprecated fields and use `image_source: 'dockerfile'` + `dockerfile_path` if they were using `image_strategy: 'build'`.

There is no migration shim. The tool is pre-production. The one-release deprecation window has elapsed.

### 3. Enforce build context boundary

A new module `src/infrastructure/ecosystem-runtime/resolve-build-context-boundary.ts` is introduced with two exports:

**`resolveAllowedBuildContextRoot(projectDir)`**

Calls `git -C <projectDir> rev-parse --show-toplevel` via `execFile`. Returns the git root with `source: 'git'` on success. Falls back to `{ root: projectDir, source: 'project-dir' }` on any failure (no git, non-zero exit, bare repo, git worktree). Results are cached in a module-level `Map<string, Promise<...>>` to avoid duplicate subprocess calls within a single CLI invocation.

**`assertBuildContextWithinBoundary({ contextDir, allowedRoot, boundarySource, logPrefix, allowEscape? })`**

- `contextDir` inside `allowedRoot`: silent, proceed.
- `contextDir` outside `allowedRoot` and `allowEscape !== true`: throw with actionable message including the resolved paths, the boundary source (`'git root'` or `'project directory'`), and a hint to set `allow_build_context_escape: true`.
- `contextDir` outside `allowedRoot` and `allowEscape === true`: `logger.warn` with security warning. Warning text: `build_context "<path>" is outside the project boundary ("<allowedRoot>"). The full directory tree will be sent to the Docker daemon — this may expose sensitive files. Set allow_build_context_escape: false to enforce the boundary.`

Both paths use `fs.realpath` on `contextDir` and `allowedRoot` before comparison to defend against symlink escapes. Containment is checked via `path.relative(allowedRoot, contextDir)` — context is inside the boundary when the relative path does not start with `..` (cross-platform, no string prefix matching).

The warn-only block in `build-project-image.ts` (lines 123–138) is replaced by a call to these two functions.

### 4. Add `allow_build_context_escape` to all three runner configs

A new `allow_build_context_escape?: boolean` field (default `false`) is added to `NpmRunnerConfig`, `PipRunnerConfig`, and `ComposerRunnerConfig` in both the TypeScript interface and the Zod schema. It is only meaningful when `image_source: 'dockerfile'` and `build_context` resolves outside the allowed root. The schema does not validate the boundary (that is a runtime concern). The resolver passes the field value as `allowBuildContextEscape` to `buildProjectImage`.

## Consequences

### Positive

- Config surface is smaller and unambiguous. Users face a binary choice: managed ephemeral image (Path A) or bring-your-own Dockerfile (Path B).
- Dead fields (`image_strategy`, `framework_profile`) are gone. No confusion about inert config.
- Build context escapes are now hard failures by default instead of silent warnings. Operators who need the escape hatch must explicitly acknowledge the security implication.
- The git root as boundary covers monorepo use cases cleanly. A project in `apps/api/` can reach `../../` (the repo root) without triggering an error.
- `fs.realpath` + `path.relative` containment check is robust against symlink attacks and cross-platform path separators.
- Module-level caching avoids repeated `git rev-parse` subprocess calls when multiple ecosystems are processed in the same run.

### Negative

- Breaking change for any user who had `image_strategy` or `framework_profile` in their composer config. The schema's `.strict()` will produce an error at startup. Error message must be descriptive enough to guide migration.
- Breaking change for any user whose `build_context` currently escapes the git root silently. They must now add `allow_build_context_escape: true` explicitly.
- `allow_build_context_escape` is per-runner. There is no global override flag. Users with multiple runners all escaping the boundary must set the flag on each runner individually. This is intentional — granularity reduces silent exposure.

### Future reconsideration triggers

- If a pattern emerges where the git root is not the right boundary for a class of repos (e.g., nested git submodules where the inner root is too restrictive), revisit `resolveAllowedBuildContextRoot` to accept a configurable override.
- If `native_deps` on Path B becomes a requested feature, revisit whether the distinction between paths is truly clean or whether preamble injection should be available on both.
- If `.dockerignore` awareness is added to the large-context warning, the boundary check and the size estimation may want to share the same context resolution path.

## Related

- [ADR-0001](./0001-docker-only-runtime.md) — Docker-only runtime; prerequisite. All ecosystem CLI commands run in containers — the build context boundary only matters in a Docker-first model.
- [ADR-0002](./0002-threat-model-and-runtime-hardening.md) — Threat model and runtime hardening. This ADR closes a specific gap in the threat model: unintentional filesystem exposure via an unchecked `build_context` value.
