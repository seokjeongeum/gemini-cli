/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({ existsSync: () => true }));

describe('build sandbox selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('CI', '');
    vi.stubEnv('BUILD_SANDBOX', '');
    mocks.execSync.mockReset().mockImplementation((command) => {
      if (command === 'npm query .workspace --json') {
        return JSON.stringify([
          { name: '@google/gemini-cli-core' },
          { name: '@google/gemini-cli' },
        ]);
      }
      return '';
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['', '0', 'false'])(
    'does not start a sandbox probe when BUILD_SANDBOX is %j',
    async (value) => {
      vi.stubEnv('BUILD_SANDBOX', value);

      await import('../build.js');

      expect(mocks.execSync).toHaveBeenCalledWith(
        'npm run generate',
        expect.any(Object),
      );
      const sandboxCommands = mocks.execSync.mock.calls
        .map(([command]) => command)
        .filter((command) => command.includes('sandbox'));
      expect(sandboxCommands).toEqual([]);
    },
  );

  it.each(['1', 'true'])(
    'checks sandbox availability before building when BUILD_SANDBOX is %j',
    async (value) => {
      vi.stubEnv('BUILD_SANDBOX', value);

      await import('../build.js');

      const commands = mocks.execSync.mock.calls.map(([command]) => command);
      expect(commands.slice(-2)).toEqual([
        'node scripts/sandbox_command.js -q',
        'node scripts/build_sandbox.js -s',
      ]);
    },
  );

  it('retains optional sandbox failure behavior', async () => {
    vi.stubEnv('BUILD_SANDBOX', 'true');
    mocks.execSync.mockImplementation((command) => {
      if (command === 'npm query .workspace --json') {
        return '[{"name":"@google/gemini-cli-core"}]';
      }
      if (command === 'node scripts/sandbox_command.js -q') {
        throw new Error('sandbox unavailable');
      }
      return '';
    });

    await expect(import('../build.js')).resolves.toBeDefined();

    expect(mocks.execSync).not.toHaveBeenCalledWith(
      'node scripts/build_sandbox.js -s',
      expect.any(Object),
    );
  });

  it('keeps ordinary build failures fatal', async () => {
    const error = new Error('TypeScript compilation failed');
    mocks.execSync.mockImplementation(() => {
      throw error;
    });

    await expect(import('../build.js')).rejects.toBe(error);
  });

  it('retains sequential builds for any nonempty CI value', async () => {
    vi.stubEnv('CI', '0');

    await import('../build.js');

    expect(mocks.execSync).toHaveBeenCalledWith(
      'npm run build --workspaces',
      expect.any(Object),
    );
    expect(mocks.execSync).not.toHaveBeenCalledWith(
      'npm query .workspace --json',
      expect.any(Object),
    );
  });
});
