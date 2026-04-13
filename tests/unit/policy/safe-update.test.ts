import { describe, it, expect } from 'vitest';
import { classifyPackage, classifyPackages } from '@core/policy/safe-update.js';
import type { ProtectedPackage } from '@core/types/config.js';

const protectedPackages: ProtectedPackage[] = [
  { package: 'laravel/framework', constraint: '^10.8', reason: 'Major upgrade requires project' },
  { package: 'alpinejs', constraint: '^3.10.2', reason: 'v4 breaking changes' },
];

describe('classifyPackage', () => {
  it('classifies auto_safe for patch update within constraint', () => {
    const result = classifyPackage(
      { name: 'some/package', currentVersion: '1.2.3', safeVersion: '1.2.4' },
      protectedPackages,
    );
    expect(result.classification).toBe('auto_safe');
  });

  it('classifies auto_safe for minor update within constraint', () => {
    const result = classifyPackage(
      { name: 'some/package', currentVersion: '1.2.3', safeVersion: '1.3.0' },
      protectedPackages,
    );
    expect(result.classification).toBe('auto_safe');
  });

  it('classifies breaking for major version bump', () => {
    const result = classifyPackage(
      { name: 'some/package', currentVersion: '1.9.9', safeVersion: '2.0.0' },
      protectedPackages,
    );
    expect(result.classification).toBe('breaking');
  });

  it('classifies breaking when safe version outside protected constraint', () => {
    const result = classifyPackage(
      { name: 'laravel/framework', currentVersion: '10.8.0', safeVersion: '11.0.0' },
      protectedPackages,
    );
    expect(result.classification).toBe('breaking');
    expect(result.reason).toContain('^10.8');
  });

  it('classifies auto_safe when protected but safe version within constraint', () => {
    const result = classifyPackage(
      { name: 'laravel/framework', currentVersion: '10.8.0', safeVersion: '10.9.0' },
      protectedPackages,
    );
    expect(result.classification).toBe('auto_safe');
  });

  it('classifies manual when no safe version available', () => {
    const result = classifyPackage(
      { name: 'some/package', currentVersion: '1.0.0', safeVersion: null },
      protectedPackages,
    );
    expect(result.classification).toBe('manual');
  });
});

describe('classifyPackages', () => {
  it('classifies multiple packages', () => {
    const packages = [
      { name: 'safe/pkg', currentVersion: '1.0.0', safeVersion: '1.0.1' },
      { name: 'laravel/framework', currentVersion: '10.0.0', safeVersion: '11.0.0' },
      { name: 'no-fix/pkg', currentVersion: '2.0.0', safeVersion: null },
    ];
    const results = classifyPackages(packages, protectedPackages);
    expect(results[0]!.classification).toBe('auto_safe');
    expect(results[1]!.classification).toBe('breaking');
    expect(results[2]!.classification).toBe('manual');
  });
});
