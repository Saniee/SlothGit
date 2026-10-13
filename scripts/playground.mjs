// Builds a throwaway repository with a scenario for every SlothGit feature, for manual testing.
// Everything is local: the "remotes" are bare repositories next to it, so pushing and fetching are safe.
//
//   npm run playground                  (creates ../slothgit-playground)
//   npm run playground -- <folder>      (somewhere else; re-running replaces a previous playground)
//
// See TESTING.md for what to try in it.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '.slothgit-playground';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.argv[2] ?? path.join(project, '..', 'slothgit-playground'));

if (fs.existsSync(root)) {
  if (!fs.existsSync(path.join(root, MARKER))) {
    console.error(`${root} exists and is not a SlothGit playground; refusing to touch it.`);
    process.exit(1);
  }
  // Clear the contents (worktrees included) but keep the folder, which may be some shell's cwd.
  try {
    // The marker goes last, so a reset that fails halfway can be retried.
    const entries = fs.readdirSync(root).filter((e) => e !== MARKER).concat(MARKER);
    for (const entry of entries) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  } catch (err) {
    console.error(`Could not reset ${root}: ${err.code ?? err.message}.\nClose VS Code windows and terminals using it, then run again.`);
    process.exit(1);
  }
}
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, MARKER), 'Created by scripts/playground.mjs; safe to delete.\n');

const repo = path.join(root, 'repo');
const origin = path.join(root, 'origin.git');
const upstream = path.join(root, 'upstream.git');
fs.mkdirSync(repo);

// Commits get increasing timestamps so "sort by date" is predictable.
let clock = Date.parse('2026-01-05T09:00:00Z') / 1000;
const ME = { name: 'Playground User', email: 'you@example.com' };

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();
}
const g = (...args) => git(repo, args);

function write(files) {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(repo, file);
    if (text === null) {
      fs.rmSync(full);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

function commit(message, files = {}, { author = ME, extra = [] } = {}) {
  write(files);
  g('add', '-A');
  clock += 3600;
  const date = `${clock} +0000`;
  git(repo, ['commit', '-q', '--allow-empty', '-m', message, ...extra], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return g('rev-parse', 'HEAD');
}

const app = (...lines) => lines.join('\n') + '\n';

// --- setup ---------------------------------------------------------------------------------
git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
git(root, ['init', '-q', '--bare', '-b', 'main', upstream]);
g('init', '-q', '-b', 'main');
for (const [k, v] of [
  ['user.name', ME.name],
  ['user.email', ME.email],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['core.autocrlf', 'false'],
]) {
  g('config', k, v);
}
g('remote', 'add', 'origin', origin);
g('remote', 'add', 'upstream', upstream);

// --- main: pushed history (green), with a bug introduced in the middle for bisect ----------
commit('Initial commit', { 'README.md': '# Playground\n', 'app.txt': app('status: ok', 'version: 1') });
commit('Add config', { 'config.json': '{ "debug": false }\n' });
g('tag', 'v0.9'); // lightweight
commit('Add login page', { 'login.txt': 'login form\n' });
commit('Add logout', { 'logout.txt': 'logout button\n' });
commit('Refactor parser', { 'app.txt': app('status: BUG', 'version: 1'), 'parser.txt': 'parser v2\n' });
commit('Update docs', { 'README.md': '# Playground\n\nNow with docs.\n' });
commit('Rename logout to signout', { 'logout.txt': null, 'signout.txt': 'logout button\n' });
commit('Bump version', { 'app.txt': app('status: BUG', 'version: 2') });
clock += 60;
git(repo, ['tag', '-a', 'v1.0', '-m', 'Release 1.0'], { GIT_COMMITTER_DATE: `${clock} +0000` });
const v1 = g('rev-parse', 'HEAD');
g('branch', 'merged/old-experiment', 'HEAD~3'); // already contained in main: "Delete merged branches"
g('push', '-q', '-u', 'origin', 'main', 'v1.0');
g('push', '-q', 'upstream', 'main');

// --- side branches -------------------------------------------------------------------------
// Pushed feature branch with one unpushed commit (ahead 1).
g('switch', '-q', '-c', 'feature/login', v1);
commit('Login: validate input', { 'login.txt': 'login form\nvalidation\n' });
commit('Login: remember me', { 'login.txt': 'login form\nvalidation\nremember me\n' });
g('push', '-q', '-u', 'origin', 'feature/login');
commit('Login: error messages', { 'login.txt': 'login form\nvalidation\nremember me\nerrors\n' });

// Stacked on feature/login: "rebase only my commits" with a marked base.
g('switch', '-q', '-c', 'feature/login-ui');
commit('Login UI: layout', { 'login-ui.txt': 'layout\n' });
commit('Login UI: colors', { 'login-ui.txt': 'layout\ncolors\n' });

// Conflicts with main when rebased or merged (both edit app.txt line 1).
g('switch', '-q', '-c', 'conflict/status-line', 'v1.0~4');
commit('Change status line', { 'app.txt': app('status: maintenance', 'version: 1') });

// fixup!/squash! commits for "Squash Fixup Commits Above" (autosquash).
g('switch', '-q', '-c', 'feature/search', v1);
const search = commit('Add search', { 'search.txt': 'search box\n' });
commit('Add filters', { 'filters.txt': 'filters\n' });
commit('', { 'search.txt': 'search box\nfixed typo\n' }, { extra: [`--fixup=${search}`] });
commit('Add sorting', { 'sorting.txt': 'sorting\n' });

// Contains a merge commit: rewrites below it recreate the merge; the merge itself can be reworded, dropped or reverted.
g('switch', '-q', '-c', 'feature/with-merge', v1);
commit('Side work', { 'side.txt': 'side\n' });
g('switch', '-q', '-c', 'feature/merged-in', v1);
commit('Merged-in work', { 'merged-in.txt': 'merged in\n' });
g('switch', '-q', 'feature/with-merge');
clock += 3600;
git(repo, ['merge', '-q', '--no-ff', '--no-edit', 'feature/merged-in'], {
  GIT_AUTHOR_DATE: `${clock} +0000`,
  GIT_COMMITTER_DATE: `${clock} +0000`,
});
commit('After merge', { 'side.txt': 'side\nafter merge\n' });

// Upstream deleted on the remote: shows "upstream gone".
g('switch', '-q', '-c', 'chore/gone-upstream', v1);
commit('Short-lived chore', { 'chore.txt': 'chore\n' });
g('push', '-q', '-u', 'origin', 'chore/gone-upstream');
g('push', '-q', 'origin', '--delete', 'chore/gone-upstream');

// Only on the remote: "Checkout" creates a tracking branch.
g('switch', '-q', '-c', 'remote-only', v1);
commit('Work only on the remote', { 'remote-only.txt': 'remote\n' });
g('push', '-q', 'origin', 'remote-only');
g('switch', '-q', 'main');
g('branch', '-q', '-D', 'remote-only');

// Behind its upstream: "Fast-forward" without checking it out.
g('switch', '-q', '-c', 'release/1.x', 'v1.0~1');
g('push', '-q', '-u', 'origin', 'release/1.x');
g('push', '-q', 'origin', 'v1.0^{commit}:refs/heads/release/1.x');
g('fetch', '-q', '--prune', 'origin');

// Checked out in a second worktree.
g('switch', '-q', 'main');
g('worktree', 'add', '-q', '-b', 'hotfix/crash', path.join(root, 'hotfix-worktree'), v1);
git(path.join(root, 'hotfix-worktree'), ['commit', '-q', '--allow-empty', '-m', 'Hotfix: placeholder']);

// --- main: unpushed commits (yellow), different author, multi-line message, multi-file -----
g('switch', '-q', 'main');
commit('Add settings page', { 'settings.txt': 'settings\n', 'config.json': '{ "debug": true }\n' });
commit('Fix typo in docs', { 'README.md': '# Playground\n\nNow with documentation.\n' }, {
  author: { name: 'Someone Else', email: 'else@example.com' },
});
commit(
  'Add profile page\n\nThis commit has a longer message body,\nwhich "Reword in Editor" shows in full.\n\nRefs: #42',
  { 'profile.txt': 'profile\n', 'avatar.txt': 'avatar\n', 'README.md': '# Playground\n\nNow with documentation and profiles.\n' },
);

// --- stashes and a dirty working tree ------------------------------------------------------
write({ 'settings.txt': 'settings\nwork in progress\n', 'scratch.txt': 'untracked\n' });
g('stash', 'push', '-q', '--include-untracked', '-m', 'WIP settings + untracked file');
write({ 'profile.txt': 'profile\nstaged change\n' });
g('add', 'profile.txt');
g('stash', 'push', '-q', '--staged', '-m', 'Only staged changes');

write({ 'notes.txt': 'staged new file\n' });
g('add', 'notes.txt');
write({ 'README.md': '# Playground\n\nNow with documentation and profiles.\n\nUnstaged edit.\n' });

console.log(`
SlothGit playground ready:  ${repo}

Open it with:
  code "${repo}"

Remotes "origin" and "upstream" are bare repositories in ${root}, so push/fetch/delete are safe.
Re-run this script any time to reset it. See TESTING.md for what to try.
`);
