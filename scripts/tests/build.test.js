/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn(),
  discoverBuildWorkspaces: vi.fn(),
  preparePackageScript: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
  execFileSync: mocks.execFileSync,
  spawn: mocks.spawn,
}));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('../build-workspace.js', () => ({
  discoverBuildWorkspaces: mocks.discoverBuildWorkspaces,
  preparePackageScript: mocks.preparePackageScript,
}));
vi.mock('../build-profile.js', () => ({
  profileBuildPhase: (_name, operation) => operation(),
  profileBuildPhaseAsync: (_name, operation) => operation(),
}));

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const directories = Object.fromEntries(
  ['cli', 'core', 'sdk'].map((name) => [name, join(root, 'packages', name)]),
);
let events;
let children;

function createChild(directory, automaticallyClose = true) {
  const child = new EventEmitter();
  children.set(directory, child);
  if (automaticallyClose) queueMicrotask(() => child.emit('close', 0, null));
  return child;
}

describe('build orchestration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('CI', '');
    vi.stubEnv('BUILD_SANDBOX', '');
    events = [];
    children = new Map();
    mocks.existsSync.mockReturnValue(true);
    mocks.execSync.mockImplementation(() => '');
    mocks.execFileSync.mockImplementation((_command, args) => {
      events.push(`sync:${args[0]}`);
    });
    mocks.discoverBuildWorkspaces.mockReturnValue([
      { name: '@google/gemini-cli', directory: directories.cli },
      { name: '@google/gemini-cli-core', directory: directories.core },
      { name: '@google/gemini-cli-sdk', directory: directories.sdk },
    ]);
    mocks.preparePackageScript.mockImplementation((directory, script) => ({
      command: process.execPath,
      args: [join(directory, `${script}.js`)],
      env: { TEST_SCRIPT_ENV: 'preserved' },
    }));
    mocks.spawn.mockImplementation((_command, _args, options) => {
      events.push(`spawn:${options.cwd}`);
      return createChild(options.cwd);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('finishes metadata and core before launching the remaining workspaces in parallel', async () => {
    await import('../build.js');

    expect(events).toEqual([
      `sync:${join(root, 'generate.js')}`,
      `sync:${join(directories.core, 'build.js')}`,
      `spawn:${directories.cli}`,
      `spawn:${directories.sdk}`,
    ]);
    expect(mocks.discoverBuildWorkspaces).toHaveBeenCalledExactlyOnceWith(root);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [join(directories.cli, 'build.js')],
      {
        cwd: directories.cli,
        env: { TEST_SCRIPT_ENV: 'preserved' },
        stdio: 'inherit',
      },
    );
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it.each(['', '0', 'false'])(
    'does not start a sandbox probe when BUILD_SANDBOX is %j',
    async (value) => {
      vi.stubEnv('BUILD_SANDBOX', value);

      await import('../build.js');

      expect(mocks.preparePackageScript).toHaveBeenCalledWith(root, 'generate');
      expect(mocks.execSync).not.toHaveBeenCalled();
    },
  );

  it.each(['1', 'true'])(
    'checks sandbox availability before building when BUILD_SANDBOX is %j',
    async (value) => {
      vi.stubEnv('BUILD_SANDBOX', value);

      await import('../build.js');

      expect(mocks.execSync.mock.calls.map(([command]) => command)).toEqual([
        'node scripts/sandbox_command.js -q',
        'node scripts/build_sandbox.js -s',
      ]);
    },
  );

  it('retains optional sandbox failure behavior', async () => {
    vi.stubEnv('BUILD_SANDBOX', 'true');
    mocks.execSync.mockImplementation(() => {
      throw new Error('sandbox unavailable');
    });

    await expect(import('../build.js')).resolves.toBeDefined();

    expect(mocks.execSync).toHaveBeenCalledExactlyOnceWith(
      'node scripts/sandbox_command.js -q',
      { stdio: 'inherit', cwd: root },
    );
  });

  it('installs dependencies first when node_modules is missing', async () => {
    mocks.existsSync.mockReturnValue(false);

    await import('../build.js');

    expect(mocks.execSync).toHaveBeenCalledExactlyOnceWith('npm install', {
      stdio: 'inherit',
      cwd: root,
    });
    expect(mocks.execSync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.preparePackageScript.mock.invocationCallOrder[0],
    );
  });

  it('keeps a core build failure fatal and does not launch dependents', async () => {
    const error = new Error('TypeScript compilation failed');
    mocks.execFileSync.mockImplementation((_command, args) => {
      if (args[0] === join(directories.core, 'build.js')) throw error;
    });

    await expect(import('../build.js')).rejects.toBe(error);

    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('retains sequential builds for any nonempty CI value', async () => {
    vi.stubEnv('CI', '0');
    mocks.spawn.mockImplementation((_command, _args, options) =>
      createChild(options.cwd, false),
    );
    const building = import('../build.js');

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    expect(mocks.spawn.mock.calls[0][2].cwd).toBe(directories.cli);
    children.get(directories.cli).emit('close', 0, null);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
    expect(mocks.spawn.mock.calls[1][2].cwd).toBe(directories.core);
    children.get(directories.core).emit('close', 0, null);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(3));
    expect(mocks.spawn.mock.calls[2][2].cwd).toBe(directories.sdk);
    children.get(directories.sdk).emit('close', 0, null);

    await building;
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it('waits for every launched child to close before rejecting a parallel failure', async () => {
    mocks.spawn.mockImplementation((_command, _args, options) =>
      createChild(options.cwd, false),
    );
    let finished = false;
    const building = import('../build.js').then(
      () => {
        finished = true;
      },
      (error) => {
        finished = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(children.size).toBe(2));
    children.get(directories.cli).emit('close', 1, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    children.get(directories.sdk).emit('close', 0, null);

    expect(await building).toEqual(
      new Error(`Build failed in ${directories.cli} (1).`),
    );
    expect(finished).toBe(true);
  });

  it('waits for an already launched child when preparing a sibling script fails', async () => {
    const error = new Error('Invalid workspace manifest');
    mocks.preparePackageScript.mockImplementation((directory, script) => {
      if (directory === directories.sdk) throw error;
      return {
        command: process.execPath,
        args: [join(directory, `${script}.js`)],
        env: {},
      };
    });
    mocks.spawn.mockImplementation((_command, _args, options) =>
      createChild(options.cwd, false),
    );
    let finished = false;
    const building = import('../build.js').catch((failure) => {
      finished = true;
      return failure;
    });
    await vi.waitFor(() => expect(children.size).toBe(1));
    await Promise.resolve();
    expect(finished).toBe(false);
    children.get(directories.cli).emit('close', 0, null);

    expect(await building).toBe(error);
  });
});
