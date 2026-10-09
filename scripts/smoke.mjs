// Launches the installed VS Code with CodeGit loaded from this folder, against a scratch repository,
// and runs test/smoke/index.ts inside it. Uses a throwaway profile, so your own settings are untouched.
//
//   npm run smoke                      (set CODE_PATH to override the VS Code executable)
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findCode() {
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

// --- scratch repository with something in every view ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-smoke-'));
const repo = path.join(tmp, 'repo');
const origin = path.join(tmp, 'origin.git');
fs.mkdirSync(repo);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);

git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(repo, 'init', '-q', '-b', 'main');
for (const [k, v] of [['user.name', 'Smoke'], ['user.email', 'smoke@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
  git(repo, 'config', k, v);
}
for (let i = 1; i <= 5; i++) {
  write('a.txt', `a${i}\n`);
  write(`f${i}.txt`, `f${i}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', `commit ${i}`);
}
git(repo, 'remote', 'add', 'origin', origin);
git(repo, 'push', '-q', '-u', 'origin', 'main');
git(repo, 'tag', '-a', 'v1', '-m', 'release 1');
git(repo, 'switch', '-q', '-c', 'feature');
write('feature.txt', 'feature\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'feature work');
git(repo, 'push', '-q', '-u', 'origin', 'feature');
git(repo, 'switch', '-q', 'main');
git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', path.join(tmp, 'wt'));
write('a.txt', 'stashed\n');
write('untracked.txt', 'u\n');
git(repo, 'stash', 'push', '-q', '--include-untracked', '-m', 'smoke stash');

// main is one commit behind origin, for the Pull button.
const other = path.join(tmp, 'other');
git(tmp, 'clone', '-q', origin, other);
for (const [k, v] of [['user.name', 'Other'], ['user.email', 'other@example.com'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
fs.writeFileSync(path.join(other, 'remote.txt'), 'r\n');
git(other, 'add', '.');
git(other, 'commit', '-q', '-m', 'upstream change');
git(other, 'push', '-q', 'origin', 'main');
git(repo, 'fetch', '-q', 'origin');

// --- run ---------------------------------------------------------------------------------
execFileSync('node', ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['esbuild.mjs', '--tests'], { cwd: root, stdio: 'inherit' });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set when launched from a VS Code terminal; would make Code.exe act as node
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];

const code = findCode();
console.log(`Running smoke test with ${code}\nRepository: ${repo}`);
const result = spawnSync(
  code,
  [
    repo,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out-test', 'smoke', 'index.js')}`,
    `--user-data-dir=${path.join(tmp, 'user-data')}`,
    `--extensions-dir=${path.join(tmp, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
  ],
  { env, stdio: 'inherit', timeout: 180_000 },
);

const ok = fs.existsSync(path.join(repo, '.smoke-ok'));
console.log(ok ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (exit ${result.status}${result.error ? `, ${result.error.message}` : ''})`);
process.exit(ok ? 0 : 1);
