/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createPhaseCollector,
  getProcessLabel,
  summarizeProfiles,
} from '../startup-profile.js';
import { getPreloadOption, runStartupProfile } from '../profile-startup.js';
import { instrumentStartupProcesses } from '../startup-profile-preload.js';
import { EventEmitter } from 'node:events';

vi.unmock('fs');
vi.unmock('node:fs');

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const wrapper = fileURLToPath(
  new URL('../profile-startup.js', import.meta.url),
);
const preload = new URL('../startup-profile-preload.js', import.meta.url).href;

describe('startup timing collection', () => {
  it.each([
    'worktree_git_toplevel',
    'worktree_canonicalize_toplevel',
    'worktree_linked_discovery',
    'worktree_base_sha',
    'warning_realpath_workspace',
    'warning_realpath_home',
  ])('retains the fixed nested phase %s without path details', (name) => {
    const collector = createPhaseCollector(100);
    collector.collect([
      { entryType: 'mark', name: `startup:${name}:start`, startTime: 10 },
      {
        entryType: 'measure',
        name,
        startTime: 10,
        duration: 20,
        detail: { path: 'private workspace path' },
      },
    ]);
    expect(collector.snapshot()).toEqual([
      { name, startMs: 110, durationMs: 20 },
    ]);
    expect(JSON.stringify(collector.snapshot())).not.toContain('private');
  });

  it('records only correlated startup phases, without performance details', () => {
    const collector = createPhaseCollector(100);
    collector.collect([
      {
        entryType: 'measure',
        name: 'cli_startup',
        startTime: 20,
        duration: 50,
        detail: { prompt: 'private prompt' },
      },
      { entryType: 'mark', name: 'startup:cli_startup:start', startTime: 20 },
      {
        entryType: 'mark',
        name: 'startup:private prompt:start',
        startTime: 30,
      },
      {
        entryType: 'measure',
        name: 'private prompt',
        startTime: 30,
        duration: 1,
      },
      {
        entryType: 'measure',
        name: 'authenticate',
        startTime: 0,
        duration: 99,
      },
    ]);
    expect(collector.snapshot()).toEqual([
      { name: 'cli_startup', startMs: 120, durationMs: 50 },
    ]);
  });

  it('bounds repeated phase storage and ignores nonmatching measures', () => {
    const collector = createPhaseCollector(0);
    collector.collect([
      { entryType: 'mark', name: 'startup:authenticate:start', startTime: 5 },
      {
        entryType: 'measure',
        name: 'authenticate',
        startTime: 6,
        duration: 10,
      },
      {
        entryType: 'measure',
        name: 'authenticate',
        startTime: 5,
        duration: 10,
      },
      { entryType: 'mark', name: 'startup:authenticate:start', startTime: 30 },
      {
        entryType: 'measure',
        name: 'authenticate',
        startTime: 30,
        duration: 20,
      },
    ]);
    expect(collector.snapshot()).toEqual([
      { name: 'authenticate', startMs: 5, durationMs: 10 },
    ]);
  });

  it('reports initialization boundary without summing nested phases or idle time', () => {
    const summary = summarizeProfiles([
      {
        schemaVersion: 1,
        pid: 2,
        ppid: 1,
        entrypoint: 'cli',
        processStartMs: 100,
        sessionDurationMs: 100000,
        secret: 'private token',
        phases: [
          { name: 'cli_startup', startMs: 120, durationMs: 50 },
          {
            name: 'authenticate',
            startMs: 125,
            durationMs: 40,
            detail: 'private',
          },
        ],
      },
    ]);
    expect(summary).toMatchObject({
      launchToCliMainMs: 120,
      preMainMs: 20,
      cliStartupEndMs: 170,
    });
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(summary.processes[0].phases).toHaveLength(2);
  });

  it('does not replace missing initialization with process lifetime', () => {
    expect(
      summarizeProfiles([
        {
          schemaVersion: 1,
          pid: 2,
          ppid: 1,
          entrypoint: 'cli',
          processStartMs: 100,
          sessionDurationMs: 100000,
          phases: [],
        },
      ]),
    ).not.toHaveProperty('cliStartupEndMs');
  });

  it('retains durations only for short-lived startup helpers', () => {
    const profiles = [
      'npm',
      'start',
      'cli',
      'check-build-status',
      'sandbox-command',
    ].map((entrypoint, index) => ({
      schemaVersion: 1,
      pid: index + 2,
      ppid: 1,
      entrypoint,
      processStartMs: index,
      helperDurationMs: 20,
      sessionDurationMs: 100000,
      phases: [],
    }));
    const summary = summarizeProfiles(profiles);
    for (const profile of summary.processes.slice(0, 3)) {
      expect(profile).not.toHaveProperty('helperDurationMs');
      expect(profile).not.toHaveProperty('sessionDurationMs');
    }
    for (const profile of summary.processes.slice(3)) {
      expect(profile.helperDurationMs).toBe(20);
    }
    expect(summary).not.toHaveProperty('cliStartupEndMs');
  });

  it('skips damaged records while retaining healthy process timings', () => {
    expect(
      summarizeProfiles([
        null,
        {
          schemaVersion: 1,
          pid: 2,
          ppid: 1,
          entrypoint: 'cli',
          processStartMs: 100,
          phases: [null, { name: 'cli_startup', startMs: 120, durationMs: 50 }],
        },
      ]).cliStartupEndMs,
    ).toBe(170);
  });

  it('recognizes launch paths without exposing or accepting arbitrary entrypoints', () => {
    expect(
      getProcessLabel(join(projectRoot, 'packages/cli'), '', projectRoot),
    ).toBe('cli');
    expect(
      getProcessLabel(
        '/private/npm-cli.js',
        '/private/npm-cli.js',
        projectRoot,
      ),
    ).toBe('npm');
    expect(
      getProcessLabel('/private/start.js', '', projectRoot),
    ).toBeUndefined();
    expect(getProcessLabel('/private/mcp.js', '', projectRoot)).toBeUndefined();
  });
});

describe('startup subprocess timing', () => {
  const fixture = () => {
    let time = 10;
    const result = {};
    class Child extends EventEmitter {
      spawn() {
        time += 30;
        return result;
      }
    }
    const original = Child.prototype.spawn;
    const synchronous = vi.fn(function () {
      time += 20;
      return result;
    });
    const builtin = {
      ChildProcess: Child,
      spawnSync: synchronous,
      execSync: synchronous,
      execFileSync: synchronous,
    };
    const syncExports = vi.fn();
    const collector = instrumentStartupProcesses({
      builtin,
      syncExports,
      now: () => time,
      processStartMs: 100,
    });
    return {
      builtin,
      collector,
      original,
      synchronous,
      syncExports,
      result,
      setTime: (value) => {
        time = value;
      },
    };
  };

  it('separates an asynchronous spawn call from child lifetime without storing command data', () => {
    const { builtin, collector, setTime, result } = fixture();
    const child = new builtin.ChildProcess();
    expect(
      child.spawn({
        file: 'C:\\private workspace\\git.exe',
        args: ['private prompt'],
        env: { TOKEN: 'private token' },
      }),
    ).toBe(result);
    expect(child.listenerCount('error')).toBe(0);
    setTime(100);
    child.emit('close', 0);
    collector.stop(120);
    expect(collector.snapshot()).toEqual([
      {
        api: 'spawn',
        commandClass: 'git',
        startMs: 110,
        callMs: 30,
        durationMs: 90,
        completed: true,
        threw: false,
      },
    ]);
    expect(JSON.stringify(collector.snapshot())).not.toContain('private');
  });

  it('preserves synchronous return values and receivers, then restores every method', () => {
    const { builtin, collector, original, synchronous, syncExports, result } =
      fixture();
    for (const api of ['spawnSync', 'execSync', 'execFileSync']) {
      expect(builtin[api]('private executable', ['private argument'])).toBe(
        result,
      );
    }
    expect(synchronous.mock.instances).toEqual([builtin, builtin, builtin]);
    collector.stop();
    expect(builtin.ChildProcess.prototype.spawn).toBe(original);
    for (const api of ['spawnSync', 'execSync', 'execFileSync']) {
      expect(builtin[api]).toBe(synchronous);
    }
    expect(syncExports).toHaveBeenCalledTimes(2);
    expect(
      collector.snapshot().map(({ callMs, durationMs, completed }) => ({
        callMs,
        durationMs,
        completed,
      })),
    ).toEqual(
      Array(3).fill({
        callMs: 20,
        durationMs: 20,
        completed: true,
      }),
    );
  });

  it('preserves the original exception object without storing its text', () => {
    const error = new Error('private error');
    const original = () => {
      throw error;
    };
    const builtin = {
      ChildProcess: class {
        spawn = original;
      },
      spawnSync: original,
      execSync: original,
      execFileSync: original,
    };
    const collector = instrumentStartupProcesses({ builtin, syncExports() {} });
    try {
      builtin.execSync('private command');
      throw new Error('Expected original error');
    } catch (caught) {
      expect(caught).toBe(error);
    }
    collector.stop();
    expect(collector.snapshot()[0].threw).toBe(true);
    expect(JSON.stringify(collector.snapshot())).not.toContain('private');
  });

  it('bounds records and excludes calls and child lifetime beyond the actual startup boundary', () => {
    const { builtin, collector, setTime } = fixture();
    const first = new builtin.ChildProcess();
    first.spawn({ file: '/private/node' });
    setTime(70);
    const late = new builtin.ChildProcess();
    late.spawn({ file: '/private/rg' });
    first.emit('close', 0);
    collector.stop(50);
    expect(first.listenerCount('close')).toBe(0);
    expect(late.listenerCount('close')).toBe(0);
    expect(collector.snapshot()).toEqual([
      {
        api: 'spawn',
        commandClass: 'node',
        startMs: 110,
        callMs: 30,
        durationMs: 40,
        completed: false,
        threw: false,
      },
    ]);
    setTime(1_000_000);
    late.emit('close', 0);
    expect(collector.snapshot()[0].durationMs).toBe(40);

    const bounded = fixture();
    const children = Array.from({ length: 70 }, () => {
      const child = new bounded.builtin.ChildProcess();
      child.spawn({ file: '/private/git' });
      return child;
    });
    bounded.collector.stop();
    expect(bounded.collector.snapshot()).toHaveLength(64);
    expect(children.every((child) => child.listenerCount('close') === 0)).toBe(
      true,
    );
  });

  it('does not evaluate command getters for classification or suppress unhandled errors', () => {
    const { builtin, collector } = fixture();
    const child = new builtin.ChildProcess();
    const getter = vi.fn(() => {
      throw new Error('private getter');
    });
    child.spawn(Object.defineProperty({}, 'file', { get: getter }));
    expect(getter).not.toHaveBeenCalled();
    const error = new Error('private child error');
    expect(() => child.emit('error', error)).toThrow(error);
    collector.stop();
    expect(collector.snapshot()[0].commandClass).toBe('other');
  });

  it('preserves successful calls if optional listener registration fails', () => {
    const { builtin, collector, result } = fixture();
    const child = new builtin.ChildProcess();
    child.once = () => {
      throw new Error('private listener override');
    };
    expect(child.spawn({ file: '/private/git' })).toBe(result);
    collector.stop();
    expect(collector.snapshot()[0].completed).toBe(false);
    expect(JSON.stringify(collector.snapshot())).not.toContain('private');
  });

  it('restores installed hooks if installation encounters a protected builtin', () => {
    class Child extends EventEmitter {
      spawn() {}
    }
    const original = Child.prototype.spawn;
    const builtin = Object.freeze({
      ChildProcess: Child,
      spawnSync() {},
      execSync() {},
      execFileSync() {},
    });
    const collector = instrumentStartupProcesses({ builtin, syncExports() {} });
    collector.stop();
    expect(Child.prototype.spawn).toBe(original);
    expect(collector.snapshot()).toEqual([]);
  });

  it('projects only fixed subprocess classes and numeric timing fields into summaries', () => {
    const valid = {
      api: 'spawn',
      commandClass: 'git',
      startMs: 10,
      callMs: 20,
      durationMs: 30,
      completed: true,
      threw: false,
      argv: ['private argument'],
      error: 'private error',
    };
    const summary = summarizeProfiles([
      {
        schemaVersion: 1,
        pid: 1,
        ppid: 0,
        entrypoint: 'cli',
        processStartMs: 0,
        phases: [],
        startupProcesses: [
          null,
          { ...valid, api: 'private api' },
          { ...valid, commandClass: 'private executable' },
          { ...valid, callMs: -1 },
          ...Array(70).fill(valid),
        ],
      },
    ]);
    expect(summary.processes[0].startupProcesses).toHaveLength(64);
    expect(JSON.stringify(summary)).not.toContain('private');
  });
});

describe('npm start profiling wrapper', () => {
  let temporary;
  let npmEntrypoint;
  let output;
  let messages;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'gemini-startup-profile-test-'));
    npmEntrypoint = join(temporary, 'npm-cli.cjs');
    messages = '';
    output = { write: (value) => (messages += value) };
    vi.stubEnv('npm_execpath', npmEntrypoint);
    vi.stubEnv('GEMINI_STARTUP_PROFILE_DIR', join(temporary, 'profiles'));
    vi.stubEnv('GEMINI_STARTUP_PROFILE_RUN_DIR', '');
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

  it('forwards literal arguments and auth environment, preserving options and exit code', async () => {
    const captured = join(temporary, 'captured.json');
    vi.stubEnv('GEMINI_API_KEY', 'private-token');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'private-project');
    vi.stubEnv('GEMINI_TEST_CAPTURE', captured);
    fakeNpm(`
      const fs = require('node:fs');
      const { performance } = require('node:perf_hooks');
      fs.writeFileSync(process.env.GEMINI_TEST_CAPTURE, JSON.stringify({
        args: process.argv.slice(2),
        key: process.env.GEMINI_API_KEY,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        options: process.env.NODE_OPTIONS,
      }));
      performance.mark('startup:cli_startup:start', { detail: 'private prompt' });
      performance.mark('startup:cli_startup:end');
      performance.measure('cli_startup', 'startup:cli_startup:start', 'startup:cli_startup:end');
      process.exit(7);
    `);
    const args = ['--model', 'literal $(echo secret)', 'space and "quote"'];
    expect(await runStartupProfile({ args, output })).toBe(7);
    const forwarded = JSON.parse(readFileSync(captured, 'utf8'));
    expect(forwarded.args).toEqual(['start', '--', ...args]);
    expect(forwarded).toMatchObject({
      key: 'private-token',
      project: 'private-project',
    });
    expect(forwarded.options).toMatch(/^--no-warnings --import=data:/);
    expect(process.env.NODE_OPTIONS).toBe('--no-warnings');
    const directory = profileDirectory();
    const reports = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(join(directory, name), 'utf8'))
      .join('');
    expect(reports).not.toContain('private');
    expect(reports).not.toContain('literal');
    const summary = JSON.parse(
      readFileSync(join(directory, 'summary.json'), 'utf8'),
    );
    // npm is a launcher, so its unrelated performance marks are not observed.
    expect(summary.processes[0].phases).toEqual([]);
    // A complete embedded module can exceed cmd.exe's inherited-variable limit.
    // Leave room for existing NODE_OPTIONS by appending only the small loader.
    expect(
      forwarded.options.length - process.env.NODE_OPTIONS.length,
    ).toBeLessThan(2048);
    expect(forwarded.options).toContain('file');
    expect(summary).not.toHaveProperty('cliStartupEndMs');
  });

  it('continues normal npm start if report storage cannot be created', async () => {
    const unavailable = join(temporary, 'regular-file');
    writeFileSync(unavailable, 'file');
    vi.stubEnv('GEMINI_STARTUP_PROFILE_DIR', join(unavailable, 'profiles'));
    fakeNpm(
      'process.exit(process.env.NODE_OPTIONS === "--no-warnings" ? 9 : 99);',
    );
    expect(await runStartupProfile({ args: [], output })).toBe(9);
    expect(messages).toContain('Cannot create reports');
  });

  it('preserves CLI failure when final report writing fails', async () => {
    fakeNpm(`
      require('node:fs').rmSync(process.env.GEMINI_STARTUP_PROFILE_RUN_DIR, { recursive: true });
      process.exit(11);
    `);
    expect(await runStartupProfile({ args: [], output })).toBe(11);
    expect(messages).toContain('Could not write the timing summary');
  });

  it('does not claim initialization was measured for a version-only exit', async () => {
    fakeNpm('process.exit(0);');
    expect(await runStartupProfile({ args: ['--version'], output })).toBe(0);
    expect(messages).toContain('No completed cli_startup phase');
    const summary = JSON.parse(
      readFileSync(join(profileDirectory(), 'summary.json'), 'utf8'),
    );
    expect(summary).not.toHaveProperty('cliStartupEndMs');
  });

  it('preserves npm launcher failure instead of treating it as success', async () => {
    vi.stubEnv('npm_execpath', join(temporary, 'does-not-exist.cjs'));
    expect(await runStartupProfile({ args: [], output })).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves signal-derived child exit status',
    async () => {
      fakeNpm('process.kill(process.pid, "SIGTERM");');
      expect(await runStartupProfile({ args: [], output })).toBe(143);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'waits for foreground-group shutdown and writes a summary',
    async () => {
      fakeNpm(
        'process.stderr.write("FAKE_NPM_READY\\n"); setInterval(() => {}, 1000);',
      );
      const child = spawn(process.execPath, [wrapper], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: process.env,
      });
      let stderr = '';
      const closed = new Promise((resolveClosed) =>
        child.once('close', (code) => resolveClosed(code)),
      );
      let deadline;
      const timedOut = new Promise((_resolveUnused, reject) => {
        deadline = setTimeout(
          () =>
            reject(new Error('Signal fixture did not start or stop in time')),
          3000,
        );
        child.once('error', reject);
      });
      try {
        const ready = new Promise((resolveReady) => {
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
            if (stderr.includes('FAKE_NPM_READY')) resolveReady();
          });
        });
        await Promise.race([ready, timedOut]);
        process.kill(-child.pid, 'SIGTERM');
        expect(await Promise.race([closed, timedOut])).toBe(143);
        expect(stderr).toContain('Summary:');
        expect(readdirSync(profileDirectory())).toContain('summary.json');
      } finally {
        clearTimeout(deadline);
        // Keep this fixture's process group isolated and clean up on assertion
        // failure as well as success. ESRCH means the group has already exited.
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group normally exits before this best-effort cleanup.
        }
      }
    },
  );

  it('allows sandbox startup when the host preload is unavailable or profiling env absent', () => {
    const missing = pathToFileURL(join(temporary, 'unavailable.js')).href;
    const option = getPreloadOption(missing);
    for (const active of ['', temporary]) {
      const result = spawnSync(process.execPath, ['-e', 'process.exit(13)'], {
        env: {
          ...process.env,
          NODE_OPTIONS: option,
          GEMINI_STARTUP_PROFILE_RUN_DIR: active,
        },
      });
      expect(result.status).toBe(13);
      expect(result.stderr.toString()).toBe('');
    }
  });

  it('captures timings when the preload path has spaces, quotes, and URL characters', () => {
    const fixture = join(
      temporary,
      process.platform === 'win32'
        ? "profile 'quoted' directory #"
        : 'profile "quoted" directory #',
    );
    const scripts = join(fixture, 'scripts');
    const cli = join(fixture, 'packages', 'cli', 'dist', 'index.js');
    const directory = join(fixture, 'reports');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(fixture, 'packages', 'cli', 'dist'), { recursive: true });
    mkdirSync(directory);
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    // The preload works with only this file; it imports no other checkout files.
    copyFileSync(
      join(projectRoot, 'scripts', 'startup-profile-preload.js'),
      join(scripts, 'startup-profile-preload.js'),
    );
    writeFileSync(
      cli,
      `
      import { performance } from 'node:perf_hooks';
      performance.mark('startup:load_settings:start', { detail: 'private prompt' });
      performance.mark('startup:load_settings:end');
      performance.measure('load_settings', 'startup:load_settings:start', 'startup:load_settings:end');
      process.exit(17);
    `,
    );
    const result = spawnSync(process.execPath, [cli], {
      env: {
        ...process.env,
        NODE_OPTIONS: getPreloadOption(
          pathToFileURL(join(scripts, 'startup-profile-preload.js')).href,
        ),
        GEMINI_STARTUP_PROFILE_RUN_DIR: directory,
        GEMINI_STARTUP_PROFILE_ROOT: fixture,
        GEMINI_STARTUP_PROFILE_LAUNCH_TIME: String(Date.now()),
        GEMINI_CLI_NO_RELAUNCH: 'true',
      },
    });
    expect(result.status).toBe(17);
    expect(result.stderr.toString()).toBe('');
    const record = JSON.parse(
      readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'),
    );
    expect(record.phases[0].name).toBe('load_settings');
    expect(record.phases[0].startMs).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toContain('private');
  });

  it('measures helper work without observing marks or storing command data', () => {
    const fixture = join(temporary, 'helper-preload');
    const scripts = join(fixture, 'scripts');
    const directory = join(fixture, 'reports');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(directory);
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    const helper = join(scripts, 'sandbox_command.js');
    writeFileSync(
      helper,
      `
      import { performance } from 'node:perf_hooks';
      performance.mark('startup:load_settings:start', { detail: 'private prompt' });
      performance.mark('startup:load_settings:end');
      performance.measure('load_settings', 'startup:load_settings:start', 'startup:load_settings:end');
      setTimeout(() => process.exit(19), 20);
    `,
    );
    const result = spawnSync(process.execPath, [helper, 'private argument'], {
      env: {
        ...process.env,
        NODE_OPTIONS: getPreloadOption(preload),
        GEMINI_STARTUP_PROFILE_ROOT: fixture,
        GEMINI_STARTUP_PROFILE_RUN_DIR: directory,
        GEMINI_STARTUP_PROFILE_LAUNCH_TIME: String(Date.now()),
      },
    });
    expect(result.status).toBe(19);
    const record = JSON.parse(
      readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'),
    );
    expect(record.entrypoint).toBe('sandbox-command');
    expect(record.helperDurationMs).toBeGreaterThanOrEqual(20);
    expect(record.phases).toEqual([]);
    expect(JSON.stringify(record)).not.toContain('private');
    expect(record).not.toHaveProperty('sessionDurationMs');
  });

  it('instruments named sync imports and async children only through startup', () => {
    const fixture = join(temporary, 'subprocess-cli');
    const cli = join(fixture, 'packages', 'cli', 'dist', 'index.js');
    const directory = join(fixture, 'reports');
    mkdirSync(join(fixture, 'packages', 'cli', 'dist'), { recursive: true });
    mkdirSync(directory);
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    writeFileSync(
      cli,
      `
      import { spawn, spawnSync, execFileSync } from 'node:child_process';
      import { performance } from 'node:perf_hooks';
      performance.mark('startup:cli_startup:start');
      spawnSync(process.execPath, ['-e', 'process.exit(0)', 'private argument']);
      execFileSync(process.execPath, ['-e', 'process.exit(0)', 'private argument']);
      const completed = spawn(process.execPath, ['-e', 'process.exit(0)']);
      await new Promise((resolve) => completed.once('close', resolve));
      const pending = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      const pendingClosed = new Promise((resolve) => pending.once('close', resolve));
      performance.mark('startup:cli_startup:end');
      performance.measure('cli_startup', 'startup:cli_startup:start', 'startup:cli_startup:end');
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
      spawnSync(process.execPath, ['-e', 'process.exit(0)', 'private later argument']);
      pending.kill();
      await pendingClosed;
    `,
    );
    const result = spawnSync(process.execPath, [cli], {
      env: {
        ...process.env,
        NODE_OPTIONS: getPreloadOption(preload),
        GEMINI_STARTUP_PROFILE_ROOT: fixture,
        GEMINI_STARTUP_PROFILE_RUN_DIR: directory,
        GEMINI_STARTUP_PROFILE_LAUNCH_TIME: String(Date.now()),
        GEMINI_CLI_NO_RELAUNCH: 'true',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('');
    const record = JSON.parse(
      readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'),
    );
    expect(record.startupProcesses.map(({ api }) => api)).toEqual([
      'spawnSync',
      'execFileSync',
      'spawn',
      'spawn',
    ]);
    expect(
      record.startupProcesses.every(
        ({ commandClass }) => commandClass === 'node',
      ),
    ).toBe(true);
    expect(record.startupProcesses.map(({ completed }) => completed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(JSON.stringify(record)).not.toContain('private');
  });

  it('buffers completed phases until initialization finishes and flushes failures on exit', () => {
    const fixture = join(temporary, 'buffered-cli');
    const cli = join(fixture, 'packages', 'cli', 'dist', 'index.js');
    const directory = join(fixture, 'reports');
    mkdirSync(join(fixture, 'packages', 'cli', 'dist'), { recursive: true });
    mkdirSync(directory);
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    writeFileSync(
      cli,
      `
      import { readdirSync } from 'node:fs';
      import { performance } from 'node:perf_hooks';
      performance.mark('startup:cli_startup:start');
      performance.mark('startup:load_settings:start');
      performance.mark('startup:load_settings:end');
      performance.measure('load_settings', 'startup:load_settings:start', 'startup:load_settings:end');
      setTimeout(() => {
        console.log(readdirSync(process.env.GEMINI_STARTUP_PROFILE_RUN_DIR).length);
        process.exit(23);
      }, 200);
    `,
    );
    const result = spawnSync(process.execPath, [cli], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: getPreloadOption(preload),
        GEMINI_STARTUP_PROFILE_ROOT: fixture,
        GEMINI_STARTUP_PROFILE_RUN_DIR: directory,
        GEMINI_STARTUP_PROFILE_LAUNCH_TIME: String(Date.now()),
        GEMINI_CLI_NO_RELAUNCH: 'true',
      },
    });
    expect(result.status).toBe(23);
    expect(result.stdout.trim()).toBe('0');
    const record = JSON.parse(
      readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'),
    );
    expect(record.phases.map((phase) => phase.name)).toEqual(['load_settings']);
    expect(summarizeProfiles([record])).not.toHaveProperty('cliStartupEndMs');
  });

  it('does not record unrelated Node tools or worker threads', async () => {
    const directory = join(temporary, 'process-reports');
    mkdirSync(directory);
    const tool = join(temporary, 'tool.cjs');
    writeFileSync(tool, 'process.exit(0);');
    const result = spawnSync(process.execPath, ['--import', preload, tool], {
      env: {
        ...process.env,
        GEMINI_STARTUP_PROFILE_RUN_DIR: directory,
        GEMINI_STARTUP_PROFILE_LAUNCH_TIME: String(Date.now()),
      },
    });
    expect(result.status).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
    // Also exercise recognized npm plus a worker with shared PID.
    fakeNpm(`
      const { Worker } = require('node:worker_threads');
      const worker = new Worker('process.exit(0)', { eval: true });
      worker.on('exit', () => process.exit(0));
    `);
    expect(await runStartupProfile({ args: [], output })).toBe(0);
    const files = readdirSync(profileDirectory());
    expect(
      files.filter((name) => /^process-\d+\.json$/.test(name)),
    ).toHaveLength(1);
    expect(files).not.toContain('undefined');
  });
});
