/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const mocks = vi.hoisted(() => ({ tmpdir: vi.fn() }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    default: { ...actual.default, tmpdir: mocks.tmpdir },
  };
});

let rootDir;
let cliDir;
let warningPath;
let checkBuildStatus;

function writeAt(relativePath, mtime) {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, 'test');
  fs.utimesSync(fullPath, mtime, mtime);
}

describe('development build status', () => {
  beforeEach(async () => {
    vi.resetModules();
    rootDir = fs.mkdtempSync(path.join(tmpdir(), 'gemini build status '));
    cliDir = path.join(rootDir, 'packages', 'cli');
    warningPath = path.join(rootDir, 'gemini-cli-warnings.txt');
    mocks.tmpdir.mockReturnValue(rootDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ({ checkBuildStatus } = await import('../check-build-status.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('does not check the build or write warnings when imported', () => {
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(fs.existsSync(warningPath)).toBe(false);
  });

  it('writes missing-build guidance and returns so the CLI can display it', () => {
    expect(() => checkBuildStatus(rootDir)).not.toThrow();

    expect(fs.readFileSync(warningPath, 'utf-8')).toBe(
      `ERROR: Build timestamp file (${path.join('packages', 'cli', 'dist', '.last_build')}) not found. Run \`npm run build\` first.`,
    );
  });

  it('removes old warnings when the build is current', () => {
    writeAt('packages/cli/dist/.last_build', 2000);
    writeAt('packages/cli/src/nested/source.ts', 1000);
    writeAt('packages/cli/src/node_modules/ignored.ts', 3000);
    writeAt('packages/cli/package.json', 1000);
    writeAt('packages/cli/tsconfig.json', 1000);
    fs.writeFileSync(warningPath, 'old warning');

    checkBuildStatus(rootDir);

    expect(fs.existsSync(warningPath)).toBe(false);
    expect(console.log).toHaveBeenCalledWith('Build is up-to-date.');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('records newer nested source and package files relative to the requested repository', () => {
    writeAt('packages/cli/dist/.last_build', 1000);
    writeAt('packages/cli/src/nested/source.ts', 2000);
    writeAt('packages/cli/package.json', 2000);
    writeAt('packages/cli/tsconfig.json', 2000);
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(rootDir, 'elsewhere'));

    checkBuildStatus(rootDir);

    const warnings = fs.readFileSync(warningPath, 'utf-8');
    for (const file of [
      'src/nested/source.ts',
      'package.json',
      'tsconfig.json',
    ]) {
      expect(warnings).toContain(
        `Warning: Source file "${path.join('packages', 'cli', file)}" has been modified since the last build.`,
      );
    }
    expect(warnings).toContain(
      'Run "npm run build" to incorporate changes before starting.',
    );
    expect(warnings).not.toContain(rootDir);
  });

  it('uses the current working directory for standalone callers', () => {
    writeAt('packages/cli/dist/.last_build', 2000);
    writeAt('packages/cli/src/source.ts', 1000);
    writeAt('packages/cli/package.json', 1000);
    writeAt('packages/cli/tsconfig.json', 1000);
    vi.spyOn(process, 'cwd').mockReturnValue(rootDir);

    checkBuildStatus();

    expect(console.log).toHaveBeenCalledWith('Build is up-to-date.');
  });

  it('keeps unexpected stat errors fatal', () => {
    const error = Object.assign(new Error('access denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw error;
    });

    expect(() => checkBuildStatus(rootDir)).toThrow(error);
    expect(console.error).toHaveBeenCalledWith(
      `Error getting stats for ${path.join(cliDir, 'dist', '.last_build')}:`,
      error,
    );
  });

  it('continues if the missing-build warning cannot be written', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('warning path unavailable');
    });

    expect(() => checkBuildStatus(rootDir)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      '[Check Script] Error writing missing build warning file: warning path unavailable',
    );
  });

  it('still runs directly as a script and exits successfully for a missing build', () => {
    const scriptPath = fileURLToPath(
      new URL('../check-build-status.js', import.meta.url),
    );
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: rootDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        TMPDIR: rootDir,
        TMP: rootDir,
        TEMP: rootDir,
      },
    });

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('Checking build status...');
    expect(result.stderr).toContain('Run `npm run build` first.');
    expect(fs.readFileSync(warningPath, 'utf-8')).toContain(
      'ERROR: Build timestamp file',
    );
  });
});
