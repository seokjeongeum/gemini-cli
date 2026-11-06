/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import {
  BUILD_ENTRYPOINTS,
  BUILD_PACKAGES,
  BUILD_PHASES,
  milliseconds,
} from './build-profile-preload.js';

// Build scripts use synchronous commands. Preserve their exact return values
// and thrown errors, including when optional Performance APIs are unavailable.
export function profileBuildPhase(name, operation) {
  if (!process.env['GEMINI_BUILD_PROFILE_RUN_DIR'] || !BUILD_PHASES.has(name)) {
    return operation();
  }
  let start;
  try {
    start = performance.mark(`build:${name}:start`).startTime;
  } catch {
    // Profiling must fail open.
  }
  let status = 'failed';
  try {
    const result = operation();
    status = 'ok';
    return result;
  } finally {
    if (start !== undefined) {
      try {
        performance.measure(`build:${name}:${status}`, { start });
        performance.clearMarks(`build:${name}:start`);
      } catch {
        // Reporting must never hide the original build failure.
      }
    }
  }
}

export function summarizeBuildProfiles(
  profiles,
  { elapsedMs, exitCode, env = process.env },
) {
  const validProfiles = profiles
    .filter(
      (record) =>
        record?.schemaVersion === 1 &&
        Number.isInteger(record.pid) &&
        Number.isInteger(record.ppid) &&
        BUILD_ENTRYPOINTS.has(record.entrypoint) &&
        Number.isFinite(record.processStartMs),
    )
    .map((record) => {
      const result = {
        pid: record.pid,
        ppid: record.ppid,
        entrypoint: record.entrypoint,
        processStartMs: record.processStartMs,
        completed: record.completed === true,
        phases: (Array.isArray(record.phases) ? record.phases : [])
          .filter(
            (phase) =>
              BUILD_PHASES.has(phase?.name) &&
              Number.isFinite(phase.startMs) &&
              Number.isFinite(phase.durationMs) &&
              phase.durationMs >= 0 &&
              ['ok', 'failed'].includes(phase.status),
          )
          .slice(0, 64)
          .map(({ name, startMs, durationMs, status }) => ({
            name,
            startMs,
            durationMs,
            status,
          })),
      };
      if (BUILD_PACKAGES.has(record.package)) result.package = record.package;
      if (result.completed && Number.isInteger(record.exitCode)) {
        result.exitCode = record.exitCode;
      }
      if (
        result.completed &&
        Number.isFinite(record.nodeBootToExitMs) &&
        record.nodeBootToExitMs >= 0
      ) {
        result.nodeBootToExitMs = record.nodeBootToExitMs;
      }
      return result;
    })
    .sort((a, b) => a.processStartMs - b.processStartMs);
  const processes = validProfiles.slice(0, 256);
  return {
    schemaVersion: 1,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    buildMode: env['CI'] ? 'ci-sequential' : 'local-parallel',
    sandboxRequested: ['1', 'true'].includes(env['BUILD_SANDBOX']),
    elapsedMs: milliseconds(elapsedMs),
    exitCode,
    omittedProcessCount: Math.max(0, validProfiles.length - processes.length),
    processes,
  };
}
