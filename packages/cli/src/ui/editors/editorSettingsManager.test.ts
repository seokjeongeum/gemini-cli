/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allowEditorTypeInSandbox,
  EDITOR_DISPLAY_NAMES,
  hasValidEditorCommand,
} from '@google/gemini-cli-core';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    allowEditorTypeInSandbox: vi.fn(),
    hasValidEditorCommand: vi.fn(),
  };
});

describe('editorSettingsManager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(hasValidEditorCommand).mockReset().mockReturnValue(true);
    vi.mocked(allowEditorTypeInSandbox).mockReset().mockReturnValue(true);
  });

  it('does not probe editor commands when the UI module is imported', async () => {
    await import('./editorSettingsManager.js');

    expect(hasValidEditorCommand).not.toHaveBeenCalled();
    expect(allowEditorTypeInSandbox).not.toHaveBeenCalled();
  });

  it('checks availability when the editor list is first requested', async () => {
    const { editorSettingsManager } = await import(
      './editorSettingsManager.js'
    );
    vi.mocked(hasValidEditorCommand).mockImplementation(
      (editor) => editor !== 'vim',
    );
    vi.mocked(allowEditorTypeInSandbox).mockImplementation(
      (editor) => editor !== 'vscode' && editor !== 'vim',
    );

    const editors = editorSettingsManager.getAvailableEditorDisplays();

    expect(editors[0]).toEqual({
      name: 'None',
      type: 'not_set',
      disabled: false,
    });
    expect(editors.slice(1).map((editor) => editor.type)).toEqual(
      Object.keys(EDITOR_DISPLAY_NAMES).sort(),
    );
    expect(editors).toContainEqual({
      name: 'VS Code (Not available in sandbox)',
      type: 'vscode',
      disabled: true,
    });
    expect(editors).toContainEqual({
      name: 'Vim (Not installed)',
      type: 'vim',
      disabled: true,
    });
    expect(editors).toContainEqual({
      name: 'Emacs',
      type: 'emacs',
      disabled: false,
    });
    expect(hasValidEditorCommand).toHaveBeenCalledTimes(
      Object.keys(EDITOR_DISPLAY_NAMES).length,
    );
  });

  it('reuses the availability list across dialog rerenders', async () => {
    const { editorSettingsManager } = await import(
      './editorSettingsManager.js'
    );
    const editors = editorSettingsManager.getAvailableEditorDisplays();
    vi.mocked(hasValidEditorCommand).mockClear();
    vi.mocked(allowEditorTypeInSandbox).mockClear();

    expect(editorSettingsManager.getAvailableEditorDisplays()).toBe(editors);
    expect(hasValidEditorCommand).not.toHaveBeenCalled();
    expect(allowEditorTypeInSandbox).not.toHaveBeenCalled();
  });
});
