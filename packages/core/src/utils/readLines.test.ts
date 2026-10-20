/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLines, readLinesSync, RecordTooLargeError } from './readLines.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

async function collectLines(filePath: string, maxLength?: number) {
  const lines: string[] = [];
  for await (const line of readLines(filePath, maxLength)) {
    lines.push(line);
  }
  return lines;
}

describe('incremental line readers', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-read-lines-'));
    filePath = path.join(directory, 'records.jsonl');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('preserves UTF-8 characters split across a read buffer', async () => {
    const line = 'a'.repeat(64 * 1024 - 1) + '한😀';
    fs.writeFileSync(filePath, `${line}\nlast`);
    expect([...readLinesSync(filePath)]).toEqual([line, 'last']);
    await expect(collectLines(filePath)).resolves.toEqual([line, 'last']);
  });

  it.each(['', 'one', 'one\n', 'one\r\ntwo\r\nlast', '\n\n'])(
    'handles CRLF, empty and unterminated records: %j',
    async (content) => {
      fs.writeFileSync(filePath, content);
      const expected = content ? content.split('\n') : [];
      if (content.endsWith('\n')) expected.pop();
      expect([...readLinesSync(filePath)]).toEqual(expected);
      await expect(collectLines(filePath)).resolves.toEqual(expected);
    },
  );

  it('applies the string limit to UTF-16 code units rather than UTF-8 bytes', async () => {
    fs.writeFileSync(filePath, '한\n😀');
    expect([...readLinesSync(filePath, 2)]).toEqual(['한', '😀']);
    await expect(collectLines(filePath, 2)).resolves.toEqual(['한', '😀']);
    const reader = readLinesSync(filePath, 1);
    expect(reader.next().value).toBe('한');
    expect(() => reader.next()).toThrow(RecordTooLargeError);
    await expect(collectLines(filePath, 1)).rejects.toThrow(
      RecordTooLargeError,
    );
  });

  it('bounds individual records instead of the aggregate file length', async () => {
    const expected = Array.from({ length: 1000 }, () => '12345678');
    fs.writeFileSync(filePath, expected.join('\n'));
    expect([...readLinesSync(filePath, 8)]).toEqual(expected);
    await expect(collectLines(filePath, 8)).resolves.toEqual(expected);
  });

  it('rejects an oversized record before joining it and closes the descriptor', async () => {
    fs.writeFileSync(filePath, 'a'.repeat(64 * 1024 + 1));
    expect(() => [...readLinesSync(filePath, 64 * 1024)]).toThrow(
      RecordTooLargeError,
    );
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    await expect(collectLines(filePath, 64 * 1024)).rejects.toMatchObject({
      code: 'ERR_STRING_TOO_LONG',
    });
  });

  it('closes the descriptor when iteration stops early', () => {
    fs.writeFileSync(filePath, 'first\nsecond');
    for (const line of readLinesSync(filePath)) {
      expect(line).toBe('first');
      break;
    }
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
  });

  it('closes the descriptor after an I/O error', () => {
    fs.writeFileSync(filePath, 'first');
    vi.mocked(fs.readSync).mockImplementationOnce(() => {
      throw new Error('simulated read failure');
    });
    expect(() => [...readLinesSync(filePath)]).toThrow(
      'simulated read failure',
    );
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
  });
});
