/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  discoverBuildWorkspaces,
  preparePackageScript,
} from '../build-workspace.js';

let root;
function manifest(directory, contents) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(contents));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gemini build workspace '));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('workspace discovery', () => {
  it('reads the declared workspaces in deterministic order and ignores excluded directories', () => {
    manifest(root, {
      workspaces: ['packages/*', '!packages/excluded', 'packages/a'],
    });
    for (const name of ['z', 'a', 'excluded']) {
      manifest(join(root, 'packages', name), {
        name: `@example/${name}`,
        scripts: { build: 'node build.js' },
      });
    }
    manifest(join(root, 'elsewhere'), { name: 'outside-workspaces' });
    mkdirSync(join(root, 'packages', 'no-manifest'));

    const workspaces = discoverBuildWorkspaces(root);

    expect(workspaces.map((w) => w.name)).toEqual(['@example/a', '@example/z']);
    expect(workspaces[0]).toEqual({
      name: '@example/a',
      directory: join(root, 'packages', 'a'),
      packageJson: {
        name: '@example/a',
        scripts: { build: 'node build.js' },
      },
    });
  });

  it('accepts the npm workspace packages object', () => {
    manifest(root, { workspaces: { packages: ['modules/*'] } });
    manifest(join(root, 'modules', 'one'), {
      name: 'one',
      scripts: { build: 'node build.js' },
    });
    expect(discoverBuildWorkspaces(root).map((w) => w.name)).toEqual(['one']);
  });

  it.each(['missing-name', 'duplicate-name', 'missing-build'])(
    'rejects %s rather than silently skipping work',
    (condition) => {
      manifest(root, { workspaces: ['packages/*'] });
      const first = { name: 'same-name', scripts: { build: 'node build.js' } };
      manifest(join(root, 'packages', 'first'), first);
      const second = { ...first };
      if (condition === 'missing-name') delete second.name;
      if (condition === 'missing-build') {
        second.name = 'different-name';
        delete second.scripts;
      }
      manifest(join(root, 'packages', 'second'), second);

      expect(() => discoverBuildWorkspaces(root)).toThrow(
        condition === 'missing-build' ? /build script/ : /workspace name/,
      );
    },
  );
});

describe('package script preparation', () => {
  const npmPath = join('npm path', 'npm-cli.js');
  const environment = {
    npm_execpath: npmPath,
    PATH: '/old-bin',
    INIT_CWD: '/initial',
  };

  function setup(script = 'node build.js', hooks = {}) {
    manifest(root, {
      name: '@example/workspace',
      version: '1.2.3',
      scripts: { build: script, ...hooks },
    });
    writeFileSync(join(root, 'build.js'), '');
  }

  it('executes a simple Node script in a directory with spaces without a shell and preserves npm script context', () => {
    setup();
    writeFileSync(
      join(root, 'build.js'),
      'require("fs").writeFileSync("result.json", JSON.stringify({ cwd: process.cwd(), lifecycle: process.env.npm_lifecycle_event, command: process.env.npm_lifecycle_script, name: process.env.npm_package_name, version: process.env.npm_package_version, manifest: process.env.npm_package_json, initial: process.env.INIT_CWD }));',
    );
    const prepared = preparePackageScript(root, 'build', { env: environment });

    execFileSync(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
    });

    expect(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))).toEqual(
      {
        cwd: root,
        lifecycle: 'build',
        command: 'node build.js',
        name: '@example/workspace',
        version: '1.2.3',
        manifest: join(root, 'package.json'),
        initial: '/initial',
      },
    );
    expect(prepared.command).toBe(process.execPath);
    expect(prepared.args).toEqual([join(root, 'build.js')]);
    expect(prepared.env.PATH.split(delimiter)[0]).toBe(
      join(root, 'node_modules', '.bin'),
    );
    expect(prepared.env.PATH.split(delimiter).at(-1)).toBe('/old-bin');
    expect(environment.PATH).toBe('/old-bin');
  });

  it.each(['prebuild', 'postbuild'])(
    'runs npm when %s exists so lifecycle hooks are retained',
    (hook) => {
      setup('node build.js', { [hook]: 'node hook.js' });

      expect(preparePackageScript(root, 'build', { env: environment })).toEqual(
        {
          command: process.execPath,
          args: [npmPath, 'run', 'build'],
          cwd: root,
          env: environment,
        },
      );
    },
  );

  it.each([
    'node build.js --production',
    'node build.js && node next.js',
    'node "build.js"',
    'node --inspect build.js',
    'tsc --build',
    'node missing.js',
  ])('retains npm for the script %j', (command) => {
    setup(command);
    expect(
      preparePackageScript(root, 'build', { env: environment }).args,
    ).toEqual([npmPath, 'run', 'build']);
  });

  it('fails clearly if npm is required but its CLI path is unavailable', () => {
    setup('tsc --build');
    expect(() => preparePackageScript(root, 'build', { env: {} })).toThrow(
      /Run this build with npm/,
    );
  });

  it('does not require npm for a simple Node script', () => {
    setup();
    expect(preparePackageScript(root, 'build', { env: {} }).args).toEqual([
      join(root, 'build.js'),
    ]);
  });

  it('merges every spelling of Path like npm and preserves the original environment', () => {
    setup();
    const env = {
      Path: ['/windows-bin', '/shared-bin'].join(delimiter),
      PATH: ['/shared-bin', '/other-bin'].join(delimiter),
    };
    const prepared = preparePackageScript(root, 'build', { env });
    expect(prepared.env.Path).toBe(prepared.env.PATH);
    expect(prepared.env.Path.split(delimiter).slice(-3)).toEqual([
      '/windows-bin',
      '/shared-bin',
      '/other-bin',
    ]);
    expect(env.Path).toBe(['/windows-bin', '/shared-bin'].join(delimiter));
    expect(env.PATH).toBe(['/shared-bin', '/other-bin'].join(delimiter));
  });

  it.each(['npm_config_script_shell', 'NPM_CONFIG_SCRIPT_SHELL'])(
    'retains npm when a custom shell is configured through %s',
    (key) => {
      setup();
      const env = { ...environment, [key]: '/custom shell' };

      expect(preparePackageScript(root, 'build', { env })).toEqual({
        command: process.execPath,
        args: [npmPath, 'run', 'build'],
        cwd: root,
        env,
      });
    },
  );

  it('keeps the direct path when the configured shell is empty', () => {
    setup();
    expect(
      preparePackageScript(root, 'build', {
        env: { ...environment, npm_config_script_shell: '' },
      }).args,
    ).toEqual([join(root, 'build.js')]);
  });

  it('exports npm package fields into the child while preserving unoverridden parent leaves', () => {
    setup();
    const packageJson = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    manifest(root, {
      ...packageJson,
      config: {
        enabled: true,
        disabled: false,
        missing: null,
        nested: { count: 3 },
        choices: ['first', false, { value: 'third' }],
      },
      engines: { node: '>=20' },
      bin: { example: 'dist/index.js' },
      description: 'not a lifecycle environment field',
    });
    writeFileSync(
      join(root, 'build.js'),
      'require("fs").writeFileSync("result.json", JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("npm_package_")))));',
    );
    const prepared = preparePackageScript(root, 'build', {
      env: {
        ...environment,
        npm_package_config_parent: 'retained',
        npm_package_engines_node: 'old engine',
        npm_package_bin_example: 'old entry',
      },
    });

    execFileSync(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
    });

    expect(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))).toEqual(
      {
        npm_package_json: join(root, 'package.json'),
        npm_package_name: '@example/workspace',
        npm_package_version: '1.2.3',
        npm_package_config_parent: 'retained',
        npm_package_config_enabled: 'true',
        npm_package_config_disabled: '',
        npm_package_config_missing: '',
        npm_package_config_nested_count: '3',
        npm_package_config_choices_0: 'first',
        npm_package_config_choices_1: '',
        npm_package_config_choices_2_value: 'third',
        npm_package_engines_node: '>=20',
        npm_package_bin_example: 'dist/index.js',
      },
    );
  });
});
