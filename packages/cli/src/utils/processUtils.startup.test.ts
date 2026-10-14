/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';

vi.mock('./cleanup.js', () => {
  throw new Error('Supervisor startup must not load application cleanup.');
});

vi.mock('./handleAutoUpdate.js', () => {
  throw new Error('Supervisor startup must not load application updates.');
});

it('loads supervisor utilities without application dependencies', async () => {
  const { getScriptArgs, getSpawnConfig, RELAUNCH_EXIT_CODE } = await import(
    './processUtils.js'
  );

  expect(getScriptArgs()).toEqual(process.argv.slice(2));
  expect(getSpawnConfig([], []).env['GEMINI_CLI_NO_RELAUNCH']).toBe('true');
  expect(RELAUNCH_EXIT_CODE).toBe(199);
});
