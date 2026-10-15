/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileBuildPhase, profileBuildPhaseAsync } from './build-profile.js';
import {
  discoverBuildWorkspaces,
  preparePackageScript,
} from './build-workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function runScriptSync(directory, script) {
  const { command, args, env } = preparePackageScript(directory, script);
  execFileSync(command, args, { cwd: directory, env, stdio: 'inherit' });
}

async function runScript(directory, script) {
  const { command, args, env } = preparePackageScript(directory, script);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Build failed in ${directory} (${signal || code}).`));
    });
  });
}

// npm install if node_modules was removed (e.g. via npm run clean or scripts/clean.js)
if (!existsSync(join(root, 'node_modules'))) {
  profileBuildPhase('install_dependencies', () =>
    execSync('npm install', { stdio: 'inherit', cwd: root }),
  );
}

// build all workspaces/packages
profileBuildPhase('generate_metadata', () => runScriptSync(root, 'generate'));

const workspaces = profileBuildPhase('query_workspaces', () =>
  discoverBuildWorkspaces(root),
);

if (process.env.CI) {
  console.log('CI environment detected. Building workspaces sequentially...');
  await profileBuildPhaseAsync('build_all_workspaces', async () => {
    for (const workspace of workspaces) {
      await runScript(workspace.directory, 'build');
    }
  });
} else {
  // Build core first because everyone depends on it
  console.log('Building @google/gemini-cli-core...');
  const core = workspaces.find(
    ({ name }) => name === '@google/gemini-cli-core',
  );
  if (!core) throw new Error('Missing @google/gemini-cli-core workspace.');
  profileBuildPhase('build_core', () => runScriptSync(core.directory, 'build'));

  // Build the rest in parallel
  console.log('Building other workspaces in parallel...');
  const parallelWorkspaces = workspaces.filter(
    (workspace) => workspace !== core,
  );

  await profileBuildPhaseAsync('build_parallel_workspaces', async () => {
    // Wait for every launched build, including after a failure, so the root
    // process and profiler don't finish while children still write artifacts.
    const results = await Promise.allSettled(
      parallelWorkspaces.map(({ directory }) => runScript(directory, 'build')),
    );
    const failure = results.find(({ status }) => status === 'rejected');
    if (failure) throw failure.reason;
  });
}

// also build container image if sandboxing is enabled
// skip (-s) npm install + build since we did that above
if (process.env.BUILD_SANDBOX === '1' || process.env.BUILD_SANDBOX === 'true') {
  try {
    profileBuildPhase('probe_sandbox', () =>
      execSync('node scripts/sandbox_command.js -q', {
        stdio: 'inherit',
        cwd: root,
      }),
    );
    profileBuildPhase('build_sandbox', () =>
      execSync('node scripts/build_sandbox.js -s', {
        stdio: 'inherit',
        cwd: root,
      }),
    );
  } catch {
    // ignore
  }
}
