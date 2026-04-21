import { describe, it, expect } from 'vitest';
import { parseNpmAuditJson } from '@modules/ecosystem/plugins/npm-audit-parser';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const auditWithVulnerabilities = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    'lodash': {
      name: 'lodash',
      severity: 'high',
      range: '>=4.0.0 <4.17.21',
      via: [{ title: 'Prototype Pollution', url: 'https://npmjs.com/advisories/1523', severity: 'high' }],
      fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false },
    },
  },
});

const auditClean = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
});

const auditNoVulnerabilitiesKey = JSON.stringify({
  auditReportVersion: 2,
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('parseNpmAuditJson', () => {
  it('returns findings when vulnerabilities are present', () => {
    const findings = parseNpmAuditJson(auditWithVulnerabilities);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      package: 'lodash',
      severity: 'high',
      title: 'Prototype Pollution',
      fixAvailable: '4.17.21',
    });
  });

  it('returns empty array for valid JSON with no vulnerabilities', () => {
    const findings = parseNpmAuditJson(auditClean);
    expect(findings).toHaveLength(0);
  });

  it('returns empty array for valid JSON without a vulnerabilities key', () => {
    const findings = parseNpmAuditJson(auditNoVulnerabilitiesKey);
    expect(findings).toHaveLength(0);
  });

  it('THROWS for malformed JSON (so caller can emit error status)', () => {
    expect(() => parseNpmAuditJson('not-valid-json')).toThrow(SyntaxError);
  });

  it('THROWS for empty string (unparseable)', () => {
    expect(() => parseNpmAuditJson('')).toThrow(SyntaxError);
  });

  it('THROWS for truncated JSON', () => {
    expect(() => parseNpmAuditJson('{"vulnerabilities": {"lodash":')).toThrow(SyntaxError);
  });
});
