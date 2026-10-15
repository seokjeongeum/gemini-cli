/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  profileBuildPhase,
  profileBuildPhaseAsync,
  summarizeBuildProfiles,
} from '../build-profile.js';
import {
  createBuildPhaseCollector,
  getBuildPackageLabel,
  getBuildProcessLabel,
} from '../build-profile-preload.js';
import { getBuildPreloadOption, runBuildProfile } from '../profile-build.js';

vi.unmock('fs');
vi.unmock('node:fs');

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const wrapper = fileURLToPath(new URL('../profile-build.js', import.meta.url));

describe('build phase collection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    performance.clearMarks();
    performance.clearMeasures();
  });

  it('preserves return values and original errors while measuring failed stages', () => {
    vi.stubEnv('GEMINI_BUILD_PROFILE_RUN_DIR', 'active');
    const result = {};
    expect(profileBuildPhase('generate_metadata', () => result)).toBe(result);
    const error = new Error('private failure');
    expect(() =>
      profileBuildPhase('build_core', () => {
        throw error;
      }),
    ).toThrow(error);
    const measures = performance.getEntriesByType('measure');
    expect(measures.map(({ name }) => name)).toEqual([
      'build:generate_metadata:ok',
      'build:build_core:failed',
    ]);
  });

  it('adds no marks when profiling is inactive or a phase is unknown', () => {
    vi.stubEnv('GEMINI_BUILD_PROFILE_RUN_DIR', '');
    expect(profileBuildPhase('build_core', () => 17)).toBe(17);
    vi.stubEnv('GEMINI_BUILD_PROFILE_RUN_DIR', 'active');
    expect(profileBuildPhase('private phase', () => 19)).toBe(19);
    expect(performance.getEntriesByType('mark')).toEqual([]);
    expect(performance.getEntriesByType('measure')).toEqual([]);
  });

  it('keeps asynchronous phases open until completion and records failures', async () => {
    vi.stubEnv('GEMINI_BUILD_PROFILE_RUN_DIR', 'active');
    let finish;
    const pending = profileBuildPhaseAsync(
      'build_parallel_workspaces',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(performance.getEntriesByType('measure')).toEqual([]);
    finish(17);
    await expect(pending).resolves.toBe(17);
    const failure = new Error('workspace failure');
    await expect(
      profileBuildPhaseAsync('build_all_workspaces', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      performance.getEntriesByType('measure').map(({ name }) => name),
    ).toEqual([
      'build:build_parallel_workspaces:ok',
      'build:build_all_workspaces:failed',
    ]);
  });

  it('keeps operations usable after optional performance mark failure', () => {
    vi.stubEnv('GEMINI_BUILD_PROFILE_RUN_DIR', 'active');
    const mark = vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('private protected builtin');
    });
    try {
      expect(profileBuildPhase('build_core', () => 23)).toBe(23);
    } finally {
      mark.mockRestore();
    }
  });

  it('requires correlated fixed marks and excludes incomplete stages and details', () => {
    const collector = createBuildPhaseCollector(100);
    collector.collect([
      {
        entryType: 'measure',
        name: 'build:build_core:failed',
        startTime: 10,
        duration: 20,
        detail: 'private arguments',
      },
      { entryType: 'mark', name: 'build:build_core:start', startTime: 10 },
      { entryType: 'mark', name: 'build:copy_assets:start', startTime: 40 },
      {
        entryType: 'measure',
        name: 'build:compile_typescript:ok',
        startTime: 0,
        duration: 99,
      },
      { entryType: 'mark', name: 'build:private:start', startTime: 50 },
      {
        entryType: 'measure',
        name: 'build:private:ok',
        startTime: 50,
        duration: 99,
      },
    ]);
    expect(collector.snapshot()).toEqual([
      { name: 'build_core', startMs: 110, durationMs: 20, status: 'failed' },
    ]);
    expect(JSON.stringify(collector.snapshot())).not.toContain('private');
  });

  it('bounds repeated stage storage', () => {
    const collector = createBuildPhaseCollector(0);
    collector.collect(
      Array.from({ length: 100 }, (_, startTime) => [
        { entryType: 'mark', name: 'build:copy_assets:start', startTime },
        {
          entryType: 'measure',
          name: 'build:copy_assets:ok',
          startTime,
          duration: 1,
        },
      ]).flat(),
    );
    expect(collector.snapshot()).toHaveLength(64);
  });

  it('uses fixed labels for package and build tools', () => {
    expect(
      getBuildProcessLabel(
        join(projectRoot, 'scripts/build.js'),
        '',
        projectRoot,
      ),
    ).toBe('build');
    expect(
      getBuildProcessLabel(
        join(projectRoot, 'node_modules/typescript/bin/tsc'),
        '',
        projectRoot,
      ),
    ).toBe('typescript');
    expect(getBuildProcessLabel('/private/command', '', projectRoot)).toBe(
      'other-node',
    );
    expect(
      getBuildPackageLabel(join(projectRoot, 'packages/core'), projectRoot),
    ).toBe('core');
    expect(
      getBuildPackageLabel(join(projectRoot, 'packages/private'), projectRoot),
    ).toBeUndefined();
    expect(
      getBuildPackageLabel(
        join(projectRoot, 'packages/core/nested'),
        projectRoot,
      ),
    ).toBeUndefined();
  });

  it('projects numeric metadata and fixed labels without summing overlapping stages', () => {
    const summary = summarizeBuildProfiles(
      [
        {
          schemaVersion: 1,
          pid: 2,
          ppid: 1,
          entrypoint: 'package-build',
          package: 'core',
          processStartMs: 10,
          completed: true,
          exitCode: 7,
          nodeBootToExitMs: 100,
          argv: 'private arguments',
          phases: [
            {
              name: 'compile_typescript',
              startMs: 20,
              durationMs: 90,
              status: 'failed',
              detail: 'private error',
            },
            { name: 'private name', startMs: 10, durationMs: 1, status: 'ok' },
          ],
        },
        {
          schemaVersion: 1,
          pid: 1,
          ppid: 0,
          entrypoint: 'build',
          processStartMs: 0,
          completed: false,
          nodeBootToExitMs: 500,
          phases: [],
        },
      ],
      { elapsedMs: 123.4567, exitCode: 7 },
    );
    expect(summary).toMatchObject({ elapsedMs: 123.457, exitCode: 7 });
    expect(summary.processes[0]).not.toHaveProperty('nodeBootToExitMs');
    expect(summary.processes[1].phases).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toContain('private');
  });

  it('bounds process records and keeps CI and sandbox mode semantics', () => {
    const summary = summarizeBuildProfiles(
      Array.from({ length: 300 }, (_, pid) => ({
        schemaVersion: 1,
        pid,
        ppid: 0,
        entrypoint: 'other-node',
        processStartMs: pid,
        completed: false,
        phases: [],
      })),
      {
        elapsedMs: 100,
        exitCode: 0,
        env: { CI: '0', BUILD_SANDBOX: 'false' },
      },
    );
    expect(summary.processes).toHaveLength(256);
    expect(summary.omittedProcessCount).toBe(44);
    expect(summary.buildMode).toBe('ci-sequential');
    expect(summary.sandboxRequested).toBe(false);
  });
});

describe('npm build profiling wrapper', () => {
  let temporary;
  let npmEntrypoint;
  let output;
  let messages;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'gemini-build-profile-test-'));
    npmEntrypoint = join(temporary, 'npm-cli.cjs');
    messages = '';
    output = { write: (value) => (messages += value) };
    vi.stubEnv('npm_execpath', npmEntrypoint);
    vi.stubEnv('GEMINI_BUILD_PROFILE_DIR', join(temporary, 'profiles'));
    vi.stubEnv('GEMINI_BUILD_PROFILE_RUN_DIR', '');
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(temporary, { recursive: true, force: true });
  });

  const fakeNpm = (source) => writeFileSync(npmEntrypoint, source);
  const profileDirectory = () => {
    const parent = join(temporary, 'profiles');
    return join(parent, readdirSync(parent)[0]);
  };
  const summary = () =>
    JSON.parse(readFileSync(join(profileDirectory(), 'summary.json'), 'utf8'));

  it('runs actual npm build with literal args and unchanged environment and exits', async () => {
    const captured = join(temporary, 'capture.json');
    vi.stubEnv('GEMINI_TEST_CAPTURE', captured);
    vi.stubEnv('GEMINI_API_KEY', 'private-token');
    vi.stubEnv('BUILD_SANDBOX', 'private-setting');
    fakeNpm(`
      require('node:fs').writeFileSync(process.env.GEMINI_TEST_CAPTURE, JSON.stringify({
        args: process.argv.slice(2),
        key: process.env.GEMINI_API_KEY,
        sandbox: process.env.BUILD_SANDBOX,
        options: process.env.NODE_OPTIONS,
      }));
      const { performance } = require('node:perf_hooks');
      const mark = performance.mark('build:build_core:start');
      performance.measure('build:build_core:failed', { start: mark.startTime });
      performance.mark('build:copy_assets:start');
      process.exit(7);
    `);
    const args = ['literal $(private)', 'space and "quote"'];
    expect(await runBuildProfile({ args, output })).toBe(7);
    const forwarded = JSON.parse(readFileSync(captured, 'utf8'));
    expect(forwarded.args).toEqual(['run', 'build', '--', ...args]);
    expect(forwarded.key).toBe('private-token');
    expect(forwarded.sandbox).toBe('private-setting');
    expect(forwarded.options).toMatch(/^--no-warnings --import=data:/);
    expect(
      forwarded.options.length - process.env.NODE_OPTIONS.length,
    ).toBeLessThan(2048);
    expect(process.env.NODE_OPTIONS).toBe('--no-warnings');
    const measured = summary();
    expect(measured.exitCode).toBe(7);
    expect(measured.elapsedMs).toBeGreaterThan(0);
    expect(measured.processes).toHaveLength(1);
    expect(measured.processes[0]).toMatchObject({
      entrypoint: 'npm',
      completed: true,
      exitCode: 7,
      phases: [
        expect.objectContaining({ name: 'build_core', status: 'failed' }),
      ],
    });
    expect(measured.processes[0].nodeBootToExitMs).toBeGreaterThan(0);
    const reports = readdirSync(profileDirectory())
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(join(profileDirectory(), name), 'utf8'))
      .join('');
    expect(reports).not.toContain('private');
    expect(reports).not.toContain(projectRoot);
    expect(reports).not.toContain('copy_assets');
  });

  it('continues the build without modified NODE_OPTIONS if storage is unavailable', async () => {
    const file = join(temporary, 'regular-file');
    writeFileSync(file, 'file');
    vi.stubEnv('GEMINI_BUILD_PROFILE_DIR', join(file, 'profiles'));
    fakeNpm(
      'process.exit(process.env.NODE_OPTIONS === "--no-warnings" ? 9 : 99);',
    );
    expect(await runBuildProfile({ args: [], output })).toBe(9);
    expect(messages).toContain('Cannot create reports');
  });

  it('preserves build failure when report writing fails', async () => {
    fakeNpm(`
      require('node:fs').rmSync(process.env.GEMINI_BUILD_PROFILE_RUN_DIR, { recursive: true });
      process.exit(11);
    `);
    expect(await runBuildProfile({ args: [], output })).toBe(11);
    expect(messages).toContain('Could not write the timing summary');
  });

  it('requires npm launch context', async () => {
    vi.stubEnv('npm_execpath', '');
    expect(await runBuildProfile({ args: [], output })).toBe(1);
    expect(messages).toContain('npm run build:profile');
  });

  it('does not fabricate stages on successful no-op launch', async () => {
    fakeNpm('process.exit(0);');
    expect(await runBuildProfile({ args: [], output })).toBe(0);
    expect(summary().processes[0].phases).toEqual([]);
    expect(messages).toContain('exit 0');
  });

  it('keeps helper imports usable when optional preload activation fails', () => {
    const helper = new URL('../build-profile.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import perfHooks from 'node:perf_hooks';
      import { syncBuiltinESMExports } from 'node:module';
      perfHooks.PerformanceObserver = class {
        constructor() { throw new Error('private protected observer'); }
      };
      syncBuiltinESMExports();
      const { profileBuildPhase } = await import(${JSON.stringify(helper)});
      process.exit(profileBuildPhase('build_core', () => 17));
    `,
      ],
      {
        env: {
          ...process.env,
          GEMINI_BUILD_PROFILE_RUN_DIR: temporary,
          GEMINI_BUILD_PROFILE_ROOT: projectRoot,
          GEMINI_BUILD_PROFILE_LAUNCH_TIME: String(Date.now()),
        },
      },
    );
    expect(result.status).toBe(17);
    expect(result.stderr.toString()).toBe('');
  });

  it('preserves exit status when optional observer methods fail at exit', () => {
    const helper = new URL('../build-profile.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import perfHooks from 'node:perf_hooks';
          import { syncBuiltinESMExports } from 'node:module';
          perfHooks.PerformanceObserver = class {
            observe() {}
            takeRecords() { throw new Error('private protected observer'); }
            disconnect() { throw new Error('private protected observer'); }
          };
          syncBuiltinESMExports();
          const { profileBuildPhase } = await import(${JSON.stringify(helper)});
          process.exit(profileBuildPhase('build_core', () => 19));
        `,
      ],
      {
        env: {
          ...process.env,
          GEMINI_BUILD_PROFILE_RUN_DIR: temporary,
          GEMINI_BUILD_PROFILE_ROOT: projectRoot,
          GEMINI_BUILD_PROFILE_LAUNCH_TIME: String(Date.now()),
        },
      },
    );
    expect(result.status).toBe(19);
    expect(result.stderr.toString()).toBe('');
  });

  it('allows tools to run when the optional host preload is unavailable', () => {
    const option = getBuildPreloadOption(
      pathToFileURL(join(temporary, 'missing.js')).href,
    );
    const result = spawnSync(process.execPath, ['-e', 'process.exit(13)'], {
      env: {
        ...process.env,
        NODE_OPTIONS: option,
        GEMINI_BUILD_PROFILE_RUN_DIR: temporary,
      },
    });
    expect(result.status).toBe(13);
    expect(result.stderr.toString()).toBe('');
  });

  it.skipIf(process.platform === 'win32')(
    'preserves signal status and retains incomplete records after foreground shutdown',
    async () => {
      fakeNpm(
        'process.stderr.write("BUILD_FIXTURE_READY\\n"); setInterval(() => {}, 1000);',
      );
      const child = spawn(process.execPath, [wrapper], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: process.env,
      });
      let stderr = '';
      let deadline;
      const timedOut = new Promise((_resolveUnused, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Build fixture timed out')),
          5000,
        );
        child.once('error', reject);
      });
      const closed = new Promise((resolveClosed) =>
        child.once('close', resolveClosed),
      );
      try {
        const ready = new Promise((resolveReady) => {
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
            if (stderr.includes('BUILD_FIXTURE_READY')) resolveReady();
          });
        });
        await Promise.race([ready, timedOut]);
        process.kill(-child.pid, 'SIGTERM');
        expect(await Promise.race([closed, timedOut])).toBe(143);
        expect(stderr).toContain('Summary:');
        expect(summary().processes[0]).toMatchObject({
          completed: false,
          phases: [],
        });
        expect(summary().processes[0]).not.toHaveProperty('nodeBootToExitMs');
      } finally {
        clearTimeout(deadline);
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group normally exits before cleanup.
        }
      }
    },
  );
});
