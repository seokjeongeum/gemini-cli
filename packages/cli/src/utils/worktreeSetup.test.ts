/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupWorktree } from './worktreeSetup.js';
import * as coreFunctions from '@google/gemini-cli-core';
import { preserveWorktreeForRestart } from './worktreeRestart.js';

vi.mock('./worktreeRestart.js', () => ({
  preserveWorktreeForRestart: vi.fn().mockResolvedValue(undefined),
}));

// Mock dependencies
vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    getProjectRootForWorktree: vi.fn(),
    createWorktreeService: vi.fn(),
    debugLogger: {
      log: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    writeToStdout: vi.fn(),
    writeToStderr: vi.fn(),
  };
});

describe('setupWorktree', () => {
  const originalCwd = process.cwd;

  const mockService = {
    setup: vi.fn(),
    maybeCleanup: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GEMINI_CLI_WORKTREE_HANDLED', '');

    // Mock process.cwd and process.chdir
    let currentPath = '/mock/project';
    process.cwd = vi.fn().mockImplementation(() => currentPath);
    process.chdir = vi.fn().mockImplementation((newPath) => {
      currentPath = newPath;
    });

    // Mock successful execution of core utilities
    vi.mocked(coreFunctions.getProjectRootForWorktree).mockResolvedValue(
      '/mock/project',
    );
    vi.mocked(coreFunctions.createWorktreeService).mockResolvedValue(
      mockService as never,
    );
    mockService.setup.mockResolvedValue({
      name: 'my-feature',
      path: '/mock/project/.gemini/worktrees/my-feature',
      baseSha: 'base-sha',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.cwd = originalCwd;
    delete (process as { chdir?: typeof process.chdir }).chdir;
  });

  it('should create and switch to a new worktree', async () => {
    await setupWorktree('my-feature');

    expect(coreFunctions.getProjectRootForWorktree).toHaveBeenCalledWith(
      '/mock/project',
    );
    expect(coreFunctions.createWorktreeService).toHaveBeenCalledWith(
      '/mock/project',
    );
    expect(mockService.setup).toHaveBeenCalledWith('my-feature');
    expect(process.chdir).toHaveBeenCalledWith(
      '/mock/project/.gemini/worktrees/my-feature',
    );
    expect(process.env['GEMINI_CLI_WORKTREE_HANDLED']).toBe('1');
  });

  it('should generate a name if worktreeName is undefined', async () => {
    mockService.setup.mockResolvedValue({
      name: 'generated-name',
      path: '/mock/project/.gemini/worktrees/generated-name',
      baseSha: 'base-sha',
    });

    await setupWorktree(undefined);

    expect(mockService.setup).toHaveBeenCalledWith(undefined);
  });

  it('should skip worktree creation if GEMINI_CLI_WORKTREE_HANDLED is set', async () => {
    vi.stubEnv('GEMINI_CLI_WORKTREE_HANDLED', '1');

    await setupWorktree('my-feature');

    expect(coreFunctions.createWorktreeService).not.toHaveBeenCalled();
    expect(process.chdir).not.toHaveBeenCalled();
  });

  it('waits for the supervisor before allowing authentication to continue', async () => {
    let acknowledge: () => void = () => {};
    vi.mocked(preserveWorktreeForRestart).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const settled = vi.fn();
    const setup = setupWorktree(undefined).then(settled);
    await vi.waitFor(() =>
      expect(preserveWorktreeForRestart).toHaveBeenCalled(),
    );
    expect(process.chdir).toHaveBeenCalledWith(
      '/mock/project/.gemini/worktrees/my-feature',
    );
    expect(settled).not.toHaveBeenCalled();
    acknowledge();
    await setup;
    expect(settled).toHaveBeenCalledOnce();
  });

  it('exits instead of starting a session when the supervisor cannot retain the worktree', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('PROCESS_EXIT');
    });
    vi.mocked(preserveWorktreeForRestart).mockRejectedValueOnce(
      new Error('Timed out preserving worktree for CLI restart.'),
    );
    try {
      await expect(setupWorktree(undefined)).rejects.toThrow('PROCESS_EXIT');
      expect(exit).toHaveBeenCalledWith(1);
      expect(coreFunctions.writeToStderr).toHaveBeenCalledWith(
        expect.stringContaining('Timed out preserving worktree'),
      );
    } finally {
      exit.mockRestore();
    }
  });

  it('should handle errors gracefully and exit', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('PROCESS_EXIT');
    });

    mockService.setup.mockRejectedValue(new Error('Git failure'));

    await expect(setupWorktree('my-feature')).rejects.toThrow('PROCESS_EXIT');

    expect(coreFunctions.writeToStderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to create or switch to worktree: Git failure',
      ),
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });
});
