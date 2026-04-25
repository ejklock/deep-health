import { describe, it, expect } from 'vitest';
import { classifyPackage, classifyPackages } from '@core/policy/safe-update';
import type { ProtectedPackage } from '@core/types/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pkg(name: string, currentVersion: string, safeVersion: string | null) {
  return { name, currentVersion, safeVersion };
}

function protected_(
  packageName: string,
  constraint: string,
  reason = 'pinned by team',
): ProtectedPackage {
  return { package: packageName, constraint, reason };
}

// ---------------------------------------------------------------------------
// Group 1: safeVersion absent → manual
// ---------------------------------------------------------------------------

describe('classifyPackage — no safe version', () => {
  it('null safeVersion → manual with "No safe version available"', () => {
    const result = classifyPackage(pkg('lodash', '4.17.20', null), []);
    expect(result.classification).toBe('manual');
    expect(result.reason).toContain('No safe version available');
    expect(result.breakingReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 2: no protected_packages → classify by major bump only
// ---------------------------------------------------------------------------

describe('classifyPackage — no protected_packages list', () => {
  it('patch bump → auto_safe', () => {
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.17.21'), []);
    expect(result.classification).toBe('auto_safe');
    expect(result.breakingReason).toBeUndefined();
  });

  it('minor bump → auto_safe', () => {
    const result = classifyPackage(pkg('lodash', '4.17.21', '4.18.0'), []);
    expect(result.classification).toBe('auto_safe');
    expect(result.breakingReason).toBeUndefined();
  });

  it('major bump → breaking with reason "Major version bump"', () => {
    const result = classifyPackage(pkg('lodash', '4.17.21', '5.0.0'), []);
    expect(result.classification).toBe('breaking');
    expect(result.reason).toContain('Major version bump');
    expect(result.breakingReason).toBe('major-bump');
  });

  it('major bump reason must NOT mention "Protected package"', () => {
    // Regression: group-2 breaking classification should not bleed protected messaging
    const result = classifyPackage(pkg('lodash', '4.17.21', '5.0.0'), []);
    expect(result.reason).not.toContain('Protected package');
  });
});

// ---------------------------------------------------------------------------
// Group 3: protected constraint SATISFIED
// ---------------------------------------------------------------------------

describe('classifyPackage — protected constraint satisfied', () => {
  it('caret constraint, patch bump within range → auto_safe', () => {
    const protectedList = [protected_('lodash', '^4.17.0')];
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.17.21'), protectedList);
    expect(result.classification).toBe('auto_safe');
  });

  it('tilde constraint, patch bump within range → auto_safe', () => {
    // ~4.17.20 permits >=4.17.20 <4.18.0
    const protectedList = [protected_('lodash', '~4.17.20')];
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.17.21'), protectedList);
    expect(result.classification).toBe('auto_safe');
  });
});

// ---------------------------------------------------------------------------
// Group 4: protected constraint VIOLATED
// ---------------------------------------------------------------------------

describe('classifyPackage — protected constraint violated', () => {
  it('tilde constraint, minor bump outside range → breaking with "Protected package" and "outside constraint"', () => {
    // ~4.17.20 does NOT allow 4.18.0
    const protectedList = [protected_('lodash', '~4.17.20', 'downstream compatibility lock')];
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.18.0'), protectedList);
    expect(result.classification).toBe('breaking');
    expect(result.reason).toContain('Protected package');
    expect(result.reason).toContain('outside constraint');
    expect(result.breakingReason).toBe('protected-constraint');
  });

  it('caret constraint, major bump outside range → breaking with "Protected package"', () => {
    // ^4.17.0 does NOT allow 5.0.0
    const protectedList = [protected_('lodash', '^4.17.0', 'v4 API only')];
    const result = classifyPackage(pkg('lodash', '4.17.21', '5.0.0'), protectedList);
    expect(result.classification).toBe('breaking');
    expect(result.reason).toContain('Protected package');
    expect(result.breakingReason).toBe('protected-constraint');
  });

  it('non-protected package alongside a protected list must NOT get "Protected package" reason on breaking', () => {
    // axios is NOT in the protected list; its breaking reason must be major bump only
    const protectedList = [protected_('lodash', '^4.17.0')];
    const result = classifyPackage(pkg('axios', '0.27.2', '1.0.0'), protectedList);
    expect(result.classification).toBe('breaking');
    expect(result.reason).not.toContain('Protected package');
    expect(result.reason).toContain('Major version bump');
    expect(result.breakingReason).toBe('major-bump');
  });
});

// ---------------------------------------------------------------------------
// Group 5: protected vs non-protected coexisting
// ---------------------------------------------------------------------------

describe('classifyPackage — protected list with irrelevant entries', () => {
  it('pkg.name not in protected list → behaves as if no protected config', () => {
    const protectedList = [protected_('lodash', '^4.17.0')];
    // axios minor bump — not protected, should be auto_safe
    const result = classifyPackage(pkg('axios', '1.3.0', '1.4.0'), protectedList);
    expect(result.classification).toBe('auto_safe');
  });
});

// ---------------------------------------------------------------------------
// Group 6: unparseable versions
// ---------------------------------------------------------------------------

describe('classifyPackage — unparseable versions', () => {
  it('empty currentVersion → manual with "Cannot parse"', () => {
    const result = classifyPackage(pkg('lodash', '', '1.0.0'), []);
    expect(result.classification).toBe('manual');
    expect(result.reason).toContain('Cannot parse');
  });

  it('non-semver safeVersion → manual with "Cannot parse"', () => {
    const result = classifyPackage(pkg('lodash', '1.2.3', 'not-semver'), []);
    expect(result.classification).toBe('manual');
    expect(result.reason).toContain('Cannot parse');
  });

  it('v-prefixed versions coerced correctly → auto_safe for patch bump', () => {
    // semver.coerce handles 'v4.17.20' and 'v4.17.21'
    const result = classifyPackage(pkg('lodash', 'v4.17.20', 'v4.17.21'), []);
    expect(result.classification).toBe('auto_safe');
  });
});

// ---------------------------------------------------------------------------
// Group 7: Map vs Array API for protectedPackages
// ---------------------------------------------------------------------------

describe('classifyPackage — protected list accepts Map or Array', () => {
  const protectedArr: ProtectedPackage[] = [protected_('lodash', '~4.17.20', 'pin reason')];
  const protectedMap = new Map<string, ProtectedPackage>([
    ['lodash', protected_('lodash', '~4.17.20', 'pin reason')],
  ]);

  it('Array form: constraint violated → breaking', () => {
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.18.0'), protectedArr);
    expect(result.classification).toBe('breaking');
    expect(result.reason).toContain('Protected package');
  });

  it('Map form: same constraint violated → same breaking result', () => {
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.18.0'), protectedMap);
    expect(result.classification).toBe('breaking');
    expect(result.reason).toContain('Protected package');
  });

  it('Array form: constraint satisfied → auto_safe', () => {
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.17.21'), protectedArr);
    expect(result.classification).toBe('auto_safe');
  });

  it('Map form: constraint satisfied → auto_safe', () => {
    const result = classifyPackage(pkg('lodash', '4.17.20', '4.17.21'), protectedMap);
    expect(result.classification).toBe('auto_safe');
  });
});

// ---------------------------------------------------------------------------
// Group 8: Regression — protected constraint check precedes major bump check
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Group 9: Downgrade detection
// ---------------------------------------------------------------------------

describe('classifyPackage — downgrade detection', () => {
  it('safeVersion older than currentVersion → manual with "older than current" reason', () => {
    // Mirrors the real rollup case: currentVersion=4.57.1, safeVersion=2.80.0
    const result = classifyPackage(pkg('rollup', '4.57.1', '2.80.0'), []);
    expect(result.classification).toBe('manual');
    expect(result.reason).toContain('older than current');
  });

  it('safeVersion equal to currentVersion → auto_safe (not treated as downgrade)', () => {
    // semver.lt("2.80.0", "2.80.0") is false, so this falls through to auto_safe.
    // Documents the boundary: equal versions are not a downgrade.
    const result = classifyPackage(pkg('rollup', '2.80.0', '2.80.0'), []);
    expect(result.classification).toBe('auto_safe');
  });
});

describe('regression: protected constraint check precedes major bump check', () => {
  it(
    // This test documents the INVARIANT: a protected package whose safe version violates
    // its constraint MUST be classified as "breaking" even when the version delta is only
    // a patch bump (i.e. even though the major bump check alone would not trigger breaking).
    // The protected constraint gate must fire BEFORE the major-bump gate.
    'patch bump that violates exact protected constraint → breaking with "Protected package" (not a major bump reason)',
    () => {
      // constraint is exactly "4.17.0" — only that exact version satisfies it.
      // safe=4.17.5 is a patch bump (would normally be auto_safe) but it violates the
      // pinned constraint, so it MUST come back as breaking.
      const protectedList = [protected_('lodash', '4.17.0', 'exact pin required by downstream')];
      const result = classifyPackage(pkg('lodash', '4.17.0', '4.17.5'), protectedList);
      expect(result.classification).toBe('breaking');
      expect(result.reason).toContain('Protected package');
      // Must NOT say "Major version bump" — the real cause is the constraint violation
      expect(result.reason).not.toContain('Major version bump');
    },
  );
});

describe('classifyPackages()', () => {
  it('classifies a batch of packages using protectedPackages list (lines 78-84)', () => {
    const pkgs = [
      pkg('lodash', '4.17.0', '4.17.5'),
      pkg('express', '4.18.0', null),
    ];
    const results = classifyPackages(pkgs, []);
    expect(results[0].classification).toBe('auto_safe');
    expect(results[1].classification).toBe('manual');
  });

  it('applies protected-constraint classification via classifyPackages', () => {
    const pkgs = [pkg('lodash', '4.17.0', '5.0.0')]; // 5.0.0 violates ^4.17.0
    const results = classifyPackages(pkgs, [protected_('lodash', '^4.17.0')]);
    expect(results[0].classification).toBe('breaking');
    expect(results[0].breakingReason).toBe('protected-constraint');
  });
});
