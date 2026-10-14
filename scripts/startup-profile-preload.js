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
  const isCliMain =
    entrypoint === 'cli' &&
    (process.env['GEMINI_CLI_NO_RELAUNCH'] || process.env['SANDBOX']);
  const observer = isCliMain
    ? new PerformanceObserver((list) => {
        if (!collector.collect(list.getEntries())) return;
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
    snapshot(helperDurationMs);
  });
}
