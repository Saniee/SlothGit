// Undo/redo, bisect, commit metadata and file edits, worktrees, and the pure helpers behind them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { commitUrl, pullRequestUrl, toWebRepo } from '../src/git/hosting';
import { buildEditorCommand, GitOps } from '../src/git/operations';
import {
  getBisectState,
  getLocalBranches,
  getLog,
  getOperation,
  getRebaseTodo,
  getWorktrees,
  type FileChange,
} from '../src/git/queries';
import { Git } from '../src/git/runner';
import { parseTodo } from '../src/git/todo';
import { planUndo } from '../src/git/undo';

function setup(commitCount = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-hist-'));
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.name', 'Test');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'commit.gpgsign', 'false');
  sh('config', 'core.autocrlf', 'false');
  const write = (file: string, content: string) => fs.writeFileSync(path.join(dir, file), content);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  const exists = (file: string) => fs.existsSync(path.join(dir, file));
  const commit = (file: string, content: string, message: string) => {
    write(file, content);
    sh('add', '.');
    sh('commit', '-q', '-m', message);
  };
  for (let i = 1; i <= commitCount; i++) commit(`f${i}.txt`, `v${i}\n`, `c${i}`);
  const git = new Git('git', dir);
  const ops = new GitOps(git, buildEditorCommand(process.execPath, path.resolve(__dirname, '../dist/rebaseEditor.js')));
  const subjects = () => sh('log', '--format=%s').split('\n');
  const sha = (subject: string) => sh('log', '--format=%H', `--grep=^${subject}$`);
  return { dir, sh, write, read, exists, commit, git, ops, subjects, sha };
}

async function undo(r: ReturnType<typeof setup>) {
  const plan = await r.ops.planUndo();
  assert.ok(plan.undo, 'expected something to undo');
  await r.ops.applyUndo(plan.undo, 'undo');
}

async function redo(r: ReturnType<typeof setup>) {
  const plan = await r.ops.planUndo();
  assert.ok(plan.redo, 'expected something to redo');
  await r.ops.applyUndo(plan.redo, 'redo');
}

// --- undo / redo -------------------------------------------------------------------

test('planUndo: pure replay of undo/redo markers and rebase grouping', () => {
  const plan = planUndo([
    { sha: 'e', subject: 'rebase (finish): returning to refs/heads/main' },
    { sha: 'd2', subject: 'rebase (pick): two' },
    { sha: 'd1', subject: 'rebase (start): checkout x' },
    { sha: 'c', subject: 'commit: c' },
    { sha: 'b', subject: 'commit: b' },
    { sha: 'a', subject: 'commit (initial): a' },
  ]);
  assert.deepEqual(plan.undo, { kind: 'reset', from: 'c', to: 'e', description: 'rebase' });
  assert.equal(plan.redo, undefined);

  const afterUndo = planUndo([
    { sha: 'b', subject: '[codegit undo]' },
    { sha: 'c', subject: 'commit: c' },
    { sha: 'b', subject: 'commit: b' },
    { sha: 'a', subject: 'commit (initial): a' },
  ]);
  assert.equal(afterUndo.undo?.to, 'b');
  assert.equal(afterUndo.redo?.to, 'c');

  const inRebase = planUndo([
    { sha: 'd1', subject: 'rebase (start): checkout x' },
    { sha: 'c', subject: 'commit: c' },
  ]);
  assert.equal(inRebase.rebaseInProgress, true);
});

test('undo and redo commits, keeping uncommitted changes', async () => {
  const r = setup();
  r.write('dirty.txt', 'keep me\n');
  await undo(r);
  assert.deepEqual(r.subjects(), ['c2', 'c1']);
  await undo(r);
  assert.deepEqual(r.subjects(), ['c1']);
  await redo(r);
  assert.deepEqual(r.subjects(), ['c2', 'c1']);
  assert.equal(r.read('dirty.txt'), 'keep me\n');
  // A new action clears the redo stack.
  r.commit('x.txt', 'x\n', 'new');
  assert.equal((await r.ops.planUndo()).redo, undefined);
});

test('undo a checkout and a whole rebase', async () => {
  const r = setup();
  r.sh('switch', '-q', '-c', 'feature');
  await undo(r);
  assert.equal(r.sh('branch', '--show-current'), 'main');
  await redo(r);
  assert.equal(r.sh('branch', '--show-current'), 'feature');

  const before = r.sh('rev-parse', 'HEAD');
  await r.ops.drop([r.sha('c2')]);
  assert.deepEqual(r.subjects(), ['c3', 'c1']);
  await undo(r);
  assert.equal(r.sh('rev-parse', 'HEAD'), before);
});

// --- commit metadata and files --------------------------------------------------------

test('fixup commit and autosquash', async () => {
  const r = setup();
  r.write('f1.txt', 'fixed\n');
  r.sh('add', '.');
  await r.ops.createFixupCommit(r.sha('c1'));
  assert.equal(r.subjects()[0], 'fixup! c1');
  await r.ops.autosquash(r.sha('c1'));
  assert.deepEqual(r.subjects(), ['c3', 'c2', 'c1']);
  assert.equal(r.sh('show', `${r.sha('c1')}:f1.txt`), 'fixed');
  await assert.rejects(r.ops.createFixupCommit(r.sha('c1')), /Stage the changes/);
});

test('reset author, set author and add co-author on older commits and HEAD', async () => {
  const r = setup();
  await r.ops.setAuthor(r.sha('c2'), 'Someone Else <else@example.com>');
  assert.equal(r.sh('log', '-1', '--format=%an <%ae>', r.sha('c2')), 'Someone Else <else@example.com>');
  await r.ops.resetAuthor(r.sha('c2'));
  assert.equal(r.sh('log', '-1', '--format=%an', r.sha('c2')), 'Test');
  await r.ops.addCoAuthor(r.sha('c3'), 'Pair <pair@example.com>');
  assert.match(r.sh('log', '-1', '--format=%B', 'HEAD'), /Co-authored-by: Pair <pair@example.com>/);
  assert.deepEqual(r.subjects(), ['c3', 'c2', 'c1']);
  assert.equal(await getOperation(r.git), undefined);
});

test('remove a file from an older commit, discarding or keeping the change', async () => {
  const r = setup();
  r.write('f1.txt', 'changed in c4\n');
  r.write('extra.txt', 'extra\n');
  r.sh('add', '.');
  r.sh('commit', '-q', '-m', 'c4');
  r.commit('f3.txt', 'v3 later\n', 'c5');
  r.write('dirty.txt', 'untouched\n');

  const changes: FileChange[] = [{ status: 'M', path: 'f1.txt' }, { status: 'A', path: 'extra.txt' }];
  // Discard: c4 no longer touches either file.
  await r.ops.removeFilesFromCommit(r.sha('c4'), [changes[0]], false);
  assert.equal(r.sh('show', '--name-only', '--format=', r.sha('c4')), 'extra.txt');
  assert.equal(r.read('f1.txt'), 'v1\n');

  // Keep: extra.txt leaves the commit but ends up staged in the working tree.
  const result = await r.ops.removeFilesFromCommit(r.sha('c4'), [changes[1]], true);
  assert.equal(result, undefined);
  assert.equal(r.sh('show', '--name-only', '--format=', r.sha('c4')), '');
  assert.equal(r.read('extra.txt'), 'extra\n');
  assert.equal(r.sh('diff', '--cached', '--name-only'), 'extra.txt');
  assert.equal(r.read('dirty.txt'), 'untouched\n');
  assert.deepEqual(r.subjects(), ['c5', 'c4', 'c3', 'c2', 'c1']);
});

test('checkout a file from an older commit', async () => {
  const r = setup();
  r.commit('f1.txt', 'new\n', 'c4');
  await r.ops.checkoutFileFrom(r.sha('c1'), 'f1.txt');
  assert.equal(r.read('f1.txt'), 'v1\n');
});

// --- bisect ------------------------------------------------------------------------------

test('bisect finds the first bad commit', async () => {
  const r = setup(6);
  // Look SHAs up front: bisect moves HEAD, and r.sha() searches from HEAD.
  const [c1, bad, c6] = [r.sha('c1'), r.sha('c4'), r.sha('c6')];
  assert.equal(await getBisectState(r.git), undefined);
  await r.ops.bisectMark(c6, 'bad');
  let message = await r.ops.bisectMark(c1, 'good');
  const state = await getBisectState(r.git);
  assert.equal(state?.start, 'main');
  assert.equal(state?.bad, c6);
  assert.deepEqual(state?.good, [c1]);

  // Answer the questions git asks until it names the culprit: a commit is bad if it contains c4.
  const containsBad = (head: string) => r.sh('rev-list', head).split('\n').includes(bad);
  for (let i = 0; i < 5 && !/is the first '?bad'? commit/.test(message); i++) {
    const head = r.sh('rev-parse', 'HEAD');
    message = await r.ops.bisectMark(head, containsBad(head) ? 'bad' : 'good');
  }
  assert.match(message, new RegExp(`${bad} is the first '?bad'? commit`));
  await r.ops.bisectReset();
  assert.equal(await getBisectState(r.git), undefined);
  assert.equal(r.sh('branch', '--show-current'), 'main');
});

// --- rebase todo ------------------------------------------------------------------------

test('parseTodo and reading the todo of a paused rebase', async () => {
  assert.deepEqual(parseTodo('pick abc1234 one\nf def5678 # two\n# comment\nexec make\n'), [
    { action: 'pick', sha: 'abc1234', subject: 'one' },
    { action: 'fixup', sha: 'def5678', subject: 'two' },
  ]);
  const r = setup(4);
  await r.ops.edit(r.sha('c2'));
  const todo = await getRebaseTodo(r.git);
  assert.deepEqual(
    todo.map((t) => [t.action, t.subject]),
    [
      ['pick', 'c3'],
      ['pick', 'c4'],
    ],
  );
  await r.ops.abortOperation('rebase');
});

// --- branches & worktrees -----------------------------------------------------------------

test('branches sorted by recent checkout; merged branches', async () => {
  const r = setup(1);
  r.sh('branch', 'old');
  r.sh('branch', 'newer');
  r.sh('switch', '-q', 'old');
  r.sh('switch', '-q', 'newer');
  r.sh('switch', '-q', 'main');
  assert.deepEqual((await getLocalBranches(r.git, 'recency')).map((b) => b.name), ['main', 'newer', 'old']);
  assert.deepEqual((await getLocalBranches(r.git, 'name')).map((b) => b.name), ['main', 'newer', 'old']);
  r.sh('switch', '-q', '-c', 'unmerged');
  r.commit('u.txt', 'u\n', 'u');
  r.sh('switch', '-q', 'main');
  assert.deepEqual((await r.ops.mergedBranches()).sort(), ['newer', 'old']);
});

test('worktrees: add, list, remove', async () => {
  const r = setup(1);
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-wt-')), 'feature');
  await r.ops.addWorktree(wt, { newBranch: 'feature', start: 'HEAD' });
  let worktrees = await getWorktrees(r.git);
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees[0].main, true);
  assert.equal(worktrees[0].current, true);
  assert.equal(worktrees[1].branch, 'feature');
  assert.equal(path.resolve(worktrees[1].path), path.resolve(wt));
  // The branch shows where it is checked out.
  const feature = (await getLocalBranches(r.git)).find((b) => b.name === 'feature');
  assert.equal(path.resolve(feature!.worktreePath!), path.resolve(wt));

  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x');
  await assert.rejects(r.ops.removeWorktree(wt, false));
  await r.ops.removeWorktree(wt, true);
  worktrees = await getWorktrees(r.git);
  assert.equal(worktrees.length, 1);
});

test('log filtered by path', async () => {
  const r = setup(3);
  r.commit('f1.txt', 'again\n', 'c4');
  assert.deepEqual((await getLog(r.git, 10, 'HEAD', ['f1.txt'])).map((c) => c.subject), ['c4', 'c1']);
});

// --- hosting -------------------------------------------------------------------------------

test('web URLs for common hosts', () => {
  const gh = toWebRepo('git@github.com:owner/repo.git')!;
  assert.deepEqual(gh, { url: 'https://github.com/owner/repo', kind: 'github' });
  assert.equal(toWebRepo('https://user@github.com/owner/repo.git')!.url, 'https://github.com/owner/repo');
  assert.equal(toWebRepo('ssh://git@gitlab.example.com:2222/group/sub/repo.git')!.url, 'https://gitlab.example.com/group/sub/repo');
  assert.equal(commitUrl(gh, 'abc'), 'https://github.com/owner/repo/commit/abc');
  assert.equal(pullRequestUrl(gh, 'feature/x', 'main'), 'https://github.com/owner/repo/compare/main...feature/x?expand=1');

  const gl = toWebRepo('git@gitlab.com:group/repo.git')!;
  assert.equal(gl.kind, 'gitlab');
  assert.equal(commitUrl(gl, 'abc'), 'https://gitlab.com/group/repo/-/commit/abc');
  assert.equal(
    pullRequestUrl(gl, 'feat'),
    'https://gitlab.com/group/repo/-/merge_requests/new?merge_request[source_branch]=feat',
  );

  const az = toWebRepo('git@ssh.dev.azure.com:v3/org/proj/repo')!;
  assert.deepEqual(az, { url: 'https://dev.azure.com/org/proj/_git/repo', kind: 'azure' });
  assert.equal(toWebRepo('https://org@dev.azure.com/org/proj/_git/repo')!.url, 'https://dev.azure.com/org/proj/_git/repo');

  const bb = toWebRepo('git@bitbucket.org:team/repo.git')!;
  assert.equal(commitUrl(bb, 'abc'), 'https://bitbucket.org/team/repo/commits/abc');
  assert.equal(toWebRepo('/local/path/repo'), undefined);
});
