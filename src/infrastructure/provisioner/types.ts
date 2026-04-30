// ─── EphemeralContainerRunner contract ─────────────────────────────────────────

/**
 * Canonical result type for a one-shot ephemeral container execution.
 *
 * Both `DockerSonarScannerRunner` and `OsvDockerRunner` produce this shape.
 * The `exitCode` reflects the container's exit code (0 = success).
 */
export interface ContainerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * EphemeralContainerRunner — contract for one-shot container execution.
 *
 * An ephemeral runner starts a container, executes a tool, captures output,
 * removes the container (via `--rm`), and returns the result.
 *
 * There is no persistent lifecycle: each `run()` call is self-contained.
 *
 * @typeParam TArgs - The type of tool-specific arguments passed to `run()`.
 *   Defaults to `string[]` (a flat args array, no shell quoting hazards).
 */
export interface EphemeralContainerRunner<TArgs = string[]> {
  run(args: TArgs): Promise<ContainerRunResult>;
  /**
   * Execute an arbitrary shell command inside the container.
   * `command` is passed as a single argv element to `sh -c` — not interpolated.
   * Optional: implemented by npm/pip/composer runners; absent on osv/sonar runners.
   */
  runShell?(command: string, opts?: { cwd?: string; timeout?: number }): Promise<ContainerRunResult>;
}

// ─── ServiceProvisioner contract ────────────────────────────────────────────────

/**
 * ServiceProvisioner — contract for ephemeral service lifecycle management.
 *
 * A provisioner creates an on-demand service (e.g. a Docker container),
 * waits until it is ready to accept requests, and tears it down afterwards.
 *
 * Implementations are responsible for ensuring teardown is always called
 * (the caller must use try/finally).
 */
export interface ServiceProvisioner {
  /**
   * Start the service and return the base URL where it is reachable.
   * Must be idempotent: calling provision() twice should be a no-op if
   * the service is already running (or throw if that is not safe).
   */
  provision(): Promise<{ baseUrl: string }>;

  /**
   * Block until the service is ready to accept requests, or throw if
   * the deadline is exceeded.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120_000).
   */
  waitReady(timeoutMs?: number): Promise<void>;

  /**
   * Stop and remove the service.
   * Must be safe to call multiple times (idempotent teardown).
   * Should never throw — log errors instead.
   */
  teardown(): Promise<void>;
}

// ─── DockerSonarScannerRunner types ────────────────────────────────────────────

/**
 * Options for DockerSonarScannerRunner — the one-shot scanner container helper.
 */
export interface DockerSonarScannerRunnerOptions {
  /**
   * Absolute path of the project directory to mount into the container.
   * Mounted at /usr/src (the sonar-scanner-cli image's default working dir).
   */
  projectDir: string;

  /**
   * The SonarQube host URL as seen from the Docker host (e.g. http://localhost:PORT).
   * `localhost` / `127.0.0.1` are automatically rewritten to `host.docker.internal`
   * so the container can reach the host-side service.
   */
  sonarHostUrl: string;

  /**
   * Docker image for the scanner container.
   * Defaults to 'sonarsource/sonar-scanner-cli:latest'.
   */
  image?: string;

  /**
   * Docker platform string to pass via `--platform` (e.g. 'linux/amd64').
   * When omitted, platform is auto-detected from the current process architecture:
   *   - arm64 → linux/amd64 (sonar-scanner-cli has no arm64 image; amd64 via emulation)
   *   - other → omitted (Docker chooses the native platform)
   * Set to an empty string '' to suppress the auto-detection and omit --platform entirely.
   */
  platform?: string;
}

// ─── DockerSonarQubeProvisionerOptions ─────────────────────────────────────────

/**
 * Options for DockerSonarQubeProvisioner.
 */
export interface DockerSonarQubeProvisionerOptions {
  /**
   * SonarQube Community Edition Docker image tag.
   * Defaults to 'sonarqube:lts-community'.
   */
  image?: string;

  /**
   * Host port to bind SonarQube's internal 9000.
   * When omitted (default), an available ephemeral port is selected automatically.
   */
  hostPort?: number;

  /**
   * Container name prefix. A random suffix is appended to avoid collisions.
   * Defaults to 'osv-sq-ephemeral'.
   */
  containerNamePrefix?: string;

  /**
   * How long to wait for SonarQube to become ready (ms).
   * Defaults to 120_000 (2 min).
   */
  readinessTimeoutMs?: number;

  /**
   * How long to sleep between readiness polling attempts (ms).
   * Defaults to 3_000.
   */
  pollIntervalMs?: number;
}
