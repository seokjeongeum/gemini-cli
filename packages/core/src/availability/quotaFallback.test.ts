/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { DEFAULT_MODEL_CONFIGS } from '../config/defaultModelConfigs.js';
import {
  BASE_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  LEGACY_CCPA_FLASH_MODEL,
  PREVIEW_GEMINI_3_1_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
} from '../config/models.js';
import { ModelConfigService } from '../services/modelConfigService.js';
import { ModelAvailabilityService } from './modelAvailabilityService.js';
import {
  markQuotaExhausted,
  selectQuotaFallbackModel,
} from './quotaFallback.js';
import {
  applyModelSelection,
  selectModelForAvailability,
} from './policyHelpers.js';
import type { BucketInfo } from '../code_assist/types.js';
import { AuthType } from '../core/contentGenerator.js';

const ARGON = 'gemini-4-argon';

function fixture(
  selected: string,
  buckets: BucketInfo[] = [],
  overrides: Partial<Config> = {},
) {
  const availability = new ModelAvailabilityService();
  let active = selected;
  const config = {
    getModel: () => DEFAULT_GEMINI_MODEL_AUTO,
    getActiveModel: () => active,
    setActiveModel: vi.fn((model: string) => {
      active = model;
    }),
    getModelAvailabilityService: () => availability,
    getUserTier: () => undefined,
    getContentGeneratorConfig: () => ({ authType: 'oauth-personal' }),
    getHasAccessToPreviewModel: () => false,
    getGemini31LaunchedSync: () => false,
    getUseCustomToolModelSync: () => false,
    hasLatestFlashGAAccess: () => false,
    hasLatestFlashLiteGAAccess: () => false,
    getProModelNoAccessSync: () => false,
    getLastRetrievedQuota: () => ({ buckets }),
    modelConfigService: new ModelConfigService(DEFAULT_MODEL_CONFIGS),
    ...overrides,
  } as unknown as Config;
  return { config, availability };
}

describe('hard quota model selection', () => {
  it.each(['auto', 'auto-gemini-2.5', 'auto-gemini-3'])(
    'keeps quota fallback enabled for the %s selection',
    (selection) => {
      const { config } = fixture(BASE_GEMINI_FLASH_MODEL, [], {
        getModel: () => selection,
      });
      markQuotaExhausted(config, BASE_GEMINI_FLASH_MODEL);

      expect(
        selectQuotaFallbackModel(config, BASE_GEMINI_FLASH_MODEL)
          ?.selectedModel,
      ).toBe(DEFAULT_GEMINI_MODEL);
      expect(config.getModel()).toBe(selection);
    },
  );

  it.each([
    'gemini-3-pro-preview',
    BASE_GEMINI_FLASH_MODEL,
    ARGON,
    'flash',
    'pro',
  ])(
    'keeps manually selected %s even when other models have quota',
    (model) => {
      const { config } = fixture(
        model,
        [
          { modelId: model, remainingFraction: 0 },
          { modelId: ARGON, remainingFraction: 0.5 },
        ],
        { getModel: () => model },
      );
      markQuotaExhausted(config, model);

      expect(selectQuotaFallbackModel(config, model)).toBeUndefined();
      expect(selectModelForAvailability(config, model).selectedModel).toBe(
        model,
      );
      expect(config.setActiveModel).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'routes Auto Flash to Pro with dynamic configuration=%s',
    (dynamic) => {
      const { config } = fixture(BASE_GEMINI_FLASH_MODEL, [], {
        getExperimentalDynamicModelConfiguration: () => dynamic,
      });
      markQuotaExhausted(config, BASE_GEMINI_FLASH_MODEL);

      expect(
        selectQuotaFallbackModel(config, BASE_GEMINI_FLASH_MODEL)
          ?.selectedModel,
      ).toBe(DEFAULT_GEMINI_MODEL);
      expect(config.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    },
  );

  it('routes Auto literal Argon to Flash before other Pro models', () => {
    const { config } = fixture(ARGON);
    markQuotaExhausted(config, ARGON);

    expect(selectQuotaFallbackModel(config, ARGON)?.selectedModel).toBe(
      BASE_GEMINI_FLASH_MODEL,
    );
  });

  it('uses advertised Argon after Flash and Pro exhaust their quota', () => {
    const { config } = fixture(BASE_GEMINI_FLASH_MODEL, [
      { modelId: ARGON, remainingFraction: 0.5 },
    ]);
    markQuotaExhausted(config, BASE_GEMINI_FLASH_MODEL);
    markQuotaExhausted(config, DEFAULT_GEMINI_MODEL);

    expect(
      selectQuotaFallbackModel(config, BASE_GEMINI_FLASH_MODEL)?.selectedModel,
    ).toBe(ARGON);
  });

  it('does not infer Argon entitlement from a paid tier or an unknown bucket', () => {
    const { config } = fixture(BASE_GEMINI_FLASH_MODEL, [{ modelId: ARGON }]);
    markQuotaExhausted(config, BASE_GEMINI_FLASH_MODEL);
    markQuotaExhausted(config, DEFAULT_GEMINI_MODEL);

    expect(
      selectQuotaFallbackModel(config, BASE_GEMINI_FLASH_MODEL)?.selectedModel,
    ).toBeNull();
  });

  it('skips advertised zero quota, including the legacy Code Assist Flash bucket', () => {
    const { config } = fixture(DEFAULT_GEMINI_MODEL, [
      { modelId: LEGACY_CCPA_FLASH_MODEL, remainingAmount: '0' },
      { modelId: ARGON, remainingFraction: 0.5 },
    ]);
    markQuotaExhausted(config, DEFAULT_GEMINI_MODEL);

    expect(
      selectQuotaFallbackModel(config, DEFAULT_GEMINI_MODEL)?.selectedModel,
    ).toBe(ARGON);
  });

  it('skips an initially selected zero-quota model without waiting for a request failure', () => {
    const { config } = fixture(ARGON, [
      { modelId: ARGON, remainingFraction: 0 },
    ]);

    expect(
      applyModelSelection(config, { model: ARGON, isChatModel: true }).model,
    ).toBe(BASE_GEMINI_FLASH_MODEL);
    expect(config.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
  });

  it('does not enable quota routing for a capacity failure because an unrelated bucket is empty', () => {
    const { config, availability } = fixture(
      ARGON,
      [{ modelId: DEFAULT_GEMINI_MODEL, remainingFraction: 0 }],
      { getModel: () => ARGON },
    );
    availability.markTerminal(ARGON, 'capacity');

    expect(selectModelForAvailability(config, ARGON).selectedModel).toBe(ARGON);
  });

  it.each(['auto', 'flash'])(
    'resolves the %s alias before checking failed quota health',
    (alias) => {
      const { config } = fixture(alias, [
        { modelId: ARGON, remainingFraction: 0.5 },
      ]);
      markQuotaExhausted(config, DEFAULT_GEMINI_MODEL);
      markQuotaExhausted(config, BASE_GEMINI_FLASH_MODEL);

      expect(selectModelForAvailability(config, alias).selectedModel).toBe(
        ARGON,
      );
    },
  );

  it('does not retry the same Code Assist Flash backend under another ID', () => {
    const { config, availability } = fixture(LEGACY_CCPA_FLASH_MODEL);
    markQuotaExhausted(config, LEGACY_CCPA_FLASH_MODEL);
    markQuotaExhausted(config, DEFAULT_GEMINI_MODEL);

    expect(availability.snapshot(BASE_GEMINI_FLASH_MODEL)).toEqual({
      available: false,
      reason: 'quota',
    });
    expect(
      selectQuotaFallbackModel(config, DEFAULT_GEMINI_MODEL)?.selectedModel,
    ).toBeNull();
    availability.resetTurn();
    expect(availability.snapshot(LEGACY_CCPA_FLASH_MODEL).available).toBe(
      false,
    );
  });

  it('keeps distinct API-key backend IDs separate', () => {
    const { config, availability } = fixture(BASE_GEMINI_FLASH_MODEL, [], {
      getContentGeneratorConfig: () => ({ authType: AuthType.USE_GEMINI }),
    });
    markQuotaExhausted(config, BASE_GEMINI_FLASH_MODEL);

    expect(availability.snapshot(LEGACY_CCPA_FLASH_MODEL).available).toBe(true);
  });

  it('skips a nominal fallback whose runtime override resolves back to an exhausted model', () => {
    const { config } = fixture(DEFAULT_GEMINI_MODEL);
    config.modelConfigService.registerRuntimeModelOverride({
      match: { model: BASE_GEMINI_FLASH_MODEL },
      modelConfig: { model: DEFAULT_GEMINI_MODEL },
    });
    markQuotaExhausted(config, DEFAULT_GEMINI_MODEL);

    expect(
      selectQuotaFallbackModel(config, DEFAULT_GEMINI_MODEL)?.selectedModel,
    ).toBeNull();
  });

  it('terminates when Pro is disallowed and the only Flash model is unavailable', () => {
    const { config, availability } = fixture(ARGON, [], {
      getProModelNoAccessSync: () => true,
    });
    markQuotaExhausted(config, ARGON);
    availability.markTerminal(BASE_GEMINI_FLASH_MODEL, 'capacity');

    expect(() => applyModelSelection(config, { model: ARGON })).toThrow(
      'No model with available quota',
    );
  });

  it('respects preview and Gemini 3.1 access flags when selecting the other tier', () => {
    const { config } = fixture(BASE_GEMINI_FLASH_MODEL, [], {
      getHasAccessToPreviewModel: () => true,
      getGemini31LaunchedSync: () => true,
    });
    markQuotaExhausted(config, BASE_GEMINI_FLASH_MODEL);

    expect(
      selectQuotaFallbackModel(config, BASE_GEMINI_FLASH_MODEL)?.selectedModel,
    ).toBe(PREVIEW_GEMINI_3_1_MODEL);
    markQuotaExhausted(config, PREVIEW_GEMINI_3_1_MODEL);
    expect(
      selectQuotaFallbackModel(config, PREVIEW_GEMINI_3_1_MODEL)?.selectedModel,
    ).toBe(PREVIEW_GEMINI_FLASH_MODEL);
  });

  it.each(['custom-model', 'gemini-future-pro', 'gemma-4-31b-it'])(
    'preserves explicit selection of %s',
    (model) => {
      const { config } = fixture(model, [], { getModel: () => model });
      markQuotaExhausted(config, model);

      expect(selectQuotaFallbackModel(config, model)).toBeUndefined();
      expect(selectModelForAvailability(config, model).selectedModel).toBe(
        model,
      );
    },
  );
});
