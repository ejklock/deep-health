import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@infra/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn() },
}));

import { logDryRunPreview } from "@orchestration/dry-run-preview";
import { logger } from "@infra/utils/logger";
import { emptyEcosystem } from "@core/types/scan";
import type { EcosystemScanResult, VulnerabilityEntry } from "@core/types/scan";

function makeVuln(
  pkg: string,
  classification: VulnerabilityEntry["classification"],
  currentVersion: string,
  safeVersion: string | null,
  breakingReason?: VulnerabilityEntry["breakingReason"],
): VulnerabilityEntry {
  return {
    ecosystem: "npm",
    package: pkg,
    currentVersion,
    safeVersion,
    cvss: "7.5",
    ghsaId: `GHSA-fake-${pkg}`,
    risk: "high",
    classification,
    reason: "test",
    breakingReason,
  };
}

function makeEcosystem(vulns: VulnerabilityEntry[]): EcosystemScanResult {
  return { ...emptyEcosystem(), vulnerabilities: vulns };
}

describe("logDryRunPreview", () => {
  beforeEach(() => {
    vi.mocked(logger.info).mockClear();
  });

  it("1. logs 'no planned changes' when ecosystem has no auto_safe vulns", () => {
    const eco = makeEcosystem([]);
    logDryRunPreview("npm", eco, false);
    expect(logger.info).toHaveBeenCalledWith(
      "[DRY-RUN] npm: no planned changes",
    );
  });

  it("2. logs a single auto-safe update", () => {
    const eco = makeEcosystem([
      makeVuln("lodash", "auto_safe", "4.17.20", "4.17.21"),
    ]);
    logDryRunPreview("npm", eco, false);
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0]);
    expect(
      calls.some((c) => c.includes("[auto-safe]  lodash: 4.17.20 → 4.17.21")),
    ).toBe(true);
  });

  it("3. logs multiple auto-safe updates", () => {
    const eco = makeEcosystem([
      makeVuln("lodash", "auto_safe", "4.17.20", "4.17.21"),
      makeVuln("axios", "auto_safe", "0.20.0", "0.21.2"),
      makeVuln("express", "auto_safe", "4.18.0", "4.18.3"),
    ]);
    logDryRunPreview("npm", eco, false);
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("lodash"))).toBe(true);
    expect(calls.some((c) => c.includes("axios"))).toBe(true);
    expect(calls.some((c) => c.includes("express"))).toBe(true);
  });

  it("4. deduplicates auto-safe entries for the same package (multiple CVEs)", () => {
    const eco = makeEcosystem([
      makeVuln("lodash", "auto_safe", "4.17.20", "4.17.21"),
      makeVuln("lodash", "auto_safe", "4.17.20", "4.17.21"),
    ]);
    logDryRunPreview("npm", eco, false);
    const autosafeCalls = vi
      .mocked(logger.info)
      .mock.calls.map((c) => c[0] as string)
      .filter((c) => c.includes("[auto-safe]") && c.includes("lodash"));
    expect(autosafeCalls).toHaveLength(1);
  });

  it("5. includes breaking package when authorizeBreaking=true", () => {
    const eco = makeEcosystem([
      makeVuln("semver", "breaking", "6.3.0", "7.0.0", "major-bump"),
    ]);
    logDryRunPreview("npm", eco, true);
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(
      calls.some((c) => c.includes("[breaking]") && c.includes("semver")),
    ).toBe(true);
  });

  it("6. excludes breaking package when authorizeBreaking=false", () => {
    const eco = makeEcosystem([
      makeVuln("semver", "breaking", "6.3.0", "7.0.0", "major-bump"),
    ]);
    logDryRunPreview("npm", eco, false);
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes("[breaking]"))).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      "[DRY-RUN] npm: no planned changes",
    );
  });

  it("7. excludes protected-constraint packages even when authorizeBreaking=true", () => {
    const eco = makeEcosystem([
      makeVuln("react", "breaking", "17.0.0", "18.0.0", "protected-constraint"),
    ]);
    logDryRunPreview("npm", eco, true);
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(
      calls.some((c) => c.includes("[breaking]") && c.includes("react")),
    ).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      "[DRY-RUN] npm: no planned changes",
    );
  });

  it("8. header shows correct total count (auto-safe + breaking)", () => {
    const eco = makeEcosystem([
      makeVuln("lodash", "auto_safe", "4.17.20", "4.17.21"),
      makeVuln("axios", "auto_safe", "0.20.0", "0.21.2"),
      makeVuln("semver", "breaking", "6.3.0", "7.0.0", "major-bump"),
    ]);
    logDryRunPreview("npm", eco, true);
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    const header = calls.find((c) => c.includes("planned changes preview"));
    expect(header).toBeDefined();
    expect(header).toContain("3 package(s)");
  });
});
