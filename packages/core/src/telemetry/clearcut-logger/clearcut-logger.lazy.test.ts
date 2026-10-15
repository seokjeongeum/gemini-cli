/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { ClearcutLogger, EventNames, TEST_ONLY } from './clearcut-logger.js';
import { EventMetadataKey } from './event-metadata-key.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { StartSessionEvent } from '../types.js';

const systemInformation = vi.hoisted(() => ({
  loaded: vi.fn(),
  graphics: vi.fn().mockResolvedValue({
    controllers: [{ model: 'Deferred GPU' }],
  }),
}));

vi.mock('systeminformation', () => {
  systemInformation.loaded();
  return { default: { graphics: systemInformation.graphics } };
});
vi.mock('../../utils/userAccountManager.js');
vi.mock('../../utils/installationManager.js');
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => 'linux' };
});

afterEach(() => {
  ClearcutLogger.clearInstance();
  TEST_ONLY.resetCachedGpuInfoForTesting();
  vi.restoreAllMocks();
});

it('loads system information only when collecting session device metadata', async () => {
  expect(systemInformation.loaded).not.toHaveBeenCalled();
  expect(
    ClearcutLogger.getInstance(
      makeFakeConfig({ usageStatisticsEnabled: false }),
    ),
  ).toBeUndefined();

  const config = makeFakeConfig({ usageStatisticsEnabled: true });
  const logger = ClearcutLogger.getInstance(config)!;
  vi.spyOn(logger, 'flushToClearcut').mockResolvedValue({});
  logger.createLogEvent(EventNames.API_ERROR, []);
  expect(systemInformation.loaded).not.toHaveBeenCalled();
  expect(systemInformation.graphics).not.toHaveBeenCalled();

  await logger.logStartSessionEvent(new StartSessionEvent(config));
  await logger.logStartSessionEvent(new StartSessionEvent(config));

  expect(systemInformation.loaded).toHaveBeenCalledOnce();
  expect(systemInformation.graphics).toHaveBeenCalledOnce();
  expect(
    logger.createLogEvent(EventNames.API_ERROR, []).event_metadata[0],
  ).toContainEqual({
    gemini_cli_key: EventMetadataKey.GEMINI_CLI_GPU_INFO,
    value: 'Deferred GPU',
  });
});
