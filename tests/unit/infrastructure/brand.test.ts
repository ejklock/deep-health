import { describe, it, expect } from 'vitest';
import {
  CLI_NAME,
  DEFAULT_REPORTS_SUBDIR,
  DEFAULT_BRANCH_PREFIX,
  KILL_SWITCH_VAR,
  NPM_DEFAULT_FIXER,
} from '@infra/brand';

describe('brand', () => {
  it('(a) CLI_NAME is hardcoded to security-scan', () => {
    expect(CLI_NAME).toBe('security-scan');
  });

  it('(b) DEFAULT_REPORTS_SUBDIR is .security-scan/reports', () => {
    expect(DEFAULT_REPORTS_SUBDIR).toBe('.security-scan/reports');
  });

  it('(c) DEFAULT_BRANCH_PREFIX is fix/security-scan-', () => {
    expect(DEFAULT_BRANCH_PREFIX).toBe('fix/security-scan-');
  });

  it('(d) KILL_SWITCH_VAR is SECURITY_SCAN_NO_AUTO_FIX', () => {
    expect(KILL_SWITCH_VAR).toBe('SECURITY_SCAN_NO_AUTO_FIX');
  });

  it('(e) NPM_DEFAULT_FIXER is osv-then-audit', () => {
    expect(NPM_DEFAULT_FIXER).toBe('osv-then-audit');
  });
});
