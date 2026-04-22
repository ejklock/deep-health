import { describe, it, expect } from 'vitest';
import { resolveComposerDockerImage } from '@infra/provisioner/php-image-resolver';

describe('resolveComposerDockerImage', () => {
  it('returns composer fallback image for undefined/empty', () => {
    expect(resolveComposerDockerImage(undefined)).toBe('composer:2');
    expect(resolveComposerDockerImage('')).toBe('composer:2');
    expect(resolveComposerDockerImage('   ')).toBe('composer:2');
  });

  it('resolves major.minor from 8.2.1 to php:8.2-cli', () => {
    expect(resolveComposerDockerImage('8.2.1')).toBe('php:8.2-cli');
  });

  it('resolves bare major 8 to php:8-cli', () => {
    expect(resolveComposerDockerImage('8')).toBe('php:8-cli');
  });

  it('falls back for non-numeric prefixes', () => {
    expect(resolveComposerDockerImage('v8.2')).toBe('composer:2');
    expect(resolveComposerDockerImage('abc')).toBe('composer:2');
  });
});
