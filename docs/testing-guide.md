# Testing Guide — deep-health

## Test Structure

Tests live in `tests/unit/` mirroring `src/`:

```
tests/unit/
├── app/                      # Command-level tests
├── core/
│   ├── gates/
│   └── policy/
├── infrastructure/
│   ├── config/
│   ├── executor/
│   └── provisioner/
├── modules/
│   └── advisor/
├── orchestration/
├── plugins/                  # Ecosystem plugin tests (updaters, fixers, inferVersion)
├── reporting/
└── scanner/
```

**File naming convention:**

| File pattern | Purpose |
|---|---|
| `<module>.test.ts` | Happy-path and primary behavior tests |
| `<module>-branches.test.ts` | Error paths, edge cases, rarely-hit branches |

The `-branches.test.ts` split keeps the primary test files readable and groups defensive paths together. When writing a new plugin, start with `<plugin>.test.ts` for the main flows and add `<plugin>-branches.test.ts` when you need to cover error returns, partial failures, or guard conditions.

---

## Running Tests

```bash
npm run test              # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration test
npm run test:smoke        # Smoke tests (requires Docker)
npm run test:coverage     # With coverage report
```

---

## The `makeRunner()` Helper

Every plugin test file defines a local `makeRunner()` function. It returns a fake `CommandRunner` whose `run` and `runArgs` methods are `vi.fn()` stubs.

**Standard pattern:**

```ts
import type { CommandRunner, CommandResult } from '@core/types/common';

function makeRunner(overrides: { dryRun?: boolean; run?: ReturnType<typeof vi.fn>; runArgs?: ReturnType<typeof vi.fn> } = {}): CommandRunner {
  const { dryRun = false, run, runArgs } = overrides;
  return {
    run: run ?? vi.fn().mockResolvedValue(ok()),
    runArgs: runArgs ?? vi.fn().mockResolvedValue(ok()),
    dryRun,
    environment: 'local',
  } as unknown as CommandRunner;
}
```

**Result helpers:**

```ts
function ok(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0, command: '', dryRun: false };
}

function fail(stderr = 'something failed'): CommandResult {
  return { stdout: '', stderr, exitCode: 1, command: '', dryRun: false };
}
```

**Usage examples:**

```ts
// Default runner — all commands succeed silently
const runner = makeRunner();

// Dry-run runner — plugins must never call runner.run() or runner.runArgs() in dry-run
const runner = makeRunner({ dryRun: true });

// Override run to return failure
const runner = makeRunner({ run: vi.fn().mockResolvedValue(fail('composer update failed')) });

// Spy on specific calls
const mockRun = vi.fn().mockResolvedValue(ok('{"updated":true}'));
const runner = makeRunner({ run: mockRun });
// ... later:
expect(mockRun).toHaveBeenCalledWith(expect.stringContaining('composer update'), expect.any(Object));
```

---

## Module-Level Mocks (Vitest hoisting)

Every plugin test file must mock `@infra/utils/git.js` and `@infra/utils/logger.js` **before** the module under test is imported. Vitest hoists `vi.mock()` calls automatically, but any mock that needs a reference captured for later assertions must use `vi.hoisted()`.

**Always mock (every plugin test file):**

```ts
vi.mock('@infra/utils/git.js', () => ({
  backupFiles: vi.fn().mockResolvedValue(new Map()),
  restoreFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@infra/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
```

**When you need to reference the mock later (e.g. `readFile`):**

```ts
// MUST use vi.hoisted() so the variable is available at mock-call time
const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// Now you can configure per-test behavior:
beforeEach(() => {
  mockReadFile.mockResolvedValue(JSON.stringify({ lockfileVersion: 2, packages: {}, dependencies: {} }));
});
```

**Why not just `vi.mocked(readFile)` after import?**

`vi.mock()` is hoisted before imports. If you declare `const mockReadFile = vi.mocked(readFile)` after the import, the reference is fine, but you cannot configure the return value in the `vi.mock()` factory itself. The `vi.hoisted()` pattern is needed when the mock factory needs access to the stub variable at module-load time.

**When `emptyEcosystem` needs mocking:**

Some tests for plugins that call `emptyEcosystem()` (used when a scan result has no entry for an ecosystem) need to mock `@core/types/scan.js`:

```ts
vi.mock('@core/types/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/types/scan.js')>();
  return {
    ...actual,
    emptyEcosystem: vi.fn(() => ({
      vulnerabilities_total: 0, auto_safe: 0, breaking: 0, manual: 0,
      auto_safe_packages: [], breaking_packages: [], manual_packages: [], vulnerabilities: [],
    })),
  };
});
```

---

## Fixture Factories

Keep fixture factories at the top of the test file, after mock declarations and before `describe` blocks.

### `baseConfig()`

A minimal valid `ProjectConfig`. Only add fields your test actually needs.

```ts
function baseConfig(opts: { testCommand?: string } = {}): ProjectConfig {
  return {
    project: { name: 'test-project', client: 'test-client' },
    ecosystems: [
      {
        id: 'npm',   // change to 'composer' or 'pip' as needed
        ...(opts.testCommand
          ? { validationCommands: [{ name: 'tests', command: opts.testCommand }] }
          : {}),
      },
    ],
    protected_packages: { composer: [], npm: [], pip: [] },
    safe_update_policy: {
      allow_patch_and_minor_within_constraints: true,
      require_authorization_for_constraint_change: false,
    },
    conflict_resolution: 'fail',
  };
}
```

### `baseScan()` / `emptyScan()`

```ts
function baseScan(autoSafePkgs: string[] = ['lodash@4.17.20']): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'osv',
    status: 'success',
    environment: 'local',
    ecosystems: {
      npm: {
        vulnerabilities_total: autoSafePkgs.length,
        auto_safe: autoSafePkgs.length,
        breaking: 0,
        manual: 0,
        auto_safe_packages: autoSafePkgs,
        breaking_packages: [],
        manual_packages: [],
        vulnerabilities: [],
      },
    },
    error: null,
  };
}

function emptyScan(): ScanResultJson {
  return baseScan([]);
}
```

### Lockfile stubs (npm)

For npm tests that read `package-lock.json` before/after an update:

```ts
function buildLockfile(pairs: Array<{ name: string; version: string }>): string {
  const packages: Record<string, { version: string }> = { '': { version: '1.0.0' } };
  const dependencies: Record<string, { version: string }> = {};
  for (const { name, version } of pairs) {
    packages[`node_modules/${name}`] = { version };
    dependencies[name] = { version };
  }
  return JSON.stringify({ name: 'sample', lockfileVersion: 2, packages, dependencies });
}
```

---

## Writing Tests for a New Plugin

When adding a new ecosystem plugin (e.g. `cargo`), follow this checklist:

1. **Create `tests/unit/plugins/cargo-updater.test.ts`** with the standard mock block + `makeRunner()` + fixture factories.
2. **Test dry-run paths first.** Every plugin must return `status: 'success'` and `validations[0].status === 'skipped'` in dry-run mode. No `runner.run()` or `runner.runArgs()` calls allowed.
3. **Test the happy path.** Provide a `baseScan()` with `auto_safe_packages` populated and verify `packages_updated` contains the expected entries.
4. **Test the empty scan path.** With `emptyScan()`, the updater should return `status: 'success'`, `packages_updated: []`.
5. **Test validation failure + revert.** When the validation command returns `fail()`, the updater must restore backups and return `status: 'error'`.
6. **Add `cargo-updater-branches.test.ts`** for error branches: runner throws, lockfile is absent, partial backup failure.

**Invariant to assert in every test:**

```ts
// validations array must never be empty — the gate rejects it
expect(result.validations.length).toBeGreaterThan(0);
```

---

## Testing `inferVersion`

Plugins that read project files to infer a runtime version (`.nvmrc`, `.node-version`, `package.json#engines.node`, etc.) must be tested by mocking `node:fs/promises`:

```ts
const ENOENT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

it('falls through to package.json when .nvmrc is absent', async () => {
  mockReadFile.mockImplementation(async (p: any) => {
    if (String(p).endsWith('.nvmrc')) throw ENOENT;
    if (String(p).endsWith('package.json')) return JSON.stringify({ engines: { node: '>=20' } });
    throw ENOENT;
  });
  expect(await plugin.inferVersion!('/project')).toBe('20');
});

it('returns undefined when no version file exists', async () => {
  mockReadFile.mockRejectedValue(ENOENT);
  expect(await plugin.inferVersion!('/project')).toBeUndefined();
});

it('never throws even if readFile throws unexpected errors', async () => {
  mockReadFile.mockRejectedValue(new Error('permission denied'));
  await expect(plugin.inferVersion!('/project')).resolves.toBeUndefined();
});
```

The third test is important: `inferVersion` **must never throw** per its interface contract.

---

## Gate Tests

Tests in `tests/unit/gates/` validate the Zod schemas directly. Pass raw objects:

```ts
import { validateGateA, validateEcosystemGate } from '@core/gates/validator';

it('Gate A passes on valid scan result', () => {
  const result = validateGateA(validScanFixture);
  expect(result.valid).toBe(true);
});

it('Gate A fails when status is error', () => {
  const result = validateGateA({ ...validScanFixture, status: 'error', error: 'osv crashed' });
  expect(result.valid).toBe(false);
  expect(result.errors[0]).toMatch(/Scanner returned error/);
});

it('Ecosystem gate fails when validations array is empty', () => {
  const result = validateEcosystemGate('npm', { ...validUpdateFixture, validations: [] });
  expect(result.valid).toBe(false);
});
```

---

## Coverage Config

Coverage is configured in `vitest.config.ts`. The reporter is `v8`. When running `npm run test:coverage`, the report is written to `coverage/`. The threshold for new code is determined by CI — check the workflow for the configured minimum.

---

## Common Pitfalls

| Problem | Cause | Fix |
|---|---|---|
| `vi.mock` not taking effect | `vi.mock` placed after `import` of module under test | Move all `vi.mock` calls to the top of the file, before any `import` of the module under test |
| `mockReadFile` is undefined at mock time | Declared outside `vi.hoisted()` | Wrap in `const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }))` |
| Test passes but gate rejects in production | Forgot `validations` entry for dry-run path | Always assert `result.validations.length >= 1` and `result.validations[0].status === 'skipped'` for dry-run |
| Module import order matters for mocks | Vitest ESM mock registration | Keep `vi.mock` before module imports; use `vi.hoisted` when variable reference is needed |
