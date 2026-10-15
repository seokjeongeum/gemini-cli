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

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { profileBuildPhase } from './build-profile.js';
import { preparePackageScript } from './build-workspace.js';
import { copyPackageAssets } from './copy_files.js';

if (!process.cwd().includes('packages')) {
  console.error('must be invoked from a package directory');
  process.exit(1);
}

const packageName = basename(process.cwd());

// build typescript files
profileBuildPhase('compile_typescript', () =>
  execFileSync(
    process.execPath,
    [
      createRequire(join(process.cwd(), 'package.json')).resolve(
        'typescript/bin/tsc',
      ),
      '--build',
    ],
    { stdio: 'inherit' },
  ),
);

// Run package-specific bundling if the script exists
const bundleScript = join(process.cwd(), 'scripts', 'bundle-browser-mcp.mjs');
if (packageName === 'core' && existsSync(bundleScript)) {
  console.log('Running chrome devtools MCP bundling...');
  profileBuildPhase('bundle_browser_mcp', () => {
    const { command, args, env } = preparePackageScript(
      process.cwd(),
      'bundle:browser-mcp',
    );
    execFileSync(command, args, {
      stdio: 'inherit',
      env,
    });
  });
}

// copy .{md,json} files
profileBuildPhase('copy_assets', () => copyPackageAssets());

// Copy documentation for the core package
if (packageName === 'core') {
  const docsSource = join(process.cwd(), '..', '..', 'docs');
  const docsTarget = join(process.cwd(), 'dist', 'docs');
  if (existsSync(docsSource)) {
    profileBuildPhase('copy_docs', () => {
      if (existsSync(docsTarget)) {
        rmSync(docsTarget, { recursive: true, force: true });
      }
      cpSync(docsSource, docsTarget, { recursive: true, dereference: true });
    });
    console.log('Copied documentation to dist/docs');
  }
}

// touch dist/.last_build
profileBuildPhase('write_build_stamp', () =>
  writeFileSync(join(process.cwd(), 'dist', '.last_build'), ''),
);
process.exit(0);
