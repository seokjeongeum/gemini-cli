/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';

interface WorktreeMessage {
  type: 'worktree-selected' | 'worktree-selected-ack';
  path: string;
}

function isWorktreeMessage(
  message: unknown,
  type: WorktreeMessage['type'],
): message is WorktreeMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === type &&
    'path' in message &&
    typeof message.path === 'string' &&
    isAbsolute(message.path)
  );
}

/** Retains child-only worktree state across supervised CLI restarts. */
export class WorktreeRestartState {
  private worktreePath: string | undefined;

  getSpawnOptions(env: NodeJS.ProcessEnv): {
    cwd?: string;
    env: NodeJS.ProcessEnv;
  } {
    return this.worktreePath
      ? {
          cwd: this.worktreePath,
          env: { ...env, GEMINI_CLI_WORKTREE_HANDLED: '1' },
        }
      : { env };
  }

  handleMessage(child: Pick<ChildProcess, 'send'>, message: unknown): void {
    if (!isWorktreeMessage(message, 'worktree-selected')) {
      return;
    }

    this.worktreePath = message.path;
    try {
      child.send(
        { type: 'worktree-selected-ack', path: this.worktreePath },
        () => {
          // The child may disconnect while the acknowledgement is being sent.
        },
      );
    } catch {
      // Keep the state even if the child has already disconnected.
    }
  }
}

/** Waits until the supervisor can relaunch the CLI in the selected worktree. */
export async function preserveWorktreeForRestart(
  worktreePath: string,
): Promise<void> {
  const send = process.send?.bind(process);
  if (!send || !process.env['GEMINI_CLI_NO_RELAUNCH']) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (message: unknown) => {
      if (
        isWorktreeMessage(message, 'worktree-selected-ack') &&
        message.path === worktreePath
      ) {
        finish();
      }
    };
    const onDisconnect = () => {
      finish(
        new Error('Supervisor disconnected before confirming worktree state.'),
      );
    };
    const timeout = setTimeout(() => {
      finish(new Error('Timed out preserving worktree for CLI restart.'));
    }, 5000);

    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    try {
      send(
        { type: 'worktree-selected', path: worktreePath },
        (error: Error | null) => {
          if (error) {
            finish(error);
          }
        },
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
