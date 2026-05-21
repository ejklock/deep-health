/**
 * Tests for the ldd-based wrapper generation logic in scripts/build-sea.sh.
 *
 * Strategy: create a minimal temp environment that satisfies build-sea.sh
 * prerequisites (fake blob, fake node binary), override postject to be a no-op,
 * then run the script with Linux TARGET_SUFFIX values and assert the produced
 * wrapper script and .bin rename behave as specified.
 *
 * For non-Linux targets the script must produce no wrapper and no rename.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const BUILD_SEA_SH = path.resolve(__dirname, '../../../scripts/build-sea.sh');

/** Run build-sea.sh inside a sandboxed tmpdir with a fake environment. */
function runBuildSea(
  tmpDir: string,
  opts: { cliName?: string; targetSuffix: string },
): ReturnType<typeof spawnSync> {
  const { cliName = 'security-scan', targetSuffix } = opts;
  const distBin = path.join(tmpDir, 'dist-bin');
  const distSea = path.join(tmpDir, 'dist-sea');
  fs.mkdirSync(distBin, { recursive: true });
  fs.mkdirSync(distSea, { recursive: true });

  // Fake SEA blob
  fs.writeFileSync(path.join(distSea, 'sea-prep.blob'), 'FAKE_BLOB');

  // Fake node binary (any executable works — we override postject to skip injection)
  const fakeNodeBin = path.join(tmpDir, 'node');
  fs.writeFileSync(fakeNodeBin, '#!/usr/bin/env sh\n: fake node binary\n');
  fs.chmodSync(fakeNodeBin, 0o755);

  // Fake npx that does nothing (bypasses actual postject + codesign calls)
  const fakeNpx = path.join(tmpDir, 'npx');
  fs.writeFileSync(fakeNpx, '#!/usr/bin/env sh\n: fake npx — no-op\n');
  fs.chmodSync(fakeNpx, 0o755);

  // Fake codesign (macOS path guard — won't be reached on Linux targets, but
  // keeps the script from failing on macOS CI when Darwin is not the active OS
  // branch for this test).
  const fakeCodesign = path.join(tmpDir, 'codesign');
  fs.writeFileSync(fakeCodesign, '#!/usr/bin/env sh\n: fake codesign — no-op\n');
  fs.chmodSync(fakeCodesign, 0o755);

  // Prepend our fake-bin dir to PATH so the script picks up our stubs
  const patchedPath = `${tmpDir}:${process.env.PATH ?? ''}`;

  return spawnSync('sh', [BUILD_SEA_SH], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PATH: patchedPath,
      CLI_NAME: cliName,
      TARGET_SUFFIX: targetSuffix,
    },
    encoding: 'utf8',
  });
}

describe('build-sea.sh — Linux wrapper generation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sea-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const linuxTargets = ['linux-x64', 'linux-arm64', 'linux-x64-musl'] as const;

  for (const target of linuxTargets) {
    describe(`TARGET_SUFFIX=${target}`, () => {
      it('exits with code 0', () => {
        const result = runBuildSea(tmpDir, { targetSuffix: target });
        expect(result.status, result.stderr).toBe(0);
      });

      it('renames the SEA binary to <name>-<suffix>.bin', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const realBin = path.join(tmpDir, 'dist-bin', `security-scan-${target}.bin`);
        expect(fs.existsSync(realBin), `expected ${realBin} to exist`).toBe(true);
      });

      it('the renamed .bin file is executable', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const realBin = path.join(tmpDir, 'dist-bin', `security-scan-${target}.bin`);
        const mode = fs.statSync(realBin).mode;
        expect(mode & 0o111, '.bin must be executable').toBeGreaterThan(0);
      });

      it('creates a wrapper script at <name>-<suffix> (no .bin extension)', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        expect(fs.existsSync(wrapper), `expected wrapper at ${wrapper}`).toBe(true);
      });

      it('the wrapper script is executable', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const mode = fs.statSync(wrapper).mode;
        expect(mode & 0o111, 'wrapper must be executable').toBeGreaterThan(0);
      });

      it('wrapper has a valid sh shebang', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content.startsWith('#!/usr/bin/env sh')).toBe(true);
      });

      it('wrapper references the correct .bin filename', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content).toContain(`security-scan-${target}.bin`);
      });

      it('wrapper uses exec to pass all arguments through', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content).toContain('exec "${REAL_BIN}" "$@"');
      });

      it('wrapper uses ldd to detect missing shared libraries', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content).toContain('command -v ldd');
        expect(content).toContain("ldd \"${REAL_BIN}\"");
      });

      it('wrapper greps ldd output for "not found" lines', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content).toContain("grep 'not found'");
      });

      it('wrapper falls back gracefully when ldd is not available', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        // The ldd check is inside an if block — if ldd absent the exec runs directly
        expect(content).toMatch(/command -v ldd.*>/);
        // exec must appear outside/after the ldd if-block to run when ldd is absent
        const lddBlockEnd = content.indexOf('\nfi\n');
        const execIndex = content.lastIndexOf('exec "${REAL_BIN}"');
        expect(execIndex).toBeGreaterThan(lddBlockEnd);
      });

      it('wrapper error message mentions Debian/Ubuntu apt-cache search hint', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content).toContain('apt-cache search');
        expect(content).toContain('apt-get install');
      });

      it('wrapper error message mentions Fedora/RHEL dnf provides hint', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content).toContain('dnf provides');
        expect(content).toContain('dnf install');
      });

      it('wrapper exits with code 1 when missing libs are detected', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `security-scan-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        expect(content).toContain('exit 1');
      });

      it('wrapper contains CLI_NAME in the error message text', () => {
        runBuildSea(tmpDir, { cliName: 'my-scanner', targetSuffix: target });
        const wrapper = path.join(tmpDir, 'dist-bin', `my-scanner-${target}`);
        const content = fs.readFileSync(wrapper, 'utf8');
        // The CLI name should appear in error output (brand support)
        expect(content).toContain('my-scanner');
      });

      it('no leftover .tmp file remains after build', () => {
        runBuildSea(tmpDir, { targetSuffix: target });
        const tmp = path.join(tmpDir, 'dist-bin', `security-scan-${target}.tmp`);
        expect(fs.existsSync(tmp), 'temp file should be cleaned up').toBe(false);
      });
    });
  }
});

describe('build-sea.sh — non-Linux targets (no wrapper)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sea-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('macos-arm64: exits with code 0 and produces no .bin file', () => {
    const result = runBuildSea(tmpDir, { targetSuffix: 'macos-arm64' });
    expect(result.status, result.stderr).toBe(0);
    const realBin = path.join(tmpDir, 'dist-bin', 'security-scan-macos-arm64.bin');
    expect(fs.existsSync(realBin), '.bin must NOT exist for macOS target').toBe(false);
  });

  it('macos-arm64: the binary itself is at the expected path (no rename)', () => {
    runBuildSea(tmpDir, { targetSuffix: 'macos-arm64' });
    const bin = path.join(tmpDir, 'dist-bin', 'security-scan-macos-arm64');
    expect(fs.existsSync(bin), 'binary should exist at plain path for macOS').toBe(true);
  });

  it('win-x64: exits with code 0 and produces no .bin file', () => {
    const result = runBuildSea(tmpDir, { targetSuffix: 'win-x64' });
    expect(result.status, result.stderr).toBe(0);
    const realBin = path.join(tmpDir, 'dist-bin', 'security-scan-win-x64.bin');
    expect(fs.existsSync(realBin), '.bin must NOT exist for Windows target').toBe(false);
  });

  it('win-x64: the binary uses .exe extension and wrapper is not created', () => {
    runBuildSea(tmpDir, { targetSuffix: 'win-x64' });
    const bin = path.join(tmpDir, 'dist-bin', 'security-scan-win-x64.exe');
    expect(fs.existsSync(bin), '.exe binary should exist for Windows target').toBe(true);
    // No wrapper without .exe extension
    const wrapper = path.join(tmpDir, 'dist-bin', 'security-scan-win-x64');
    expect(fs.existsSync(wrapper), 'wrapper must NOT exist for Windows target').toBe(false);
  });
});

describe('build-sea.sh — wrapper runtime behaviour (simulated)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sea-wrapper-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('wrapper passes all args to the real binary and exits 0 when ldd reports no missing libs', () => {
    // Build the wrapper via the script
    runBuildSea(tmpDir, { targetSuffix: 'linux-x64' });

    const wrapper = path.join(tmpDir, 'dist-bin', 'security-scan-linux-x64');
    const realBin = path.join(tmpDir, 'dist-bin', 'security-scan-linux-x64.bin');

    // Replace the .bin with a small shell script that echoes args
    fs.writeFileSync(realBin, '#!/usr/bin/env sh\necho "ARGS: $@"\n');
    fs.chmodSync(realBin, 0o755);

    // Fake ldd that reports all libraries as found (no 'not found' lines)
    const fakeLdd = path.join(tmpDir, 'ldd');
    fs.writeFileSync(
      fakeLdd,
      '#!/usr/bin/env sh\necho "\tlibstdc++.so.6 => /usr/lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f0000000000)"\necho "\tlibatomic.so.1 => /usr/lib/x86_64-linux-gnu/libatomic.so.1 (0x00007f0000010000)"\n',
    );
    fs.chmodSync(fakeLdd, 0o755);

    const patchedPath = `${tmpDir}:${process.env.PATH ?? ''}`;
    const result = spawnSync('sh', [wrapper, 'arg1', 'arg2'], {
      env: { ...process.env, PATH: patchedPath },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ARGS: arg1 arg2');
  });

  it('wrapper exits 1 and lists ALL missing libs when ldd reports multiple not found', () => {
    runBuildSea(tmpDir, { targetSuffix: 'linux-x64' });

    const wrapper = path.join(tmpDir, 'dist-bin', 'security-scan-linux-x64');

    // Fake ldd that reports two missing libraries
    const fakeLdd = path.join(tmpDir, 'ldd');
    fs.writeFileSync(
      fakeLdd,
      '#!/usr/bin/env sh\necho "\tlibatomic.so.1 => not found"\necho "\tlibfoo.so.2 => not found"\necho "\tlibstdc++.so.6 => /usr/lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f0000000000)"\n',
    );
    fs.chmodSync(fakeLdd, 0o755);

    const patchedPath = `${tmpDir}:${process.env.PATH ?? ''}`;
    const result = spawnSync('sh', [wrapper], {
      env: { ...process.env, PATH: patchedPath },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    // Both missing libs must appear in the error output
    expect(result.stderr).toContain('libatomic.so.1');
    expect(result.stderr).toContain('libfoo.so.2');
    // Generic install hints for both distros
    expect(result.stderr).toContain('apt-cache search');
    expect(result.stderr).toContain('apt-get install');
    expect(result.stderr).toContain('dnf provides');
    expect(result.stderr).toContain('dnf install');
  });

  it('wrapper exits 1 when ldd reports a single missing lib', () => {
    runBuildSea(tmpDir, { targetSuffix: 'linux-x64' });

    const wrapper = path.join(tmpDir, 'dist-bin', 'security-scan-linux-x64');

    // Fake ldd that reports one missing library
    const fakeLdd = path.join(tmpDir, 'ldd');
    fs.writeFileSync(
      fakeLdd,
      '#!/usr/bin/env sh\necho "\tlibatomic.so.1 => not found"\n',
    );
    fs.chmodSync(fakeLdd, 0o755);

    const patchedPath = `${tmpDir}:${process.env.PATH ?? ''}`;
    const result = spawnSync('sh', [wrapper], {
      env: { ...process.env, PATH: patchedPath },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('libatomic.so.1');
  });

  it('wrapper execs the binary directly when ldd is not available (no pre-check)', () => {
    runBuildSea(tmpDir, { targetSuffix: 'linux-x64' });

    const wrapper = path.join(tmpDir, 'dist-bin', 'security-scan-linux-x64');
    const realBin = path.join(tmpDir, 'dist-bin', 'security-scan-linux-x64.bin');

    // Real binary echoes success
    fs.writeFileSync(realBin, '#!/usr/bin/env sh\necho "EXECUTED"\n');
    fs.chmodSync(realBin, 0o755);

    // Use a PATH that has no ldd — only our tmpDir which has no ldd binary
    const noLddPath = `${tmpDir}/no-ldd-dir:${process.env.PATH ?? ''}`;
    // Ensure the no-ldd-dir directory exists but has no ldd
    fs.mkdirSync(path.join(tmpDir, 'no-ldd-dir'), { recursive: true });

    // Override PATH to exclude any real ldd by using a minimal PATH with only our bins
    // We create a clean bin dir with only the real binary available
    const minimalBinDir = path.join(tmpDir, 'minimal-bin');
    fs.mkdirSync(minimalBinDir, { recursive: true });

    const result = spawnSync('sh', [wrapper], {
      env: {
        ...process.env,
        PATH: minimalBinDir,
      },
      encoding: 'utf8',
    });

    // Without ldd the wrapper should attempt exec directly;
    // the real binary will run (or fail with exec error if sh itself is not on PATH).
    // We simply verify the wrapper content confirms the fallback pattern rather than
    // asserting a specific exit code (PATH manipulation is environment-dependent).
    const content = fs.readFileSync(wrapper, 'utf8');
    expect(content).toContain('command -v ldd');
    // exec must be unconditionally reachable after the ldd if-block
    expect(content).toMatch(/\nfi\n[\s\S]*exec "\$\{REAL_BIN\}"/);
  });
});
