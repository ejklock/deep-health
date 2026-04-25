/**
 * Barrel test for src/index.ts — ensures all re-exports are defined.
 * Achieves coverage on the barrel file's statements/functions.
 */
import { describe, it, expect } from 'vitest';

import {
  loadConfig,
  DEFAULT_CONFIG_PATH,
  generateConfigYaml,
  runOrchestrator,
  generateExecutiveReport,
  executiveReportFilename,
  validateGateA,
  validateEcosystemGate,
  LocalExecutor,
  resolveReportsDir,
  saveReport,
} from '@app/../index';

describe('src/index.ts barrel exports', () => {
  it('DEFAULT_CONFIG_PATH is a non-empty string', () => {
    expect(typeof DEFAULT_CONFIG_PATH).toBe('string');
    expect(DEFAULT_CONFIG_PATH.length).toBeGreaterThan(0);
  });

  it('loadConfig is a function', () => {
    expect(typeof loadConfig).toBe('function');
  });

  it('generateConfigYaml is a function', () => {
    expect(typeof generateConfigYaml).toBe('function');
  });

  it('runOrchestrator is a function', () => {
    expect(typeof runOrchestrator).toBe('function');
  });

  it('generateExecutiveReport is a function', () => {
    expect(typeof generateExecutiveReport).toBe('function');
  });

  it('executiveReportFilename is a function', () => {
    expect(typeof executiveReportFilename).toBe('function');
  });

  it('validateGateA is a function', () => {
    expect(typeof validateGateA).toBe('function');
  });

  it('validateEcosystemGate is a function', () => {
    expect(typeof validateEcosystemGate).toBe('function');
  });

  it('LocalExecutor is a constructor', () => {
    expect(typeof LocalExecutor).toBe('function');
    const e = new LocalExecutor();
    expect(e.environment).toBe('local');
  });

  it('resolveReportsDir is a function', () => {
    expect(typeof resolveReportsDir).toBe('function');
  });

  it('saveReport is a function', () => {
    expect(typeof saveReport).toBe('function');
  });
});
