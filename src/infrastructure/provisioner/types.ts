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

/**
 * Options for DockerSonarQubeProvisioner.
 */
export interface DockerSonarQubeProvisionerOptions {
  /**
   * SonarQube Community Edition Docker image tag.
   * Defaults to 'sonarqube:community'.
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
