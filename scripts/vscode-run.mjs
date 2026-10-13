// Shared by smoke.mjs and e2e.mjs: runs a compiled test module inside the installed VS Code, with SlothGit
// loaded from this folder and a throwaway profile, so your own settings and extensions are untouched.
import { execFileSync, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findCode() {
  if (process.env.CODE_PATH) return process.env.CODE_PATH;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code', '/usr/bin/code'];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('VS Code not found; set CODE_PATH.');
  return found;
}

export function build() {
  execFileSync('node', ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync('node', ['esbuild.mjs', '--tests'], { cwd: root, stdio: 'inherit' });
}

/**
 * Opens `workspace` in VS Code, runs `testsPath` (a module exporting `run()`) and resolves with the exit code
 * once VS Code closes. Only lines starting with `[<tag>]` are printed; VS Code's own output goes to
 * `<profile>/vscode.log`. `profile` is a scratch folder for the user data and extensions directories.
 */
export function runInVSCode({ workspace, testsPath, profile, timeout, tag, env: extraEnv = {} }) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE; // set when launched from a VS Code terminal; would make Code.exe act as node
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];

  const code = findCode();
  const logFile = path.join(profile, 'vscode.log');
  console.log(`Running ${tag} tests in a separate VS Code window (${code}).`);
  console.log(`Workspace: ${workspace}\nVS Code output: ${logFile}\n`);
  const log = fs.createWriteStream(logFile);
  const child = spawn(
    code,
    [
      workspace,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${testsPath}`,
      `--user-data-dir=${path.join(profile, 'user-data')}`,
      `--extensions-dir=${path.join(profile, 'extensions')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--new-window',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => {
      log.write(`${line}\n`);
      if (line.startsWith(`[${tag}]`)) console.log(line.slice(tag.length + 3));
    });
  }
  // If this script is stopped, don't leave the test window running.
  const stop = () => child.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  const timer = setTimeout(() => {
    console.log(`Timed out after ${timeout / 1000} s; closing VS Code.`);
    child.kill();
  }, timeout);
  return new Promise((resolve) => {
    child.on('exit', (status) => {
      clearTimeout(timer);
      log.end();
      resolve({ status });
    });
  });
}
