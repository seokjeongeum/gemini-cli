/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants } from 'node:os';
import { performance } from 'node:perf_hooks';
import { summarizeBuildProfiles } from './build-profile.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function getBuildPreloadOption(preloadUrl) {
  const source = `if (process.env.GEMINI_BUILD_PROFILE_RUN_DIR) await import(${JSON.stringify(preloadUrl)}).catch(() => {});`;
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

export function readBuildSummary(directory, result) {
  const profiles = readdirSync(directory)
    .filter((name) => /^process-\d+\.json$/.test(name))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(directory, name), 'utf8'))];
      } catch {
        // Interrupted children can leave incomplete snapshots.
        return [];
      }
    });
  return summarizeBuildProfiles(profiles, result);
}

export async function runBuildProfile({
  args = process.argv.slice(2),
  env = process.env,
  output = process.stderr,
} = {}) {
  if (!env['npm_execpath']) {
    output.write('Run this profiler with npm run build:profile.\n');
    return 1;
  }
  let directory;
  let launchEnv = env;
  try {
    const parent = resolve(
      env['GEMINI_BUILD_PROFILE_DIR'] || join(root, '.gemini/build-profiles'),
    );
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const prefix = new Date().toISOString().replace(/[:.]/g, '-');
    directory = mkdtempSync(join(parent, `${prefix}-`));
    const option = getBuildPreloadOption(
      new URL('./build-profile-preload.js', import.meta.url).href,
    );
    launchEnv = {
      ...env,
      NODE_OPTIONS: [env['NODE_OPTIONS'], option].filter(Boolean).join(' '),
      GEMINI_BUILD_PROFILE_ROOT: root,
      GEMINI_BUILD_PROFILE_RUN_DIR: directory,
      GEMINI_BUILD_PROFILE_LAUNCH_TIME: String(Date.now()),
    };
    output.write(`[build profile] Reports: ${directory}\n`);
  } catch {
    output.write(
      '[build profile] Cannot create reports; running npm run build.\n',
    );
  }

  // This is the wall duration of the real nested npm run build, including its
  // launch and descendants. It excludes the outer npm run build:profile launch.
  if (directory && launchEnv !== env) {
    launchEnv.GEMINI_BUILD_PROFILE_LAUNCH_TIME = String(Date.now());
  }
  const started = performance.now();
  const result = await new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      [env['npm_execpath'], 'run', 'build', '--', ...args],
      { cwd: root, env: launchEnv, stdio: 'inherit' },
    );
    // Foreground terminal signals reach the build as well. Keep the wrapper
    // alive to collect reports, without forwarding a second copy of Ctrl-C.
    const keepAlive = () => {};
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.on(signal, keepAlive);
    const cleanup = () => {
      for (const signal of signals) process.off(signal, keepAlive);
    };
    child.once('error', () => {
      cleanup();
      output.write('[build profile] Could not launch npm run build.\n');
      resolveResult(1);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolveResult(code ?? 128 + (constants.signals[signal] || 1));
    });
  });
  const elapsedMs = performance.now() - started;

  if (directory) {
    try {
      const summary = readBuildSummary(directory, {
        elapsedMs,
        exitCode: result,
        env,
      });
      writeFileSync(
        join(directory, 'summary.json'),
        JSON.stringify(summary, null, 2) + '\n',
        { mode: 0o600 },
      );
      output.write(
        `[build profile] npm run build ended after ${summary.elapsedMs} ms (exit ${result}).\n` +
          `[build profile] Summary: ${join(directory, 'summary.json')}\n`,
      );
    } catch {
      output.write('[build profile] Could not write the timing summary.\n');
    }
  }
  return result;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runBuildProfile();
}
