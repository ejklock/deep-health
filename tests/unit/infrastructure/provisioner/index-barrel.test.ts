/**
 * Barrel test for src/infrastructure/provisioner/index.ts
 */
import { describe, it, expect } from 'vitest';

import {
  DockerSonarQubeProvisioner,
  DockerSonarScannerRunner,
  OsvDockerRunner,
  resolveComposerDockerImage,
} from '@infra/provisioner/index';

describe('src/infrastructure/provisioner/index.ts barrel exports', () => {
  it('DockerSonarQubeProvisioner is exported', () => {
    expect(typeof DockerSonarQubeProvisioner).toBe('function');
  });

  it('DockerSonarScannerRunner is exported', () => {
    expect(typeof DockerSonarScannerRunner).toBe('function');
  });

  it('OsvDockerRunner is exported', () => {
    expect(typeof OsvDockerRunner).toBe('function');
  });

  it('resolveComposerDockerImage is a function', () => {
    expect(typeof resolveComposerDockerImage).toBe('function');
  });
});
