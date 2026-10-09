// Branch, remote and tag operations against throwaway repositories, with a local bare repo as "origin".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildEditorCommand, GitOps } from '../src/git/operations';
import { getLocalBranches, getOperation, getRemoteBranches, getRemotes, getTags, parseTrack } from '../src/git/queries';
import { GitError, Git } from '../src/git/runner';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-br-'));
  const sh = (...args: string[]) => git(dir, ...args);
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.name', 'Test');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'commit.gpgsign', 'false');
  sh('config', 'core.autocrlf', 'false');
  sh('config', 'tag.gpgsign', 'false');
  const commit = (file: string, content: string, message: string) => {
    fs.writeFileSync(path.join(dir, file), content);
    sh('add', '.');
    sh('commit', '-q', '-m', message);
  };
  const subjects = (ref = 'HEAD') => sh('log', '--format=%s', ref).split('\n');
  const g = new Git('git', dir);
  const ops = new GitOps(g, buildEditorCommand(process.execPath, path.resolve(__dirname, '../dist/rebaseEditor.js')));
  commit('a.txt', 'a\n', 'c1');
  return { dir, sh, commit, subjects, git: g, ops };
}

function withOrigin(r: ReturnType<typeof setup>) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-origin-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  r.sh('remote', 'add', 'origin', bare);
  r.sh('push', '-q', '-u', 'origin', 'main');
  return bare;
}

test('parseTrack', () => {
  assert.deepEqual(parseTrack('ahead 2, behind 3'), { ahead: 2, behind: 3, gone: false });
  assert.deepEqual(parseTrack('behind 1'), { ahead: 0, behind: 1, gone: false });
  assert.deepEqual(parseTrack('gone'), { ahead: 0, behind: 0, gone: true });
  assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
});

test('local branches list the current branch first with upstream tracking info', async () => {
  const r = setup();
  withOrigin(r);
  r.commit('a.txt', 'local\n', 'c2');
  r.sh('branch', 'feature/x');
  r.sh('switch', '-q', 'feature/x');
  r.commit('b.txt', 'b\n', 'c3');

  const branches = await getLocalBranches(r.git);
  assert.equal(branches[0].name, 'feature/x');
  assert.equal(branches[0].current, true);
  assert.equal(branches[0].upstream, undefined);
  const main = branches.find((b) => b.name === 'main')!;
  assert.deepEqual(main.upstream, { name: 'origin/main', remote: 'origin', remoteRef: 'refs/heads/main' });
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 0);
});

test('remotes and remote branches, skipping origin/HEAD', async () => {
  const r = setup();
  const bare = withOrigin(r);
  r.sh('remote', 'set-head', 'origin', 'main');
  r.sh('push', '-q', 'origin', 'main:feature/y');
  r.sh('fetch', '-q', 'origin');

  const remotes = await getRemotes(r.git);
  assert.deepEqual(remotes, [{ name: 'origin', url: bare }]);
  const branches = await getRemoteBranches(r.git, remotes);
  assert.deepEqual(
    branches.map((b) => [b.name, b.remote, b.branch]),
    [
      ['origin/feature/y', 'origin', 'feature/y'],
      ['origin/main', 'origin', 'main'],
    ],
  );
});

test('checkout a remote branch creates a tracking branch, then reuses it', async () => {
  const r = setup();
  withOrigin(r);
  r.sh('push', '-q', 'origin', 'main:topic');
  r.sh('fetch', '-q', 'origin');
  assert.equal(await r.ops.checkoutRemoteBranch('origin/topic', 'topic'), 'created');
  assert.equal(r.sh('rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');
  await r.ops.switchBranch('main');
  assert.equal(await r.ops.checkoutRemoteBranch('origin/topic', 'topic'), 'switched');
  assert.equal(r.sh('branch', '--show-current'), 'topic');
  await r.ops.switchPrevious();
  assert.equal(r.sh('branch', '--show-current'), 'main');
});

test('delete refuses unmerged branches unless forced; rename', async () => {
  const r = setup();
  r.sh('switch', '-q', '-c', 'wip');
  r.commit('w.txt', 'w\n', 'wip');
  r.sh('switch', '-q', 'main');
  await assert.rejects(r.ops.deleteBranch('wip', false), (e: unknown) => e instanceof GitError && /not fully merged/.test(e.stderr));
  await r.ops.renameBranch('wip', 'wip2');
  await r.ops.deleteBranch('wip2', true);
  assert.equal(r.sh('branch', '--list', 'wip*'), '');
});

test('merge modes', async () => {
  const r = setup();
  r.sh('switch', '-q', '-c', 'feat');
  r.commit('f.txt', 'f\n', 'feat');
  r.sh('switch', '-q', 'main');

  await r.ops.merge('feat', 'noFastForward');
  assert.equal(r.sh('rev-list', '--count', '--merges', 'HEAD'), '1');

  r.sh('reset', '-q', '--hard', 'HEAD~1');
  await r.ops.merge('feat', 'squash');
  assert.deepEqual(r.subjects(), ['c1']);
  assert.equal(r.sh('diff', '--cached', '--name-only'), 'f.txt');
});

test('rebase onto a branch, and onto with a marked base', async () => {
  const r = setup();
  r.sh('switch', '-q', '-c', 'feature-a');
  r.commit('a1.txt', '1\n', 'a1');
  r.sh('switch', '-q', '-c', 'feature-b');
  r.commit('b1.txt', '1\n', 'b1');
  r.sh('switch', '-q', 'main');
  r.commit('m.txt', 'm\n', 'm1');

  // Simple rebase moves both a1 and b1.
  r.sh('switch', '-q', 'feature-b');
  r.sh('branch', 'feature-b-copy');
  await r.ops.rebaseOnto('main');
  assert.deepEqual(r.subjects(), ['b1', 'a1', 'm1', 'c1']);

  // With a1 marked as base, only b1 moves (git rebase --onto main a1).
  r.sh('switch', '-q', 'feature-b-copy');
  const a1 = r.sh('rev-parse', 'feature-a');
  await r.ops.rebaseOnto('main', a1);
  assert.deepEqual(r.subjects(), ['b1', 'm1', 'c1']);
});

test('rebase with conflicts stops and is detected', async () => {
  const r = setup();
  r.sh('switch', '-q', '-c', 'side');
  r.commit('a.txt', 'side\n', 'side');
  r.sh('switch', '-q', 'main');
  r.commit('a.txt', 'main\n', 'main');
  r.sh('switch', '-q', 'side');
  await assert.rejects(r.ops.rebaseOnto('main'));
  assert.equal(await getOperation(r.git), 'rebase');
  await r.ops.abortOperation('rebase');
});

test('counts pushed commits that a rebase would rewrite', async () => {
  const r = setup();
  withOrigin(r);
  r.sh('switch', '-q', '-c', 'feat');
  r.commit('f1.txt', '1\n', 'f1');
  r.commit('f2.txt', '2\n', 'f2');
  r.sh('push', '-q', '-u', 'origin', 'feat');
  r.commit('f3.txt', '3\n', 'f3');
  assert.equal(await r.ops.countPushedCommitsAfter('main'), 2);
  assert.equal(await r.ops.countPushedCommitsAfter('HEAD~1'), 0);
  r.sh('switch', '-q', '-c', 'no-upstream');
  assert.equal(await r.ops.countPushedCommitsAfter('main'), 0);
});

test('upstream set/unset and fast-forward of the current branch', async () => {
  const r = setup();
  const bare = withOrigin(r);
  // Another clone pushes a commit.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-other-'));
  git(other, 'clone', '-q', bare, '.');
  git(other, 'config', 'user.name', 'O');
  git(other, 'config', 'user.email', 'o@example.com');
  fs.writeFileSync(path.join(other, 'o.txt'), 'o\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'from other');
  git(other, 'push', '-q');

  r.sh('fetch', '-q', 'origin');
  await r.ops.fastForwardCurrent();
  assert.deepEqual(r.subjects(), ['from other', 'c1']);

  await r.ops.setUpstream('main', undefined);
  assert.equal((await getLocalBranches(r.git))[0].upstream, undefined);
  await r.ops.setUpstream('main', 'origin/main');
  assert.equal((await getLocalBranches(r.git))[0].upstream?.name, 'origin/main');
});

test('remote add, rename, set-url, remove', async () => {
  const r = setup();
  await r.ops.addRemote('upstream', 'https://example.com/a.git');
  await r.ops.renameRemote('upstream', 'fork');
  await r.ops.setRemoteUrl('fork', 'https://example.com/b.git');
  assert.deepEqual(await getRemotes(r.git), [{ name: 'fork', url: 'https://example.com/b.git' }]);
  await r.ops.removeRemote('fork');
  assert.deepEqual(await getRemotes(r.git), []);
});

test('tags: lightweight and annotated, peeled to the commit, delete', async () => {
  const r = setup();
  const c1 = r.sh('rev-parse', 'HEAD');
  r.commit('b.txt', 'b\n', 'c2');
  await r.ops.createTag('v1', c1, '');
  await r.ops.createTag('v2', 'HEAD', 'release two');
  const tags = await getTags(r.git);
  const v1 = tags.find((t) => t.name === 'v1')!;
  const v2 = tags.find((t) => t.name === 'v2')!;
  assert.equal(v1.sha, c1);
  assert.equal(v1.annotated, false);
  assert.equal(v2.sha, r.sh('rev-parse', 'HEAD'));
  assert.equal(v2.annotated, true);
  assert.equal(v2.subject, 'release two');
  await r.ops.deleteTag('v1');
  assert.deepEqual((await getTags(r.git)).map((t) => t.name), ['v2']);
});
