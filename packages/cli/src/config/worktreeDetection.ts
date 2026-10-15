/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

/**
 * Recognizes only an ordinary checkout root that cannot be a Gemini worktree.
 * Uncertain layouts and Git configuration always retain Git's own discovery.
 */
export function canSkipWorktreeDiscovery(cwd: string): boolean {
  try {
    if (
      Object.keys(process.env).some((name) =>
        name.toUpperCase().startsWith('GIT_'),
      )
    ) {
      return false;
    }

    // Resolve junctions and short-name aliases before excluding Gemini's layout.
    const physicalCwd =
      process.platform === 'win32'
        ? fs.realpathSync.native(cwd)
        : fs.realpathSync(cwd);
    const segments = physicalCwd
      .split(path.sep)
      .map((segment) =>
        process.platform === 'win32' ? segment.toLowerCase() : segment,
      );
    if (
      segments.some(
        (segment, index) =>
          segment === '.gemini' && segments[index + 1] === 'worktrees',
      )
    ) {
      return false;
    }

    const gitDir = path.join(physicalCwd, '.git');
    if (!fs.lstatSync(gitDir).isDirectory()) return false;
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.lstatSync(headPath).isFile()) return false;
    const head = fs.readFileSync(headPath, 'utf8');
    if (
      !/^ref: refs\/[A-Za-z0-9_./-]+\r?\n?$/.test(head) &&
      !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})\r?\n?$/.test(head)
    ) {
      return false;
    }
    for (const directory of ['objects', 'refs']) {
      const entry = path.join(gitDir, directory);
      if (!fs.statSync(entry).isDirectory()) return false;
      fs.accessSync(entry, fs.constants.X_OK);
    }

    try {
      fs.lstatSync(path.join(gitDir, 'commondir'));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }

    // Reject redirects, includes, worktreeConfig, and line continuations rather
    // than reproducing Git's configuration parser. Global/system config is
    // already disabled by getSafeGitEnv in the authoritative discovery path.
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    return !/\\|worktree|include/i.test(config);
  } catch {
    return false;
  }
}
