/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';

function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

/** Read the declared workspaces without starting another npm process. */
export function discoverBuildWorkspaces(root) {
  // Keep module loading dependency-free until build.js has had a chance to
  // restore a missing node_modules directory. Package script preparation also
  // does not need to load glob in each child process.
  const { globSync } = createRequire(import.meta.url)('glob');
  const manifest = readManifest(root);
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
    throw new Error('The root package must declare workspace patterns.');
  }
  const manifestPattern = (pattern) =>
    `${pattern.replace(/\/$/, '')}/package.json`;
  const paths = globSync(
    patterns.filter((p) => !p.startsWith('!')).map(manifestPattern),
    {
      cwd: root,
      absolute: true,
      nodir: true,
      ignore: [
        '**/node_modules/**',
        ...patterns
          .filter((p) => p.startsWith('!'))
          .map((p) => manifestPattern(p.slice(1))),
      ],
    },
  ).sort();
  const names = new Set();
  return [...new Set(paths)].map((file) => {
    const directory = dirname(file);
    const packageJson = readManifest(directory);
    const name = packageJson.name;
    if (typeof name !== 'string' || !name.trim() || names.has(name)) {
      throw new Error(`Missing or duplicate workspace name in ${file}.`);
    }
    if (
      typeof packageJson.scripts?.build !== 'string' ||
      !packageJson.scripts.build.trim()
    ) {
      throw new Error(`Workspace ${name} does not declare a build script.`);
    }
    names.add(name);
    return { name, directory, packageJson };
  });
}

function addPackageFields(values, prefix, env) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value === null || value === false) {
      env[`${prefix}${key}`] = '';
    } else if (Array.isArray(value)) {
      value.forEach((item, index) =>
        addPackageFields({ [`${key}_${index}`]: item }, prefix, env),
      );
    } else if (typeof value === 'object') {
      addPackageFields(value, `${prefix}${key}_`, env);
    } else {
      env[`${prefix}${key}`] = String(value);
    }
  }
}

function scriptEnvironment(directory, packageJson, script, command, env) {
  const result = {
    ...env,
    npm_package_json: join(directory, 'package.json'),
    npm_lifecycle_event: script,
    npm_lifecycle_script: command,
    npm_node_execpath: process.execPath,
    INIT_CWD: env.INIT_CWD || process.cwd(),
  };
  // These are the five package fields exported by npm's run-script lifecycle.
  // npm merges their leaves with inherited variables rather than clearing all
  // npm_package_* values from the parent workspace.
  addPackageFields(
    {
      name: packageJson.name,
      version: packageJson.version,
      config: packageJson.config,
      engines: packageJson.engines,
      bin: packageJson.bin,
    },
    'npm_package_',
    result,
  );
  // npm makes local binaries available to lifecycle scripts. Retain that
  // behavior for a direct Node script that starts another tool itself.
  const pathKeys = Object.keys(env).filter((key) => /^path$/i.test(key));
  const inheritedPath = [];
  for (const key of pathKeys) {
    if (env[key]) {
      inheritedPath.push(
        ...env[key]
          .split(delimiter)
          .filter((entry) => !inheritedPath.includes(entry)),
      );
    }
  }
  const localBins = [];
  let parent = directory;
  while (true) {
    localBins.push(join(parent, 'node_modules', '.bin'));
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const updatedPath = [...localBins, inheritedPath.join(delimiter)].join(
    delimiter,
  );
  // npm updates every spelling to the same merged value, which also prevents
  // Windows' case-insensitive environment handling from losing PATH entries.
  for (const key of pathKeys.length ? pathKeys : ['PATH'])
    result[key] = updatedPath;
  return result;
}

/**
 * Prepare a shell-free command. Simple Node scripts can bypass npm's wrappers;
 * lifecycle hooks and all other commands still run through npm unchanged.
 */
export function preparePackageScript(
  directory,
  script,
  { env = process.env } = {},
) {
  directory = resolve(directory);
  const packageJson = readManifest(directory);
  const command = packageJson.scripts?.[script];
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error(`Missing package script ${script} in ${directory}.`);
  }
  const simpleNode = /^node ([\w./-]+\.(?:js|mjs|cjs))$/.exec(command);
  const hasHooks =
    packageJson.scripts?.[`pre${script}`] ||
    packageJson.scripts?.[`post${script}`];
  const customShell = Object.entries(env).some(
    ([key, value]) => /^npm_config_script_shell$/i.test(key) && value,
  );
  if (simpleNode && !hasHooks && !customShell) {
    const file = resolve(directory, simpleNode[1]);
    if (existsSync(file)) {
      return {
        command: process.execPath,
        args: [file],
        cwd: directory,
        env: scriptEnvironment(directory, packageJson, script, command, env),
      };
    }
  }

  // The build entry point is normally invoked by npm. Using that same CLI
  // avoids npm.cmd and shell quoting while retaining lifecycle semantics.
  const npmPath = env.npm_execpath;
  if (!npmPath) {
    throw new Error(
      `Run this build with npm so package script ${script} can use npm.`,
    );
  }
  return {
    command: process.execPath,
    args: [npmPath, 'run', script],
    cwd: directory,
    env,
  };
}
