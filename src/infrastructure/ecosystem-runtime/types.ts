/**
 * Ecosystem Runtime Container — types
 *
 * The seam through which an ecosystem plugin's CLI (`npm`, `pip`, `composer`, `php`,
 * etc.) runs in an ephemeral Docker container. A single `EcosystemRuntimeSpec` per
 * ecosystem captures everything that varies; the runtime module owns everything
 * that doesn't (retry, host-gateway, platform resolution, host-only command routing,
 * dry-run shortcut, streaming dispatch, error handling).
 *
 * Adding a new ecosystem = ship one `EcosystemRuntimeSpec` on its plugin. No new
 * provisioner class, no new executor class, no edits to the orchestrator.
 *
 * See CONTEXT.md for vocabulary, ADR-0001 for why this is docker-only.
 */

/**
 * Declarative description of how an ecosystem's CLI runs in an ephemeral container.
 * Lives on the `EcosystemPlugin` as `runtimeSpec`.
 */
export interface EcosystemRuntimeSpec {
  /**
   * Docker image used when no version is configured or inferred.
   * Examples: `'node:lts'`, `'python:3-slim'`, `'composer:2'`.
   */
  readonly defaultImage: string;

  /**
   * Resolves a Docker image from a (possibly undefined) version hint.
   * The hint comes from `scanners.<id>.runtime_version` config, falling back
   * to `plugin.inferVersion(cwd)`. When both are absent, the resolver receives
   * `undefined` and must return a valid image (typically `defaultImage`).
   *
   * Examples:
   *   resolveNpmDockerImage('20.11.1') → 'node:20'
   *   resolvePipDockerImage('3.11')    → 'python:3.11-slim'
   *   resolveComposerDockerImage('8.2') → 'php:8.2-cli'
   */
  readonly resolveImage: (version: string | undefined) => string;

  /**
   * Binaries this spec recognizes as "should run inside the container."
   * The executor uses these to route invocations: a `runner.runArgs('npm', [...])`
   * with an npm spec routes to the container; `runner.runArgs('git', [...])` does
   * not (git is a Host-Only Command — see CONTEXT.md).
   *
   * The match is exact for bare names (`'npm'`) and suffix for paths
   * (`'/usr/bin/npm'` matches `'npm'`).
   */
  readonly containerBinaries: readonly string[];

  /**
   * How argv composes into the `docker run` command line.
   * See `RunMode` for the two supported shapes.
   */
  readonly runMode: RunMode;
}

/**
 * Tagged enum describing how the user's argv reaches the container's process.
 *
 * Two shapes today; add a new `kind` only when a real ecosystem demands it.
 * Avoid making this a generic callback — the enum is part of the spec's
 * declarative contract and should remain introspectable.
 */
export type RunMode = DirectExecRunMode | ShellWrapRunMode;

/**
 * Direct exec — argv reaches the container's process without a shell layer.
 *
 * Final docker invocation:
 *   docker run --rm <flags> <image> <binary> <args...>
 *
 * Used by ecosystems whose CLI tolerates direct exec and whose tokens never
 * contain shell metacharacters (e.g. npm). No shell parsing means tokens are
 * passed as independent argv elements — robust against package names with
 * dots/dashes/etc.
 */
export interface DirectExecRunMode {
  readonly kind: 'direct-exec';

  /**
   * Binary that always prefaces argv inside the container.
   * For npm, this is `'npm'` — so `runArgs('npm', ['install'])` produces
   * the docker invocation `docker run <image> npm install`.
   */
  readonly binary: string;
}

/**
 * Shell wrap — argv is joined into a string and run via `sh -lc "<cmd>"`.
 *
 * Final docker invocation:
 *   docker run --rm <flags> <image> sh -lc "<preamble> && <joined>"
 *
 * Used by ecosystems that need shell features (e.g. pip's `pip install -U pkg`
 * with multiple flags) or on-the-fly bootstrap (composer when running on bare
 * `php:*-cli` images that don't bundle composer).
 *
 * Trust boundary: the joined string passes through `sh -lc`, which re-tokenizes
 * on whitespace and expands shell metacharacters. Variable data (package names,
 * versions, branch names) MUST be passed via `runArgs` *and* must be free of
 * shell metacharacters at the call site. The runtime does not sanitize.
 */
export interface ShellWrapRunMode {
  readonly kind: 'shell-wrap';

  /**
   * Optional preamble injected before the joined command via `&&`.
   * Receives the resolved image string so the preamble can be conditional
   * on image variant (e.g. composer's bootstrap only fires for `php:*-cli`
   * images that lack composer).
   *
   * Return `undefined` to skip the preamble for this image.
   */
  readonly preamble?: (image: string) => string | undefined;
}

/**
 * Result of a single container invocation. Mirrors the existing
 * `infrastructure/provisioner/types.ts#ContainerRunResult` so callers can
 * migrate without changing return shapes.
 */
export interface ContainerRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
