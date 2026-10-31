/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GenerateContentResponse, Part } from '@google/genai';
import { GeminiClient } from './client.js';
import { GeminiChat, CONTINUE_PROMPT_TEXT } from './geminiChat.js';
import type { HistoryTurn } from './agentChatHistory.js';
import { AuthType, type ContentGenerator } from './contentGenerator.js';
import type { Config } from '../config/config.js';
import { getInitialChatHistory } from '../utils/environmentContext.js';
import {
  loadConversationRecord,
  MAX_HISTORY_MESSAGES,
  type MessagePatchRecord,
} from '../services/chatRecordingService.js';
import { CoreToolCallStatus } from '../scheduler/types.js';
import { createAvailabilityServiceMock } from '../availability/testUtils.js';
import { LlmRole } from '../telemetry/types.js';

describe('canonical history output masking', () => {
  let tempDir: string;
  let config: Config;
  let client: GeminiClient;
  let chat: GeminiChat;
  const generateContentStream =
    vi.fn<ContentGenerator['generateContentStream']>();

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'gemini-canonical-masking-'),
    );
    generateContentStream.mockReset();
    config = {
      get config() {
        return this;
      },
      getSessionId: () => 'canonical-masking-session',
      promptId: 'canonical-masking-session',
      getProjectRoot: () => tempDir,
      storage: { getProjectTempDir: () => tempDir },
      toolRegistry: { getTool: vi.fn() },
      getModel: () => 'gemini-2.5-pro',
      getActiveModel: () => 'gemini-2.5-pro',
      getContentGeneratorConfig: () => ({
        authType: AuthType.LOGIN_WITH_GOOGLE,
      }),
      getContentGenerator: () => ({ generateContentStream }),
      isContextManagementEnabled: () => false,
      getDebugMode: () => false,
      getUsageStatisticsEnabled: () => false,
      getRetryFetchErrors: () => false,
      getMaxAttempts: () => 1,
      getRequestTimeoutMs: () => undefined,
      getHookSystem: () => undefined,
      getSessionMemory: () => '',
      getIncludeDirectoryTree: () => false,
      getToolOutputMaskingConfig: async () => ({
        protectionThresholdTokens: 50000,
        minPrunableThresholdTokens: 30000,
        protectLatestTurn: true,
      }),
      modelConfigService: {
        getResolvedConfig: () => ({
          model: 'gemini-2.5-pro',
          generateContentConfig: {},
        }),
      },
      getModelAvailabilityService: () => createAvailabilityServiceMock(),
    } as unknown as Config;
    chat = new GeminiChat(config, '', [], await getInitialChatHistory(config));
    await chat.initialize();
    client = new GeminiClient(config);
    client['chat'] = chat;
  });

  afterEach(async () => {
    client.dispose();
    vi.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('returns independent snapshot containers without API filtering or coalescing', () => {
    chat.addHistory({
      id: 'image-prompt',
      content: {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'image' } }],
      },
    });
    chat.addHistory({
      id: 'thought-only',
      content: { role: 'model', parts: [{ text: 'thinking', thought: true }] },
    });
    const snapshot = chat.getCanonicalHistoryTurnsSnapshot();
    const second = chat.getCanonicalHistoryTurnsSnapshot();
    expect(snapshot).toEqual(second);
    expect(snapshot).not.toBe(second);
    expect(snapshot[0]).not.toBe(second[0]);
    expect(snapshot[0].content).not.toBe(second[0].content);
    expect(snapshot[0].content.parts).not.toBe(second[0].content.parts);
    expect(snapshot.map((turn) => turn.id)).toContain('image-prompt');
    expect(snapshot.map((turn) => turn.id)).toContain('thought-only');
    expect(chat.getHistoryTurns().map((turn) => turn.id)).not.toContain(
      'image-prompt',
    );
    expect(chat.getHistoryTurns().map((turn) => turn.id)).not.toContain(
      'thought-only',
    );
    snapshot[0].content.parts!.push({ text: 'snapshot-only' });
    expect(second[0].content.parts).not.toContainEqual({
      text: 'snapshot-only',
    });
    expect(chat.getCanonicalHistoryTurnsSnapshot()).toEqual(second);
  });

  it('patches only changed tool results after eviction, repeated masking and resume', async () => {
    const image = 'synthetic-image-data-'.repeat(2048);
    const imageTurn: HistoryTurn = {
      id: 'image-prompt',
      content: {
        role: 'user',
        parts: [
          { text: 'inspect image' },
          { inlineData: { mimeType: 'image/png', data: image } },
        ],
      },
    };
    chat.setHistory([
      ...chat.getCanonicalHistoryTurnsSnapshot(),
      imageTurn,
      {
        id: 'thought-only',
        content: {
          role: 'model',
          parts: [{ text: 'thinking', thought: true }],
        },
      },
    ]);
    const mask = vi.spyOn(client['toolOutputMaskingService'], 'mask');
    let expectedHistory = chat.getCanonicalHistoryTurnsSnapshot();

    for (let round = 0; round < 2; round++) {
      const callId = `call-${round}`;
      const modelId = `tool-model-${round}`;
      const responseId = `tool-response-${round}`;
      const toolParts: Part[] = [
        {
          functionResponse: {
            id: callId,
            name: 'read_file',
            response: { output: 'x'.repeat(400 * 1024) },
          },
        },
      ];
      chat.setHistory([
        ...chat.getCanonicalHistoryTurnsSnapshot(),
        {
          id: modelId,
          content: {
            role: 'model',
            parts: [
              { functionCall: { id: callId, name: 'read_file', args: {} } },
            ],
          },
        },
      ]);
      const recorder = chat.getChatRecordingService();
      recorder.recordToolCalls('gemini-2.5-pro', [
        {
          id: callId,
          name: 'read_file',
          args: {},
          result: toolParts,
          status: CoreToolCallStatus.Success,
          timestamp: new Date().toISOString(),
        },
      ]);
      chat.setHistory([
        ...chat.getCanonicalHistoryTurnsSnapshot(),
        { id: responseId, content: { role: 'user', parts: toolParts } },
        ...Array.from({ length: MAX_HISTORY_MESSAGES + 10 }, (_, index) => ({
          id: `round-${round}-filler-${index}`,
          content: {
            role: index % 2 ? 'user' : 'model',
            parts: [{ text: `filler ${index}` }],
          },
        })),
      ]);
      expectedHistory = chat.getCanonicalHistoryTurnsSnapshot();
      // Freeze shared parts: the real masker must replace changed paths rather
      // than mutate canonical content, including nested response objects.
      for (const turn of expectedHistory) {
        for (const part of turn.content.parts ?? []) {
          if (part.functionResponse) {
            Object.freeze(part.functionResponse.response);
            Object.freeze(part.functionResponse);
          }
          Object.freeze(part);
        }
      }
      const filePath = recorder.getConversationFilePath()!;
      const before = fs.statSync(filePath).size;
      await client['tryMaskToolOutputs']();
      expect((await mask.mock.results.at(-1)!.value).maskedCount).toBe(1);
      const actual = chat.getCanonicalHistoryTurnsSnapshot();
      expect(actual.map((turn) => turn.id)).toEqual(
        expectedHistory.map((turn) => turn.id),
      );
      expect(actual.find((turn) => turn.id === imageTurn.id)).toEqual(
        imageTurn,
      );
      expect(actual.find((turn) => turn.id === 'thought-only')).toEqual(
        expectedHistory.find((turn) => turn.id === 'thought-only'),
      );
      const appended = fs.readFileSync(filePath, 'utf8').slice(before);
      expect(appended).not.toContain(image);
      expect(appended).not.toContain('"removeIds"');
      expect(appended).not.toContain('"orderIds"');
      expect(appended.length).toBeLessThan(16 * 1024);
      const patches = appended
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as MessagePatchRecord)
        .filter((record) => '$patch' in record);
      expect(patches).toHaveLength(1);
      expect(
        patches[0].$patch.updates?.map((update) => update.id).sort(),
      ).toEqual([modelId, responseId].sort());
      const saved = (await loadConversationRecord(filePath))!;
      expect(saved.messages.map((message) => message.id)).toEqual(
        actual.map((turn) => turn.id),
      );
      const modelMessage = saved.messages.find(
        (message) => message.id === modelId,
      )!;
      expect(
        modelMessage.type === 'gemini' && modelMessage.toolCalls?.[0].result,
      ).toEqual(actual.find((turn) => turn.id === responseId)!.content.parts);
      expect(
        saved.messages.find((message) => message.id === imageTurn.id)?.content,
      ).toEqual(imageTurn.content.parts);
      chat = new GeminiChat(config, '', [], [], {
        filePath,
        conversation: saved,
      });
      await chat.initialize({ filePath, conversation: saved });
      client['chat'] = chat;
      const unchangedBytes = fs.statSync(filePath).size;
      await client['tryMaskToolOutputs']();
      expect((await mask.mock.results.at(-1)!.value).maskedCount).toBe(0);
      expect(fs.statSync(filePath).size).toBe(unchangedBytes);
    }

    generateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'done' }] },
              finishReason: 'STOP',
            },
          ],
        } as GenerateContentResponse;
      })(),
    );
    const filePath = chat.getChatRecordingService().getConversationFilePath()!;
    const beforeRequest = fs.statSync(filePath).size;
    const stream = await chat.sendMessageStream(
      { model: 'gemini-2.5-pro' },
      'Continue after resumed masking',
      'resumed-request',
      new AbortController().signal,
      LlmRole.MAIN,
      undefined,
      [
        ...chat.getHistory(),
        { role: 'model', parts: [{ text: 'request-only model tail' }] },
        {
          role: 'model',
          parts: [{ text: 'request-only thought', thought: true }],
        },
      ],
    );
    for await (const _ of stream) {
      // Consume the real request/recording path.
    }
    const request = generateContentStream.mock.calls[0][0];
    expect(request.contents).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    );
    expect(Array.isArray(request.contents) && request.contents.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: CONTINUE_PROMPT_TEXT }],
    });
    const appended = fs.readFileSync(filePath, 'utf8').slice(beforeRequest);
    expect(appended).not.toContain(CONTINUE_PROMPT_TEXT);
    expect(appended).not.toContain('request-only thought');
    expect(appended).not.toContain('request-only model tail');
    expect(appended).not.toContain(image);
    expect(
      chat
        .getCanonicalHistoryTurnsSnapshot()
        .find((turn) => turn.id === imageTurn.id),
    ).toEqual(imageTurn);
    const targetId = expectedHistory[40].id;
    const rewound = chat.getChatRecordingService().rewindTo(targetId)!;
    expect(rewound.messages.map((message) => message.id)).toEqual(
      expectedHistory.slice(0, 40).map((turn) => turn.id),
    );
    expect((await loadConversationRecord(filePath))!.messages).toEqual(
      rewound.messages,
    );
  });
});
