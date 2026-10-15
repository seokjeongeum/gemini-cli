/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPackageAssets } from '../copy_files.js';

vi.unmock('fs');
vi.unmock('node:fs');
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(name, files) {
  const root = mkdtempSync(join(tmpdir(), 'gemini-copy-assets-'));
  directories.push(root);
  const directory = join(root, name);
  for (const [file, content] of Object.entries(files)) {
    const target = join(directory, 'src', file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return directory;
}

describe('in-process package assets', () => {
  it('copies nested package assets while leaving compilation to TypeScript', () => {
    const directory = fixture('sdk', {
      'nested/policy.toml': 'allow = true',
      'nested/metadata.json': '{"enabled":true}',
      'nested/worker.cs': 'worker content',
      'nested/source.ts': 'export const value = 1;',
    });
    copyPackageAssets(directory);
    expect(
      readFileSync(join(directory, 'dist/src/nested/policy.toml'), 'utf8'),
    ).toBe('allow = true');
    expect(
      readFileSync(join(directory, 'dist/src/nested/metadata.json'), 'utf8'),
    ).toBe('{"enabled":true}');
    expect(
      readFileSync(join(directory, 'dist/src/nested/worker.cs'), 'utf8'),
    ).toBe('worker content');
    expect(existsSync(join(directory, 'dist/src/nested/source.ts'))).toBe(
      false,
    );
  });

  it.each([
    ['cli', 'commands/extensions/examples/example/script.js'],
    ['core', 'skills/builtin/example/script.py'],
  ])(
    'preserves all %s example/skill files regardless of extension',
    (name, file) => {
      const directory = fixture(name, { [file]: 'example content' });
      copyPackageAssets(directory);
      expect(readFileSync(join(directory, 'dist/src', file), 'utf8')).toBe(
        'example content',
      );
    },
  );

  it('reports missing sources to the build caller', () => {
    const directory = fixture('empty', {});
    expect(() => copyPackageAssets(directory)).toThrow('Source directory');
  });
});
