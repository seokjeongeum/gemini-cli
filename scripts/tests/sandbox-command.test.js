/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  platform: vi.fn(),
  dotenvConfig: vi.fn(),
  quiet: false,
}));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));
vi.mock('node:os', () => ({
  default: { platform: mocks.platform, homedir: () => '/unused-home' },
}));
vi.mock('dotenv', () => ({ default: { config: mocks.dotenvConfig } }));
vi.mock('yargs', () => ({
  default: () => ({ option: () => ({ argv: { q: mocks.quiet } }) }),
}));
vi.mock('@google/gemini-cli-core/dist/src/utils/paths.js', () => ({
  GEMINI_DIR: '.gemini',
}));

class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

async function runSandboxCommand(code) {
  await expect(import('../sandbox_command.js')).rejects.toMatchObject({ code });
}

describe('sandbox command selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('GEMINI_SANDBOX', '');
    vi.stubEnv('GEMINI_CLI_HOME', '/test-home');
    vi.stubEnv('SEATBELT_PROFILE', '');
    mocks.platform.mockReturnValue('linux');
    mocks.existsSync.mockReturnValue(false);
    mocks.execSync.mockImplementation(() => {});
    mocks.quiet = false;
    vi.spyOn(process, 'cwd').mockReturnValue('/project/workspace');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Exit(code);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['0', 'false'])(
    'does not probe container commands when disabled on Windows with %s',
    async (value) => {
      mocks.platform.mockReturnValue('win32');
      vi.stubEnv('GEMINI_SANDBOX', value);

      await runSandboxCommand(1);

      expect(mocks.execSync).not.toHaveBeenCalled();
      expect(mocks.existsSync).not.toHaveBeenCalled();
    },
  );

  it('keeps the macOS seatbelt default even when containers are explicitly disabled', async () => {
    mocks.platform.mockReturnValue('darwin');
    vi.stubEnv('GEMINI_SANDBOX', 'false');

    await runSandboxCommand(0);

    expect(mocks.execSync).toHaveBeenCalledWith('command -v sandbox-exec', {
      stdio: 'ignore',
    });
    expect(console.log).toHaveBeenCalledWith('sandbox-exec');
  });

  it('honors the macOS seatbelt opt-out', async () => {
    mocks.platform.mockReturnValue('darwin');
    vi.stubEnv('GEMINI_SANDBOX', 'false');
    vi.stubEnv('SEATBELT_PROFILE', 'none');

    await runSandboxCommand(1);

    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it('selects Docker when containers are enabled', async () => {
    vi.stubEnv('GEMINI_SANDBOX', 'true');

    await runSandboxCommand(0);

    expect(mocks.execSync).toHaveBeenCalledWith('command -v docker', {
      stdio: 'ignore',
    });
    expect(console.log).toHaveBeenCalledWith('docker');
  });

  it('falls back to Podman if Docker is missing', async () => {
    vi.stubEnv('GEMINI_SANDBOX', '1');
    mocks.execSync.mockImplementation((command) => {
      if (command === 'command -v docker') throw new Error('missing');
    });

    await runSandboxCommand(0);

    expect(console.log).toHaveBeenCalledWith('podman');
  });

  it('reports a missing explicit sandbox command on Windows', async () => {
    mocks.platform.mockReturnValue('win32');
    vi.stubEnv('GEMINI_SANDBOX', 'podman');
    mocks.execSync.mockImplementation(() => {
      throw new Error('missing');
    });

    await runSandboxCommand(1);

    expect(mocks.execSync).toHaveBeenCalledWith('where podman', {
      stdio: 'ignore',
    });
    expect(mocks.execSync).toHaveBeenCalledWith('where podman.exe', {
      stdio: 'ignore',
    });
    expect(console.error).toHaveBeenCalledWith(
      "ERROR: missing sandbox command 'podman' (from GEMINI_SANDBOX)",
    );
  });

  it('reads the sandbox setting from the configured Gemini home', async () => {
    const settingsPath = join('/test-home', '.gemini', 'settings.json');
    mocks.existsSync.mockImplementation((path) => path === settingsPath);
    mocks.readFileSync.mockReturnValue('{ // comment\n "sandbox": "podman" }');

    await runSandboxCommand(0);

    expect(mocks.readFileSync).toHaveBeenCalledWith(settingsPath, 'utf-8');
    expect(console.log).toHaveBeenCalledWith('podman');
    expect(mocks.dotenvConfig).not.toHaveBeenCalled();
  });

  it('loads an ancestor Gemini environment file before selecting a command', async () => {
    const envPath = join('/project', '.gemini', '.env');
    mocks.existsSync.mockImplementation((path) => path === envPath);
    mocks.dotenvConfig.mockImplementation(() => {
      vi.stubEnv('GEMINI_SANDBOX', 'docker');
    });

    await runSandboxCommand(0);

    expect(mocks.dotenvConfig).toHaveBeenCalledWith({
      path: envPath,
      quiet: true,
    });
    expect(console.log).toHaveBeenCalledWith('docker');
  });

  it('keeps quiet output for build-time checks', async () => {
    vi.stubEnv('GEMINI_SANDBOX', 'docker');
    mocks.quiet = true;

    await runSandboxCommand(0);

    expect(console.log).not.toHaveBeenCalled();
  });
});
