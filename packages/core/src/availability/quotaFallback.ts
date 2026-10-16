/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  GEMINI_MODEL_ALIAS_FLASH,
  GEMINI_MODEL_ALIAS_PRO,
  VALID_GEMINI_MODELS,
  getBackendModelMappings,
  isProModel,
  isAutoModel,
  resolveModel,
} from '../config/models.js';
import { normalizeModelId } from '../utils/modelUtils.js';
import type { ModelSelectionResult } from './modelAvailabilityService.js';

// A selected Argon ID must remain literal, even before it is in the catalog.
const ARGON_MODEL = 'gemini-4-argon';

function getQuotaModelMappings(config: Config): Record<string, string> {
  const authType = config.getContentGeneratorConfig?.()?.authType;
  return getBackendModelMappings(
    config,
    authType === 'oauth-personal' || authType === 'compute-default-credentials',
  );
}

/** Whether the requested backend model is explicitly advertised with zero quota. */
export function hasZeroQuotaForModel(config: Config, model: string): boolean {
  const mappings = getQuotaModelMappings(config);
  const quotaId = (id: string) => {
    const normalized = normalizeModelId(id);
    return mappings[normalized] ?? normalized;
  };
  return (
    config
      .getLastRetrievedQuota?.()
      ?.buckets?.some(
        (bucket) =>
          bucket.modelId &&
          quotaId(bucket.modelId) === quotaId(model) &&
          (bucket.remainingFraction === 0 ||
            (bucket.remainingAmount !== undefined &&
              Number(bucket.remainingAmount) === 0)),
      ) ?? false
  );
}

/** Record all IDs that send requests to the same exhausted backend model. */
export function markQuotaExhausted(config: Config, model: string): void {
  const normalized = normalizeModelId(model);
  const mappings = getQuotaModelMappings(config);
  const backendModel = mappings[normalized] ?? normalized;
  const availability = config.getModelAvailabilityService();
  availability.markTerminal(normalized, 'quota');
  availability.markTerminal(backendModel, 'quota');
  for (const [alias, target] of Object.entries(mappings)) {
    if (target === backendModel) availability.markTerminal(alias, 'quota');
  }
}

function isQuotaRoutingModel(model: string): boolean {
  return (
    model === ARGON_MODEL ||
    (VALID_GEMINI_MODELS.has(model) &&
      (isProModel(model) ||
        (model.includes('flash') && !model.includes('flash-lite'))))
  );
}

/** Only Auto selections may move between model tiers after exhausting quota. */
export function canUseQuotaFallback(config: Config, model: string): boolean {
  return (
    isAutoModel(normalizeModelId(config.getModel()), config) &&
    isQuotaRoutingModel(normalizeModelId(model))
  );
}

/**
 * Selects across Pro and Flash after hard quota exhaustion. Custom model IDs
 * retain their explicit-selection behavior. Unknown quota is attemptable;
 * advertised zero quota and models already known to be unavailable are skipped.
 */
export function selectQuotaFallbackModel(
  config: Config,
  requestedModel: string,
): ModelSelectionResult | undefined {
  const useGemini31 = config.getGemini31LaunchedSync?.() ?? false;
  const useCustomTools = config.getUseCustomToolModelSync?.() ?? false;
  const hasPreview = config.getHasAccessToPreviewModel?.() ?? false;
  const useLatestFlash = config.hasLatestFlashGAAccess?.() ?? false;
  const useLatestFlashLite = config.hasLatestFlashLiteGAAccess?.() ?? false;
  const resolve = (model: string) =>
    normalizeModelId(
      resolveModel(
        model,
        useGemini31,
        useCustomTools,
        hasPreview,
        config,
        useLatestFlash,
        useLatestFlashLite,
      ),
    );
  const requested = resolve(requestedModel);
  if (!canUseQuotaFallback(config, requested)) return undefined;

  const mappings = getQuotaModelMappings(config);
  const quotaId = (model: string) => {
    const normalized = normalizeModelId(model);
    return mappings[normalized] ?? normalized;
  };
  const buckets = config.getLastRetrievedQuota?.()?.buckets ?? [];
  const quotaFor = (model: string) =>
    buckets.filter(
      (bucket) => bucket.modelId && quotaId(bucket.modelId) === quotaId(model),
    );
  const advertisedArgon = quotaFor(ARGON_MODEL).some(
    (bucket) =>
      (bucket.remainingFraction !== undefined &&
        bucket.remainingFraction > 0) ||
      (bucket.remainingAmount !== undefined &&
        Number(bucket.remainingAmount) > 0),
  );
  const selectedArgon = [
    requested,
    normalizeModelId(config.getModel()),
    normalizeModelId(config.getActiveModel()),
  ].includes(ARGON_MODEL);

  const proModels = [resolve(GEMINI_MODEL_ALIAS_PRO)];
  if (selectedArgon || advertisedArgon) proModels.push(ARGON_MODEL);
  const flashModel = resolve(GEMINI_MODEL_ALIAS_FLASH);
  const candidates =
    requested === ARGON_MODEL || isProModel(requested)
      ? [requested, flashModel, ...proModels]
      : [requested, ...proModels, flashModel];
  const noProAccess = config.getProModelNoAccessSync?.() ?? false;
  const availability = config.getModelAvailabilityService();
  const seen = new Set<string>();
  const skipped: ModelSelectionResult['skipped'] = [];
  const eligible = candidates.filter((model) => {
    const actualModel = normalizeModelId(
      config.modelConfigService.getResolvedConfig({ model }).model,
    );
    const id = quotaId(actualModel);
    if (seen.has(id)) return false;
    seen.add(id);
    if (noProAccess && (actualModel === ARGON_MODEL || isProModel(actualModel)))
      return false;
    const health = availability.snapshot(actualModel);
    if (!health.available) {
      skipped.push({ model, reason: health.reason ?? 'unknown' });
      return false;
    }
    if (
      [...quotaFor(model), ...quotaFor(actualModel)].some(
        (bucket) =>
          bucket.remainingFraction === 0 ||
          (bucket.remainingAmount !== undefined &&
            Number(bucket.remainingAmount) === 0),
      )
    ) {
      skipped.push({ model, reason: 'quota' });
      return false;
    }
    return true;
  });
  const selection = availability.selectFirstAvailable(eligible);
  return { ...selection, skipped: [...selection.skipped, ...skipped] };
}
