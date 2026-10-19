/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  preserveWorktreeForRestart,
  WorktreeRestartState,
} from './worktreeRestart.js';

const worktreePath = resolve('project with spaces', '.gemini/worktrees/first');

describe('WorktreeRestartState', () => {
  it.each(['cached', 'fresh'])(
    'retains cwd across two restarts with %s spawn environments',
    (strategy) => {
      const state = new WorktreeRestartState();
      const initialEnv = {
        NODE_OPTIONS: '--trace-warnings',
        GEMINI_CLI_AUTH_OVERRIDE: 'login_with_google',
      };
      const child = { send: vi.fn(() => true) };
      expect(state.getSpawnOptions(initialEnv)).toEqual({ env: initialEnv });

      state.handleMessage(child, {
        type: 'worktree-selected',
        path: worktreePath,
      });
      expect(child.send).toHaveBeenCalledWith(
        { type: 'worktree-selected-ack', path: worktreePath },
        expect.any(Function),
      );

      for (let restart = 0; restart < 2; restart++) {
        const env = strategy === 'cached' ? initialEnv : { ...initialEnv };
        expect(state.getSpawnOptions(env)).toEqual({
          cwd: worktreePath,
          env: { ...initialEnv, GEMINI_CLI_WORKTREE_HANDLED: '1' },
        });
        expect(env).not.toHaveProperty('GEMINI_CLI_WORKTREE_HANDLED');
      }
    },
  );

  it('stores the state before acknowledging a fast restart', () => {
    const state = new WorktreeRestartState();
    const child = {
      send: vi.fn(() => {
        expect(state.getSpawnOptions({}).cwd).toBe(worktreePath);
        return true;
      }),
    };
    state.handleMessage(child, {
      type: 'worktree-selected',
      path: worktreePath,
    });
    expect(child.send).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { type: 'worktree-selected', path: 'relative' },
    { type: 'other', path: worktreePath },
  ])('ignores unrelated or invalid messages: %j', (message) => {
    const state = new WorktreeRestartState();
    const child = { send: vi.fn(() => true) };
    state.handleMessage(child, message);
    expect(child.send).not.toHaveBeenCalled();
    expect(state.getSpawnOptions({})).not.toHaveProperty('cwd');
  });

  it('retains state when the acknowledgement channel has already closed', () => {
    const state = new WorktreeRestartState();
    const child = {
      send: vi.fn(() => {
        throw new Error('IPC channel closed');
      }),
    };
    expect(() =>
      state.handleMessage(child, {
        type: 'worktree-selected',
        path: worktreePath,
      }),
    ).not.toThrow();
    expect(state.getSpawnOptions({}).cwd).toBe(worktreePath);
  });
});

describe('preserveWorktreeForRestart', () => {
  const originalSend = process.send;
  const send = vi.fn(
    (_message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
      return true;
    },
  );
  let channel: EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('GEMINI_CLI_NO_RELAUNCH', 'true');
    process.send = send;
    send.mockClear();
    channel = new EventEmitter();
    const on = process.on;
    const once = process.once;
    const off = process.off;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'message' || event === 'disconnect') {
        channel.on(event, listener);
      } else {
        Reflect.apply(on, process, [event, listener]);
      }
      return process;
    });
    vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      if (event === 'message' || event === 'disconnect') {
        channel.once(event, listener);
      } else {
        Reflect.apply(once, process, [event, listener]);
      }
      return process;
    });
    vi.spyOn(process, 'off').mockImplementation((event, listener) => {
      if (event === 'message' || event === 'disconnect') {
        channel.off(event, listener);
      } else {
        Reflect.apply(off, process, [event, listener]);
      }
      return process;
    });
  });

  afterEach(() => {
    const remainingMessages = channel.listenerCount('message');
    const remainingDisconnects = channel.listenerCount('disconnect');
    vi.mocked(process.on).mockRestore();
    vi.mocked(process.once).mockRestore();
    vi.mocked(process.off).mockRestore();
    process.send = originalSend;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    expect(remainingMessages).toBe(0);
    expect(remainingDisconnects).toBe(0);
  });

  it('waits for the matching parent acknowledgement rather than the send callback', async () => {
    const settled = vi.fn();
    const pending = preserveWorktreeForRestart(worktreePath).then(settled);
    expect(send).toHaveBeenCalledWith(
      { type: 'worktree-selected', path: worktreePath },
      expect.any(Function),
    );
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    channel.emit(
      'message',
      { type: 'worktree-selected-ack', path: resolve('other') },
      undefined,
    );
    channel.emit(
      'message',
      { type: 'admin-settings', settings: {} },
      undefined,
    );
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    channel.emit(
      'message',
      { type: 'worktree-selected-ack', path: worktreePath },
      undefined,
    );
    await pending;
    expect(settled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the wait when the supervisor never acknowledges', async () => {
    const pending = preserveWorktreeForRestart(worktreePath).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual(
      new Error('Timed out preserving worktree for CLI restart.'),
    );
  });

  it('fails promptly if the supervisor disconnects', async () => {
    const pending = preserveWorktreeForRestart(worktreePath).catch(
      (error: unknown) => error,
    );
    channel.emit('disconnect');
    expect(await pending).toEqual(
      new Error('Supervisor disconnected before confirming worktree state.'),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles asynchronous IPC send errors', async () => {
    send.mockImplementationOnce((_message, callback) => {
      callback?.(new Error('IPC send failed'));
      return false;
    });
    await expect(preserveWorktreeForRestart(worktreePath)).rejects.toThrow(
      'IPC send failed',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles synchronous IPC send errors', async () => {
    send.mockImplementationOnce(() => {
      throw new Error('IPC send threw');
    });
    await expect(preserveWorktreeForRestart(worktreePath)).rejects.toThrow(
      'IPC send threw',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips the handshake when no supervisor IPC channel exists', async () => {
    process.send = undefined;
    await preserveWorktreeForRestart(worktreePath);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send worktree messages to an unrelated parent process', async () => {
    vi.stubEnv('GEMINI_CLI_NO_RELAUNCH', '');
    await preserveWorktreeForRestart(worktreePath);
    expect(send).not.toHaveBeenCalled();
  });
});
