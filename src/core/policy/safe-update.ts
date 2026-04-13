import semver from 'semver';
import type { ProtectedPackage } from '../types/config.js';
import type { VulnerabilityClass } from '../types/common.js';

export interface PackageVulnerability {
  name: string;
  currentVersion: string;
  safeVersion: string | null;
}

export interface ClassifiedPackage {
  name: string;
  currentVersion: string;
  safeVersion: string | null;
  classification: VulnerabilityClass;
  reason?: string;
}

export function classifyPackage(
  pkg: PackageVulnerability,
  protectedPackages: ProtectedPackage[] | Map<string, ProtectedPackage>,
): ClassifiedPackage {
  if (!pkg.safeVersion) {
    return { ...pkg, classification: 'manual', reason: 'No safe version available' };
  }

  const protected_ = protectedPackages instanceof Map
    ? protectedPackages.get(pkg.name)
    : protectedPackages.find((p) => p.package === pkg.name);

  if (protected_) {
    // Check if the safe version satisfies the protected constraint
    const satisfies = semver.satisfies(pkg.safeVersion, protected_.constraint, {
      includePrerelease: false,
    });

    if (!satisfies) {
      return {
        ...pkg,
        classification: 'breaking',
        reason: `Protected package: ${protected_.reason}. Safe version ${pkg.safeVersion} is outside constraint ${protected_.constraint}`,
      };
    }
  }

  // Check if safe version requires a major bump
  const current = semver.coerce(pkg.currentVersion);
  const safe = semver.coerce(pkg.safeVersion);

  if (!current || !safe) {
    return { ...pkg, classification: 'manual', reason: 'Cannot parse version strings' };
  }

  if (safe.major > current.major) {
    return {
      ...pkg,
      classification: 'breaking',
      reason: `Major version bump required: ${pkg.currentVersion} → ${pkg.safeVersion}`,
    };
  }

  return { ...pkg, classification: 'auto_safe' };
}

export function classifyPackages(
  packages: PackageVulnerability[],
  protectedPackages: ProtectedPackage[],
): ClassifiedPackage[] {
  const protectedMap = new Map(protectedPackages.map((p) => [p.package, p]));
  return packages.map((pkg) => classifyPackage(pkg, protectedMap));
}
