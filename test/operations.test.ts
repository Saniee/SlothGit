// Runs the real rebase flow (git -> sh -> rebaseEditor.js) against throwaway repositories.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildEditorCommand, GitOps } from '../src/git/operations';
import { getOperation, getRebaseTodo, getStashes, getStashFiles } from '../src/git/queries';
import { Git } from '../src/git/runner';
import { pendingRewordMessage } from '../src/git/todo';

const editorScript = path.resolve(__dirname, '../dist/rebaseEditor.js');

function setup(commitCount = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-'));
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.name', 'Test');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'commit.gpgsign', 'false');
  sh('config', 'core.autocrlf', 'false');
  for (let i = 1; i <= commitCount; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `v${i}\n`);
    sh('add', '.');
    sh('commit', '-q', '-m', `c${i}`);
  }
  const git = new Git('git', dir);
  const ops = new GitOps(git, buildEditorCommand(process.execPath, editorScript));
  const subjects = () => sh('log', '--format=%s').split('\n');
  const sha = (subject: string) => sh('log', '--format=%H', `--grep=^${subject}$`);
  const write = (file: string, content: string) => fs.writeFileSync(path.join(dir, file), content);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  return { dir, sh, git, ops, subjects, sha, write, read };
}

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

test('refuses to rewrite across merge commits', async () => {
  const r = setup(2);
  r.sh('checkout', '-q', '-b', 'side');
  r.write('side.txt', 'side\n');
  r.sh('add', '.');
  r.sh('commit', '-q', '-m', 'side');
  r.sh('checkout', '-q', 'main');
  r.write('main.txt', 'main\n');
  r.sh('add', '.');
  r.sh('commit', '-q', '-m', 'main');
  r.sh('merge', '-q', '--no-ff', '-m', 'merge', 'side');
  await assert.rejects(r.ops.drop([r.sha('c2')]), /merge commits/);
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
