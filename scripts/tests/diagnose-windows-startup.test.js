/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnosticCases,
  diagnose,
  parseDiagnosticArgs,
} from '../diagnose-windows-startup.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fork: vi.fn(actual.fork) };
});

const directories = [];
const output = { write() {} };

afterEach(() => {
  vi.mocked(fork).mockClear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('startup diagnostic', () => {
  it('reverses the complete path probe order between rounds', () => {
    const cases = diagnosticCases(2);
    expect(cases).toHaveLength(24);
    expect(
      cases.slice(0, 12).map(({ target, method }) => ({ target, method })),
    ).toEqual(
      cases
        .slice(12)
        .reverse()
        .map(({ target, method }) => ({ target, method })),
    );
  });

  it('measures paths containing literal percent signs and spaces without reporting paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemini diagnostic %20 '));
    directories.push(directory);
    const target = join(directory, 'target %2F space');
    const link = join(directory, 'link %20 space');
    mkdirSync(target);
    symlinkSync(
      target,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const report = await diagnose({
      workspace: link,
      samples: 2,
      operationTimeoutMs: 10_000,
      totalTimeoutMs: 30_000,
      output,
    });

    expect(report.complete).toBe(true);
    expect(report.paths.records).toHaveLength(24);
    expect(report.paths.records.every(({ status }) => status === 'ok')).toBe(
      true,
    );
    expect(
      report.paths.records
        .filter(({ method }) => method === 'promises_stat')
        .every(({ isDirectory }) => isDirectory),
    ).toBe(true);
    expect(
      report.processMeasurements.map(({ sample, method }) => ({
        sample,
        method,
      })),
    ).toEqual([
      { sample: 1, method: 'node_empty' },
      { sample: 1, method: 'git_worktree_root' },
      { sample: 2, method: 'git_worktree_root' },
      { sample: 2, method: 'node_empty' },
    ]);
    expect(JSON.stringify(report)).not.toContain(directory);
    expect(JSON.stringify(report)).not.toContain('fatal:');
    for (const record of [
      ...report.paths.records,
      ...report.processMeasurements,
    ]) {
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    for (const record of report.processMeasurements) {
      expect(record.spawnCallMs).toBeGreaterThanOrEqual(0);
      expect(record.spawnCallMs).toBeLessThanOrEqual(record.elapsedMs);
    }
  }, 30_000);

  it('returns a partial report when the total budget expires', async () => {
    const report = await diagnose({
      samples: 2,
      operationTimeoutMs: 1,
      totalTimeoutMs: 1,
      output,
    });

    expect(report.complete).toBe(false);
    expect(report.paths.stoppedBecause).toBe('total_timeout');
    expect(report.paths.records).toEqual([]);
    expect(
      report.processMeasurements.every(({ status }) => status === 'timeout'),
    ).toBe(true);
  });

  it('keeps completed records when a later path probe times out', async () => {
    vi.mocked(fork).mockImplementationOnce(() => {
      const child = new EventEmitter();
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      });
      queueMicrotask(() => {
        const probe = {
          target: 'workspace',
          method: 'promises_realpath',
          sample: 1,
        };
        child.emit('message', { type: 'begin', probe });
        child.emit('message', {
          type: 'result',
          record: { ...probe, elapsedMs: 1, status: 'ok' },
        });
        child.emit('message', {
          type: 'begin',
          probe: { ...probe, target: 'home' },
        });
      });
      return child;
    });
    const report = await diagnose({
      samples: 1,
      operationTimeoutMs: 10,
      output,
    });

    expect(report.complete).toBe(false);
    expect(report.paths.stoppedBecause).toBe('operation_timeout');
    expect(report.paths.records).toMatchObject([
      { target: 'workspace', status: 'ok' },
      { target: 'home', status: 'timeout' },
    ]);
  });

  it('records nonexistent-workspace failures without leaking error text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemini missing diagnostic '));
    directories.push(directory);
    const workspace = join(directory, 'missing %20 path');
    const report = await diagnose({ workspace, samples: 1, output });

    expect(report.complete).toBe(true);
    expect(
      report.processMeasurements.every(
        ({ errorCode }) => errorCode === 'ENOENT',
      ),
    ).toBe(true);
    const records = report.paths.records.filter(
      ({ target }) => target === 'workspace',
    );
    expect(records).toHaveLength(6);
    expect(
      records.every(
        ({ status, errorCode }) => status === 'error' && errorCode === 'ENOENT',
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(directory);
    expect(JSON.stringify(report)).not.toContain(workspace);
  });

  it('accepts only explicit, paired options with bounded integer values', () => {
    expect(
      parseDiagnosticArgs([
        '--workspace',
        'C:\\literal %20 path',
        '--samples',
        '3',
      ]),
    ).toMatchObject({ workspace: 'C:\\literal %20 path', samples: 3 });
    for (const args of [
      ['--unknown', 'secret path'],
      ['--samples'],
      ['--samples', '--workspace', 'path'],
      ['--samples', '0'],
      ['--samples', '1.5'],
      ['--samples', '6'],
      ['--total-timeout-ms', '1800001'],
      ['--operation-timeout-ms', '600001'],
    ]) {
      expect(() => parseDiagnosticArgs(args)).toThrow(
        'Invalid diagnostic arguments.',
      );
    }
  });
});
