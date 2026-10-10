// Undo/redo, bisect, commit metadata and file edits, worktrees, and the pure helpers behind them.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { parseRefs } from '../src/git/graph';
import { commitUrl, pullRequestUrl, toWebRepo } from '../src/git/hosting';
import { buildEditorCommand, GitOps } from '../src/git/operations';
import {
  getBisectState,
  getLocalBranches,
  getLog,
  getOperation,
  getRebaseTodo,
  getWorktrees,
  notOnHead,
  type FileChange,
} from '../src/git/queries';
import { Git } from '../src/git/runner';
import { parseTodo } from '../src/git/todo';
import { planUndo } from '../src/git/undo';
import { concurrency, git, newRepo, writeFile } from './repo';

function setup(commitCount = 3) {
  const commitIn = (dir: string, file: string, content: string, message: string) => {
    writeFile(dir, file, content);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
  };
  const dir = newRepo(`${commitCount}`, (dir) => {
    for (let i = 1; i <= commitCount; i++) commitIn(dir, `f${i}.txt`, `v${i}\n`, `c${i}`);
  });
  const sh = (...args: string[]) => git(dir, ...args);
  const write = (file: string, content: string) => writeFile(dir, file, content);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  const exists = (file: string) => fs.existsSync(path.join(dir, file));
  const commit = (file: string, content: string, message: string) => commitIn(dir, file, content, message);
  const repo = new Git('git', dir);
  const ops = new GitOps(repo, buildEditorCommand(process.execPath, path.resolve(__dirname, '../dist/rebaseEditor.js')));
  const subjects = () => sh('log', '--format=%s').split('\n');
  const sha = (subject: string) => sh('log', '--format=%H', `--grep=^${subject}$`);
  return { dir, sh, write, read, exists, commit, git: repo, ops, subjects, sha };
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

describe('history', { concurrency }, () => {
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
    const commitThenReset = (subject: string) =>
      planUndo([
        { sha: 'c', subject },
        { sha: 'b', subject: 'commit: b' },
      ]).undo?.kind;
    assert.equal(commitThenReset('commit: c'), 'commit');
    assert.equal(commitThenReset('commit (amend): c'), 'commit');
    assert.equal(commitThenReset('reset: moving to HEAD~1'), 'reset');
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

  test('undo and redo commits: undone changes come back staged, uncommitted changes are kept', async () => {
    const r = setup();
    r.write('dirty.txt', 'keep me\n');
    await undo(r);
    assert.deepEqual(r.subjects(), ['c2', 'c1']);
    assert.equal(r.sh('diff', '--cached', '--name-only'), 'f3.txt');
    await undo(r);
    assert.deepEqual(r.subjects(), ['c1']);
    assert.equal(r.sh('diff', '--cached', '--name-only'), 'f2.txt\nf3.txt');
    await redo(r);
    assert.deepEqual(r.subjects(), ['c2', 'c1']);
    assert.equal(r.sh('diff', '--cached', '--name-only'), 'f3.txt');
    await redo(r);
    assert.deepEqual(r.subjects(), ['c3', 'c2', 'c1']);
    assert.equal(r.sh('diff', '--cached', '--name-only'), '');
    assert.equal(r.read('dirty.txt'), 'keep me\n');
    // A new action clears the redo stack.
    r.commit('x.txt', 'x\n', 'new');
    assert.equal((await r.ops.planUndo()).redo, undefined);
  });

  test('undo an amend leaves the amendment staged', async () => {
    const r = setup();
    const before = r.sh('rev-parse', 'HEAD');
    r.write('f3.txt', 'amended\n');
    r.sh('commit', '-q', '-a', '--amend', '--no-edit');
    await undo(r);
    assert.equal(r.sh('rev-parse', 'HEAD'), before);
    assert.equal(r.sh('diff', '--cached', '--name-only'), 'f3.txt');
    assert.equal(r.read('f3.txt'), 'amended\n');
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

  test('log search by message, author and SHA; all branches; commits not on HEAD', async () => {
    const r = setup(3);
    r.sh('switch', '-q', '-c', 'side', 'HEAD~1');
    r.write('side.txt', 'side\n');
    r.sh('add', '.');
    r.sh('-c', 'user.name=Grace Hopper', 'commit', '-q', '-m', 'Side quest');
    const side = r.sh('rev-parse', 'HEAD');
    r.sh('switch', '-q', 'main');
    const subjects = (commits: { subject: string }[]) => commits.map((c) => c.subject);

    assert.deepEqual(subjects(await getLog(r.git, 10)), ['c3', 'c2', 'c1'], 'HEAD only by default');
    const all = await getLog(r.git, 10, 'HEAD', [], { all: true });
    assert.deepEqual(new Set(subjects(all)), new Set(['Side quest', 'c3', 'c2', 'c1']));
    assert.ok(all.findIndex((c) => c.subject === 'Side quest') < all.findIndex((c) => c.subject === 'c2'), 'children before parents');

    assert.deepEqual(subjects(await getLog(r.git, 10, 'HEAD', [], { search: 'C2' })), ['c2'], 'message, case-insensitive');
    assert.deepEqual(subjects(await getLog(r.git, 10, 'HEAD', [], { search: 'grace', all: true })), ['Side quest'], 'author');
    assert.deepEqual(subjects(await getLog(r.git, 10, 'HEAD', [], { search: side.slice(0, 8) })), ['Side quest'], 'SHA prefix');
    assert.deepEqual(subjects(await getLog(r.git, 10, 'HEAD', [], { search: 'c[2' })), [], 'text, not a regex');

    const others = await notOnHead(r.git, all.map((c) => c.sha));
    assert.deepEqual([...others], [side]);
  });

  test('graph refs from git log decorations', () => {
    assert.deepEqual(parseRefs(['HEAD -> main', 'origin/main', 'origin/HEAD', 'tag: v1.0', 'feature/x', 'up/stream'], ['origin', 'up']), [
      { name: 'main', kind: 'head' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
      { name: 'feature/x', kind: 'local' },
      { name: 'up/stream', kind: 'remote' },
    ]);
  });

  // --- hosting -------------------------------------------------------------------------------

  test('web URLs for common hosts', () => {
    const gh = toWebRepo('git@github.com:owner/repo.git')!;
    assert.deepEqual(gh, { url: 'https://github.com/owner/repo', kind: 'github' });
    assert.equal(toWebRepo('https://user@github.com/owner/repo.git')!.url, 'https://github.com/owner/repo');
    assert.equal(toWebRepo('ssh://git@gitlab.example.com:2222/group/sub/repo.git')!.url, 'https://gitlab.example.com/group/sub/repo');
    assert.equal(commitUrl(gh, 'abc'), 'https://github.com/owner/repo/commit/abc');
    // Local remotes have no web page (and "C:" is not a host).
    for (const local of ['C:\\work\\origin.git', 'C:/work/origin.git', '/srv/git/origin.git', '../origin.git']) {
      assert.equal(toWebRepo(local), undefined, local);
    }
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
});
