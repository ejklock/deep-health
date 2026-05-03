import type { CommandRunner } from '@core/types/common';
import type { ValidationCommandConfig } from '@core/types/config';
import type { UpdateResultJson, ValidationEntry } from '@core/types/update';
import type { ScanResultJson } from '@core/types/scan';
import { emptyEcosystem } from '@core/types/scan';
import { PhaseError } from '@core/errors';
import { logger } from '@infra/utils/logger';
import type { BootstrapSpec } from './updater-transaction';
import { beginUpdaterTransaction } from './updater-transaction';
import { runValidations } from './validation-runner';

export type FixResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      /**
       * Defaults to 'skipped' — validations never ran.
       * Use 'fail' for fix failures that are validation-level signals (e.g. breaking install error).
       */
      validationStatus?: 'fail' | 'skipped';
    };

export interface LifecycleCtx {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly scanResult: ScanResultJson;
  readonly ecosystemId: string;
  readonly validationCommands: ValidationCommandConfig[];
  readonly authorizeBreaking: boolean;
}

/**
 * Recipe provided by each ecosystem updater. Generic TFixerResult types the value
 * flowing between applyFix → preValidation → derivePackagesUpdated → partialRevert.
 */
export interface UpdaterRecipe<TFixerResult = void> {
  agentName: string;
  ecosystemKey: string;
  backupPaths: string[];
  bootstrapSpec: BootstrapSpec;

  /** Apply the fix. Return ok:false to abort and revert. */
  applyFix(ctx: LifecycleCtx): Promise<FixResult<TFixerResult>>;

  /** Pre-flight check before the transaction opens. Return non-null to short-circuit. */
  probe?(ctx: LifecycleCtx): Promise<UpdateResultJson | null>;

  /** Called after applyFix succeeds, before validations. Throw to abort. */
  preValidation?(ctx: LifecycleCtx, fixerResult: TFixerResult): Promise<void>;

  /** Derive packages_updated from the fixer result. Defaults to []. */
  derivePackagesUpdated?(ctx: LifecycleCtx, fixerResult: TFixerResult): Promise<string[]>;

  /**
   * Attempt a partial rollback when validation fails.
   * Return { packagesUpdated } on success — lifecycle re-validates and succeeds if it passes.
   * Return null to skip partial revert and fall through to full revert.
   * Throw on bootstrap failure — lifecycle wraps it as PhaseError('partial-revert-bootstrap').
   */
  partialRevert?(ctx: LifecycleCtx, fixerResult: TFixerResult): Promise<{ packagesUpdated: string[] } | null>;
}

export interface RunLifecycleOpts {
  preFixBackups?: Map<string, string>;
  preRunSnapshots?: Map<string, string>;
  failIfAllSkipped?: boolean;
}

/**
 * Generic updater lifecycle skeleton shared by npm, pip, and composer.
 *
 * Sequence: probe → dry-run gate → beginUpdaterTransaction → applyFix →
 * preValidation → runValidations → (partial revert + re-validate) →
 * tx.success / tx.abortWithError → PhaseError wrap on unexpected throw.
 */
export async function runUpdaterLifecycle<TFixerResult>(
  recipe: UpdaterRecipe<TFixerResult>,
  ctx: LifecycleCtx,
  opts: RunLifecycleOpts = {},
): Promise<UpdateResultJson> {
  const { runner, cwd, scanResult, validationCommands } = ctx;
  const { preFixBackups, preRunSnapshots, failIfAllSkipped = false } = opts;

  const ecosystem = scanResult.ecosystems[recipe.ecosystemKey] ?? emptyEcosystem();

  const skippedValidations: ValidationEntry[] =
    validationCommands.length > 0
      ? validationCommands.map((vc) => ({ name: vc.name, status: 'skipped' as const, detail: 'Dry-run — not executed' }))
      : [{ name: 'validation', status: 'skipped', detail: 'No validation commands configured' }];

  const base: UpdateResultJson = {
    $schema: 'osv-update-result/v1',
    agent: recipe.agentName,
    status: 'success',
    packages_updated: [],
    packages_skipped: [],
    packages_pending_breaking: ecosystem.breaking_packages,
    validations: skippedValidations,
    error: null,
  };

  if (recipe.probe) {
    const probeResult = await recipe.probe(ctx);
    if (probeResult !== null) return probeResult;
  }

  if (runner.dryRun) return { ...base, validations: skippedValidations };

  try {
    const tx = await beginUpdaterTransaction({
      files: recipe.backupPaths,
      base,
      cwd,
      runner,
      bootstrapSpec: recipe.bootstrapSpec,
      preExistingBackups: preFixBackups,
      preRunSnapshots,
    });

    const fixResult = await recipe.applyFix(ctx);

    if (!fixResult.ok) {
      const valStatus = fixResult.validationStatus ?? 'skipped';
      return tx.abortWithError({
        error: fixResult.error,
        validations: [{ name: 'validation', status: valStatus, detail: fixResult.error }],
      });
    }

    const fixerResult = fixResult.value;

    if (recipe.preValidation) {
      try {
        await recipe.preValidation(ctx, fixerResult);
      } catch (preErr) {
        const detail = preErr instanceof Error ? preErr.message : String(preErr);
        return tx.abortWithError({ error: detail, validations: [{ name: 'pre-validation', status: 'fail', detail }] });
      }
    }

    const validationResult = await runValidations({ runner, cwd, commands: validationCommands, failIfAllSkipped });

    if (!validationResult.allPassed) {
      const failedEntry = validationResult.entries.find((e) => e.status === 'fail');
      if (failedEntry) {
        logger.error(`Validation "${failedEntry.name}" did not pass. Detail: ${failedEntry.detail ?? '(no detail)'}`);
      }

      if (recipe.partialRevert) {
        try {
          const partialResult = await recipe.partialRevert(ctx, fixerResult);
          if (partialResult !== null) {
            logger.tagged(recipe.ecosystemKey, 'partial-revert', 'Partial revert succeeded; re-validating...');
            const reValidation = await runValidations({ runner, cwd, commands: validationCommands });
            if (reValidation.allPassed) {
              logger.tagged(recipe.ecosystemKey, 'partial-revert', 'Post-intermediate state validates successfully. Partial revert preserved.');
              return tx.success({ packages_updated: partialResult.packagesUpdated, validations: reValidation.entries });
            }
            logger.tagged(recipe.ecosystemKey, 'partial-revert', 'Post-intermediate state also failed validation. Performing full revert...', 'warn');
          }
        } catch (partialErr) {
          throw new PhaseError(
            `${recipe.ecosystemKey} updater partial-revert bootstrap failed: ${partialErr instanceof Error ? partialErr.message : String(partialErr)}`,
            'partial-revert-bootstrap',
            partialErr,
          );
        }
      }

      logger.error(`Validation failed — reverting ${recipe.ecosystemKey} changes...`);
      return tx.abortWithError({
        error: `Validation failed after ${recipe.ecosystemKey} update — changes reverted`,
        validations: validationResult.entries,
      });
    }

    const packagesUpdated = recipe.derivePackagesUpdated
      ? await recipe.derivePackagesUpdated(ctx, fixerResult)
      : [];

    return tx.success({ packages_updated: packagesUpdated, validations: validationResult.entries });
  } catch (err) {
    if (err instanceof PhaseError) throw err;
    throw new PhaseError(
      `${recipe.ecosystemKey} updater phase failed: ${err instanceof Error ? err.message : String(err)}`,
      `${recipe.ecosystemKey}-updater`,
      err,
    );
  }
}
