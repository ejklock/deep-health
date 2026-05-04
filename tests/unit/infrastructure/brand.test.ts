import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('brand', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env['CLI_NAME'];
    delete process.env['NPM_DEFAULT_FIXER'];
  });

  it('(a) CLI_NAME defaults to deep-health when env is unset', async () => {
    delete process.env['CLI_NAME'];
    const brand = await import('@infra/brand');
    expect(brand.CLI_NAME).toBe('deep-health');
  });

  it('(b) CLI_NAME reads from process.env.CLI_NAME', async () => {
    process.env['CLI_NAME'] = 'my-cli';
    const brand = await import('@infra/brand');
    expect(brand.CLI_NAME).toBe('my-cli');
  });

  it('(c) DEFAULT_REPORTS_SUBDIR is .${CLI_NAME}/reports', async () => {
    process.env['CLI_NAME'] = 'test-tool';
    const brand = await import('@infra/brand');
    expect(brand.DEFAULT_REPORTS_SUBDIR).toBe('.test-tool/reports');
  });

  it('(d) DEFAULT_BRANCH_PREFIX is fix/${CLI_NAME}-', async () => {
    process.env['CLI_NAME'] = 'test-tool';
    const brand = await import('@infra/brand');
    expect(brand.DEFAULT_BRANCH_PREFIX).toBe('fix/test-tool-');
  });

  it('(e) KILL_SWITCH_VAR is derived correctly for deep-health', async () => {
    delete process.env['CLI_NAME'];
    const brand = await import('@infra/brand');
    expect(brand.KILL_SWITCH_VAR).toBe('DEEP_HEALTH_NO_AUTO_FIX');
  });

  it('(e) KILL_SWITCH_VAR is derived correctly for security-scan', async () => {
    process.env['CLI_NAME'] = 'security-scan';
    const brand = await import('@infra/brand');
    expect(brand.KILL_SWITCH_VAR).toBe('SECURITY_SCAN_NO_AUTO_FIX');
  });

  it('(f) NPM_DEFAULT_FIXER defaults to osv-then-audit independent of CLI_NAME', async () => {
    delete process.env['NPM_DEFAULT_FIXER'];
    process.env['CLI_NAME'] = 'security-scan';
    const brand = await import('@infra/brand');
    expect(brand.NPM_DEFAULT_FIXER).toBe('osv-then-audit');
  });

  it('(g) NPM_DEFAULT_FIXER can be overridden by process.env.NPM_DEFAULT_FIXER', async () => {
    process.env['NPM_DEFAULT_FIXER'] = 'npm-audit';
    const brand = await import('@infra/brand');
    expect(brand.NPM_DEFAULT_FIXER).toBe('npm-audit');
  });
});
