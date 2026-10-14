/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The preload is self-contained so measured processes load one checkout module.
export {
  STARTUP_PHASES,
  createPhaseCollector,
  getProcessLabel,
  milliseconds,
  summarizeProfiles,
} from './startup-profile-preload.js';
