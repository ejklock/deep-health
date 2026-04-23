import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CommandRunner, CommandResult } from "@core/types/common";

// ── Module-level mocks ───────────────────────────────────────────────────────
vi.mock("@infra/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runValidations } from "@modules/ecosystem/utils/validation-runner";
import { logger } from "@infra/utils/logger";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRunner(
  responses: Partial<Record<string, Partial<CommandResult>>> = {},
  defaultExitCode = 0,
): CommandRunner {
  return {
    dryRun: false,
    environment: "local",
    run: vi.fn(async (command: string) => {
      for (const [key, resp] of Object.entries(responses)) {
        if (command.includes(key)) {
          return {
            stdout: resp?.stdout ?? "",
            stderr: resp?.stderr ?? "",
            exitCode: resp?.exitCode ?? 0,
            command,
            dryRun: false,
          };
        }
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: defaultExitCode,
        command,
        dryRun: false,
      };
    }),
    runArgs: vi
      .fn()
      .mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
        command: "",
        dryRun: false,
      }),
  } as unknown as CommandRunner;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runValidations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns skipped entry when no commands configured", async () => {
    const runner = makeRunner();
    const result = await runValidations({ runner, cwd: "/tmp", commands: [] });

    expect(result.allPassed).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.status).toBe("skipped");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("returns pass entry when command exits 0", async () => {
    const runner = makeRunner({
      "npm run build": { stdout: "Build complete", exitCode: 0 },
    });

    const result = await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "build", command: "npm run build" }],
    });

    expect(result.allPassed).toBe(true);
    expect(result.entries[0]!.status).toBe("pass");
    expect(result.entries[0]!.name).toBe("build");
  });

  it("returns fail entry and allPassed=false when command exits non-zero", async () => {
    const runner = makeRunner({
      "npm run build": {
        stdout: "error output",
        stderr: "build error",
        exitCode: 1,
      },
    });

    const result = await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "build", command: "npm run build" }],
    });

    expect(result.allPassed).toBe(false);
    expect(result.entries[0]!.status).toBe("fail");
    expect(result.entries[0]!.detail).toBe("error output");
  });

  it("uses stderr as detail when stdout is empty on failure", async () => {
    const runner = makeRunner({
      "npm test": { stdout: "", stderr: "Test suite failed", exitCode: 2 },
    });

    const result = await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "test", command: "npm test" }],
    });

    expect(result.allPassed).toBe(false);
    expect(result.entries[0]!.detail).toBe("Test suite failed");
  });

  it("falls back to exit code message when both stdout and stderr empty on failure", async () => {
    const runner = makeRunner({
      "npm run lint": { stdout: "", stderr: "", exitCode: 127 },
    });

    const result = await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "lint", command: "npm run lint" }],
    });

    expect(result.allPassed).toBe(false);
    expect(result.entries[0]!.detail).toBe("Exited with code 127");
  });

  it("logs command, stdout, stderr and exit code on failure", async () => {
    const runner = makeRunner({
      "npm run build": {
        stdout: "some output",
        stderr: "some error",
        exitCode: 1,
      },
    });

    await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "build", command: "npm run build" }],
    });

    const errorCalls: string[] = (
      logger.error as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: unknown[]) => String(c[0]));

    expect(errorCalls.some((m) => m.includes("npm run build"))).toBe(true);
    expect(errorCalls.some((m) => m.includes("some output"))).toBe(true);
    expect(errorCalls.some((m) => m.includes("some error"))).toBe(true);
    expect(errorCalls.some((m) => m.includes("1"))).toBe(true);
  });

  it("stops on first failure and does not run subsequent commands", async () => {
    const runner = makeRunner({ "npm run build": { exitCode: 1 } });

    const result = await runValidations({
      runner,
      cwd: "/tmp",
      commands: [
        { name: "build", command: "npm run build" },
        { name: "test", command: "npm test" },
      ],
    });

    expect(result.allPassed).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("runs all commands sequentially when all pass", async () => {
    const runner = makeRunner();

    const result = await runValidations({
      runner,
      cwd: "/tmp",
      commands: [
        { name: "build", command: "npm run build" },
        { name: "test", command: "npm test" },
      ],
    });

    expect(result.allPassed).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("respects custom successExitCodes", async () => {
    const runner = makeRunner({ "npm run check": { exitCode: 2 } });

    const result = await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "check", command: "npm run check" }],
      successExitCodes: [0, 2],
    });

    expect(result.allPassed).toBe(true);
    expect(result.entries[0]!.status).toBe("pass");
  });

  it("does not log stdout/stderr sections when they are empty on failure", async () => {
    const runner = makeRunner({
      "npm run lint": { stdout: "", stderr: "", exitCode: 1 },
    });

    await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "lint", command: "npm run lint" }],
    });

    const errorCalls: string[] = (
      logger.error as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: unknown[]) => String(c[0]));

    // Should not emit stdout/stderr lines when there's nothing to show
    expect(errorCalls.some((m) => m.includes("stdout"))).toBe(false);
    expect(errorCalls.some((m) => m.includes("stderr"))).toBe(false);
  });

  it("propagates timeout to runner.run when timeout_seconds is set", async () => {
    const runner = makeRunner({
      "npm run build": { stdout: "Build complete", exitCode: 0 },
    });

    await runValidations({
      runner,
      cwd: "/tmp",
      commands: [
        { name: "build", command: "npm run build", timeout_seconds: 30 },
      ],
    });

    expect(runner.run).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ timeout: 30000 }),
    );
  });

  it("does not pass timeout property to runner.run when timeout_seconds is not set", async () => {
    const runner = makeRunner({
      "npm run build": { stdout: "Build complete", exitCode: 0 },
    });

    await runValidations({
      runner,
      cwd: "/tmp",
      commands: [{ name: "build", command: "npm run build" }],
    });

    const callArgs = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(callArgs[1]).not.toHaveProperty("timeout");
  });
});
