/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  on: vi.fn(),
  exit: vi.fn(),
  stderrWrite: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
  spawn: mocks.spawn,
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({ version: 'test-version' })),
}));

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(scriptsDir);
const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';

describe('development launcher', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const name of [
      'DEBUG',
      'DEBUG_PORT',
      'SANDBOX',
      'CI',
      'CONTINUOUS_INTEGRATION',
      'GITHUB_ACTIONS',
      'GEMINI_KEEP_CI_ENV',
      'GEMINI_CLI_NO_RELAUNCH',
    ]) {
      vi.stubEnv(name, '');
    }
    vi.stubGlobal('process', {
      ...process,
      execPath: nodeExecutable,
      argv: [nodeExecutable, join(scriptsDir, 'start.js')],
      stderr: { write: mocks.stderrWrite },
      exit: mocks.exit,
    });
    mocks.execFileSync.mockReset().mockImplementation(() => Buffer.from(''));
    mocks.spawn.mockReset().mockReturnValue({ on: mocks.on });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('runs helpers and the CLI with the current Node executable, preserving arguments', async () => {
    const args = ['-m', 'auto', '-p', 'spaces & %PATH% $HOME "quoted"'];
    process.argv.push(...args);
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');

    await import('../start.js');

    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      1,
      nodeExecutable,
      [join(scriptsDir, 'check-build-status.js')],
      { stdio: 'inherit', cwd: root },
    );
    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      nodeExecutable,
      [join(scriptsDir, 'sandbox_command.js')],
      { cwd: root },
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      nodeExecutable,
      ['--no-warnings=DEP0040', join(root, 'packages', 'cli'), ...args],
      {
        stdio: 'inherit',
        env: expect.objectContaining({
          CLI_VERSION: 'test-version',
          DEV: 'true',
          NODE_OPTIONS: '--max-old-space-size=4096',
          GOOGLE_CLOUD_PROJECT: 'test-project',
        }),
      },
    );
    const closeHandler = mocks.on.mock.calls.find(
      ([event]) => event === 'close',
    )[1];
    closeHandler(7);
    expect(mocks.exit).toHaveBeenCalledWith(7);
  });

  it('keeps the build failure fatal and does not start the CLI', async () => {
    const error = new Error('build check failed');
    mocks.execFileSync.mockImplementationOnce(() => {
      throw error;
    });

    await expect(import('../start.js')).rejects.toBe(error);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('continues without sandbox and enables direct debugging when the probe fails', async () => {
    vi.stubEnv('DEBUG', 'true');
    mocks.execFileSync.mockImplementationOnce(() => Buffer.from(''));
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('no sandbox');
    });

    await import('../start.js');

    expect(mocks.spawn).toHaveBeenCalledWith(
      nodeExecutable,
      ['--no-warnings=DEP0040', '--inspect-brk', join(root, 'packages', 'cli')],
      expect.objectContaining({
        env: expect.objectContaining({ GEMINI_CLI_NO_RELAUNCH: 'true' }),
      }),
    );
  });

  it('keeps debug flags inside a selected sandbox', async () => {
    vi.stubEnv('DEBUG', '1');
    mocks.execFileSync.mockImplementationOnce(() => Buffer.from(''));
    mocks.execFileSync.mockImplementationOnce(() => Buffer.from('docker\n'));

    await import('../start.js');

    expect(mocks.spawn.mock.calls[0][1]).toEqual([
      '--no-warnings=DEP0040',
      join(root, 'packages', 'cli'),
    ]);
  });

  it('preserves the debug port when already inside a sandbox', async () => {
    vi.stubEnv('DEBUG', '1');
    vi.stubEnv('SANDBOX', 'docker');
    vi.stubEnv('DEBUG_PORT', '12345');

    await import('../start.js');

    expect(mocks.spawn.mock.calls[0][1]).toContain(
      '--inspect-brk=0.0.0.0:12345',
    );
  });

  it.each(['1', 'true'])(
    'retains CI flags with GEMINI_KEEP_CI_ENV=%s',
    async (value) => {
      vi.stubEnv('CI', 'true');
      vi.stubEnv('CONTINUOUS_INTEGRATION', 'true');
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      vi.stubEnv('GEMINI_KEEP_CI_ENV', value);

      await import('../start.js');

      expect(mocks.spawn.mock.calls[0][2].env).toEqual(
        expect.objectContaining({
          CI: 'true',
          CONTINUOUS_INTEGRATION: 'true',
          GITHUB_ACTIONS: 'true',
        }),
      );
      expect(mocks.stderrWrite).not.toHaveBeenCalled();
    },
  );

  it('removes CI flags for interactive development by default', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('CONTINUOUS_INTEGRATION', 'true');
    vi.stubEnv('GITHUB_ACTIONS', 'true');

    await import('../start.js');

    const env = mocks.spawn.mock.calls[0][2].env;
    expect(env).not.toHaveProperty('CI');
    expect(env).not.toHaveProperty('CONTINUOUS_INTEGRATION');
    expect(env).not.toHaveProperty('GITHUB_ACTIONS');
  });
});
