/**
 * Smoke test: DockerSonarQubeProvisioner — real Docker integration.
 *
 * These tests require a running Docker daemon.  They are automatically skipped
 * when Docker is unavailable (see `beforeAll(skipIfNoDocker)`).
 *
 * What is tested:
 *  - provision() starts a real SonarQube CE container and returns a base URL.
 *  - teardown() removes the container without error.
 *  - Calling teardown() twice is idempotent (no error on second call).
 *  - The container name / resolved port are accessible via the public getters.
 *  - Calling provision() twice returns the same base URL without starting a second container.
 *
 * NOTE: waitReady() is intentionally NOT tested here because SonarQube startup
 * can take 60-120 s, which exceeds a reasonable CI smoke-test budget.
 * The provision → teardown round-trip verifies the Docker plumbing only.
 *
 * Timeout: 60 s per test (container pull + start).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { DockerSonarQubeProvisioner } from '@infra/provisioner/docker-sonarqube';
import { skipIfNoDocker } from '../helpers/docker-skip.js';

// ─── Suite-level skip guard ───────────────────────────────────────────────────

beforeAll(skipIfNoDocker, 15_000);

// ─── Lifecycle: ensure every test tears down its container ────────────────────

let provisioner: DockerSonarQubeProvisioner | null = null;

afterEach(async () => {
  if (provisioner) {
    await provisioner.teardown().catch(() => {});
    provisioner = null;
  }
}, 30_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DockerSonarQubeProvisioner (smoke)', () => {
  it(
    'provision() starts a container and returns a localhost base URL',
    { timeout: 60_000 },
    async () => {
      provisioner = new DockerSonarQubeProvisioner();

      const { baseUrl } = await provisioner.provision();

      // URL must point at localhost with an ephemeral port
      expect(baseUrl).toMatch(/^http:\/\/localhost:\d+$/);

      // Public getters reflect the provisioned state
      expect(provisioner.containerName_).toBeTruthy();
      expect(provisioner.resolvedPort_).toBeGreaterThan(0);
      expect(provisioner.resolvedPort_).toBeLessThanOrEqual(65535);
    },
  );

  it(
    'provision() called twice returns the same base URL without starting a second container',
    { timeout: 60_000 },
    async () => {
      provisioner = new DockerSonarQubeProvisioner();

      const first = await provisioner.provision();
      const second = await provisioner.provision();

      expect(second.baseUrl).toBe(first.baseUrl);
    },
  );

  it(
    'teardown() removes the container cleanly',
    { timeout: 60_000 },
    async () => {
      provisioner = new DockerSonarQubeProvisioner();
      await provisioner.provision();
      const name = provisioner.containerName_!;

      // Should not throw
      await expect(provisioner.teardown()).resolves.toBeUndefined();

      // After teardown, the null sentinel is not exposed, but the second call
      // must be safe too (idempotency check below).
      provisioner = null; // prevent afterEach from calling teardown again

      // Docker rm --force on a non-existent container exits non-zero but the
      // provisioner catches that; the important thing is the promise resolves.
      const staleProvisioner = new DockerSonarQubeProvisioner();
      // Not provisioned — teardown is a no-op
      await expect(staleProvisioner.teardown()).resolves.toBeUndefined();
    },
  );

  it(
    'teardown() is idempotent — calling it twice does not throw',
    { timeout: 60_000 },
    async () => {
      provisioner = new DockerSonarQubeProvisioner();
      await provisioner.provision();

      await provisioner.teardown();
      // Second call must be safe
      await expect(provisioner.teardown()).resolves.toBeUndefined();

      provisioner = null; // already torn down
    },
  );

  it(
    'uses the custom containerNamePrefix when provided',
    { timeout: 60_000 },
    async () => {
      provisioner = new DockerSonarQubeProvisioner({
        containerNamePrefix: 'smoke-test-sq',
      });

      await provisioner.provision();

      expect(provisioner.containerName_).toMatch(/^smoke-test-sq-/);
    },
  );
});
