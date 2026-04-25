/**
 * Branch coverage top-up for src/reporting/sonarqube-export.ts
 * Targets uncovered branches (lines 75, 87-88).
 */
import { describe, it, expect } from 'vitest';
import { buildSonarQubeExport } from '@reporting/sonarqube-export';
import type { ScanResultJson } from '@core/types/scan';

describe('buildSonarQubeExport() — branch coverage', () => {
  it('uses error ?? "unknown error" when error field is null/undefined on error status', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'error',
      environment: 'local',
      ecosystems: {},
      error: undefined,
    };
    const exported = buildSonarQubeExport({ sonarqube: result });
    expect(exported).not.toBeNull();
    expect(exported!.error).toBe('unknown error');
  });

  it('qualityGatePassed falls back to qualityGateStatus === OK when qualityGatePassed is undefined', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: 'OK',
        qualityGatePassed: undefined, // not set — should fall back to status === 'OK'
        qualityGateConditions: [],
      },
    };
    const exported = buildSonarQubeExport({ sonarqube: result });
    expect(exported!.qualityGate!.passed).toBe(true);
  });

  it('qualityGate is null when qualityGateStatus is absent', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: undefined,
      },
    };
    const exported = buildSonarQubeExport({ sonarqube: result });
    expect(exported!.qualityGate).toBeNull();
  });

  it('issues is null when metadata.issues is absent', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {},
    };
    const exported = buildSonarQubeExport({ sonarqube: result });
    expect(exported!.issues).toBeNull();
  });

  it('qualityGate.passed falls back to qualityGateStatus===OK when qualityGatePassed is absent (line 88)', () => {
    const result: ScanResultJson = {
      agent: 'sonarqube',
      status: 'success',
      environment: 'local',
      ecosystems: {},
      error: null,
      metadata: {
        qualityGateStatus: 'OK',
        // qualityGatePassed intentionally absent — triggers ?? branch
      },
    };
    const exported = buildSonarQubeExport({ sonarqube: result });
    expect(exported!.qualityGate).not.toBeNull();
    expect(exported!.qualityGate!.passed).toBe(true); // 'OK' === 'OK'
  });
});
