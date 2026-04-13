import { describe, it, expect } from 'vitest';
import { validateGateA, validateEcosystemGate } from '../../../src/gates/validator.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../fixtures');

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(resolve(fixturesDir, name), 'utf-8');
  return JSON.parse(raw);
}

describe('validateGateA (OSV Scanner)', () => {
  it('passes for valid scan result', async () => {
    const data = await loadFixture('scan-result-success.json');
    const result = validateGateA(data);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails for error scan result', async () => {
    const data = await loadFixture('scan-result-error.json');
    const result = validateGateA(data);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Scanner returned error');
  });

  it('fails for missing required fields', () => {
    const result = validateGateA({ $schema: 'osv-scan-result/v1', agent: 'osv-scanner' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('passes for any $schema string (engine-agnostic)', () => {
    // validateGateA validates shape/status only — it does not enforce engine identity
    const result = validateGateA({
      $schema: 'other-scan-result/v1',
      agent: 'other-scanner',
      status: 'success',
      environment: 'docker',
      ecosystems: {},
      error: null,
    });
    expect(result.valid).toBe(true);
  });

  it('passes with valid vulnerability entries in ecosystems', () => {
    const result = validateGateA({
      $schema: 'osv-scan-result/v1',
      agent: 'osv-scanner',
      status: 'success',
      environment: 'docker',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: ['lodash@4.17.20'],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'lodash',
              currentVersion: '4.17.20',
              safeVersion: '4.17.21',
              cvss: '7.4',
              ghsaId: 'GHSA-35jh-r3h4-6jhm',
              risk: 'high',
              classification: 'auto_safe',
              reason: 'Patch upgrade resolves prototype pollution vulnerability',
            },
          ],
        },
      },
      error: null,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes with empty vulnerabilities array', () => {
    const result = validateGateA({
      $schema: 'osv-scan-result/v1',
      agent: 'osv-scanner',
      status: 'success',
      environment: 'docker',
      ecosystems: {
        npm: {
          vulnerabilities_total: 0,
          auto_safe: 0,
          breaking: 0,
          manual: 0,
          auto_safe_packages: [],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [],
        },
      },
      error: null,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when vulnerabilities array is missing', () => {
    const result = validateGateA({
      $schema: 'osv-scan-result/v1',
      agent: 'osv-scanner',
      status: 'success',
      environment: 'docker',
      ecosystems: {
        npm: {
          vulnerabilities_total: 0,
          auto_safe: 0,
          breaking: 0,
          manual: 0,
          auto_safe_packages: [],
          breaking_packages: [],
          manual_packages: [],
          // vulnerabilities intentionally omitted
        },
      },
      error: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('vulnerabilities'))).toBe(true);
  });

  it('fails when a vulnerability entry has a wrong classification', () => {
    const result = validateGateA({
      $schema: 'osv-scan-result/v1',
      agent: 'osv-scanner',
      status: 'success',
      environment: 'docker',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 0,
          breaking: 0,
          manual: 0,
          auto_safe_packages: [],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [
            {
              ecosystem: 'npm',
              package: 'lodash',
              currentVersion: '4.17.20',
              safeVersion: null,
              cvss: '7.4',
              ghsaId: 'GHSA-35jh-r3h4-6jhm',
              risk: 'high',
              classification: 'unknown_class', // invalid
              reason: 'test',
            },
          ],
        },
      },
      error: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('classification'))).toBe(true);
  });

  it('fails when a vulnerability entry is missing required fields', () => {
    const result = validateGateA({
      $schema: 'osv-scan-result/v1',
      agent: 'osv-scanner',
      status: 'success',
      environment: 'docker',
      ecosystems: {
        npm: {
          vulnerabilities_total: 1,
          auto_safe: 1,
          breaking: 0,
          manual: 0,
          auto_safe_packages: [],
          breaking_packages: [],
          manual_packages: [],
          vulnerabilities: [
            {
              // missing: ecosystem, currentVersion, safeVersion, cvss, ghsaId, risk, reason
              package: 'lodash',
              classification: 'auto_safe',
            },
          ],
        },
      },
      error: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

/** Canonical update result with validations[] for use in tests */
function validNpmResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'osv-update-result/v1',
    agent: 'npm-safe-update',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: [],
    validations: [{ name: 'build', status: 'pass', detail: 'Build OK' }],
    error: null,
    ...overrides,
  };
}

function validComposerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'osv-update-result/v1',
    agent: 'composer-safe-update',
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: [],
    validations: [{ name: 'tests', status: 'pass', detail: '42 tests passed' }],
    error: null,
    ...overrides,
  };
}

describe('validateEcosystemGate (canonical validations[] model)', () => {
  it('passes for valid npm update result (fixture)', async () => {
    const data = await loadFixture('update-result-npm.json');
    const result = validateEcosystemGate('npm', data);
    expect(result.valid).toBe(true);
    expect(result.gate).toBe('npm');
  });

  it('passes for valid composer update result (fixture)', async () => {
    const data = await loadFixture('update-result-composer.json');
    const result = validateEcosystemGate('composer', data);
    expect(result.valid).toBe(true);
    expect(result.gate).toBe('composer');
  });

  it('accepts any agent name (no agent enforcement)', async () => {
    const data = await loadFixture('update-result-composer.json');
    // validateEcosystemGate does NOT enforce agent name — that is the caller's responsibility
    const result = validateEcosystemGate('npm', data);
    expect(result.valid).toBe(true);
  });

  it('fails for missing packages_updated', () => {
    const result = validateEcosystemGate('npm', {
      $schema: 'osv-update-result/v1',
      agent: 'npm-safe-update',
      status: 'success',
      validations: [{ name: 'build', status: 'skipped', detail: 'No build_commands configured — skipped' }],
      error: null,
    });
    expect(result.valid).toBe(false);
    expect(result.gate).toBe('npm');
  });

  it('fails for missing validations array', () => {
    const result = validateEcosystemGate('npm', {
      $schema: 'osv-update-result/v1',
      agent: 'npm-safe-update',
      status: 'success',
      packages_updated: [],
      packages_skipped: [],
      packages_pending_breaking: [],
      error: null,
      // validations intentionally omitted
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('validations'))).toBe(true);
  });

  it('fails when status is error', () => {
    const result = validateEcosystemGate('composer', {
      ...validComposerResult(),
      status: 'error',
      error: 'Something went wrong',
    });
    expect(result.valid).toBe(false);
    expect(result.gate).toBe('composer');
    expect(result.errors[0]).toContain('Something went wrong');
  });

  it('uses ecosystemId in gate field and error messages', () => {
    const result = validateEcosystemGate('pip', {
      $schema: 'osv-update-result/v1',
      agent: 'pip-safe-update',
      status: 'error',
      packages_updated: [],
      packages_skipped: [],
      packages_pending_breaking: [],
      validations: [{ name: 'tests', status: 'skipped' }],
      error: 'pip error',
    });
    expect(result.gate).toBe('pip');
    expect(result.errors[0]).toContain('pip');
  });

  it('accepts validations[] with multiple entries', () => {
    const result = validateEcosystemGate('npm', validNpmResult({
      packages_updated: ['lodash@4.17.21'],
      validations: [
        { name: 'tests', status: 'pass', detail: '10 tests passed' },
        { name: 'build', status: 'pass' },
      ],
    }));
    expect(result.valid).toBe(true);
    expect(result.gate).toBe('npm');
  });

  it('accepts validations[] with skipped entries', () => {
    const result = validateEcosystemGate('composer', validComposerResult({
      validations: [{ name: 'tests', status: 'skipped', detail: 'No test_command configured — skipped' }],
    }));
    expect(result.valid).toBe(true);
  });

  it('rejects validations[] entry with invalid status', () => {
    const result = validateEcosystemGate('npm', validNpmResult({
      validations: [
        { name: 'build', status: 'unknown' }, // invalid status value
      ],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('validations'))).toBe(true);
  });

  it('rejects empty validations[] array (.min(1) invariant)', () => {
    const result = validateEcosystemGate('npm', validNpmResult({ validations: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('validations'))).toBe(true);
  });

  it('accepts validations[] with a single skipped entry', () => {
    const result = validateEcosystemGate('npm', validNpmResult({
      validations: [{ name: 'build', status: 'skipped', detail: 'No build_commands configured — skipped' }],
    }));
    expect(result.valid).toBe(true);
  });
});
