/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type GenerateContentResponse } from '@google/genai';
import { BaseLlmClient } from './baseLlmClient.js';
import type { ContentGenerator } from './contentGenerator.js';
import { ModelMappingContentGenerator } from './modelMappingContentGenerator.js';
import { Config } from '../config/config.js';
import { DEFAULT_MODEL_CONFIGS } from '../config/defaultModelConfigs.js';
import {
  BASE_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  LEGACY_CCPA_FLASH_MODEL,
  getBackendModelMappings,
} from '../config/models.js';
import { ModelAvailabilityService } from '../availability/modelAvailabilityService.js';
import { ModelConfigService } from '../services/modelConfigService.js';
import { UserTierId } from '../code_assist/types.js';
import { LlmRole } from '../telemetry/types.js';
import { coreEvents } from '../utils/events.js';
import { TerminalQuotaError } from '../utils/googleQuotaErrors.js';
import { ApprovalMode } from '../policy/types.js';

// Keep the actual retry, fallback, model configuration, and backend mapping paths.
// Only the provider transport and telemetry/error reporting are mocked.
vi.mock('../telemetry/loggers.js');
vi.mock('../utils/errorReporting.js');

const ARGON_MODEL = 'gemini-4-argon';
const PROJECT_ID = 'quota-routing-test-project';
const successResponse = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'Recovered' }] } }],
} as GenerateContentResponse;

function createClientFixture(
  selectedModel: string,
  interactive: boolean,
  configuredModel = DEFAULT_GEMINI_MODEL_AUTO,
) {
  let activeModel = selectedModel;
  const availability = new ModelAvailabilityService();
  const providerConfig = Object.freeze({
    authType: 'oauth-personal',
    project: PROJECT_ID,
  });
  const generateContent = vi.fn<ContentGenerator['generateContent']>();
  const transport: ContentGenerator = {
    generateContent,
    generateContentStream: vi.fn(),
    countTokens: vi.fn(),
    embedContent: vi.fn(),
    userTier: UserTierId.STANDARD,
  };
  const generator = new ModelMappingContentGenerator(transport, () =>
    getBackendModelMappings(),
  );
  const configFixture = {
    modelConfigService: new ModelConfigService(DEFAULT_MODEL_CONFIGS),
    getModel: vi.fn(() => configuredModel),
    getActiveModel: vi.fn(() => activeModel),
    setActiveModel: vi.fn((model: string) => {
      activeModel = model;
    }),
    setModel: vi.fn(),
    activateFallbackMode: vi.fn(),
    refreshAuth: vi.fn(),
    rotateSessionId: vi.fn(),
    getContentGenerator: vi.fn(() => generator),
    getContentGeneratorConfig: vi.fn(() => providerConfig),
    getModelAvailabilityService: vi.fn(() => availability),
    getFallbackModelHandler: vi.fn(),
    getUserTier: vi.fn(() => UserTierId.STANDARD),
    getRetryFetchErrors: vi.fn(() => false),
    getApprovalMode: vi.fn(() => ApprovalMode.DEFAULT),
    getHasAccessToPreviewModel: vi.fn(() => false),
    getExperimentalDynamicModelConfiguration: vi.fn(() => false),
    hasLatestFlashGAAccess: vi.fn(() => false),
    hasLatestFlashLiteGAAccess: vi.fn(() => false),
    getLastRetrievedQuota: vi.fn(() => ({
      buckets: [
        { modelId: selectedModel, remainingFraction: 0.5 },
        { modelId: BASE_GEMINI_FLASH_MODEL, remainingFraction: 0.5 },
        { modelId: DEFAULT_GEMINI_MODEL, remainingFraction: 0.5 },
      ],
    })),
    isInteractive: vi.fn(() => interactive),
  };
  const client = new BaseLlmClient(
    generator,
    configFixture as unknown as Config,
  );
  return {
    client,
    availability,
    configFixture,
    generateContent,
    providerConfig,
  };
}

function quotaExhaustedError() {
  return new ApiError({
    status: 429,
    message: JSON.stringify({
      error: {
        code: 429,
        message: 'The selected model has exhausted its quota.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'QUOTA_EXHAUSTED',
            domain: 'cloudcode-pa.googleapis.com',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '3600s',
          },
        ],
      },
    }),
  });
}

describe('BaseLlmClient terminal quota routing through the provider transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', PROJECT_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'stops manual hard quota without switching with interactive=%s',
    async (interactive) => {
      for (const model of [
        ARGON_MODEL,
        DEFAULT_GEMINI_MODEL,
        BASE_GEMINI_FLASH_MODEL,
        'gemini-3-pro-preview',
        DEFAULT_GEMINI_FLASH_LITE_MODEL,
      ]) {
        const { client, configFixture, generateContent, providerConfig } =
          createClientFixture(model, interactive, model);
        configFixture.getHasAccessToPreviewModel.mockReturnValue(true);
        generateContent.mockRejectedValue(quotaExhaustedError());

        await expect(
          client.generateContent({
            modelConfigKey: { model, isChatModel: true },
            contents: [
              { role: 'user', parts: [{ text: 'Continue the task.' }] },
            ],
            abortSignal: new AbortController().signal,
            promptId: 'manual-quota-stop',
            role: LlmRole.MAIN,
          }),
        ).rejects.toThrow('The selected model has exhausted its quota.');

        expect(generateContent).toHaveBeenCalledTimes(1);
        expect(configFixture.getActiveModel()).toBe(model);
        expect(configFixture.getModel()).toBe(model);
        expect(configFixture.getContentGeneratorConfig()).toBe(providerConfig);
        expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
        expect(configFixture.setModel).not.toHaveBeenCalled();
        expect(configFixture.rotateSessionId).not.toHaveBeenCalled();
        expect(configFixture.getFallbackModelHandler).toHaveBeenCalledTimes(
          interactive ? 1 : 0,
        );
        expect(vi.getTimerCount()).toBe(0);
      }
    },
    2000,
  );

  it('keeps utility calls fixed when the configured chat selection is manual', async () => {
    const { client, generateContent, configFixture } = createClientFixture(
      DEFAULT_GEMINI_MODEL,
      false,
      DEFAULT_GEMINI_MODEL,
    );
    generateContent.mockRejectedValue(quotaExhaustedError());

    await expect(
      client.generateContent({
        modelConfigKey: { model: BASE_GEMINI_FLASH_MODEL, isChatModel: false },
        contents: [{ role: 'user', parts: [{ text: 'Summarize the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'manual-utility-quota',
        role: LlmRole.UTILITY_TOOL,
      }),
    ).rejects.toThrow('The selected model has exhausted its quota.');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0].model).toBe(
      LEGACY_CCPA_FLASH_MODEL,
    );
    expect(configFixture.getActiveModel()).toBe(DEFAULT_GEMINI_MODEL);
    expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
    expect(configFixture.rotateSessionId).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it('does not install the Auto hard-quota callback for an unsupported Flash-Lite utility model', async () => {
    const { client, generateContent, configFixture } = createClientFixture(
      DEFAULT_GEMINI_MODEL,
      false,
    );
    generateContent.mockRejectedValue(quotaExhaustedError());

    await expect(
      client.generateContent({
        modelConfigKey: {
          model: DEFAULT_GEMINI_FLASH_LITE_MODEL,
          isChatModel: false,
        },
        contents: [{ role: 'user', parts: [{ text: 'Summarize the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'unsupported-utility-quota',
        role: LlmRole.UTILITY_TOOL,
      }),
    ).rejects.toThrow('The selected model has exhausted its quota.');

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
    expect(configFixture.rotateSessionId).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it.each([false, true])(
    'retries Auto literal Argon immediately on Flash with interactive=%s',
    async (interactive) => {
      const {
        client,
        availability,
        configFixture,
        generateContent,
        providerConfig,
      } = createClientFixture(ARGON_MODEL, interactive);
      const emitRetryAttempt = vi.spyOn(coreEvents, 'emitRetryAttempt');
      generateContent
        .mockRejectedValueOnce(quotaExhaustedError())
        .mockResolvedValue(successResponse);

      const options = {
        modelConfigKey: { model: ARGON_MODEL, isChatModel: true },
        contents: [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'quota-routing-argon',
        role: LlmRole.MAIN,
      };
      const response = await client.generateContent(options);

      expect(response).toBe(successResponse);
      expect(
        generateContent.mock.calls.map(([request]) => request.model),
      ).toEqual([ARGON_MODEL, LEGACY_CCPA_FLASH_MODEL]);
      expect(configFixture.getActiveModel()).toBe(BASE_GEMINI_FLASH_MODEL);
      expect(availability.snapshot(ARGON_MODEL)).toEqual({
        available: false,
        reason: 'quota',
      });
      expect(availability.snapshot(BASE_GEMINI_FLASH_MODEL)).toEqual({
        available: true,
      });

      // The next request still carries the user's configured model. It must
      // continue on Flash rather than sending another request to exhausted Argon.
      await expect(client.generateContent(options)).resolves.toBe(
        successResponse,
      );
      expect(
        generateContent.mock.calls.map(([request]) => request.model),
      ).toEqual([
        ARGON_MODEL,
        LEGACY_CCPA_FLASH_MODEL,
        LEGACY_CCPA_FLASH_MODEL,
      ]);
      expect(configFixture.getActiveModel()).toBe(BASE_GEMINI_FLASH_MODEL);
      expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
      expect(configFixture.getContentGeneratorConfig()).toBe(providerConfig);
      expect(providerConfig).toEqual({
        authType: 'oauth-personal',
        project: PROJECT_ID,
      });
      expect(process.env['GOOGLE_CLOUD_PROJECT']).toBe(PROJECT_ID);
      expect(configFixture.setModel).not.toHaveBeenCalled();
      expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
      expect(configFixture.refreshAuth).not.toHaveBeenCalled();
      expect(configFixture.rotateSessionId).toHaveBeenCalledTimes(1);
      expect(configFixture.getFallbackModelHandler).not.toHaveBeenCalled();
      expect(emitRetryAttempt).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
    2000,
  );

  it('retries Auto Flash on Pro without changing the provider or selection', async () => {
    const {
      client,
      availability,
      configFixture,
      generateContent,
      providerConfig,
    } = createClientFixture(BASE_GEMINI_FLASH_MODEL, false);
    generateContent
      .mockRejectedValueOnce(
        new TerminalQuotaError(
          'Flash daily quota exhausted.',
          { code: 429, message: 'Flash daily quota exhausted.', details: [] },
          3600,
          'QUOTA_EXHAUSTED',
        ),
      )
      .mockResolvedValueOnce(successResponse);

    await expect(
      client.generateContent({
        modelConfigKey: { model: BASE_GEMINI_FLASH_MODEL, isChatModel: true },
        contents: [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'quota-routing-flash',
        role: LlmRole.MAIN,
      }),
    ).resolves.toBe(successResponse);

    expect(
      generateContent.mock.calls.map(([request]) => request.model),
    ).toEqual([LEGACY_CCPA_FLASH_MODEL, DEFAULT_GEMINI_MODEL]);
    expect(configFixture.getActiveModel()).toBe(DEFAULT_GEMINI_MODEL);
    expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    expect(configFixture.getContentGeneratorConfig()).toBe(providerConfig);
    expect(availability.snapshot(BASE_GEMINI_FLASH_MODEL)).toEqual({
      available: false,
      reason: 'quota',
    });
    expect(configFixture.setModel).not.toHaveBeenCalled();
    expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
    expect(configFixture.refreshAuth).not.toHaveBeenCalled();
    expect(configFixture.getFallbackModelHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it('switches a utility request to the already active Pro model after Flash exhausts quota', async () => {
    const {
      client,
      availability,
      configFixture,
      generateContent,
      providerConfig,
    } = createClientFixture(DEFAULT_GEMINI_MODEL, false);
    let attempts = 0;
    generateContent.mockImplementation(async (request) => {
      // Bound this regression: the previous retry loop kept requesting Flash
      // because the fallback target was already the active model.
      if (++attempts > 2) {
        throw new Error('Quota retry repeated the exhausted utility model.');
      }
      if (request.model === LEGACY_CCPA_FLASH_MODEL) {
        throw quotaExhaustedError();
      }
      return successResponse;
    });

    await expect(
      client.generateContent({
        modelConfigKey: { model: BASE_GEMINI_FLASH_MODEL, isChatModel: false },
        contents: [{ role: 'user', parts: [{ text: 'Summarize the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'quota-routing-utility',
        role: LlmRole.UTILITY_TOOL,
      }),
    ).resolves.toBe(successResponse);

    expect(
      generateContent.mock.calls.map(([request]) => request.model),
    ).toEqual([LEGACY_CCPA_FLASH_MODEL, DEFAULT_GEMINI_MODEL]);
    expect(generateContent.mock.calls[1][0].config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
    expect(availability.snapshot(BASE_GEMINI_FLASH_MODEL)).toEqual({
      available: false,
      reason: 'quota',
    });
    expect(configFixture.getActiveModel()).toBe(DEFAULT_GEMINI_MODEL);
    expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    expect(configFixture.getContentGeneratorConfig()).toBe(providerConfig);
    expect(configFixture.setModel).not.toHaveBeenCalled();
    expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
    expect(configFixture.refreshAuth).not.toHaveBeenCalled();
    expect(configFixture.getFallbackModelHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it('skips initially advertised zero quota before contacting the provider', async () => {
    const { client, configFixture, generateContent } = createClientFixture(
      ARGON_MODEL,
      false,
    );
    configFixture.getLastRetrievedQuota.mockReturnValue({
      buckets: [
        { modelId: ARGON_MODEL, remainingFraction: 0 },
        { modelId: BASE_GEMINI_FLASH_MODEL, remainingFraction: 0.5 },
      ],
    });
    generateContent.mockImplementation(async (request) => {
      if (request.model !== LEGACY_CCPA_FLASH_MODEL) {
        throw new Error('The provider was called with a zero-quota model.');
      }
      return successResponse;
    });

    await expect(
      client.generateContent({
        modelConfigKey: { model: ARGON_MODEL, isChatModel: true },
        contents: [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'quota-routing-advertised-zero',
        role: LlmRole.MAIN,
      }),
    ).resolves.toBe(successResponse);

    expect(
      generateContent.mock.calls.map(([request]) => request.model),
    ).toEqual([LEGACY_CCPA_FLASH_MODEL]);
    expect(configFixture.getActiveModel()).toBe(BASE_GEMINI_FLASH_MODEL);
    expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    expect(configFixture.setModel).not.toHaveBeenCalled();
    expect(configFixture.getFallbackModelHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it('does not retry exhausted Pro through a runtime Flash override', async () => {
    const { client, availability, configFixture, generateContent } =
      createClientFixture(DEFAULT_GEMINI_MODEL, false);
    configFixture.modelConfigService.registerRuntimeModelOverride({
      match: { model: BASE_GEMINI_FLASH_MODEL },
      modelConfig: { model: DEFAULT_GEMINI_MODEL },
    });
    let attempts = 0;
    generateContent.mockImplementation(async () => {
      if (++attempts > 1) {
        throw new Error('Runtime override retried exhausted Pro.');
      }
      throw quotaExhaustedError();
    });
    const options = {
      modelConfigKey: { model: BASE_GEMINI_FLASH_MODEL, isChatModel: false },
      contents: [{ role: 'user', parts: [{ text: 'Summarize the task.' }] }],
      abortSignal: new AbortController().signal,
      promptId: 'quota-routing-runtime-override',
      role: LlmRole.UTILITY_TOOL,
    };

    await expect(client.generateContent(options)).rejects.toThrow(
      'The selected model has exhausted its quota.',
    );
    expect(
      generateContent.mock.calls.map(([request]) => request.model),
    ).toEqual([DEFAULT_GEMINI_MODEL]);
    expect(availability.snapshot(DEFAULT_GEMINI_MODEL)).toEqual({
      available: false,
      reason: 'quota',
    });

    await expect(client.generateContent(options)).rejects.toThrow(
      'No model with available quota remains for this selection.',
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    expect(configFixture.setModel).not.toHaveBeenCalled();
    expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it('stops a scoped Flash override before repeating exhausted Pro without marking Flash exhausted', async () => {
    const { client, availability, configFixture, generateContent } =
      createClientFixture(DEFAULT_GEMINI_MODEL, false);
    configFixture.modelConfigService.registerRuntimeModelOverride({
      match: { model: BASE_GEMINI_FLASH_MODEL, overrideScope: 'utility' },
      modelConfig: { model: DEFAULT_GEMINI_MODEL },
    });
    let attempts = 0;
    generateContent.mockImplementation(async () => {
      if (++attempts > 1) {
        throw new Error('Scoped runtime override retried exhausted Pro.');
      }
      throw quotaExhaustedError();
    });

    await expect(
      client.generateContent({
        modelConfigKey: {
          model: BASE_GEMINI_FLASH_MODEL,
          overrideScope: 'utility',
          isChatModel: false,
        },
        contents: [{ role: 'user', parts: [{ text: 'Summarize the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'quota-routing-scoped-override',
        role: LlmRole.UTILITY_TOOL,
      }),
    ).rejects.toThrow('The selected model has exhausted its quota.');

    expect(
      generateContent.mock.calls.map(([request]) => request.model),
    ).toEqual([DEFAULT_GEMINI_MODEL]);
    expect(availability.snapshot(DEFAULT_GEMINI_MODEL)).toEqual({
      available: false,
      reason: 'quota',
    });
    expect(availability.snapshot(BASE_GEMINI_FLASH_MODEL)).toEqual({
      available: true,
    });
    expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it('preserves Auto and quota exclusions after a non-quota fallback selects Pro in Plan mode', async () => {
    const { client, availability, configFixture, generateContent } =
      createClientFixture(ARGON_MODEL, true);
    configFixture.getApprovalMode.mockReturnValue(ApprovalMode.PLAN);

    // Exercise production activation of the non-quota fallback, preserving the
    // configured Auto selection and the real availability service's exclusions.
    configFixture.activateFallbackMode.mockImplementation(
      (model: string, failedModel?: string) =>
        Config.prototype.activateFallbackMode.call(
          configFixture as unknown as Config,
          model,
          failedModel,
        ),
    );
    let attempts = 0;
    generateContent.mockImplementation(async (request) => {
      if (++attempts > 3) {
        throw new Error('Plan mode revisited an exhausted last-resort model.');
      }
      if (
        request.model === ARGON_MODEL ||
        request.model === DEFAULT_GEMINI_MODEL
      ) {
        throw quotaExhaustedError();
      }
      throw new ApiError({ status: 404, message: 'Flash model unavailable.' });
    });

    await expect(
      client.generateContent({
        modelConfigKey: { model: ARGON_MODEL, isChatModel: true },
        contents: [{ role: 'user', parts: [{ text: 'Plan the task.' }] }],
        abortSignal: new AbortController().signal,
        promptId: 'quota-routing-plan-not-found',
        role: LlmRole.MAIN,
      }),
    ).rejects.toThrow('The selected model has exhausted its quota.');

    expect(
      generateContent.mock.calls.map(([request]) => request.model),
    ).toEqual([ARGON_MODEL, LEGACY_CCPA_FLASH_MODEL, DEFAULT_GEMINI_MODEL]);
    expect(availability.snapshot(ARGON_MODEL)).toEqual({
      available: false,
      reason: 'quota',
    });
    expect(availability.snapshot(DEFAULT_GEMINI_MODEL)).toEqual({
      available: false,
      reason: 'quota',
    });
    expect(availability.snapshot(BASE_GEMINI_FLASH_MODEL)).toEqual({
      available: false,
      reason: 'capacity',
    });
    expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    expect(configFixture.setModel).not.toHaveBeenCalled();
    expect(configFixture.activateFallbackMode).toHaveBeenCalledTimes(1);
    expect(configFixture.getFallbackModelHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);

  it('stops after all eligible models exhaust quota and skips transport on the next request', async () => {
    const { client, configFixture, generateContent } = createClientFixture(
      ARGON_MODEL,
      false,
    );
    generateContent.mockRejectedValue(quotaExhaustedError());
    const options = {
      modelConfigKey: { model: ARGON_MODEL, isChatModel: true },
      contents: [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
      abortSignal: new AbortController().signal,
      promptId: 'quota-routing-all-exhausted',
      role: LlmRole.MAIN,
    };

    await expect(client.generateContent(options)).rejects.toThrow(
      'The selected model has exhausted its quota.',
    );
    expect(
      generateContent.mock.calls.map(([request]) => request.model),
    ).toEqual([ARGON_MODEL, LEGACY_CCPA_FLASH_MODEL, DEFAULT_GEMINI_MODEL]);

    await expect(client.generateContent(options)).rejects.toThrow(
      'No model with available quota remains for this selection.',
    );
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(configFixture.getModel()).toBe(DEFAULT_GEMINI_MODEL_AUTO);
    expect(configFixture.setModel).not.toHaveBeenCalled();
    expect(configFixture.activateFallbackMode).not.toHaveBeenCalled();
    expect(configFixture.refreshAuth).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }, 2000);
});
