// Launches the installed VS Code with CodeGit loaded from this folder, against a scratch repository,
// and runs test/smoke/index.ts inside it. Uses a throwaway profile, so your own settings are untouched.
//
//   npm run smoke                      (set CODE_PATH to override the VS Code executable)
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build, root, runInVSCode } from './vscode-run.mjs';

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
build();
const result = await runInVSCode({
  tag: 'smoke',
  workspace: repo,
  testsPath: path.join(root, 'out-test', 'smoke', 'index.js'),
  profile: tmp,
  timeout: 180_000,
});

const ok = fs.existsSync(path.join(repo, '.smoke-ok'));
console.log(ok ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (exit ${result.status})`);
process.exit(ok ? 0 : 1);
