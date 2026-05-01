/**
 * Branch coverage top-up for src/core/gates/validator.ts
 * Targets lines 103 and 131: the `?? 'unknown'` fallback when error field is undefined.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@infra/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn(), tagged: vi.fn() },
}));

import { validateGateA, validateEcosystemGate } from '@core/gates/validator';

// Fully valid scan result (all required fields per ScanResultSchema)
const validScan = {
  $schema: 'osv-scan-result/v1',
  agent: 'osv-scanner',
  status: 'success',
  environment: 'local',
  ecosystems: {},
  error: null,
};

// Fully valid update result (all required fields per UpdateResultSchema)
const validUpdate = {
  $schema: 'update-result/v1',
  agent: 'npm',
  status: 'success',
  environment: 'local',
  packages_updated: [],
  packages_skipped: [],
  packages_pending_breaking: [],
  validations: [{ name: 'build', status: 'pass' }],
  error: null,
};

describe('validateGateA()', () => {
  it('returns invalid when scan status=error and error field is null (hits ?? unknown fallback)', () => {
    const gate = validateGateA({ ...validScan, status: 'error', error: null });
    expect(gate.valid).toBe(false);
    expect(gate.errors[0]).toContain('unknown');
  });

  it('returns invalid when scan status=error and error field is set', () => {
    const gate = validateGateA({ ...validScan, status: 'error', error: 'scan exploded' });
    expect(gate.valid).toBe(false);
    expect(gate.errors[0]).toContain('scan exploded');
  });

  it('returns valid for a well-formed success scan', () => {
    const gate = validateGateA(validScan);
    expect(gate.valid).toBe(true);
    expect(gate.gate).toBe('A');
  });

  it('returns invalid for schema-invalid input (missing $schema)', () => {
    const gate = validateGateA({ not: 'valid' });
    expect(gate.valid).toBe(false);
  });
});

describe('validateEcosystemGate()', () => {
  it('returns invalid when update status=error and error field is null (hits ?? unknown fallback)', () => {
    const gate = validateEcosystemGate('npm', { ...validUpdate, status: 'error', error: null });
    expect(gate.valid).toBe(false);
    expect(gate.errors[0]).toContain('unknown');
  });

  it('returns invalid when update status=error and error field is set', () => {
    const gate = validateEcosystemGate('npm', { ...validUpdate, status: 'error', error: 'npm exploded' });
    expect(gate.valid).toBe(false);
    expect(gate.errors[0]).toContain('npm exploded');
  });

  it('returns valid for a well-formed success update result', () => {
    const gate = validateEcosystemGate('npm', validUpdate);
    expect(gate.valid).toBe(true);
    expect(gate.gate).toBe('npm');
  });

  it('returns invalid for schema-invalid update input', () => {
    const gate = validateEcosystemGate('npm', { bad: 'data' });
    expect(gate.valid).toBe(false);
  });
});
