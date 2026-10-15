/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeEach,
  type Mock,
} from 'vitest';
import { getIdeProcessInfo } from './process-utils.js';
import os from 'node:os';

const { mockedExec, mockedExecFile } = vi.hoisted(() => ({
  mockedExec: vi.fn(),
  mockedExecFile: vi.fn(),
}));
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  const { execFile } = await import('node:child_process');
  return {
    ...actual,
    promisify: vi.fn((fn: unknown) =>
      fn === execFile ? mockedExecFile : mockedExec,
    ),
  };
});
vi.mock('node:os', () => ({
  default: {
    platform: vi.fn(),
  },
}));

describe('getIdeProcessInfo', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
    mockedExec.mockReset();
    mockedExecFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('GEMINI_CLI_IDE_PID override', () => {
    it('should use GEMINI_CLI_IDE_PID and fetch command on Unix', async () => {
      (os.platform as Mock).mockReturnValue('linux');
      vi.stubEnv('GEMINI_CLI_IDE_PID', '12345');
      mockedExec.mockResolvedValueOnce({ stdout: '0 my-ide-command' }); // getProcessInfo result

      const result = await getIdeProcessInfo();

      expect(result).toEqual({ pid: 12345, command: 'my-ide-command' });
      expect(mockedExec).toHaveBeenCalledWith(
        expect.stringContaining('ps -o ppid=,command= -p 12345'),
        { timeout: 3000 },
      );
    });

    it('should use GEMINI_CLI_IDE_PID and fetch command on Windows', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      vi.stubEnv('GEMINI_CLI_IDE_PID', '54321');
      const processes = [
        {
          ProcessId: 54321,
          ParentProcessId: 0,
          Name: 'Code.exe',
          CommandLine: 'C:\\Program Files\\VSCode\\Code.exe',
        },
      ];
      mockedExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify(processes),
      });

      const result = await getIdeProcessInfo();

      expect(result).toEqual({
        pid: 54321,
        command: 'C:\\Program Files\\VSCode\\Code.exe',
      });
      expect(mockedExecFile).toHaveBeenCalledExactlyOnceWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
        ],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 5000,
          windowsHide: true,
        },
      );
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe('on Unix', () => {
    afterEach(() => {
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it('should traverse up to find the shell and return grandparent process info', async () => {
      (os.platform as Mock).mockReturnValue('linux');
      // process (1000) -> shell (800) -> IDE (700)
      mockedExec
        .mockResolvedValueOnce({ stdout: '800 /bin/bash' }) // pid 1000 -> ppid 800 (shell)
        .mockResolvedValueOnce({ stdout: '700 /usr/lib/vscode/code' }) // pid 800 -> ppid 700 (IDE)
        .mockResolvedValueOnce({ stdout: '700 /usr/lib/vscode/code' }); // get command for pid 700

      const result = await getIdeProcessInfo();

      expect(result).toEqual({ pid: 700, command: '/usr/lib/vscode/code' });
    });

    it('should return parent process info if grandparent lookup fails', async () => {
      (os.platform as Mock).mockReturnValue('linux');
      mockedExec
        .mockResolvedValueOnce({ stdout: '800 /bin/bash' }) // pid 1000 -> ppid 800 (shell)
        .mockRejectedValueOnce(new Error('ps failed')) // lookup for ppid of 800 fails
        .mockResolvedValueOnce({ stdout: '800 /bin/bash' }); // get command for pid 800

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 800, command: '/bin/bash' });
    });

    it('should handle timeout when ps command hangs or rejects during getProcessInfo', async () => {
      (os.platform as Mock).mockReturnValue('linux');
      const timeoutError = new Error('exec timeout');
      Object.assign(timeoutError, {
        killed: true,
        code: undefined,
        signal: 'SIGTERM',
      });
      mockedExec.mockRejectedValue(timeoutError);

      const result = await getIdeProcessInfo();

      expect(result).toEqual({ pid: 1000, command: '' });
    });
  });

  describe('on Windows', () => {
    afterEach(() => {
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it('should traverse up and find the great-grandchild of the root process', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      // process (1000) -> powershell (900) -> code (800) -> wininit (700) -> root (0)
      // Ancestors: [1000, 900, 800, 700]
      // Target (great-grandchild of root): 900
      const processes = [
        {
          ProcessId: 1000,
          ParentProcessId: 900,
          Name: 'node.exe',
          CommandLine: 'node.exe',
        },
        {
          ProcessId: 900,
          ParentProcessId: 800,
          Name: 'powershell.exe',
          CommandLine: 'powershell.exe',
        },
        {
          ProcessId: 800,
          ParentProcessId: 700,
          Name: 'code.exe',
          CommandLine: 'code.exe',
        },
        {
          ProcessId: 700,
          ParentProcessId: 0,
          Name: 'wininit.exe',
          CommandLine: 'wininit.exe',
        },
      ];
      mockedExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify(processes),
      });

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 900, command: 'powershell.exe' });
      expect(mockedExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          expect.stringContaining('Get-CimInstance Win32_Process'),
        ],
        expect.objectContaining({ timeout: 5000, windowsHide: true }),
      );
    });

    it('should handle short process chains', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      // process (1000) -> root (0)
      const processes = [
        {
          ProcessId: 1000,
          ParentProcessId: 0,
          Name: 'node.exe',
          CommandLine: 'node.exe',
        },
      ];
      mockedExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify(processes),
      });

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 1000, command: 'node.exe' });
    });

    it('should handle PowerShell failure gracefully', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      mockedExecFile.mockRejectedValueOnce(new Error('PowerShell failed'));

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 1000, command: '' });
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    it('should handle malformed JSON output gracefully', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      mockedExecFile.mockResolvedValueOnce({ stdout: '{"invalid":json}' });

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 1000, command: '' });
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    it('does not launch a Unix lookup when the snapshot omits this process', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      mockedExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            ProcessId: 900,
            ParentProcessId: 0,
            Name: 'Code.exe',
            CommandLine: 'Code.exe',
          },
        ]),
      });

      const result = await getIdeProcessInfo();

      expect(result).toEqual({ pid: 1000, command: '' });
      expect(mockedExecFile).toHaveBeenCalledOnce();
    });

    it('should handle single process output from ConvertTo-Json', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      const process = {
        ProcessId: 1000,
        ParentProcessId: 0,
        Name: 'node.exe',
        CommandLine: 'node.exe',
      };
      mockedExecFile.mockResolvedValueOnce({ stdout: JSON.stringify(process) });

      const result = await getIdeProcessInfo();
      expect(result).toEqual({ pid: 1000, command: 'node.exe' });
    });

    it('should handle missing process in map during traversal', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      // process (1000) -> parent (900) -> missing (800)
      const processes = [
        {
          ProcessId: 1000,
          ParentProcessId: 900,
          Name: 'node.exe',
          CommandLine: 'node.exe',
        },
        {
          ProcessId: 900,
          ParentProcessId: 800,
          Name: 'parent.exe',
          CommandLine: 'parent.exe',
        },
      ];
      mockedExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify(processes),
      });

      const result = await getIdeProcessInfo();
      // Ancestors: [1000, 900]. Length < 3, returns last (900)
      expect(result).toEqual({ pid: 900, command: 'parent.exe' });
    });
  });
});
