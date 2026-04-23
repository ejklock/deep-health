import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runOrchestrator } from "@orchestration/orchestrator";
import { ScannerEngineRegistry } from "@modules/scanner/registry";
import { OsvScannerEngine } from "@modules/scanner/osv-engine";
import { npmPlugin } from "@modules/ecosystem/plugins/npm";
import type {
  CommandRunner,
  CommandResult,
  CommandRunnerOptions,
  ExecutionEnv,
} from "@core/types/common";
import type { ProjectConfig } from "@core/types/config";
import { logger } from "@infra/utils/logger";

// ── Module-level mocks ───────────────────────────────────────────────────────

vi.mock("@infra/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@infra/utils/git-branch.js", () => ({
  detectGitBranch: vi.fn().mockResolvedValue(null),
}));

vi.mock("@infra/provisioner/npm-runner.js", () => ({
  NpmDockerRunner: vi.fn(),
  resolveNpmDockerImage: vi.fn(() => "node:lts"),
}));
vi.mock("@infra/provisioner/osv-runner.js", () => ({
  OsvDockerRunner: vi.fn(),
}));
vi.mock("@infra/provisioner/pip-runner.js", () => ({
  PipDockerRunner: vi.fn(),
  resolvePipDockerImage: vi.fn(() => "python:3-slim"),
}));
vi.mock("@infra/provisioner/composer-runner.js", () => ({
  ComposerDockerRunner: vi.fn(),
}));
vi.mock("@infra/provisioner/php-image-resolver.js", () => ({
  resolveComposerDockerImage: vi.fn(() => "composer:2"),
}));
vi.mock("@infra/executor/npm-container-runner.js", () => ({
  NpmContainerCommandRunner: vi.fn(),
}));
vi.mock("@infra/executor/osv-container-runner.js", () => ({
  OsvContainerCommandRunner: vi.fn(),
}));
vi.mock("@infra/executor/pip-container-runner.js", () => ({
  PipContainerCommandRunner: vi.fn(),
}));
vi.mock("@infra/executor/composer-container-runner.js", () => ({
  ComposerContainerCommandRunner: vi.fn(),
}));
vi.mock("@orchestration/osv-fix-applier.js", () => ({
  applyOsvFixViaStaging: vi.fn().mockResolvedValue({
    applied: false,
    packagesUpdated: [],
    backups: new Map(),
  }),
}));
vi.mock("@orchestration/lockfile-inspect.js", () => ({
  readNpmLockfileVersion: vi.fn().mockResolvedValue(null),
}));
vi.mock("@modules/advisor/index.js", () => ({
  runAdvisors: vi.fn().mockResolvedValue([]),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

class MockCommandRunner implements CommandRunner {
  readonly dryRun: boolean;
  readonly environment: ExecutionEnv;
  readonly calledCommands: string[] = [];
  private responses: Map<string, Partial<CommandResult>>;
  private defaultResponse: Partial<CommandResult>;

  constructor(
    responses: Record<string, Partial<CommandResult>> = {},
    options: {
      dryRun?: boolean;
      environment?: ExecutionEnv;
      defaultExitCode?: number;
    } = {},
  ) {
    this.dryRun = options.dryRun ?? false;
    this.environment = options.environment ?? "local";
    this.responses = new Map(Object.entries(responses));
    this.defaultResponse = {
      stdout: "",
      stderr: "",
      exitCode: options.defaultExitCode ?? 0,
    };
  }

  async run(
    command: string,
    _options?: CommandRunnerOptions,
  ): Promise<CommandResult> {
    this.calledCommands.push(command);
    for (const [key, response] of this.responses) {
      if (command.includes(key)) {
        return {
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
          exitCode: response.exitCode ?? 0,
          command,
          dryRun: this.dryRun,
        };
      }
    }
    return {
      stdout: this.defaultResponse.stdout ?? "",
      stderr: this.defaultResponse.stderr ?? "",
      exitCode: this.defaultResponse.exitCode ?? 0,
      command,
      dryRun: this.dryRun,
    };
  }

  async runArgs(
    file: string,
    args: string[],
    options?: CommandRunnerOptions,
  ): Promise<CommandResult> {
    return this.run([file, ...args].join(" "), options);
  }
}

function makeRegistry(): ScannerEngineRegistry {
  const reg = new ScannerEngineRegistry();
  reg.register(new OsvScannerEngine());
  return reg;
}

function baseNpmConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const { scanners: overrideScanners, ...restOverrides } = overrides;
  return {
    project: { name: "Kill Switch Test", client: "Test" },
    ecosystems: [
      {
        id: "npm",
        validationCommands: [],
        advisors: [],
      },
    ],
    protected_packages: { npm: [], composer: [], pip: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: true,
    },
    conflict_resolution: "stop_and_ask",
    scanners: {
      osv: { runner: "local" },
      ...(overrideScanners ?? {}),
    },
    ...restOverrides,
  };
}

function npmScanWithAutoSafe(): string {
  return JSON.stringify({
    results: [
      {
        source: { path: "package-lock.json", type: "lockfile" },
        packages: [
          {
            package: { name: "lodash", version: "4.17.15", ecosystem: "npm" },
            vulnerabilities: [
              {
                id: "GHSA-test-npm-1",
                summary: "Test npm vuln",
                affected: [
                  {
                    package: { ecosystem: "npm", name: "lodash" },
                    ranges: [
                      {
                        type: "SEMVER",
                        events: [{ introduced: "0" }, { fixed: "4.17.21" }],
                      },
                    ],
                  },
                ],
              },
            ],
            groups: [{ ids: ["GHSA-test-npm-1"] }],
          },
        ],
      },
    ],
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runOrchestrator — DEEP_HEALTH_NO_AUTO_FIX kill-switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["DEEP_HEALTH_NO_AUTO_FIX"];
  });

  afterEach(() => {
    delete process.env["DEEP_HEALTH_NO_AUTO_FIX"];
  });

  it("skips all plugin updaters and logs a warning when DEEP_HEALTH_NO_AUTO_FIX is set", async () => {
    process.env["DEEP_HEALTH_NO_AUTO_FIX"] = "1";

    const runUpdaterSpy = vi.spyOn(npmPlugin, "runUpdater");

    const config = baseNpmConfig();
    const runner = new MockCommandRunner({
      "--lockfile package-lock.json --format json": {
        stdout: npmScanWithAutoSafe(),
        exitCode: 0,
      },
    });

    const result = await runOrchestrator(runner, config, {
      configPath: "project-config.yml",
      cwd: "/repo",
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect(runUpdaterSpy).not.toHaveBeenCalled();
    expect(result.scan).not.toBeNull();
    expect(result.updates).toEqual({});
    expect(
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        (c: unknown[]) => String(c[0]).includes("DEEP_HEALTH_NO_AUTO_FIX"),
      ),
    ).toBe(true);

    runUpdaterSpy.mockRestore();
  });

  it("calls plugin updater normally when DEEP_HEALTH_NO_AUTO_FIX is not set", async () => {
    const runUpdaterSpy = vi.spyOn(npmPlugin, "runUpdater").mockResolvedValue({
      $schema: "osv-update-result/v1",
      agent: "deep-health/test",
      status: "success",
      packages_updated: [],
      packages_skipped: [],
      packages_pending_breaking: [],
      validations: [{ name: "validation", status: "skipped" }],
      error: null,
    });

    const config = baseNpmConfig();
    const runner = new MockCommandRunner({
      "--lockfile package-lock.json --format json": {
        stdout: npmScanWithAutoSafe(),
        exitCode: 0,
      },
    });

    await runOrchestrator(runner, config, {
      configPath: "project-config.yml",
      cwd: "/repo",
      dryRun: false,
      verbose: false,
      scannerRegistry: makeRegistry(),
    });

    expect(runUpdaterSpy).toHaveBeenCalled();

    runUpdaterSpy.mockRestore();
  });
});
