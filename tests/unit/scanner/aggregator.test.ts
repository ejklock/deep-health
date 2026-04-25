/**
 * Unit tests for aggregateScanResults and OSV_ENGINE_ID.
 *
 * Covers:
 * - OSV_ENGINE_ID is the canonical constant ('osv')
 * - Primary is always selected by engine id, never by array position
 * - Registry-order independence: OSV registered last still becomes primary
 * - Throws loudly when OSV result is missing from engineResults
 * - Throws when engineResults is empty
 * - Ecosystem merging is driven by OSV result metadata (agent, $schema, branch)
 * - Secondary engine ecosystems are merged into primary ecosystems
 * - Warnings are passed through unchanged
 * - engineResults map contains all engine results indexed by id
 */
import { describe, it, expect } from 'vitest';
import { aggregateScanResults, OSV_ENGINE_ID } from '@modules/scanner/aggregator';
import type { ScanResultJson, EcosystemScanResult } from '@core/types/scan';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmptyEcosystem(): EcosystemScanResult {
  return {
    vulnerabilities_total: 0,
    auto_safe: 0,
    breaking: 0,
    manual: 0,
    auto_safe_packages: [],
    breaking_packages: [],
    manual_packages: [],
    vulnerabilities: [],
  };
}

function makeOsvResult(overrides: Partial<ScanResultJson> = {}): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {},
    error: null,
    ...overrides,
  };
}

function makeSecondaryResult(id: string, overrides: Partial<ScanResultJson> = {}): ScanResultJson {
  return {
    $schema: `${id}-result/v1`,
    agent: id,
    status: 'success',
    environment: 'local',
    ecosystems: {},
    error: null,
    ...overrides,
  };
}

// ─── OSV_ENGINE_ID constant ───────────────────────────────────────────────────

describe('OSV_ENGINE_ID', () => {
  it('is the string "osv"', () => {
    expect(OSV_ENGINE_ID).toBe('osv');
  });

  it('matches the id on OsvScannerEngine', async () => {
    // Import dynamically to keep this test file self-contained — no mock needed
    const { OsvScannerEngine } = await import('@modules/scanner/osv-engine');
    const engine = new OsvScannerEngine();
    expect(engine.id).toBe(OSV_ENGINE_ID);
  });
});

// ─── aggregateScanResults — guard clauses ─────────────────────────────────────

describe('aggregateScanResults — guard clauses', () => {
  it('throws when engineResults array is empty', () => {
    expect(() => aggregateScanResults([])).toThrow(
      'aggregateScanResults: at least one engine result is required',
    );
  });

  it('throws loudly when OSV result is absent', () => {
    const entries = [
      { engineId: 'sonarqube', result: makeSecondaryResult('sonarqube') },
      { engineId: 'custom-engine', result: makeSecondaryResult('custom-engine') },
    ];

    expect(() => aggregateScanResults(entries)).toThrow(
      /OSV engine result is required but was not found/,
    );
  });

  it('error message includes the actual engine ids received', () => {
    const entries = [
      { engineId: 'sonarqube', result: makeSecondaryResult('sonarqube') },
    ];

    let caught: Error | undefined;
    try {
      aggregateScanResults(entries);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('sonarqube');
  });
});

// ─── aggregateScanResults — primary selection by engine id ────────────────────

describe('aggregateScanResults — primary selection by engine id (not array position)', () => {
  it('selects OSV as primary when OSV is first in the array', () => {
    const osvResult = makeOsvResult({ branch: 'main' });
    const sonarResult = makeSecondaryResult('sonarqube');

    const entries = [
      { engineId: 'osv', result: osvResult },
      { engineId: 'sonarqube', result: sonarResult },
    ];

    const aggregated = aggregateScanResults(entries);

    expect(aggregated.primary.agent).toBe('osv');
    expect(aggregated.primary.$schema).toBe('osv-scan-result/v1');
    expect(aggregated.primary.branch).toBe('main');
  });

  it('selects OSV as primary when OSV is LAST in the array (registry-order independence)', () => {
    const osvResult = makeOsvResult({ branch: 'feature/test' });
    const sonarResult = makeSecondaryResult('sonarqube');

    // Deliberately put SonarQube first — OSV is last
    const entries = [
      { engineId: 'sonarqube', result: sonarResult },
      { engineId: 'osv', result: osvResult },
    ];

    const aggregated = aggregateScanResults(entries);

    // Must still select OSV — not position [0]
    expect(aggregated.primary.agent).toBe('osv');
    expect(aggregated.primary.$schema).toBe('osv-scan-result/v1');
    expect(aggregated.primary.branch).toBe('feature/test');
  });

  it('selects OSV as primary when it is in the middle of the array', () => {
    const osvResult = makeOsvResult();
    const entries = [
      { engineId: 'engine-a', result: makeSecondaryResult('engine-a') },
      { engineId: 'osv', result: osvResult },
      { engineId: 'engine-b', result: makeSecondaryResult('engine-b') },
    ];

    // engine-a and engine-b have no on_failure config, but we are not going through
    // the orchestrator here — we are testing the aggregator directly with clean results.
    const aggregated = aggregateScanResults(entries);

    expect(aggregated.primary.agent).toBe('osv');
  });

  it('primary preserves OSV metadata ($schema, agent, branch, environment)', () => {
    const osvResult = makeOsvResult({
      branch: 'release/1.0',
      environment: 'docker',
    });
    const sonarResult = makeSecondaryResult('sonarqube');

    const entries = [
      { engineId: 'sonarqube', result: sonarResult },
      { engineId: 'osv', result: osvResult },
    ];

    const aggregated = aggregateScanResults(entries);

    expect(aggregated.primary.$schema).toBe('osv-scan-result/v1');
    expect(aggregated.primary.agent).toBe('osv');
    expect(aggregated.primary.branch).toBe('release/1.0');
    expect(aggregated.primary.environment).toBe('docker');
  });
});

// ─── aggregateScanResults — engineResults map ─────────────────────────────────

describe('aggregateScanResults — engineResults map', () => {
  it('contains all engine results indexed by id', () => {
    const osvResult = makeOsvResult();
    const sonarResult = makeSecondaryResult('sonarqube');

    const entries = [
      { engineId: 'osv', result: osvResult },
      { engineId: 'sonarqube', result: sonarResult },
    ];

    const aggregated = aggregateScanResults(entries);

    expect(aggregated.engineResults['osv']).toBe(osvResult);
    expect(aggregated.engineResults['sonarqube']).toBe(sonarResult);
    expect(Object.keys(aggregated.engineResults)).toHaveLength(2);
  });

  it('engineResults contains OSV even when OSV is last in the input', () => {
    const osvResult = makeOsvResult();
    const sonarResult = makeSecondaryResult('sonarqube');

    const entries = [
      { engineId: 'sonarqube', result: sonarResult },
      { engineId: 'osv', result: osvResult },
    ];

    const aggregated = aggregateScanResults(entries);

    expect(aggregated.engineResults['osv']).toBeDefined();
    expect(aggregated.engineResults['sonarqube']).toBeDefined();
  });

  it('OSV-only: engineResults has exactly one entry', () => {
    const osvResult = makeOsvResult();
    const entries = [{ engineId: 'osv', result: osvResult }];

    const aggregated = aggregateScanResults(entries);

    expect(Object.keys(aggregated.engineResults)).toHaveLength(1);
    expect(aggregated.engineResults['osv']).toBe(osvResult);
  });
});

// ─── aggregateScanResults — ecosystem merging ─────────────────────────────────

describe('aggregateScanResults — ecosystem merging', () => {
  it('primary.ecosystems is empty when all engines have no findings', () => {
    const entries = [{ engineId: 'osv', result: makeOsvResult() }];
    const aggregated = aggregateScanResults(entries);
    expect(aggregated.primary.ecosystems).toEqual({});
  });

  it('OSV ecosystems appear in primary when OSV is the only engine', () => {
    const npmEco: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      vulnerabilities_total: 3,
      auto_safe: 2,
      breaking: 1,
    };

    const osvResult = makeOsvResult({ ecosystems: { npm: npmEco } });
    const entries = [{ engineId: 'osv', result: osvResult }];

    const aggregated = aggregateScanResults(entries);

    expect(aggregated.primary.ecosystems['npm']).toBeDefined();
    expect(aggregated.primary.ecosystems['npm']?.vulnerabilities_total).toBe(3);
  });

  it('merges ecosystems from multiple engines into primary.ecosystems', () => {
    const osvNpm: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      vulnerabilities_total: 2,
      auto_safe: 2,
    };

    const sonarCustomEco: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      vulnerabilities_total: 5,
      auto_safe: 5,
    };

    const osvResult = makeOsvResult({ ecosystems: { npm: osvNpm } });
    const sonarResult = makeSecondaryResult('sonarqube', {
      ecosystems: { 'custom-quality': sonarCustomEco },
    });

    const entries = [
      { engineId: 'osv', result: osvResult },
      { engineId: 'sonarqube', result: sonarResult },
    ];

    const aggregated = aggregateScanResults(entries);

    expect(aggregated.primary.ecosystems['npm']?.vulnerabilities_total).toBe(2);
    expect(aggregated.primary.ecosystems['custom-quality']?.vulnerabilities_total).toBe(5);
  });

  it('deduplicates package refs when two engines report the same ecosystem', () => {
    const eco1: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      vulnerabilities_total: 1,
      auto_safe: 1,
      auto_safe_packages: ['lodash@4.17.20'],
    };

    const eco2: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      vulnerabilities_total: 1,
      auto_safe: 1,
      auto_safe_packages: ['lodash@4.17.20', 'express@4.18.0'],
    };

    const osvResult = makeOsvResult({ ecosystems: { npm: eco1 } });
    const secondaryResult = makeSecondaryResult('secondary', { ecosystems: { npm: eco2 } });

    const entries = [
      { engineId: 'osv', result: osvResult },
      { engineId: 'secondary', result: secondaryResult },
    ];

    const aggregated = aggregateScanResults(entries);
    const mergedNpm = aggregated.primary.ecosystems['npm']!;

    // lodash deduped, express added — total 2 unique refs
    expect(mergedNpm.auto_safe_packages).toHaveLength(2);
    expect(mergedNpm.auto_safe_packages).toContain('lodash@4.17.20');
    expect(mergedNpm.auto_safe_packages).toContain('express@4.18.0');
  });

  it('errored secondary engines are excluded from ecosystem merge', () => {
    const osvNpm: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      vulnerabilities_total: 1,
      auto_safe: 1,
    };

    const osvResult = makeOsvResult({ ecosystems: { npm: osvNpm } });
    const erroredSecondary = makeSecondaryResult('sonarqube', {
      status: 'error',
      ecosystems: { npm: { ...makeEmptyEcosystem(), vulnerabilities_total: 99 } },
    });

    const entries = [
      { engineId: 'osv', result: osvResult },
      { engineId: 'sonarqube', result: erroredSecondary },
    ];

    const aggregated = aggregateScanResults(entries);

    // Errored secondary should NOT contaminate OSV's ecosystem count
    expect(aggregated.primary.ecosystems['npm']?.vulnerabilities_total).toBe(1);
  });
});

// ─── aggregateScanResults — warnings passthrough ──────────────────────────────

describe('aggregateScanResults — warnings passthrough', () => {
  it('warnings array is empty by default', () => {
    const entries = [{ engineId: 'osv', result: makeOsvResult() }];
    const aggregated = aggregateScanResults(entries);
    expect(aggregated.warnings).toEqual([]);
  });

  it('warnings from caller are passed through unchanged', () => {
    const warnings = [
      { engineId: 'sonarqube', message: 'sonar not available' },
      { engineId: 'custom', message: 'timeout' },
    ];
    const entries = [{ engineId: 'osv', result: makeOsvResult() }];
    const aggregated = aggregateScanResults(entries, warnings);
    expect(aggregated.warnings).toEqual(warnings);
  });
});

// ─── aggregateScanResults — status propagation ────────────────────────────────

describe('aggregateScanResults — status propagation', () => {
  it('primary.status is "success" when OSV result is success', () => {
    const entries = [{ engineId: 'osv', result: makeOsvResult({ status: 'success' }) }];
    const aggregated = aggregateScanResults(entries);
    expect(aggregated.primary.status).toBe('success');
  });

  it('primary.status reflects OSV error status when OSV reports an error', () => {
    const entries = [
      {
        engineId: 'osv',
        result: makeOsvResult({ status: 'error', error: 'scan failed' }),
      },
    ];
    const aggregated = aggregateScanResults(entries);
    expect(aggregated.primary.status).toBe('error');
  });
});

// ─── aggregator branch coverage top-up ───────────────────────────────────────

describe('aggregateScanResults — breaking/manual package merge (lines 78, 81)', () => {
  it('merges breaking_packages and manual_packages from secondary engine', () => {
    const eco1: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      breaking: 1,
      breaking_packages: ['lodash@4.x'],
      manual: 1,
      manual_packages: ['chalk@5.x'],
    };
    const eco2: EcosystemScanResult = {
      ...makeEmptyEcosystem(),
      breaking: 1,
      breaking_packages: ['lodash@4.x', 'express@4.x'],
      manual: 1,
      manual_packages: ['chalk@5.x', 'inquirer@9.x'],
    };

    const osvResult = makeOsvResult({ ecosystems: { npm: eco1 } });
    const secondary = makeSecondaryResult('secondary', { ecosystems: { npm: eco2 } });

    const aggregated = aggregateScanResults([
      { engineId: 'osv', result: osvResult },
      { engineId: 'secondary', result: secondary },
    ]);

    const mergedNpm = aggregated.primary.ecosystems['npm']!;
    // lodash deduped, express added
    expect(mergedNpm.breaking_packages).toHaveLength(2);
    expect(mergedNpm.breaking_packages).toContain('express@4.x');
    // chalk deduped, inquirer added
    expect(mergedNpm.manual_packages).toHaveLength(2);
    expect(mergedNpm.manual_packages).toContain('inquirer@9.x');
  });
});
