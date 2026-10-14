/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { fork, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir, release } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const callbackRealpath = promisify(fs.realpath);
const nativeRealpath = promisify(fs.realpath.native);
const methods = {
  promises_realpath: (target) => fs.promises.realpath(target),
  callback_realpath: (target) => callbackRealpath(target),
  native_callback_realpath: (target) => nativeRealpath(target),
  sync_realpath: (target) => fs.realpathSync(target),
  native_sync_realpath: (target) => fs.realpathSync.native(target),
  promises_stat: (target) => fs.promises.stat(target, { bigint: true }),
};

export function diagnosticCases(samples) {
  const cases = Object.keys(methods).flatMap((method) => [
    { target: 'workspace', method },
    { target: 'home', method },
  ]);
  return Array.from({ length: samples }, (_, sample) =>
    (sample % 2 === 0 ? cases : [...cases].reverse()).map((probe) => ({
      ...probe,
      sample: sample + 1,
    })),
  ).flat();
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z_0-9]+$/.test(error.code)
    ? error.code
    : 'UNKNOWN';
}

function milliseconds(start) {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

async function pathWorker() {
  const { workspace, samples } = JSON.parse(process.argv[3]);
  const targets = { workspace, home: homedir() };
  const firstPaths = new Map();
  for (const probe of diagnosticCases(samples)) {
    process.send({ type: 'begin', probe });
    const start = performance.now();
    try {
      const result = await methods[probe.method](targets[probe.target]);
      const record = { ...probe, elapsedMs: milliseconds(start), status: 'ok' };
      if (typeof result === 'string') {
        const first = firstPaths.get(probe.target);
        if (!first) {
          firstPaths.set(probe.target, { method: probe.method, path: result });
        }
        // Compare text only. Different casing or 8.3 aliases can identify the
        // same directory; this diagnostic makes no trust/security decision.
        record.sameTextAsFirstRealpath = !first || first.path === result;
        record.firstRealpathMethod = first?.method ?? probe.method;
      } else {
        record.isDirectory = result.isDirectory();
      }
      process.send({ type: 'result', record });
    } catch (error) {
      process.send({
        type: 'result',
        record: {
          ...probe,
          elapsedMs: milliseconds(start),
          status: 'error',
          errorCode: errorCode(error),
        },
      });
    }
  }
  process.disconnect();
}

// Match the CLI's safe Git configuration without importing its module graph.
// Keep discovery variables such as GIT_DIR/GIT_WORK_TREE, as the CLI does.
function gitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_CONFIG_'),
    ),
  );
  const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const settings = [
    ['credential.helper', ''],
    ['core.fsmonitor', ''],
    ['core.hooksPath', ''],
    ['core.sshCommand', ''],
    ['core.pager', 'cat'],
    ['core.editor', ''],
    ['sequence.editor', ''],
  ];
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: nullPath,
    GIT_CONFIG_SYSTEM: nullPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: String(settings.length),
  });
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function processProbe(command, args, options, timeoutMs) {
  return new Promise((resolveResult) => {
    const start = performance.now();
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    let failure;
    child.stdout.on('data', (chunk) => {
      // Only git --version is retained in the report. Never retain a Git root.
      if (args[0] === '--version' && output.length < 256) output += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      failure = errorCode(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        elapsedMs: milliseconds(start),
        status: timedOut ? 'timeout' : failure || code !== 0 ? 'error' : 'ok',
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(failure ? { errorCode: failure } : {}),
        ...(args[0] === '--version' &&
        /^git version [\w. ()-]+\s*$/.test(output)
          ? { version: output.trim() }
          : {}),
      });
    });
  });
}

async function pathProbes(options, timeoutMs, progress) {
  return new Promise((resolveResult) => {
    const child = fork(script, ['--path-worker', JSON.stringify(options)], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    const records = [];
    let active;
    let started;
    let operationTimer;
    let reason;
    const stop = (value) => {
      reason = value;
      child.kill('SIGKILL');
    };
    const totalTimer = setTimeout(() => stop('total_timeout'), timeoutMs);
    child.on('message', (message) => {
      if (message.type === 'begin') {
        active = message.probe;
        started = performance.now();
        progress(active);
        operationTimer = setTimeout(
          () => stop('operation_timeout'),
          options.operationTimeoutMs,
        );
      } else if (message.type === 'result') {
        clearTimeout(operationTimer);
        records.push(message.record);
        active = undefined;
      }
    });
    child.once('error', (error) => {
      reason = errorCode(error);
    });
    child.once('close', (code) => {
      clearTimeout(totalTimer);
      clearTimeout(operationTimer);
      if (active) {
        records.push({
          ...active,
          elapsedMs: milliseconds(started),
          status: reason?.endsWith('timeout') ? 'timeout' : 'error',
        });
      }
      resolveResult({
        complete:
          !reason &&
          code === 0 &&
          records.length === diagnosticCases(options.samples).length,
        ...(reason ? { stoppedBecause: reason } : {}),
        records,
      });
    });
  });
}

export async function diagnose({
  workspace = process.cwd(),
  samples = 2,
  operationTimeoutMs = 60_000,
  totalTimeoutMs = 300_000,
  output = process.stderr,
} = {}) {
  const start = performance.now();
  const remaining = () => Math.max(0, totalTimeoutMs - milliseconds(start));
  const report = {
    schemaVersion: 1,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    osVersion: release(),
    samplesRequested: samples,
    operationTimeoutMs,
    totalTimeoutMs,
    processMeasurements: [],
  };
  const cwd = resolve(workspace);
  const env = gitEnvironment();
  // Reverse Node/Git order on alternating rounds to expose warm-order effects.
  for (let sample = 1; sample <= samples && remaining() > 0; sample++) {
    const probes = [
      { method: 'node_empty', command: process.execPath, args: ['-e', ''] },
      {
        method: 'git_worktree_root',
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        env,
      },
    ];
    for (const probe of sample % 2 ? probes : probes.reverse()) {
      if (remaining() <= 0) break;
      output.write(`Measuring ${probe.method}, sample ${sample}.\n`);
      const result = await processProbe(
        probe.command,
        probe.args,
        { cwd, ...(probe.env ? { env: probe.env } : {}) },
        Math.min(operationTimeoutMs, remaining()),
      );
      report.processMeasurements.push({
        sample,
        method: probe.method,
        ...result,
      });
    }
  }
  if (remaining() > 0) {
    const version = await processProbe(
      'git',
      ['--version'],
      { cwd, env },
      Math.min(operationTimeoutMs, remaining()),
    );
    if (version.version) report.gitVersion = version.version;
  }
  report.paths =
    remaining() > 0
      ? await pathProbes(
          { workspace: cwd, samples, operationTimeoutMs },
          remaining(),
          ({ method, target, sample }) =>
            output.write(
              `Measuring ${method} for ${target}, sample ${sample}.\n`,
            ),
        )
      : { complete: false, stoppedBecause: 'total_timeout', records: [] };
  report.elapsedMs = milliseconds(start);
  report.complete =
    report.paths.complete && report.processMeasurements.length === samples * 2;
  return report;
}

export function parseDiagnosticArgs(args) {
  const names = new Set([
    '--workspace',
    '--samples',
    '--operation-timeout-ms',
    '--total-timeout-ms',
  ]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (
      !names.has(args[index]) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    ) {
      throw new Error('Invalid diagnostic arguments.');
    }
    values[args[index]] = args[index + 1];
  }
  const number = (name, fallback, maximum) => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error('Invalid diagnostic arguments.');
    }
    return value;
  };
  return {
    workspace: values['--workspace'],
    samples: number('--samples', 2, 5),
    operationTimeoutMs: number('--operation-timeout-ms', 60_000, 600_000),
    totalTimeoutMs: number('--total-timeout-ms', 300_000, 1_800_000),
  };
}

if (process.argv[2] === '--path-worker') {
  await pathWorker();
} else if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const report = await diagnose(parseDiagnosticArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch {
    process.stderr.write(
      'Diagnostic failed. Options: --workspace PATH --samples 1..5 ' +
        '--operation-timeout-ms 1..600000 --total-timeout-ms 1..1800000.\n',
    );
    process.exitCode = 1;
  }
}
