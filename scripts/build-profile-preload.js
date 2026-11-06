/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

// Keep this preload self-contained: each measured process loads one checkout
// module, and a sandbox without that file can ignore the short optional loader.
export const BUILD_PHASES = new Set([
  'install_dependencies',
  'generate_metadata',
  'build_core',
  'query_workspaces',
  'build_parallel_workspaces',
  'build_all_workspaces',
  'probe_sandbox',
  'build_sandbox',
  'compile_typescript',
  'bundle_browser_mcp',
  'copy_assets',
  'copy_docs',
  'write_build_stamp',
]);

export const BUILD_ENTRYPOINTS = new Set([
  'npm',
  'other-node',
  'build',
  'package-build',
  'generate-metadata',
  'typescript',
  'parallel-workspaces',
  'copy-assets',
  'bundle-browser-mcp',
  'devtools-client',
  'vscode-build',
  'probe-sandbox',
  'build-sandbox',
]);

export const BUILD_PACKAGES = new Set([
  'core',
  'cli',
  'a2a-server',
  'sdk',
  'test-utils',
  'devtools',
  'vscode-ide-companion',
]);

export const milliseconds = (value) => Math.round(value * 1000) / 1000;
const PHASE_LIMIT = 64;

export function getBuildProcessLabel(entry, npmPath, root) {
  if (!root) return undefined;
  if (!entry) return 'other-node';
  const normalize = (value) => {
    const absolute = resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const actual = normalize(entry);
  if (
    npmPath &&
    [npmPath, join(dirname(npmPath), 'npx-cli.js')].some(
      (file) => actual === normalize(file),
    )
  ) {
    return 'npm';
  }
  const entries = [
    ['scripts/build.js', 'build'],
    ['scripts/build_package.js', 'package-build'],
    ['scripts/generate-git-commit-info.js', 'generate-metadata'],
    ['scripts/copy_files.js', 'copy-assets'],
    ['scripts/sandbox_command.js', 'probe-sandbox'],
    ['scripts/build_sandbox.js', 'build-sandbox'],
    ['packages/core/scripts/bundle-browser-mcp.mjs', 'bundle-browser-mcp'],
    ['packages/devtools/esbuild.client.js', 'devtools-client'],
    ['packages/vscode-ide-companion/esbuild.js', 'vscode-build'],
    ['node_modules/typescript/bin/tsc', 'typescript'],
    ['node_modules/typescript/lib/tsc.js', 'typescript'],
    ['node_modules/typescript/lib/_tsc.js', 'typescript'],
    ['node_modules/.bin/tsc', 'typescript'],
    [
      'node_modules/npm-run-all/bin/npm-run-all/index.js',
      'parallel-workspaces',
    ],
    ['node_modules/.bin/npm-run-all', 'parallel-workspaces'],
  ];
  return (
    entries.find(([file]) => actual === normalize(join(root, file)))?.[1] ||
    'other-node'
  );
}

export function getBuildPackageLabel(cwd, root) {
  if (!cwd || !root) return undefined;
  const normalize = (value) => {
    const absolute = resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const actual = normalize(cwd);
  return [...BUILD_PACKAGES].find(
    (name) => actual === normalize(join(root, 'packages', name)),
  );
}

export function createBuildPhaseCollector(processStartMs) {
  const starts = new Map();
  const phases = [];
  return {
    collect(entries) {
      // Observer batches can list a measure before its start mark. Correlate
      // all marks first without trusting arbitrary measure names or details.
      for (const entry of entries) {
        if (!Number.isFinite(entry.startTime)) continue;
        if (entry.entryType === 'mark') {
          const match = /^build:([a-z_]+):start$/.exec(entry.name);
          if (
            match &&
            BUILD_PHASES.has(match[1]) &&
            starts.size < PHASE_LIMIT
          ) {
            starts.set(`${match[1]}:${entry.startTime}`, entry.startTime);
          }
        }
      }
      for (const entry of entries) {
        if (!Number.isFinite(entry.startTime)) continue;
        const match = /^build:([a-z_]+):(ok|failed)$/.exec(entry.name);
        if (
          entry.entryType !== 'measure' ||
          !match ||
          !BUILD_PHASES.has(match[1]) ||
          phases.length >= PHASE_LIMIT ||
          !Number.isFinite(entry.duration) ||
          entry.duration < 0
        ) {
          continue;
        }
        const key = `${match[1]}:${entry.startTime}`;
        if (!starts.has(key)) continue;
        starts.delete(key);
        phases.push({
          name: match[1],
          startMs: milliseconds(processStartMs + entry.startTime),
          durationMs: milliseconds(entry.duration),
          status: match[2],
        });
      }
    },
    snapshot: () => phases.map((phase) => ({ ...phase })),
  };
}

try {
  const root = process.env['GEMINI_BUILD_PROFILE_ROOT'];
  const directory = process.env['GEMINI_BUILD_PROFILE_RUN_DIR'];
  const launchTime = Number(process.env['GEMINI_BUILD_PROFILE_LAUNCH_TIME']);
  const entrypoint = getBuildProcessLabel(
    process.argv[1],
    process.env['npm_execpath'],
    root,
  );

  if (isMainThread && directory && Number.isFinite(launchTime) && entrypoint) {
    const processStartMs = performance.timeOrigin - launchTime;
    const packageLabel = getBuildPackageLabel(process.cwd(), root);
    const collector = createBuildPhaseCollector(processStartMs);
    const observer = new PerformanceObserver((list) => {
      try {
        collector.collect(list.getEntries());
      } catch {
        // Reports remain optional if host instrumentation changes the observer.
      }
    });
    observer.observe({ entryTypes: ['mark', 'measure'] });
    const target = join(directory, `process-${process.pid}.json`);
    let disabled = false;
    const snapshot = (exitCode) => {
      if (disabled) return;
      try {
        collector.collect(observer.takeRecords());
      } catch {
        // Observer failures must not replace the build's exit status.
      }
      const record = {
        schemaVersion: 1,
        pid: process.pid,
        ppid: process.ppid,
        entrypoint,
        processStartMs: milliseconds(processStartMs),
        completed: exitCode !== undefined,
        phases: collector.snapshot(),
      };
      if (packageLabel) record.package = packageLabel;
      if (exitCode !== undefined) {
        record.exitCode = exitCode;
        record.nodeBootToExitMs = milliseconds(performance.now());
      }
      try {
        writeFileSync(`${target}.tmp`, JSON.stringify(record, null, 2) + '\n', {
          mode: 0o600,
        });
        renameSync(`${target}.tmp`, target);
      } catch {
        // Reports are optional. Keep all build behavior and errors unchanged.
        disabled = true;
      }
    };
    snapshot();
    process.once('exit', (code) => {
      snapshot(code);
      try {
        observer.disconnect();
      } catch {
        // A host can protect observer methods after profiling starts.
      }
    });
  }
} catch {
  // A protected builtin or unavailable cwd must not make the preload fatal.
}
