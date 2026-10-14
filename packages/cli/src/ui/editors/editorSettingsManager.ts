/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  allowEditorTypeInSandbox,
  hasValidEditorCommand,
  type EditorType,
  EDITOR_DISPLAY_NAMES,
} from '@google/gemini-cli-core';

export interface EditorDisplay {
  name: string;
  type: EditorType | 'not_set';
  disabled: boolean;
}

class EditorSettingsManager {
  private availableEditors: EditorDisplay[] | undefined;

  getAvailableEditorDisplays(): EditorDisplay[] {
    if (this.availableEditors) {
      return this.availableEditors;
    }

    // Probe editor commands only when the editor dialog is opened. On Windows,
    // each availability check starts where.exe and can delay UI module loading.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const editorTypes = Object.keys(
      EDITOR_DISPLAY_NAMES,
    ).sort() as EditorType[];
    this.availableEditors = [
      {
        name: 'None',
        type: 'not_set',
        disabled: false,
      },
      ...editorTypes.map((type) => {
        const hasEditor = hasValidEditorCommand(type);
        const isAllowedInSandbox = allowEditorTypeInSandbox(type);

        let labelSuffix = !isAllowedInSandbox
          ? ' (Not available in sandbox)'
          : '';
        labelSuffix = !hasEditor ? ' (Not installed)' : labelSuffix;

        return {
          name: EDITOR_DISPLAY_NAMES[type] + labelSuffix,
          type,
          disabled: !hasEditor || !isAllowedInSandbox,
        };
      }),
    ];
    return this.availableEditors;
  }
}

export const editorSettingsManager = new EditorSettingsManager();
