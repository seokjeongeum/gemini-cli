/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readPackageUp: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock('read-package-up', () => ({ readPackageUp: mocks.readPackageUp }));

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outputFiles = ['cli', 'core'].map((name) =>
  join(root, 'packages', name, 'src', 'generated', 'git-commit.ts'),
);
let files;

async function generate() {
  vi.resetModules();
  await import('../generate-git-commit-info.js');
}

describe('generated build metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GIT_COMMIT', '');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    files = new Map();
    mocks.existsSync.mockImplementation(
      (file) => !outputFiles.includes(file) || files.has(file),
    );
    mocks.readFileSync.mockImplementation((file) => files.get(file));
    mocks.writeFileSync.mockImplementation((file, content) => {
      files.set(file, content);
    });
    mocks.execSync.mockReturnValue('abc123\n');
    mocks.readPackageUp.mockResolvedValue({
      packageJson: { version: '1.2.3' },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('creates both metadata files, then preserves their mtimes on an unchanged build', async () => {
    await generate();

    expect(mocks.writeFileSync).toHaveBeenCalledTimes(2);
    const content = files.get(outputFiles[0]);
    expect(content).toContain("export const GIT_COMMIT_INFO = 'abc123';");
    expect(content).toContain("export const CLI_VERSION = '1.2.3';");
    expect(files.get(outputFiles[1])).toBe(content);
    mocks.writeFileSync.mockClear();

    await generate();

    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('recreates a missing output without touching the current output', async () => {
    await generate();
    files.delete(outputFiles[1]);
    mocks.writeFileSync.mockClear();

    await generate();

    expect(mocks.writeFileSync).toHaveBeenCalledExactlyOnceWith(
      outputFiles[1],
      files.get(outputFiles[0]),
    );
  });

  it.each(['commit', 'version', 'year'])(
    'updates metadata when the %s changes',
    async (field) => {
      await generate();
      const previousContent = files.get(outputFiles[0]);
      mocks.writeFileSync.mockClear();
      if (field === 'commit') {
        mocks.execSync.mockReturnValue('def456\n');
      } else if (field === 'version') {
        mocks.readPackageUp.mockResolvedValue({
          packageJson: { version: '1.2.4' },
        });
      } else {
        vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
      }

      await generate();

      expect(mocks.writeFileSync).toHaveBeenCalledTimes(2);
      expect(files.get(outputFiles[0])).not.toBe(previousContent);
      expect(files.get(outputFiles[1])).toBe(files.get(outputFiles[0]));
    },
  );

  it('retains the environment commit override without invoking Git', async () => {
    vi.stubEnv('GIT_COMMIT', 'deadc0de');

    await generate();

    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(files.get(outputFiles[0])).toContain(
      "export const GIT_COMMIT_INFO = 'deadc0de';",
    );
  });

  it('retains the fallback metadata when Git fails', async () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('Git unavailable');
    });

    await generate();

    expect(files.get(outputFiles[0])).toContain(
      "export const GIT_COMMIT_INFO = 'N/A';",
    );
    expect(files.get(outputFiles[0])).toContain(
      "export const CLI_VERSION = 'UNKNOWN';",
    );
  });
});
