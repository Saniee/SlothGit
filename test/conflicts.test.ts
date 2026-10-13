import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { getConflicts, getStoppedOperation, parseConflicts, resolveHunk } from '../src/git/conflicts';
import { buildEditorCommand, GitOps } from '../src/git/operations';
import { Git } from '../src/git/runner';
import { concurrency, git, newRepo, writeFile } from './repo';

const text = ['top', '<<<<<<< HEAD', 'ours 1', 'ours 2', '=======', 'theirs', '>>>>>>> abc1234 (Add theirs)', 'middle', '<<<<<<< HEAD', '=======', 'added', '>>>>>>> abc1234 (Add theirs)', 'end', ''].join('\n');

test('parses conflict hunks', () => {
  assert.deepEqual(parseConflicts(text), [
    { line: 1, current: ['ours 1', 'ours 2'], incoming: ['theirs'] },
    { line: 8, current: [], incoming: ['added'] },
  ]);
});

test('parses the base section of diff3 markers, and CRLF', () => {
  const diff3 = ['<<<<<<< HEAD', 'a', '||||||| base', 'b', '=======', 'c', '>>>>>>> x', ''].join('\r\n');
  assert.deepEqual(parseConflicts(diff3), [{ line: 0, current: ['a'], base: ['b'], incoming: ['c'] }]);
});

test('stops at unbalanced markers', () => {
  assert.deepEqual(parseConflicts('<<<<<<< HEAD\na\n=======\nb\n'), []);
  assert.deepEqual(parseConflicts('a ======= line\n======= \n'), []);
});

test('resolves one hunk at a time', () => {
  const first = resolveHunk(text, 0, 'incoming');
  assert.equal(first.split('\n').slice(0, 3).join('|'), 'top|theirs|middle');
  assert.equal(parseConflicts(first).length, 1);
  assert.equal(resolveHunk(first, 0, 'both'), 'top\ntheirs\nmiddle\nadded\nend\n');
  assert.equal(resolveHunk(text, 0, 'current').split('\n').slice(0, 4).join('|'), 'top|ours 1|ours 2|middle');
  assert.equal(resolveHunk('a\r\n<<<<<<< x\r\nb\r\n=======\r\nc\r\n>>>>>>> y\r\n', 0, 'current'), 'a\r\nb\r\n');
  assert.throws(() => resolveHunk(text, 2, 'current'), /no longer/);
});

/** main and side change the same line of f.txt; side also changes d.txt, which main deletes. */
function setup() {
  const dir = newRepo('conflicts', (dir) => {
    writeFile(dir, 'f.txt', 'a\nb\nc\n');
    writeFile(dir, 'd.txt', 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'side');
    writeFile(dir, 'f.txt', 'a\nSIDE\nc\n');
    writeFile(dir, 'd.txt', 'side\n');
    git(dir, 'commit', '-q', '-am', 'Side change');
    git(dir, 'checkout', '-q', 'main');
    writeFile(dir, 'f.txt', 'a\nMAIN\nc\n');
    git(dir, 'rm', '-q', 'd.txt');
    git(dir, 'commit', '-q', '-am', 'Main change');
  });
  const repo = new Git('git', dir);
  const ops = new GitOps(repo, buildEditorCommand(process.execPath, path.resolve(__dirname, '../dist/rebaseEditor.js')));
  const sh = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      return 'failed';
    }
  };
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  return { dir, git: repo, ops, sh, read };
}

describe('conflicts', { concurrency }, () => {
  test('lists conflicted files and describes a stopped merge', async () => {
    const r = setup();
    assert.equal(await getStoppedOperation(r.git), undefined);
    r.sh('merge', 'side');
    assert.deepEqual(await getConflicts(r.git), [
      { path: 'd.txt', kind: 'deleted-in-current' },
      { path: 'f.txt', kind: 'both-modified' },
    ]);
    const stopped = await getStoppedOperation(r.git);
    assert.equal(stopped?.operation, 'merge');
    assert.equal(stopped?.branch, 'main');
    assert.equal(stopped?.incomingName, 'side');
    assert.equal(stopped?.incoming?.subject, 'Side change');
  });

  test('describes a stopped rebase: the commit being applied, the base and the step', async () => {
    const r = setup();
    r.sh('checkout', '-q', 'side');
    r.sh('rebase', 'main');
    const stopped = await getStoppedOperation(r.git);
    assert.equal(stopped?.operation, 'rebase');
    assert.equal(stopped?.branch, 'side');
    assert.equal(stopped?.incoming?.subject, 'Side change');
    assert.equal(stopped?.onto?.subject, 'Main change');
    assert.deepEqual(stopped?.step, { number: 1, total: 1 });
    assert.deepEqual(
      (await getConflicts(r.git)).map((c) => c.kind),
      ['deleted-in-current', 'both-modified'],
    );
  });

  test('take a side, mark resolved, reopen', async () => {
    const r = setup();
    r.sh('merge', 'side');
    await r.ops.takeSide('f.txt', 'incoming');
    assert.equal(r.read('f.txt'), 'a\nSIDE\nc\n');
    await r.ops.takeSide('d.txt', 'current');
    assert.ok(!fs.existsSync(path.join(r.dir, 'd.txt')), 'keeping the deleting side deletes the file');
    assert.deepEqual(await getConflicts(r.git), []);

    await r.ops.reopenConflict('f.txt');
    assert.deepEqual(await getConflicts(r.git), [{ path: 'f.txt', kind: 'both-modified' }]);
    assert.equal(parseConflicts(r.read('f.txt')).length, 1);

    fs.writeFileSync(path.join(r.dir, 'f.txt'), resolveHunk(r.read('f.txt'), 0, 'both'));
    await r.ops.markResolved('f.txt');
    assert.deepEqual(await getConflicts(r.git), []);
    assert.equal(r.sh('show', ':f.txt'), 'a\nMAIN\nSIDE\nc');
  });

  test('keeping the side that changed a file deleted on the other side keeps it', async () => {
    const r = setup();
    r.sh('merge', 'side');
    await r.ops.takeSide('d.txt', 'incoming');
    assert.equal(r.read('d.txt'), 'side\n');
    assert.deepEqual((await getConflicts(r.git)).map((c) => c.path), ['f.txt']);
  });
});
