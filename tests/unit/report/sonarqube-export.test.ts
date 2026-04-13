import { describe, it, expect } from 'vitest';
import {
  buildSonarQubeExport,
  sonarQubeExportFilename,
} from '@reporting/sonarqube-export';
import type { ScanResultJson } from '@core/types/scan';

// ─── Fixtures ───────────────────────────────────────────────────────────────────

const sonarSuccessResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'success',
  environment: 'local',
  ecosystems: {},
  error: null,
  metadata: {
    qualityGateStatus: 'OK',
    qualityGatePassed: true,
    qualityGateConditions: [
      {
        status: 'OK',
        metricKey: 'new_reliability_rating',
        comparator: 'GT',
        errorThreshold: '1',
        actualValue: '1',
      },
    ],
    metrics: {
      bugs: '0',
      vulnerabilities: '2',
      code_smells: '10',
      coverage: '88.0',
    },
    issues: [
      {
        key: 'abc123',
        rule: 'typescript:S2486',
        severity: 'CRITICAL',
        component: 'my-project:src/utils/parser.ts',
        line: 15,
        message: 'Handle this exception',
        type: 'BUG',
        status: 'OPEN',
      },
    ],
  },
};

const sonarErrorResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'error',
  environment: 'local',
  ecosystems: {},
  error: 'sonar-scanner exited with code 2',
};

const sonarSkippedResult: ScanResultJson = {
  $schema: 'sonarqube-scan-result/v1',
  agent: 'sonarqube',
  status: 'skipped',
  environment: 'local',
  ecosystems: {},
  error: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────────

describe('buildSonarQubeExport', () => {
  it('returns null when engineResults is undefined', () => {
    expect(buildSonarQubeExport(undefined)).toBeNull();
  });

  it('returns null when sonarqube not in engineResults', () => {
    expect(buildSonarQubeExport({ 'osv-scanner': sonarSuccessResult })).toBeNull();
  });

  it('returns null when status is skipped', () => {
    expect(buildSonarQubeExport({ sonarqube: sonarSkippedResult })).toBeNull();
  });

  it('returns error export when status is error', () => {
    const result = buildSonarQubeExport({ sonarqube: sonarErrorResult });
    expect(result).not.toBeNull();
    expect(result!.$schema).toBe('sonarqube-export/v1');
    expect(result!.status).toBe('error');
    expect(result!.error).toBe('sonar-scanner exited with code 2');
    expect(result!.qualityGate).toBeNull();
    expect(result!.metrics).toBeNull();
    expect(result!.issues).toBeNull();
  });

  it('returns full export when status is success', () => {
    const result = buildSonarQubeExport({ sonarqube: sonarSuccessResult });
    expect(result).not.toBeNull();
    expect(result!.$schema).toBe('sonarqube-export/v1');
    expect(result!.status).toBe('success');
    expect(result!.agent).toBe('sonarqube');
    expect(result!.error).toBeNull();
  });

  it('includes quality gate in success export', () => {
    const result = buildSonarQubeExport({ sonarqube: sonarSuccessResult });
    expect(result!.qualityGate).not.toBeNull();
    expect(result!.qualityGate!.status).toBe('OK');
    expect(result!.qualityGate!.passed).toBe(true);
    expect(result!.qualityGate!.conditions).toHaveLength(1);
  });

  it('includes metrics in success export', () => {
    const result = buildSonarQubeExport({ sonarqube: sonarSuccessResult });
    expect(result!.metrics).not.toBeNull();
    expect(result!.metrics!['bugs']).toBe('0');
    expect(result!.metrics!['coverage']).toBe('88.0');
  });

  it('includes issues with normalized file paths in success export', () => {
    const result = buildSonarQubeExport({ sonarqube: sonarSuccessResult });
    expect(result!.issues).not.toBeNull();
    expect(result!.issues).toHaveLength(1);
    expect(result!.issues![0]!.file).toBe('src/utils/parser.ts');
    expect(result!.issues![0]!.key).toBe('abc123');
    expect(result!.issues![0]!.severity).toBe('CRITICAL');
  });

  it('normalizes component without colon to full component string', () => {
    const resultWithPlainComponent: ScanResultJson = {
      ...sonarSuccessResult,
      metadata: {
        ...sonarSuccessResult.metadata,
        issues: [
          {
            key: 'x1',
            rule: 'rule:S1',
            severity: 'MAJOR',
            component: 'plain-component',
            message: 'msg',
            type: 'CODE_SMELL',
            status: 'OPEN',
          },
        ],
      },
    };
    const result = buildSonarQubeExport({ sonarqube: resultWithPlainComponent });
    expect(result!.issues![0]!.file).toBe('plain-component');
  });

  it('sets exportedAt to an ISO date string', () => {
    const result = buildSonarQubeExport({ sonarqube: sonarSuccessResult });
    expect(result!.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles missing metadata gracefully (no metrics, no issues)', () => {
    const noMetaResult: ScanResultJson = {
      ...sonarSuccessResult,
      metadata: undefined,
    };
    const result = buildSonarQubeExport({ sonarqube: noMetaResult });
    expect(result).not.toBeNull();
    expect(result!.qualityGate).toBeNull();
    expect(result!.metrics).toBeNull();
    expect(result!.issues).toBeNull();
  });
});

describe('sonarQubeExportFilename', () => {
  it('generates a consistent filename from project name and date', () => {
    const name = sonarQubeExportFilename('My Project', '2026-04-07');
    expect(name).toBe('sonarqube-export-my-project-2026-04-07.json');
  });

  it('lowercases and slugifies project name', () => {
    const name = sonarQubeExportFilename('Acme Corp App', '2026-01-01');
    expect(name).toBe('sonarqube-export-acme-corp-app-2026-01-01.json');
  });
});
