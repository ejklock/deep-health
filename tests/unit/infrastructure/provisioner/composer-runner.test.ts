/**
 * Coverage for src/infrastructure/provisioner/composer-runner.ts
 * and EphemeralEcosystemContainer with shell-wrap + preamble RunMode (composer).
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('@infra/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), phase: vi.fn(), skip: vi.fn(), header: vi.fn(), tagged: vi.fn() },
}));

vi.mock('@infra/utils/docker-platform', () => ({
  needsHostGateway: vi.fn().mockReturnValue(false),
  resolvePlatform: vi.fn().mockReturnValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { COMPOSER_BOOTSTRAP, isPhpCliImage } from '@infra/provisioner/composer-runner';
import { EphemeralEcosystemContainer } from '@infra/ecosystem-runtime/ephemeral-container';
import { execFile, spawn } from 'node:child_process';
import { needsHostGateway, resolvePlatform } from '@infra/utils/docker-platform';
import { COMPOSER_DEFAULT_IMAGE } from '@infra/provisioner/php-profiles';

function makeComposerRunMode(image: string) {
  return {
    kind: 'shell-wrap' as const,
    preamble: (img: string) => isPhpCliImage(img) ? COMPOSER_BOOTSTRAP : undefined,
  };
}

function makeComposerContainer(opts: { projectDir?: string; image?: string; platform?: string } = {}) {
  const image = opts.image ?? COMPOSER_DEFAULT_IMAGE;
  return new EphemeralEcosystemContainer({
    runMode: makeComposerRunMode(image),
    projectDir: opts.projectDir ?? '/project',
    image,
    logPrefix: 'composer',
    platform: opts.platform,
  });
}

describe('EphemeralEcosystemContainer._buildDockerArgs() — shell-wrap mode (composer)', () => {
  it('builds basic docker run args', () => {
    const runner = makeComposerContainer({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args.join(' ')).toContain('/project');
    expect(args).toContain('sh');
    expect(args).toContain('-lc');
  });

  it('includes --platform when resolvePlatform returns a value', async () => {
    vi.mocked(resolvePlatform).mockReturnValueOnce('linux/amd64');
    const runner = makeComposerContainer({ projectDir: '/project', platform: 'linux/amd64' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    expect(args).toContain('--platform');
    expect(args).toContain('linux/amd64');
  });

  it('does not include --platform when not set', () => {
    const runner = makeComposerContainer({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    expect(args).not.toContain('--platform');
  });

  it('includes --add-host when needsHostGateway returns true', async () => {
    vi.mocked(needsHostGateway).mockReturnValueOnce(true);
    const runner = makeComposerContainer({ projectDir: '/project' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    const idx = args.indexOf('--add-host');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('host.docker.internal:host-gateway');
  });

  it('uses sh -lc to wrap command tokens (non-php-cli image)', () => {
    const runner = makeComposerContainer({ projectDir: '/my/project', image: 'composer:2' });
    const args = runner._buildDockerArgs(['php', '-v']);
    const shIndex = args.indexOf('sh');
    expect(shIndex).toBeGreaterThan(0);
    expect(args[shIndex + 1]).toBe('-lc');
    expect(args[shIndex + 2]).toBe('php -v');
  });

  it('prepends composer bootstrap when image is php:*-cli', () => {
    const runner = makeComposerContainer({ projectDir: '/my/project', image: 'php:8.2-cli' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    const shIndex = args.indexOf('sh');
    expect(shIndex).toBeGreaterThan(0);
    expect(args[shIndex + 1]).toBe('-lc');
    const shellCmd = args[shIndex + 2];
    expect(shellCmd).toContain('getcomposer.org/installer');
    expect(shellCmd).toContain('/usr/local/bin');
    expect(shellCmd).toMatch(/&&\s*composer install$/);
    // SHA-384 integrity check is present between download and execution
    expect(shellCmd).toContain('composer.github.io/installer.sig');
    expect(shellCmd).toContain('sha384');
    expect(shellCmd).toContain('&& rm -f /tmp/cs.php');
    // Verification step must appear after download and before execution
    const downloadIdx = shellCmd.indexOf('getcomposer.org/installer');
    const verifyIdx = shellCmd.indexOf('composer.github.io/installer.sig');
    const execIdx = shellCmd.indexOf('php /tmp/cs.php');
    expect(verifyIdx).toBeGreaterThan(downloadIdx);
    expect(execIdx).toBeGreaterThan(verifyIdx);
  });

  it('bootstrap installs git/unzip on php:*-cli images, guarded by command -v', () => {
    const runner = makeComposerContainer({ projectDir: '/p', image: 'php:8.2-cli' });
    const args = runner._buildDockerArgs(['composer', 'install']);
    const shellCmd = args[args.indexOf('sh') + 2] as string;
    expect(shellCmd).toContain('command -v git');
    expect(shellCmd).toContain('command -v unzip');
    expect(shellCmd).toContain('apt-get install -y --no-install-recommends -o APT::Sandbox::User=root git unzip');
    expect(shellCmd.indexOf('command -v')).toBeLessThan(shellCmd.indexOf('getcomposer.org/installer'));
  });

  it('uses COMPOSER_DEFAULT_IMAGE when image is default', () => {
    const runner = makeComposerContainer({ projectDir: '/my/project' });
    const args = runner._buildDockerArgs(['composer', '--version']);
    expect(args).toContain(COMPOSER_DEFAULT_IMAGE);
  });
});

describe('EphemeralEcosystemContainer.run() — catch branch edge cases (composer mode)', () => {
  it('uses exitCode=1 and String(err) when spawnErr has no fields', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      callCount++;
      if (callCount === 1) {
        // First call: _ensureImagePresent docker image inspect → succeed (image cached)
        cb(null, '[]', '');
      } else {
        cb('string-err');
      }
    });
    const runner = makeComposerContainer({ projectDir: '/p' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('string-err');
  });

  it('uses spawnErr.code when numeric', async () => {
    const mockExecFile = vi.mocked(execFile) as unknown as Mock;
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      callCount++;
      if (callCount === 1) {
        // First call: _ensureImagePresent docker image inspect → succeed (image cached)
        cb(null, '[]', '');
      } else {
        cb(Object.assign(new Error('exit'), { code: 5, stdout: 'out', stderr: 'err' }));
      }
    });
    const runner = makeComposerContainer({ projectDir: '/p' });
    const result = await runner.run(['install']);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('out');
  });
});

describe('EphemeralEcosystemContainer._buildShellDockerArgs() — composer mode', () => {
  it('routes to sh -c with command as single argv element', () => {
    const runner = makeComposerContainer({ projectDir: '/myproject' });
    const args = runner._buildShellDockerArgs('php artisan test', '/myproject');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'php artisan test']);
  });

  it('mounts the provided cwd as /project', () => {
    const runner = makeComposerContainer({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('php artisan test', '/myproject');
    expect(args.join(' ')).toContain('/myproject:/project');
  });

  it('passes compound shell command as a single argv element (not split)', () => {
    const runner = makeComposerContainer({ projectDir: '/p' });
    const args = runner._buildShellDockerArgs('echo hello world && ls');
    const last3 = args.slice(-3);
    expect(last3).toEqual(['sh', '-c', 'echo hello world && ls']);
  });

  it('falls back to projectDir when no cwd provided', () => {
    const runner = makeComposerContainer({ projectDir: '/defaultdir' });
    const args = runner._buildShellDockerArgs('php artisan test');
    expect(args.join(' ')).toContain('/defaultdir:/project');
  });

  it('prepends composer bootstrap in sh -c when image is php:*-cli', () => {
    const runner = makeComposerContainer({ projectDir: '/p', image: 'php:8.2-cli' });
    const args = runner._buildShellDockerArgs('php artisan test');
    const last3 = args.slice(-3);
    expect(last3[0]).toBe('sh');
    expect(last3[1]).toBe('-c');
    expect(last3[2]).toContain('getcomposer.org/installer');
    expect(last3[2]).toContain('php artisan test');
  });
});

describe('EphemeralEcosystemContainer.runStreaming() — null close code (composer mode)', () => {
  it('uses exitCode=1 when close event fires with null code', async () => {
    const mockSpawn = vi.mocked(spawn) as unknown as Mock;
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    mockSpawn.mockReturnValue(child);

    const runner = makeComposerContainer({ projectDir: '/p' });
    const resultPromise = runner.runStreaming(['install']);
    child.emit('close', null);
    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
  });
});
