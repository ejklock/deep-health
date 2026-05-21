import { describe, it, expect } from 'vitest';
import { formatCliError } from '@app/diagnostics';
import { ConfigLoadError, GateValidationError, PhaseError } from '@core/errors';

describe('formatCliError', () => {
  describe('ConfigLoadError', () => {
    it('returns exitCode 3', () => {
      const err = new ConfigLoadError('Cannot read config', '/some/path');
      const result = formatCliError(err);
      expect(result.exitCode).toBe(3);
    });

    it('prefixes message with "Configuration error:"', () => {
      const err = new ConfigLoadError('Cannot read config: /foo/bar.yml', '/foo/bar.yml');
      const result = formatCliError(err);
      expect(result.message).toBe('Configuration error: Cannot read config: /foo/bar.yml');
    });

    it('preserves the full error message including hints', () => {
      const msg =
        'Cannot read config file: /foo/bar.yml\n  Hint: Run "security-scan init" to generate a starter config.';
      const err = new ConfigLoadError(msg, '/foo/bar.yml');
      const result = formatCliError(err);
      expect(result.message).toContain('security-scan init');
    });
  });

  describe('GateValidationError', () => {
    it('returns exitCode 2', () => {
      const err = new GateValidationError('gate failed', 'A', ['err1', 'err2']);
      const result = formatCliError(err);
      expect(result.exitCode).toBe(2);
    });

    it('includes the gate id in message', () => {
      const err = new GateValidationError('gate failed', 'npm', ['vuln found']);
      const result = formatCliError(err);
      expect(result.message).toMatch(/Gate npm/);
    });

    it('includes all error lines', () => {
      const err = new GateValidationError('gate failed', 'A', ['error one', 'error two']);
      const result = formatCliError(err);
      expect(result.message).toContain('  - error one');
      expect(result.message).toContain('  - error two');
    });

    it('handles empty errors array gracefully', () => {
      const err = new GateValidationError('gate failed', 'A', []);
      const result = formatCliError(err);
      expect(result.exitCode).toBe(2);
      expect(result.message).toMatch(/Gate A/);
    });
  });

  describe('PhaseError', () => {
    it('returns exitCode 2', () => {
      const err = new PhaseError('scan failed', 'scan');
      const result = formatCliError(err);
      expect(result.exitCode).toBe(2);
    });

    it('includes phase name and message', () => {
      const err = new PhaseError('OSV scanner not found', 'scan');
      const result = formatCliError(err);
      expect(result.message).toBe('Phase "scan" failed: OSV scanner not found');
    });
  });

  describe('unexpected / generic errors', () => {
    it('returns exitCode 2 for a plain Error', () => {
      const err = new Error('something exploded');
      const result = formatCliError(err);
      expect(result.exitCode).toBe(2);
    });

    it('includes the error message for a plain Error', () => {
      const err = new Error('something exploded');
      const result = formatCliError(err);
      expect(result.message).toBe('Unexpected error: something exploded');
    });

    it('returns exitCode 2 for a non-Error throw', () => {
      const result = formatCliError('a string was thrown');
      expect(result.exitCode).toBe(2);
    });

    it('stringifies non-Error throws', () => {
      const result = formatCliError('a string was thrown');
      expect(result.message).toBe('Unexpected error: a string was thrown');
    });

    it('handles null throw', () => {
      const result = formatCliError(null);
      expect(result.exitCode).toBe(2);
      expect(result.message).toBe('Unexpected error: null');
    });
  });

  describe('purity — no side effects', () => {
    it('does not call process.exit', () => {
      const origExit = process.exit;
      let exitCalled = false;
      // @ts-expect-error stub
      process.exit = () => { exitCalled = true; };
      try {
        formatCliError(new ConfigLoadError('x', '/x'));
        expect(exitCalled).toBe(false);
      } finally {
        process.exit = origExit;
      }
    });
  });
});
