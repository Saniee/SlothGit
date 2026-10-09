import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number,
    readonly args: readonly string[],
  ) {
    super(message);
  }
}

export interface ExecOptions {
  env?: Record<string, string>;
  /** Exit codes that resolve instead of throwing. */
  allowedExitCodes?: number[];
  /** Written to stdin; otherwise stdin is closed. */
  input?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Thin wrapper around the git CLI, bound to one repository. Has no vscode dependency so it can be tested with plain node. */
export class Git {
  constructor(
    readonly gitPath: string,
    readonly cwd: string,
  ) {}

  exec(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.gitPath,
        args,
        {
          cwd: this.cwd,
          env: { ...process.env, ...options.env },
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          if (error && !options.allowedExitCodes?.includes(exitCode)) {
            const detail = (stderr || stdout).trim() || error.message;
            reject(new GitError(detail, stderr, exitCode, args));
          } else {
            resolve({ stdout, stderr, exitCode });
          }
        },
      );
      child.stdin?.end(options.input);
    });
  }

  async run(args: string[], options?: ExecOptions): Promise<string> {
    return (await this.exec(args, options)).stdout;
  }
}
