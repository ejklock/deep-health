import { execFileSync } from 'node:child_process';

const CONTAINER_PREFIXES = ['osv-sq-ephemeral-', 'smoke-test-sq-'];

function sweepOrphanedContainers(): void {
  for (const prefix of CONTAINER_PREFIXES) {
    try {
      const ids = execFileSync(
        'docker',
        ['ps', '-aq', '--filter', `name=${prefix}`],
        { encoding: 'utf8' },
      ).trim();
      if (ids) {
        execFileSync('docker', ['rm', '-f', ...ids.split('\n').filter(Boolean)]);
      }
    } catch {
      // Docker unavailable or no orphans — non-fatal
    }
  }
}

export function setup(): void {
  sweepOrphanedContainers();
}

export function teardown(): void {
  sweepOrphanedContainers();
}
