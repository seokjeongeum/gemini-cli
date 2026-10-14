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
  checkBuildStatus: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
  spawn: mocks.spawn,
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({ version: 'test-version' })),
}));

vi.mock('../check-build-status.js', () => ({
  checkBuildStatus: mocks.checkBuildStatus,
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
      'npm_lifecycle_event',
      'NODE_ENV',
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
    mocks.checkBuildStatus.mockReset();
    mocks.spawn.mockReset().mockReturnValue({ on: mocks.on });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('checks the build in process and launches the CLI with literal arguments using the current Node executable', async () => {
    const args = ['-m', 'auto', '-p', 'spaces & %PATH% $HOME "quoted"'];
    process.argv.push(...args);
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=4096');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');

    await import('../start.js');

    expect(mocks.checkBuildStatus).toHaveBeenCalledWith(root);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
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
    mocks.checkBuildStatus.mockImplementationOnce(() => {
      throw error;
    });

    await expect(import('../start.js')).rejects.toBe(error);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['start', 'development'],
    ['start:prod', 'production'],
  ])(
    'sets the npm %s launcher and CLI environment to %s',
    async (lifecycleEvent, nodeEnv) => {
      vi.stubEnv('npm_lifecycle_event', lifecycleEvent);
      vi.stubEnv('NODE_ENV', 'inherited-value');
      mocks.checkBuildStatus.mockImplementation(() => {
        expect(process.env.NODE_ENV).toBe(nodeEnv);
      });

      await import('../start.js');

      expect(mocks.spawn.mock.calls[0][2].env.NODE_ENV).toBe(nodeEnv);
      expect(process.env.NODE_ENV).toBe(nodeEnv);
    },
  );

  it.each(['', 'debug', 'another-script'])(
    'preserves inherited NODE_ENV for direct and debug invocations with lifecycle event "%s"',
    async (lifecycleEvent) => {
      vi.stubEnv('npm_lifecycle_event', lifecycleEvent);
      vi.stubEnv('NODE_ENV', 'inherited-value');
      vi.stubEnv('DEBUG', lifecycleEvent === 'debug' ? '1' : '');
      mocks.checkBuildStatus.mockImplementation(() => {
        expect(process.env.NODE_ENV).toBe('inherited-value');
      });

      await import('../start.js');

      expect(mocks.spawn.mock.calls[0][2].env.NODE_ENV).toBe('inherited-value');
      expect(process.env.NODE_ENV).toBe('inherited-value');
    },
  );

  it('continues without sandbox and enables direct debugging when the probe fails', async () => {
    vi.stubEnv('DEBUG', 'true');
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
    mocks.execFileSync.mockImplementationOnce(() => Buffer.from('docker\n'));

    await import('../start.js');

    expect(mocks.spawn.mock.calls[0][1]).toEqual([
      '--no-warnings=DEP0040',
      join(root, 'packages', 'cli'),
    ]);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      nodeExecutable,
      [join(scriptsDir, 'sandbox_command.js')],
      { cwd: root },
    );
  });

  it.each(['', '0', 'false'])(
    'starts ordinary sandboxed sessions without a debug probe when DEBUG=%s',
    async (debug) => {
      vi.stubEnv('DEBUG', debug);
      vi.stubEnv('GEMINI_SANDBOX', 'docker');

      await import('../start.js');

      expect(mocks.execFileSync).not.toHaveBeenCalled();
      expect(mocks.spawn.mock.calls[0][2].env.GEMINI_SANDBOX).toBe('docker');
      expect(mocks.spawn.mock.calls[0][1]).toEqual([
        '--no-warnings=DEP0040',
        join(root, 'packages', 'cli'),
      ]);
    },
  );

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
