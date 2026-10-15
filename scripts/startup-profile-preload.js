/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Only names used by StartupProfiler are recorded. Arbitrary performance marks
// and their details can contain user data and must not enter a timing report.
export const STARTUP_PHASES = new Set([
  'cli_startup',
  'load_settings',
  'setup_worktree',
  'cleanup_ops',
  'parse_arguments',
  'load_cli_config',
  'setup_terminal',
  'initialize_app',
  'authenticate',
  'discover_tools',
  'load_builtin_commands',
  'import_interactive_ui',
  'read_startup_warnings',
  'resolve_session',
  'load_partial_config',
  'initial_auth',
  'load_sandbox_config',
  'startup_oauth',
  'collect_startup_warnings',
  'detect_worktree',
  'worktree_git_toplevel',
  'worktree_canonicalize_toplevel',
  'worktree_linked_discovery',
  'worktree_base_sha',
  'check_folder_trust',
  'resolve_workspace_policies',
  'load_policies',
  'detect_pty',
  'construct_config',
  'home_directory_warning',
  'root_directory_warning',
  'folder_trust_warning',
  'compatibility_warnings',
  'warning_realpath_workspace',
  'warning_realpath_home',
]);

const SHORT_LIVED_HELPERS = new Set(['check-build-status', 'sandbox-command']);

const ENTRYPOINTS = new Set([
  'npm',
  'cross-env',
  'start',
  'check-build-status',
  'sandbox-command',
  'cli',
]);

export const milliseconds = (value) => Math.round(value * 1000) / 1000;

const PROCESS_APIS = new Set([
  'spawn',
  'spawnSync',
  'execSync',
  'execFileSync',
]);
const COMMAND_CLASSES = new Set(['node', 'git', 'shell', 'rg', 'other']);
const PROCESS_RECORD_LIMIT = 64;

function commandClass(file) {
  if (typeof file !== 'string') return 'other';
  const name = file
    .split(/[\\/]/)
    .at(-1)
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (name === 'node' || name === 'git' || name === 'rg') return name;
  return ['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'dash'].includes(name)
    ? 'shell'
    : 'other';
}

// Used only by the opt-in preload in the CLI child. Never retain command text,
// arguments, environment, output, or error objects in the timing records.
export function instrumentStartupProcesses({
  builtin = childProcess,
  syncExports = syncBuiltinESMExports,
  now = () => performance.now(),
  processStartMs = 0,
} = {}) {
  const records = [];
  const hooks = [];
  const listeners = new Map();
  let boundary;

  const begin = (api, file) => {
    if (boundary !== undefined || records.length >= PROCESS_RECORD_LIMIT)
      return;
    const record = { api, commandClass: commandClass(file), start: now() };
    records.push(record);
    return record;
  };

  const hook = (owner, name, asynchronous) => {
    const original = owner[name];
    const wrapped = function (...args) {
      let file = name === 'execSync' ? 'cmd' : args[0];
      if (asynchronous) {
        // Avoid evaluating an options getter a second time for classification.
        try {
          file = Object.getOwnPropertyDescriptor(args[0], 'file')?.value;
        } catch {
          file = undefined;
        }
      }
      const record = begin(name, file);
      let returned = false;
      try {
        const result = Reflect.apply(original, this, args);
        returned = true;
        return result;
      } finally {
        if (record) {
          record.callEnd = now();
          record.threw = !returned;
          if (!asynchronous || !returned) {
            record.end = record.callEnd;
          } else {
            const closed = () => {
              record.end = now();
              listeners.delete(record);
            };
            // A close listener does not suppress unhandled error events.
            listeners.set(record, { child: this, closed });
            try {
              this.once('close', closed);
            } catch {
              // A host may override EventEmitter methods. Timing is optional.
            }
          }
        }
      }
    };
    owner[name] = wrapped;
    hooks.push({ owner, name, original, wrapped });
  };

  const restore = () => {
    for (const { owner, name, original, wrapped } of hooks) {
      try {
        if (owner[name] === wrapped) owner[name] = original;
      } catch {
        // A host can protect a builtin after instrumentation was installed.
      }
    }
    try {
      syncExports();
    } catch {
      // Continue removing listeners even if named exports cannot be refreshed.
    }
    for (const { child, closed } of listeners.values()) {
      try {
        child.removeListener('close', closed);
      } catch {
        // Best effort on hosts that override EventEmitter methods.
      }
    }
    listeners.clear();
  };

  try {
    hook(builtin.ChildProcess.prototype, 'spawn', true);
    for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
      hook(builtin, name, false);
    }
    syncExports();
  } catch {
    // A report must not prevent startup if a host has protected its builtins.
    try {
      restore();
    } catch {
      // Best effort only; installed hooks become inert at this boundary.
    }
    boundary = now();
  }

  return {
    stop(end = now()) {
      if (boundary !== undefined) return;
      boundary = end;
      try {
        restore();
      } catch {
        // Reporting must not change application behavior on a protected host.
      }
    },
    snapshot() {
      const end = boundary ?? now();
      return records
        .filter((record) => record.start <= end)
        .map((record) => ({
          api: record.api,
          commandClass: record.commandClass,
          startMs: milliseconds(processStartMs + record.start),
          callMs: milliseconds(
            Math.max(0, Math.min(record.callEnd ?? end, end) - record.start),
          ),
          durationMs: milliseconds(
            Math.max(0, Math.min(record.end ?? end, end) - record.start),
          ),
          completed: record.end !== undefined && record.end <= end,
          threw: Boolean(record.threw),
        }));
    },
  };
}

export function getProcessLabel(entrypoint, npmEntrypoint, root) {
  if (!entrypoint) return undefined;
  const actual = resolve(entrypoint);
  if (npmEntrypoint && actual === resolve(npmEntrypoint)) return 'npm';
  const paths = new Map([
    [join(root, 'node_modules/.bin/cross-env'), 'cross-env'],
    [join(root, 'node_modules/.bin/cross-env.js'), 'cross-env'],
    [join(root, 'node_modules/cross-env/src/bin/cross-env.js'), 'cross-env'],
    [join(root, 'scripts/start.js'), 'start'],
    [join(root, 'scripts/check-build-status.js'), 'check-build-status'],
    [join(root, 'scripts/sandbox_command.js'), 'sandbox-command'],
    [join(root, 'packages/cli'), 'cli'],
    [join(root, 'packages/cli/dist/index.js'), 'cli'],
  ]);
  return paths.get(actual);
}

export function createPhaseCollector(processStartMs) {
  const starts = new Map();
  const phases = new Map();

  return {
    collect(entries) {
      let changed = false;
      // Marks and measures can be delivered together, including on exit.
      for (const entry of entries) {
        if (entry.entryType !== 'mark') continue;
        const match = /^startup:([^:]+):start$/.exec(entry.name);
        if (
          match &&
          STARTUP_PHASES.has(match[1]) &&
          !starts.has(match[1]) &&
          Number.isFinite(entry.startTime)
        ) {
          starts.set(match[1], entry.startTime);
          changed = true;
        }
      }
      for (const entry of entries) {
        if (
          entry.entryType === 'measure' &&
          STARTUP_PHASES.has(entry.name) &&
          !phases.has(entry.name) &&
          starts.get(entry.name) === entry.startTime &&
          Number.isFinite(entry.duration) &&
          entry.duration >= 0
        ) {
          phases.set(entry.name, {
            name: entry.name,
            startMs: milliseconds(processStartMs + entry.startTime),
            durationMs: milliseconds(entry.duration),
          });
          changed = true;
        }
      }
      return changed;
    },
    snapshot() {
      return [...phases.values()].sort((a, b) => a.startMs - b.startMs);
    },
    hasCompletedCliStartup() {
      return phases.has('cli_startup');
    },
    hasPendingPhases() {
      return starts.size !== phases.size;
    },
  };
}

// Explicit projection also keeps unexpected fields out of an aggregate report.
export function summarizeProfiles(profiles) {
  const processes = profiles
    .filter(
      (profile) =>
        profile &&
        profile.schemaVersion === 1 &&
        ENTRYPOINTS.has(profile.entrypoint) &&
        Number.isInteger(profile.pid) &&
        Number.isInteger(profile.ppid) &&
        Number.isFinite(profile.processStartMs) &&
        Array.isArray(profile.phases),
    )
    .map((profile) => {
      const phases = profile.phases
        .filter(
          (phase) =>
            phase &&
            STARTUP_PHASES.has(phase.name) &&
            Number.isFinite(phase.startMs) &&
            Number.isFinite(phase.durationMs) &&
            phase.durationMs >= 0,
        )
        .slice(0, STARTUP_PHASES.size)
        .map(({ name, startMs, durationMs }) => ({
          name,
          startMs,
          durationMs,
        }));
      const result = {
        pid: profile.pid,
        ppid: profile.ppid,
        entrypoint: profile.entrypoint,
        processStartMs: profile.processStartMs,
        phases,
      };
      if (
        profile.entrypoint === 'cli' &&
        Array.isArray(profile.startupProcesses)
      ) {
        result.startupProcesses = profile.startupProcesses
          .filter(
            (record) =>
              record &&
              PROCESS_APIS.has(record.api) &&
              COMMAND_CLASSES.has(record.commandClass) &&
              Number.isFinite(record.startMs) &&
              Number.isFinite(record.callMs) &&
              record.callMs >= 0 &&
              Number.isFinite(record.durationMs) &&
              record.durationMs >= record.callMs &&
              typeof record.completed === 'boolean' &&
              typeof record.threw === 'boolean',
          )
          .slice(0, PROCESS_RECORD_LIMIT)
          .map(
            ({
              api,
              commandClass,
              startMs,
              callMs,
              durationMs,
              completed,
              threw,
            }) => ({
              api,
              commandClass,
              startMs,
              callMs,
              durationMs,
              completed,
              threw,
            }),
          );
      }
      // Only these processes finish as part of startup. Launcher and CLI
      // lifetimes also include interactive testing and must not be used here.
      if (
        SHORT_LIVED_HELPERS.has(profile.entrypoint) &&
        Number.isFinite(profile.helperDurationMs) &&
        profile.helperDurationMs >= 0
      ) {
        result.helperDurationMs = profile.helperDurationMs;
      }
      return result;
    })
    .sort((a, b) => a.processStartMs - b.processStartMs);

  const summary = { schemaVersion: 1, processes };
  // A supervisor can restart the CLI during testing. Report the first startup.
  const cli = processes.find(
    (profile) =>
      profile.entrypoint === 'cli' &&
      profile.phases.some((phase) => phase.name === 'cli_startup'),
  );
  const startup = cli?.phases.find((phase) => phase.name === 'cli_startup');
  if (startup) {
    summary.launchToCliMainMs = startup.startMs;
    summary.preMainMs = milliseconds(startup.startMs - cli.processStartMs);
    summary.cliStartupEndMs = milliseconds(
      startup.startMs + startup.durationMs,
    );
  }
  return summary;
}

const root =
  process.env['GEMINI_STARTUP_PROFILE_ROOT'] ||
  (import.meta.url.startsWith('file:')
    ? dirname(dirname(fileURLToPath(import.meta.url)))
    : undefined);

const directory = process.env['GEMINI_STARTUP_PROFILE_RUN_DIR'];
const launchTime = Number(process.env['GEMINI_STARTUP_PROFILE_LAUNCH_TIME']);
const entrypoint = root
  ? getProcessLabel(process.argv[1], process.env['npm_execpath'], root)
  : undefined;

// NODE_OPTIONS also reaches tools and workers. Only the launch chain should
// observe performance entries or write reports; workers share their parent's PID.
if (isMainThread && directory && Number.isFinite(launchTime) && entrypoint) {
  const processStartMs = performance.timeOrigin - launchTime;
  const collector = createPhaseCollector(processStartMs);
  const isCliMain =
    entrypoint === 'cli' &&
    (process.env['GEMINI_CLI_NO_RELAUNCH'] || process.env['SANDBOX']);
  const processCollector = isCliMain
    ? instrumentStartupProcesses({ processStartMs })
    : undefined;
  const finishProcessCollection = () => {
    const startup = collector
      .snapshot()
      .find(({ name }) => name === 'cli_startup');
    if (startup) {
      processCollector?.stop(
        startup.startMs + startup.durationMs - processStartMs,
      );
    }
  };
  const target = join(directory, `process-${process.pid}.json`);
  let scheduled;
  let disabled = false;

  const snapshot = (helperDurationMs) => {
    if (disabled) return;
    const record = {
      schemaVersion: 1,
      pid: process.pid,
      ppid: process.ppid,
      entrypoint,
      processStartMs: milliseconds(processStartMs),
      phases: collector.snapshot(),
    };
    if (processCollector) record.startupProcesses = processCollector.snapshot();
    if (SHORT_LIVED_HELPERS.has(entrypoint) && helperDurationMs !== undefined) {
      record.helperDurationMs = milliseconds(helperDurationMs);
    }
    try {
      writeFileSync(`${target}.tmp`, JSON.stringify(record, null, 2) + '\n', {
        mode: 0o600,
      });
      renameSync(`${target}.tmp`, target);
    } catch {
      // Reporting must never prevent startup or change the CLI's exit status.
      disabled = true;
    }
  };

  // Helpers do not emit StartupProfiler marks. Avoid observers in npm, shell
  // wrappers, probes, and the CLI supervisor before heavy imports reach main.
  const observer = isCliMain
    ? new PerformanceObserver((list) => {
        if (!collector.collect(list.getEntries())) return;
        finishProcessCollection();
        clearTimeout(scheduled);
        scheduled = undefined;
        // Keep report I/O outside measured initialization phases. Completed
        // phases remain buffered and are also written if initialization fails.
        if (
          collector.hasCompletedCliStartup() &&
          !collector.hasPendingPhases()
        ) {
          scheduled = setTimeout(() => {
            scheduled = undefined;
            snapshot();
          }, 100);
          scheduled.unref();
        }
      })
    : undefined;
  observer?.observe({ entryTypes: ['mark', 'measure'] });
  process.on('exit', () => {
    // Capture short-lived helper work before writing its report. There is no
    // lifetime metric for the long-running npm, launcher, or CLI processes.
    const helperDurationMs = SHORT_LIVED_HELPERS.has(entrypoint)
      ? performance.now()
      : undefined;
    clearTimeout(scheduled);
    if (observer) {
      collector.collect(observer.takeRecords());
      observer.disconnect();
    }
    finishProcessCollection();
    processCollector?.stop();
    snapshot(helperDurationMs);
  });
}
