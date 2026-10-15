/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClearcutLogger, EventNames, TEST_ONLY } from './clearcut-logger.js';
import { EventMetadataKey } from './event-metadata-key.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { StartSessionEvent } from '../types.js';

const gpuProbe = vi.hoisted(() => ({
  run: vi.fn(),
  systemInformationLoaded: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: gpuProbe.run });
  return { ...actual, execFile };
});
vi.mock('systeminformation', () => {
  gpuProbe.systemInformationLoaded();
  return { default: { graphics: vi.fn() } };
});
vi.mock('../../utils/userAccountManager.js');
vi.mock('../../utils/installationManager.js');
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => 'win32' };
});

beforeEach(() => {
  gpuProbe.run.mockReset();
});

afterEach(() => {
  ClearcutLogger.clearInstance();
  TEST_ONLY.resetCachedGpuInfoForTesting();
  vi.restoreAllMocks();
});

async function loggedGpuInfo(): Promise<string | undefined> {
  const config = makeFakeConfig({ usageStatisticsEnabled: true });
  const logger = ClearcutLogger.getInstance(config)!;
  vi.spyOn(logger, 'flushToClearcut').mockResolvedValue({});
  await logger.logStartSessionEvent(new StartSessionEvent(config));
  await logger.logStartSessionEvent(new StartSessionEvent(config));
  expect(gpuProbe.run).toHaveBeenCalledOnce();
  expect(gpuProbe.systemInformationLoaded).not.toHaveBeenCalled();
  return logger
    .createLogEvent(EventNames.API_ERROR, [])
    .event_metadata[0].find(
      ({ gemini_cli_key }) =>
        gemini_cli_key === EventMetadataKey.GEMINI_CLI_GPU_INFO,
    )?.value;
}

it.each([
  { output: '[]', expected: 'NA' },
  { output: '"Single GPU"', expected: 'Single GPU' },
  { output: '["GPU 1", "GPU 2"]', expected: 'GPU 1, GPU 2' },
  { output: '["그래픽 GPU"]\r\n', expected: '그래픽 GPU' },
])(
  'logs Windows controller names from $output',
  async ({ output, expected }) => {
    gpuProbe.run.mockResolvedValue({ stdout: output });

    expect(await loggedGpuInfo()).toBe(expected);
  },
);

it('uses one bounded direct PowerShell controller-name query', async () => {
  gpuProbe.run.mockResolvedValue({ stdout: '["GPU"]' });

  await loggedGpuInfo();

  expect(gpuProbe.run).toHaveBeenCalledWith(
    expect.stringMatching(/\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference = 'Stop'; " +
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ' +
        'ConvertTo-Json -Compress -InputObject @(' +
        'Get-CimInstance -ClassName Win32_VideoController -Property Name | ' +
        'Select-Object -ExpandProperty Name)',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
});

it.each(['not JSON', '[12]'])(
  'logs FAILED for invalid output %s',
  async (stdout) => {
    gpuProbe.run.mockResolvedValue({ stdout });

    expect(await loggedGpuInfo()).toBe('FAILED');
  },
);

it('logs FAILED if the Windows query fails or times out', async () => {
  gpuProbe.run.mockRejectedValue(new Error('Query timed out'));

  expect(await loggedGpuInfo()).toBe('FAILED');
});
