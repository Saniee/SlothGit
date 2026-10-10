// Runs the real rebase flow (git -> sh -> rebaseEditor.js) against throwaway repositories.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { buildEditorCommand, GitOps } from '../src/git/operations';
import { getOperation, getRebaseTodo, getStashes, getStashFiles } from '../src/git/queries';
import { Git } from '../src/git/runner';
import { removalPatch, type LineRange } from '../src/git/patch';
import { pendingRewordMessage } from '../src/git/todo';
import { concurrency, git, newRepo, writeFile } from './repo';

const editorScript = path.resolve(__dirname, '../dist/rebaseEditor.js');

function commitFile(dir: string, file: string, content: string, message: string) {
  writeFile(dir, file, content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', message);
}

/** Commits c1..c<commitCount>, each adding f<i>.txt, then whatever `more` adds (`more.key` names it). */
function setup(commitCount = 4, more?: { key: string; build: (dir: string) => void }) {
  const dir = newRepo(`${commitCount} ${more?.key ?? ''}`, (dir) => {
    for (let i = 1; i <= commitCount; i++) commitFile(dir, `f${i}.txt`, `v${i}\n`, `c${i}`);
    more?.build(dir);
  });
  const sh = (...args: string[]) => git(dir, ...args);
  const repo = new Git('git', dir);
  const ops = new GitOps(repo, buildEditorCommand(process.execPath, editorScript));
  const subjects = () => sh('log', '--format=%s').split('\n');
  const sha = (subject: string) => sh('log', '--format=%H', `--grep=^${subject}$`);
  const write = (file: string, content: string) => fs.writeFileSync(path.join(dir, file), content);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  return { dir, sh, git: repo, ops, subjects, sha, write, read };
}

describe('operations', { concurrency }, () => {
  test('drop', async () => {
    const r = setup();
    await r.ops.drop([r.sha('c2')]);
    assert.deepEqual(r.subjects(), ['c4', 'c3', 'c1']);
    assert.equal(fs.existsSync(path.join(r.dir, 'f2.txt')), false);
  });

  test('drop multiple with a dirty working tree (autostash)', async () => {
    const r = setup();
    r.write('f4.txt', 'dirty\n');
    await r.ops.drop([r.sha('c3'), r.sha('c2')]);
    assert.deepEqual(r.subjects(), ['c4', 'c1']);
    assert.equal(r.read('f4.txt'), 'dirty\n');
  });

  test('fixup keeps the older message', async () => {
    const r = setup();
    await r.ops.squash([r.sha('c3')], 'fixup');
    assert.deepEqual(r.subjects(), ['c4', 'c2', 'c1']);
    assert.equal(r.read('f3.txt'), 'v3\n');
  });

  test('squash combines messages', async () => {
    const r = setup();
    await r.ops.squash([r.sha('c3')], 'squash');
    assert.deepEqual(r.subjects(), ['c4', 'c2', 'c1']);
    assert.match(r.sh('log', '-1', '--format=%B', 'HEAD~1'), /c2[\s\S]*c3/);
  });

  test('squash into the root commit and refusing to squash the root itself', async () => {
    const r = setup();
    await r.ops.squash([r.sha('c2')], 'fixup');
    assert.deepEqual(r.subjects(), ['c4', 'c3', 'c1']);
    await assert.rejects(r.ops.squash([r.sha('c1')], 'fixup'), /first commit/);
  });

  test('reword an older commit and HEAD', async () => {
    const r = setup();
    await r.ops.reword(r.sha('c2'), 'renamed\n\nwith body');
    await r.ops.reword(r.sha('c4'), 'head renamed');
    assert.deepEqual(r.subjects(), ['head renamed', 'c3', 'renamed', 'c1']);
    assert.equal(r.sh('log', '-1', '--format=%b', 'HEAD~2'), 'with body');
  });

  test('move up and down', async () => {
    const r = setup();
    await r.ops.move(r.sha('c2'), 'up');
    assert.deepEqual(r.subjects(), ['c4', 'c2', 'c3', 'c1']);
    await r.ops.move(r.sha('c2'), 'down');
    assert.deepEqual(r.subjects(), ['c4', 'c3', 'c2', 'c1']);
    await r.ops.move(r.sha('c2'), 'down');
    assert.deepEqual(r.subjects(), ['c4', 'c3', 'c1', 'c2']);
    await assert.rejects(r.ops.move(r.sha('c4'), 'up'), /newest/);
    await assert.rejects(r.ops.move(r.sha('c2'), 'down'), /oldest/);
  });

  test('amend staged changes into an older commit, keeping unstaged ones', async () => {
    const r = setup();
    r.write('f2.txt', 'amended\n');
    r.sh('add', 'f2.txt');
    r.write('f4.txt', 'unstaged\n');
    await r.ops.amendStaged(r.sha('c2'));
    assert.deepEqual(r.subjects(), ['c4', 'c3', 'c2', 'c1']);
    assert.equal(r.sh('show', `${r.sha('c2')}:f2.txt`), 'amended');
    assert.equal(r.read('f4.txt'), 'unstaged\n');
    assert.equal(r.sh('diff', '--cached', '--name-only'), '');
    await assert.rejects(r.ops.amendStaged(r.sha('c2')), /no staged changes/);
  });

  test('edit pauses the rebase until continued', async () => {
    const r = setup();
    await r.ops.edit(r.sha('c2'));
    assert.equal(await getOperation(r.git), 'rebase');
    r.write('f2.txt', 'edited\n');
    r.sh('add', 'f2.txt');
    await r.ops.continueOperation('rebase');
    assert.equal(await getOperation(r.git), undefined);
    assert.deepEqual(r.subjects(), ['c4', 'c3', 'c2', 'c1']);
    assert.equal(r.sh('show', `${r.sha('c2')}:f2.txt`), 'edited');
  });

  test('reword a pending step of a paused rebase', async () => {
    const r = setup();
    await r.ops.edit(r.sha('c2'));
    const [c3, c4] = (await getRebaseTodo(r.git)).map((t) => t.sha);
    await r.ops.rewordTodo(c3, 'c3 reworded\n\nwith a body');
    assert.equal((await getRebaseTodo(r.git))[0].action, 'reword');
    // Changing the message twice keeps the latest; other steps keep theirs.
    await r.ops.rewordTodo(c3, 'c3 final');
    await r.ops.continueOperation('rebase');
    assert.equal(await getOperation(r.git), undefined);
    assert.deepEqual(r.subjects(), ['c4', 'c3 final', 'c2', 'c1']);
    assert.ok(c4);
    await assert.rejects(r.ops.rewordTodo(c4, 'x'), /No interactive rebase/);
  });

  test('reword step that stops on a conflict gets its message after continuing', async () => {
    const r = setup(3);
    await r.ops.edit(r.sha('c1'));
    const c2 = (await getRebaseTodo(r.git))[0].sha;
    await r.ops.rewordTodo(c2, 'c2 reworded');
    // Conflict with c2, which creates f2.txt.
    r.write('f2.txt', 'conflict\n');
    r.sh('add', 'f2.txt');
    r.sh('commit', '-q', '--amend', '--no-edit');
    await assert.rejects(r.ops.continueOperation('rebase'));
    r.write('f2.txt', 'v2\n');
    r.sh('add', 'f2.txt');
    await r.ops.continueOperation('rebase');
    assert.equal(await getOperation(r.git), undefined);
    assert.deepEqual(r.subjects(), ['c3', 'c2 reworded', 'c1']);
  });

  test('pendingRewordMessage reads the current step from rebase-merge/done', () => {
    const full = 'abc1234' + '0'.repeat(33);
    const messages = { [full]: 'new message' };
    assert.equal(pendingRewordMessage('pick 1111111 a\nreword abc1234 b\n', messages), 'new message');
    assert.equal(pendingRewordMessage('reword abc1234 b\npick 1111111 a\n', messages), undefined, 'not the current step');
    assert.equal(pendingRewordMessage('edit abc1234 b\n', messages), undefined, 'not a reword');
    assert.equal(pendingRewordMessage('reword 9999999 b\n', messages), undefined, 'no saved message');
  });

  test('conflicting rebase stops and can be aborted', async () => {
    const r = setup(2);
    r.write('f1.txt', 'x\n');
    r.sh('commit', '-q', '-am', 'c3');
    r.write('f1.txt', 'y\n');
    r.sh('commit', '-q', '-am', 'c4');
    const before = r.sh('rev-parse', 'HEAD');
    // Dropping c3 makes c4's change to f1 conflict.
    await assert.rejects(r.ops.drop([r.sha('c3')]));
    assert.equal(await getOperation(r.git), 'rebase');
    await r.ops.abortOperation('rebase');
    assert.equal(await getOperation(r.git), undefined);
    assert.equal(r.sh('rev-parse', 'HEAD'), before);
  });

  // --- line-level patches ------------------------------------------------------------------

  function setupPatch() {
    const r = setup(1, {
      key: 'patch',
      build: (dir) => {
        commitFile(dir, 'x.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n', 'base');
        commitFile(dir, 'x.txt', 'a\nb\nC\nd\ne\nN1\nN2\nf\ng\n', 'change');
        // A later commit touching another part of the file, so the rebase has to carry it over.
        commitFile(dir, 'x.txt', 'a\nb\nC\nd\ne\nN1\nN2\nf\ng\nlast\n', 'later');
      },
    });
    const change = { status: 'M', path: 'x.txt' };
    const patchFor = async (sha: string, ranges: LineRange[]) =>
      removalPatch(await r.ops.commitFileDiff(sha, change), 'new', ranges)!;
    return { ...r, patchFor };
  }

  test('patch: remove selected lines from an older commit', async () => {
    const r = setupPatch();
    const sha = r.sha('change');
    r.write('other.txt', 'dirty\n');
    await r.ops.removePatchFromCommit(sha, await r.patchFor(sha, [{ start: 6, end: 6, whole: true }]), 'discard');
    assert.deepEqual(r.subjects(), ['later', 'change', 'base', 'c1']);
    assert.equal(r.sh('show', `${r.sha('change')}:x.txt`), 'a\nb\nC\nd\ne\nf\ng');
    assert.equal(r.read('x.txt'), 'a\nb\nC\nd\ne\nf\ng\nlast\n');
    assert.equal(r.read('other.txt'), 'dirty\n', 'uncommitted changes are kept');
  });

  test('patch: move selected lines to the index', async () => {
    const r = setupPatch();
    const sha = r.sha('change');
    const message = await r.ops.removePatchFromCommit(sha, await r.patchFor(sha, [{ start: 3, end: 3 }]), 'index');
    assert.equal(message, undefined);
    assert.equal(r.sh('show', `${r.sha('change')}:x.txt`), 'a\nb\nc\nd\ne\nN1\nN2\nf\ng');
    assert.equal(r.sh('show', 'HEAD:x.txt'), 'a\nb\nc\nd\ne\nN1\nN2\nf\ng\nlast');
    assert.equal(r.read('x.txt'), 'a\nb\nC\nd\ne\nN1\nN2\nf\ng\nlast\n', 'the change is back in the working tree');
    assert.match(r.sh('diff', '--cached'), /-c\n\+C/, 'and staged');
  });

  test('patch: move selected lines to a new commit after the original', async () => {
    const r = setupPatch();
    const sha = r.sha('change');
    await r.ops.removePatchFromCommit(sha, await r.patchFor(sha, [{ start: 6, end: 7 }]), { newCommit: 'insert N lines' });
    assert.deepEqual(r.subjects(), ['later', 'insert N lines', 'change', 'base', 'c1']);
    assert.equal(r.sh('show', `${r.sha('change')}:x.txt`), 'a\nb\nC\nd\ne\nf\ng');
    assert.equal(r.sh('show', 'HEAD:x.txt'), 'a\nb\nC\nd\ne\nN1\nN2\nf\ng\nlast', 'the end result is unchanged');
  });

  // --- history with a merge ------------------------------------------------------------
  //
  //   c1 - c2 - m1 ---- merge - c3     (main)
  //          \         /
  //           s1 - s2                  (side)
  function setupMerge() {
    const r = setup(2, {
      key: 'merge',
      build: (dir) => {
        const commit = (subject: string) => commitFile(dir, `${subject}.txt`, `${subject}\n`, subject);
        git(dir, 'checkout', '-q', '-b', 'side');
        commit('s1');
        commit('s2');
        git(dir, 'checkout', '-q', 'main');
        commit('m1');
        git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
        commit('c3');
      },
    });
    const mainline = () => r.sh('log', '--first-parent', '--format=%s').split('\n');
    const sideline = () => r.sh('log', '--format=%s', 'HEAD^^2', '--not', 'HEAD^^1').split('\n');
    const merges = () => r.sh('rev-list', '--merges', '--count', 'HEAD');
    return { ...r, mainline, sideline, merges };
  }

  test('rewrites below a merge keep the merge', async () => {
    const r = setupMerge();
    await r.ops.reword(r.sha('c2'), 'c2 reworded');
    assert.deepEqual(r.mainline(), ['c3', 'merge', 'm1', 'c2 reworded', 'c1']);
    assert.deepEqual(r.sideline(), ['s2', 's1']);
    assert.equal(r.merges(), '1');
    assert.equal(r.sh('merge-base', 'HEAD^^1', 'HEAD^^2'), r.sha('c2 reworded'), 'both branches build on the new c2');
  });

  test('drop, squash and amend commits on the merged branch', async () => {
    const r = setupMerge();
    await r.ops.drop([r.sha('s1')]);
    assert.deepEqual(r.sideline(), ['s2']);
    assert.equal(fs.existsSync(path.join(r.dir, 's1.txt')), false);

    const s = setupMerge();
    await s.ops.squash([s.sha('s2')], 'fixup');
    assert.deepEqual(s.sideline(), ['s1']);
    assert.equal(s.read('s2.txt'), 's2\n');
    assert.equal(s.merges(), '1');

    const a = setupMerge();
    a.write('s1.txt', 'amended\n');
    a.sh('add', 's1.txt');
    await a.ops.amendStaged(a.sha('s1'));
    assert.deepEqual(a.sideline(), ['s2', 's1']);
    assert.equal(a.sh('show', `${a.sha('s1')}:s1.txt`), 'amended');
    assert.equal(a.read('s1.txt'), 'amended\n');

    const e = setupMerge();
    await e.ops.setAuthor(e.sha('s2'), 'Other <other@example.com>');
    assert.equal(e.sh('log', '-1', '--format=%an', e.sha('s2')), 'Other');
    assert.equal(e.merges(), '1');
  });

  test('changes that would break the branch structure are refused, leaving history alone', async () => {
    const r = setupMerge();
    const head = r.sh('rev-parse', 'HEAD');
    // s1's previous commit in the todo list is on main: squashing would meld it into the wrong branch.
    await assert.rejects(r.ops.squash([r.sha('s1')], 'squash'), /another branch|merge/);
    await assert.rejects(r.ops.squash([r.sha('c3')], 'squash'), /merge commit/);
    await assert.rejects(r.ops.drop([r.sha('merge')]), /merge commit itself/);
    await assert.rejects(r.ops.reword(r.sha('merge'), 'x'), /merge commit itself/);
    await assert.rejects(r.ops.move(r.sha('m1'), 'up'), /past a merge|branch point/);
    assert.equal(await getOperation(r.git), undefined);
    assert.equal(r.sh('rev-parse', 'HEAD'), head);

    // The newest commit can still be amended when it is the merge.
    r.sh('reset', '-q', '--hard', 'HEAD~1');
    await r.ops.reword(r.sha('merge'), 'merge reworded');
    assert.equal(r.subjects()[0], 'merge reworded');
    assert.equal(r.merges(), '1');
  });

  test('stash push, list files, rename, pop', async () => {
    const r = setup(2);
    r.write('f1.txt', 'modified\n');
    r.write('new.txt', 'untracked\n');
    await r.ops.stashPush('all', 'my stash');
    let stashes = await getStashes(r.git);
    assert.equal(stashes.length, 1);
    assert.match(stashes[0].message, /my stash/);
    const files = await getStashFiles(r.git, stashes[0]);
    assert.deepEqual(
      files.map((f) => `${f.change.status} ${f.change.path}`),
      ['M f1.txt', 'U new.txt'],
    );
    await r.ops.stashRename(stashes[0].ref, stashes[0].sha, 'renamed');
    stashes = await getStashes(r.git);
    assert.equal(stashes[0].message, 'renamed');
    await r.ops.stashApply(stashes[0].ref, true);
    assert.equal(r.read('f1.txt'), 'modified\n');
    assert.equal(r.read('new.txt'), 'untracked\n');
    assert.equal((await getStashes(r.git)).length, 0);
  });
});
