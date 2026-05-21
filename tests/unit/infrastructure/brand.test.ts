import { describe, it, expect } from 'vitest';
import {
  CLI_NAME,
  DEFAULT_REPORTS_SUBDIR,
  DEFAULT_BRANCH_PREFIX,
  KILL_SWITCH_VAR,
  NPM_DEFAULT_FIXER,
} from '@infra/brand';

describe('brand', () => {
  it('(a) CLI_NAME is hardcoded to deep-health', () => {
    expect(CLI_NAME).toBe('deep-health');
  });

  it('(b) DEFAULT_REPORTS_SUBDIR is .deep-health/reports', () => {
    expect(DEFAULT_REPORTS_SUBDIR).toBe('.deep-health/reports');
  });

  it('(c) DEFAULT_BRANCH_PREFIX is fix/deep-health-', () => {
    expect(DEFAULT_BRANCH_PREFIX).toBe('fix/deep-health-');
  });

  it('(d) KILL_SWITCH_VAR is DEEP_HEALTH_NO_AUTO_FIX', () => {
    expect(KILL_SWITCH_VAR).toBe('DEEP_HEALTH_NO_AUTO_FIX');
  });

  it('(e) NPM_DEFAULT_FIXER is osv-then-audit', () => {
    expect(NPM_DEFAULT_FIXER).toBe('osv-then-audit');
  });
});
