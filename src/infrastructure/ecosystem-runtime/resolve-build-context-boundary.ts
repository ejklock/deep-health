import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

// Module-level cache avoids duplicate `git rev-parse` subprocesses when
// multiple ecosystems resolve the same projectDir in a single CLI invocation.
export const _testOnlyCacheMap = new Map<
  string,
  Promise<{ root: string; source: 'git' | 'project-dir' }>
>();

export async function resolveAllowedBuildContextRoot(
  projectDir: string,
): Promise<{ root: string; source: 'git' | 'project-dir' }> {
  const cached = _testOnlyCacheMap.get(projectDir);
  if (cached !== undefined) {
    return cached;
  }

  const promise = (async (): Promise<{ root: string; source: 'git' | 'project-dir' }> => {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        projectDir,
        'rev-parse',
        '--show-toplevel',
      ]);
      return { root: stdout.trim(), source: 'git' };
    } catch {
      return { root: projectDir, source: 'project-dir' };
    }
  })();

  _testOnlyCacheMap.set(projectDir, promise);
  return promise;
}

export async function assertBuildContextWithinBoundary(opts: {
  contextDir: string;
  allowedRoot: string;
  boundarySource: 'git' | 'project-dir';
  logPrefix: string;
  allowEscape?: boolean;
}): Promise<void> {
  const { contextDir, allowedRoot, boundarySource, logPrefix, allowEscape } = opts;

  const [realContextDir, realAllowedRoot] = await Promise.all([
    fs.realpath(contextDir),
    fs.realpath(allowedRoot),
  ]);

  const rel = path.relative(realAllowedRoot, realContextDir);
  const isInside = !rel.startsWith('..');

  if (isInside) {
    return;
  }

  const boundaryLabel =
    boundarySource === 'git' ? 'git root' : 'project directory';

  if (allowEscape !== true) {
    throw new Error(
      `[ecosystem-runtime/${logPrefix}] build_context resolves outside the allowed project boundary.\n` +
        `  Context:  ${realContextDir}\n` +
        `  Boundary: ${realAllowedRoot} (${boundaryLabel})\n` +
        `Set allow_build_context_escape: true under scanners.<ecosystem> to allow this explicitly.`,
    );
  }

  logger.warn(
    `[ecosystem-runtime/${logPrefix}] build_context "${realContextDir}" is outside the project boundary ("${realAllowedRoot}"). ` +
      `The full directory tree will be sent to the Docker daemon — this may expose sensitive files. ` +
      `Set allow_build_context_escape: false to enforce the boundary.`,
  );
}
