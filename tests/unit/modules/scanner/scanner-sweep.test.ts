/**
 * Unit tests for Scanner Sweep (scanner-sweep.ts).
 *
 * Uses silentScannerSweepRenderer or a minimal fake renderer — NO listr2 mocking.
 * All tests are config-agnostic: policy is injected directly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executeScannerSweep,
  PrimaryEngineFailure,
} from '@modules/scanner/scanner-sweep';
import type { EngineRunRenderer, EngineRunPolicy } from '@modules/scanner/scanner-sweep';
import { silentScannerSweepRenderer } from '@modules/scanner/scanner-sweep-renderers';
import type { ScannerEngine, ScannerEngineContext } from '@modules/scanner/types';
import type { ScanResultJson } from '@core/types/scan';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(): ScannerEngineContext {
  return {
    runner: {} as ScannerEngineContext['runner'],
    config: {} as ScannerEngineContext['config'],
    cwd: '/project',
    ecosystemRegistry: {} as ScannerEngineContext['ecosystemRegistry'],
    branch: null,
  };
}

function makeEngine(
  id: string,
  scan: () => Promise<ScanResultJson>,
): ScannerEngine {
  return {
    id,
    name: id.toUpperCase(),
    scan,
    assertAvailable: vi.fn().mockResolvedValue(undefined),
  };
}

function successResult(id = 'osv'): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: id,
    status: 'success',
    environment: 'local',
    ecosystems: {},
    error: null,
  };
}

function errorResult(errorMsg: string | null = 'scan failed'): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'test',
    status: 'error',
    environment: 'local',
    ecosystems: {},
    error: errorMsg,
  };
}

function skippedResult(): ScanResultJson {
  return {
    $schema: 'osv-scan-result/v1',
    agent: 'test',
    status: 'skipped',
    environment: 'local',
    ecosystems: {},
    error: null,
  };
}

function policy(
  primaryEngineId: string,
  resolveOnFailure: (id: string) => 'warn' | 'fail' = () => 'fail',
): EngineRunPolicy {
  return { primaryEngineId, resolveOnFailure };
}

// ─── Fake renderer ────────────────────────────────────────────────────────────

/**
 * A minimal renderer that just calls runOne per engine and captures results.
 * Also records call order for sequencing tests.
 */
function fakeRenderer(): EngineRunRenderer & { callOrder: string[] } {
  const callOrder: string[] = [];
  return {
    callOrder,
    async runSweep<T>(
      engines: ScannerEngine[],
      runOne: (engine: ScannerEngine) => Promise<T>,
    ): Promise<Map<string, T | Error>> {
      const map = new Map<string, T | Error>();
      for (const engine of engines) {
        callOrder.push(engine.id);
        try {
          map.set(engine.id, await runOne(engine));
        } catch (err) {
          map.set(engine.id, err instanceof Error ? err : new Error(String(err)));
        }
      }
      return map;
    },
  };
}

// ─── Tests: renderer delegation ───────────────────────────────────────────────

describe('Scanner Sweep: renderer delegation', () => {
  it('calls renderer.runSweep with the full engine list and runOne fn', async () => {
    const renderer: EngineRunRenderer = {
      runSweep: vi.fn().mockImplementation(async <T>(
        engines: ScannerEngine[],
        runOne: (e: ScannerEngine) => Promise<T>,
      ) => {
        const map = new Map<string, T | Error>();
        for (const engine of engines) {
          map.set(engine.id, await runOne(engine));
        }
        return map;
      }),
    };

    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult('osv'))),
    ];

    await executeScannerSweep(engines, makeCtx(), policy('osv'), renderer);

    expect(renderer.runSweep).toHaveBeenCalledOnce();
    const [calledEngines] = (renderer.runSweep as ReturnType<typeof vi.fn>).mock.calls[0] as [ScannerEngine[], unknown];
    expect(calledEngines.map((e) => e.id)).toEqual(['osv']);
  });

  it('runs engines in registry order (sequential, recorded via fake renderer)', async () => {
    const renderer = fakeRenderer();
    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult('osv'))),
      makeEngine('sonar', () => Promise.resolve(successResult('sonar'))),
      makeEngine('extra', () => Promise.resolve(successResult('extra'))),
    ];

    await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', () => 'warn'),
      renderer,
    );

    expect(renderer.callOrder).toEqual(['osv', 'sonar', 'extra']);
  });
});

// ─── Tests: success path ──────────────────────────────────────────────────────

describe('Scanner Sweep: success path', () => {
  it('three engines all succeed — engineEntries has 3 entries, warnings is empty', async () => {
    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult('osv'))),
      makeEngine('sonar', () => Promise.resolve(successResult('sonar'))),
      makeEngine('extra', () => Promise.resolve(successResult('extra'))),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', () => 'warn'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow type for TypeScript

    expect(result.value.engineEntries).toHaveLength(3);
    expect(result.value.engineEntries.map((e) => e.engineId)).toEqual(['osv', 'sonar', 'extra']);
    expect(result.value.warnings).toHaveLength(0);
  });
});

// ─── Tests: secondary engine errors ──────────────────────────────────────────

describe('Scanner Sweep: secondary throws + on_failure="warn"', () => {
  it('records a warning and excludes the failed engine from engineEntries', async () => {
    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult())),
      makeEngine('sonar', () => Promise.reject(new Error('sonar down'))),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', () => 'warn'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.engineEntries).toHaveLength(1);
    expect(result.value.engineEntries[0]?.engineId).toBe('osv');
    expect(result.value.warnings).toHaveLength(1);
    expect(result.value.warnings[0]).toMatchObject({ engineId: 'sonar', message: 'sonar down' });
  });
});

describe('Scanner Sweep: secondary throws + on_failure="fail"', () => {
  it('returns Err with kind="secondary" carrying the original error', async () => {
    const originalError = new Error('sonar exploded');
    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult())),
      makeEngine('sonar', () => Promise.reject(originalError)),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', () => 'fail'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('secondary');
    if (result.error.kind !== 'secondary') return;

    expect(result.error.error).toBe(originalError);
    expect(result.error.error.message).toBe('sonar exploded');

    // Must NOT be a PrimaryEngineFailure
    expect(result.error.error).not.toBeInstanceOf(PrimaryEngineFailure);
  });
});

describe('Scanner Sweep: secondary returns status="error" + on_failure="warn"', () => {
  it('records a warning with the result.error message', async () => {
    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult())),
      makeEngine('sonar', () => Promise.resolve(errorResult('sonar reported error'))),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', () => 'warn'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.warnings).toHaveLength(1);
    expect(result.value.warnings[0]).toMatchObject({ engineId: 'sonar', message: 'sonar reported error' });
    expect(result.value.engineEntries).toHaveLength(1); // only osv
  });
});

describe('Scanner Sweep: secondary returns status="error" + on_failure="fail"', () => {
  it('returns Err with kind="secondary" and the error message from result.error', async () => {
    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult())),
      makeEngine('sonar', () => Promise.resolve(errorResult('sonar fatal error'))),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', () => 'fail'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('secondary');
    if (result.error.kind !== 'secondary') return;

    expect(result.error.error.message).toBe('sonar fatal error');
  });
});

describe('Scanner Sweep: secondary returns status="skipped"', () => {
  it('silently drops — no warning, no entry', async () => {
    const engines = [
      makeEngine('osv', () => Promise.resolve(successResult())),
      makeEngine('sonar', () => Promise.resolve(skippedResult())),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', () => 'warn'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.engineEntries).toHaveLength(1);
    expect(result.value.engineEntries[0]?.engineId).toBe('osv');
    expect(result.value.warnings).toHaveLength(0);
  });
});

// ─── Tests: primary engine errors ────────────────────────────────────────────

describe('Scanner Sweep: primary throws', () => {
  it('returns Err with kind="primary", failure has engineId, cause, and partialWarnings', async () => {
    const primaryError = new Error('osv crashed');
    const engines = [
      makeEngine('osv', () => Promise.reject(primaryError)),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('primary');
    if (result.error.kind !== 'primary') return;

    expect(result.error.failure).toBeInstanceOf(PrimaryEngineFailure);
    expect(result.error.failure.engineId).toBe('osv');
    expect(result.error.failure.cause).toBe(primaryError);
    expect(result.error.failure.partialWarnings).toEqual([]);
  });
});

describe('Scanner Sweep: primary returns status="error"', () => {
  it('returns Err with kind="primary", failure.cause wraps result.error', async () => {
    const engines = [
      makeEngine('osv', () => Promise.resolve(errorResult('scan tool failed'))),
    ];

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv'),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('primary');
    if (result.error.kind !== 'primary') return;

    expect(result.error.failure).toBeInstanceOf(PrimaryEngineFailure);
    expect(result.error.failure.engineId).toBe('osv');
    expect(result.error.failure.cause).toBeInstanceOf(Error);
    expect((result.error.failure.cause as Error).message).toContain('scan tool failed');
    expect(result.error.failure.partialWarnings).toEqual([]);
  });
});

describe('Scanner Sweep: primary failure preserves partialWarnings from earlier secondaries', () => {
  it('partialWarnings includes warnings from secondaries that ran before the primary failed', async () => {
    // Engine order: sonar (secondary, warns), osv (primary, fails)
    // The fake renderer and silent renderer both process engines in array order.
    const primaryError = new Error('primary exploded late');
    const engines = [
      // sonar runs first (secondary, warns)
      makeEngine('sonar', () => Promise.reject(new Error('sonar non-fatal'))),
      // osv runs second (primary, throws)
      makeEngine('osv', () => Promise.reject(primaryError)),
    ];

    const resolveOnFailure = (id: string) => (id === 'sonar' ? 'warn' : 'fail') as 'warn' | 'fail';

    const result = await executeScannerSweep(
      engines,
      makeCtx(),
      policy('osv', resolveOnFailure),
      silentScannerSweepRenderer,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('primary');
    if (result.error.kind !== 'primary') return;

    expect(result.error.failure.partialWarnings).toHaveLength(1);
    expect(result.error.failure.partialWarnings[0]).toMatchObject({ engineId: 'sonar', message: 'sonar non-fatal' });
  });
});

// ─── Tests: silentScannerSweepRenderer ───────────────────────────────────────

describe('silentScannerSweepRenderer: runSweep', () => {
  it('returns Map preserving engine ids and result/error association', async () => {
    const err = new Error('boom');
    const engines = [
      makeEngine('a', () => Promise.resolve(successResult('a'))),
      makeEngine('b', () => Promise.reject(err)),
    ];

    const map = await silentScannerSweepRenderer.runSweep(engines, (e) => e.scan(makeCtx()));

    expect(map.get('a')).toMatchObject({ status: 'success' });
    expect(map.get('b')).toBe(err);
  });
});

// ─── Tests: PrimaryEngineFailure ─────────────────────────────────────────────

describe('PrimaryEngineFailure', () => {
  it('is instanceof Error', () => {
    const f = new PrimaryEngineFailure('osv', new Error('cause'), []);
    expect(f).toBeInstanceOf(Error);
  });

  it('.name === "PrimaryEngineFailure"', () => {
    const f = new PrimaryEngineFailure('osv', new Error('cause'), []);
    expect(f.name).toBe('PrimaryEngineFailure');
  });

  it('carries engineId, cause, and partialWarnings', () => {
    const cause = new Error('root cause');
    const warnings = [{ engineId: 'sonar', message: 'warn' }];
    const f = new PrimaryEngineFailure('osv', cause, warnings);

    expect(f.engineId).toBe('osv');
    expect(f.cause).toBe(cause);
    expect(f.partialWarnings).toStrictEqual(warnings);
  });
});
