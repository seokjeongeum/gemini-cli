/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { constants } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

const READ_BUFFER_SIZE = 64 * 1024;

export class RecordTooLargeError extends Error {
  readonly code = 'ERR_STRING_TOO_LONG';

  constructor() {
    super('Conversation record exceeds the runtime string size limit.');
    this.name = 'RecordTooLargeError';
  }
}

export function isRecordCapacityError(error: unknown): boolean {
  return (
    error instanceof RecordTooLargeError ||
    (error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_STRING_TOO_LONG')
  );
}

class LineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private fragments: string[] = [];
  private length = 0;

  constructor(private readonly maxLength: number) {}

  private append(fragment: string): void {
    if (this.length + fragment.length > this.maxLength) {
      throw new RecordTooLargeError();
    }
    if (fragment.length > 0) {
      this.fragments.push(fragment);
      this.length += fragment.length;
    }
  }

  private *split(text: string): Generator<string> {
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf('\n', start)) !== -1) {
      this.append(text.slice(start, newline));
      yield this.fragments.join('');
      this.fragments = [];
      this.length = 0;
      start = newline + 1;
    }
    this.append(text.slice(start));
  }

  *write(chunk: Buffer): Generator<string> {
    yield* this.split(this.decoder.write(chunk));
  }

  *end(): Generator<string> {
    yield* this.split(this.decoder.end());
    if (this.length > 0) {
      yield this.fragments.join('');
    }
  }
}

/** Reads one record at a time without materializing the entire file. */
export function* readLinesSync(
  filePath: string,
  maxLength = constants.MAX_STRING_LENGTH,
): Generator<string> {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
    const decoder = new LineDecoder(maxLength);
    let bytesRead: number;
    while (
      (bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0
    ) {
      yield* decoder.write(buffer.subarray(0, bytesRead));
    }
    yield* decoder.end();
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function* readLines(
  filePath: string,
  maxLength = constants.MAX_STRING_LENGTH,
): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, {
    highWaterMark: READ_BUFFER_SIZE,
  });
  try {
    const decoder = new LineDecoder(maxLength);
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError('Expected a binary file stream.');
      }
      yield* decoder.write(chunk);
    }
    yield* decoder.end();
  } finally {
    stream.destroy();
  }
}
