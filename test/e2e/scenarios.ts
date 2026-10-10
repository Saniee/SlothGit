// Every TESTING.md item as an automated scenario against the playground (scripts/playground.mjs).
// Each scenario starts from the same snapshot: main checked out with 3 unpushed commits, README.md modified,
// notes.txt staged, and 2 stashes.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitNode, Node } from '../../src/views/nodes';
import { button, dismiss, input, pick, prompts, type Context } from './harness';

export interface Scenario {
  name: string;
  run(t: Context): Promise<void>;
}

const scenarios: Scenario[] = [];
const scenario = (name: string, run: Scenario['run']) => scenarios.push({ name, run });

const BASELINE = ' M README.md\nA  notes.txt';
const RESOLVED_APP = 'status: resolved\nversion: 2\n';

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const activeTabLabel = () => vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? '';
const clipboard = () => vscode.env.clipboard.readText();

// --- Branches view ---------------------------------------------------------------------------

scenario('branch: checkout local branch, then previous', async (t) => {
  await t.cleanTree();
  await t.run('codegit.branch.checkout', [await t.localBranch('feature/search')]);
  assert.equal(t.branch(), 'feature/search');
  await t.run('codegit.branch.checkoutPrevious');
  assert.equal(t.branch(), 'main');
});

scenario('branch: checkout keeps uncommitted changes when possible', async (t) => {
  // feature/login-ui doesn't touch README.md or notes.txt.
  t.sh('stash', 'push', '-q', '--', 'README.md');
  await t.refresh();
  await t.run('codegit.branch.checkout', [await t.localBranch('feature/login-ui')]);
  assert.equal(t.branch(), 'feature/login-ui');
  assert.equal(t.status(), 'A  notes.txt');
});

scenario('branch: checkout of a branch in another worktree offers to open it', async (t) => {
  await t.run('codegit.branch.checkout', [await t.localBranch('hotfix/crash')], [dismiss(/checked out in the worktree/)]);
  assert.equal(t.branch(), 'main');
  await t.run('codegit.branch.checkout', [await t.localBranch('hotfix/crash')], [button('Open Worktree')]);
  assert.ok(prompts.opened.some((o) => o.endsWith('hotfix-worktree')), `opened ${prompts.opened}`);
});

scenario('branch: checkout remote-only branch creates a tracking branch', async (t) => {
  await t.cleanTree();
  await t.run('codegit.branch.checkout', [await t.remoteBranch('origin/remote-only')]);
  assert.equal(t.branch(), 'remote-only');
  assert.equal(t.sh('rev-parse', '--abbrev-ref', 'remote-only@{u}'), 'origin/remote-only');
});

scenario('tag: checkout detaches HEAD', async (t) => {
  await t.cleanTree();
  await t.run('codegit.branch.checkout', [await t.tag('v0.9')]);
  assert.equal(t.branch(), '');
  assert.equal(t.rev('HEAD'), t.rev('v0.9^{commit}'));
});

scenario('branch: create from another branch', async (t) => {
  await t.cleanTree();
  await t.run('codegit.branch.create', [await t.localBranch('feature/login')], [input('new/from-login', /from feature\/login/)]);
  assert.equal(t.branch(), 'new/from-login');
  assert.equal(t.rev('HEAD'), t.rev('feature/login'));
});

scenario('branch: create rejects names with spaces', async (t) => {
  prompts.queue.push(input('bad name'));
  await vscode.commands.executeCommand('codegit.branch.create', await t.localBranch('main'));
  assert.ok(prompts.problems.splice(0).some((p) => /rejected/.test(p)), 'the input box rejects the name');
  assert.ok(!t.exists('refs/heads/bad'));
});

scenario('branch: delete merged branch', async (t) => {
  await t.run('codegit.branch.delete', [await t.localBranch('merged/old-experiment')], [button('Delete')]);
  assert.ok(!t.exists('refs/heads/merged/old-experiment'));
});

scenario('branch: delete unmerged branch asks to force', async (t) => {
  await t.run('codegit.branch.delete', [await t.localBranch('conflict/status-line')], [
    button('Delete'),
    button('Force Delete', /not fully merged/),
  ]);
  assert.ok(!t.exists('refs/heads/conflict/status-line'));
});

scenario('branch: cancelling force delete keeps the branch', async (t) => {
  await t.run('codegit.branch.delete', [await t.localBranch('conflict/status-line')], [button('Delete'), dismiss(/not fully merged/)]);
  assert.ok(t.exists('refs/heads/conflict/status-line'));
});

scenario('branch: delete local and remote', async (t) => {
  await t.run('codegit.branch.delete', [await t.localBranch('feature/login')], [
    pick('Delete Local and Remote Branch'),
    button('Delete', /on the remote/),
    button('Force Delete', /not fully merged/),
  ]);
  assert.ok(!t.exists('refs/heads/feature/login'));
  assert.ok(!t.exists('refs/heads/feature/login', t.origin), 'deleted on origin');
});

scenario('branch: delete only the remote branch', async (t) => {
  await t.run('codegit.branch.delete', [await t.localBranch('feature/login')], [pick('Delete Remote Branch'), button('Delete')]);
  assert.ok(t.exists('refs/heads/feature/login'));
  assert.ok(!t.exists('refs/heads/feature/login', t.origin));
});

scenario('branch: the current branch cannot be deleted', async (t) => {
  await t.run('codegit.branch.delete', [await t.localBranch('main')]);
  assert.ok(t.saw('warning', /cannot delete the branch that is checked out/));
});

scenario('remote branch: delete on the remote', async (t) => {
  await t.run('codegit.branch.delete', [await t.remoteBranch('origin/remote-only')], [button('Delete', /remote-only/)]);
  assert.ok(!t.exists('refs/heads/remote-only', t.origin));
});

scenario('branch: rename', async (t) => {
  await t.run('codegit.branch.rename', [await t.localBranch('feature/search')], [input('feature/find')]);
  assert.ok(t.exists('refs/heads/feature/find'));
  assert.ok(!t.exists('refs/heads/feature/search'));
});

scenario('branch: rename a tracking branch explains the remote keeps its name', async (t) => {
  await t.run('codegit.branch.rename', [await t.localBranch('feature/login')], [input('feature/signin')]);
  assert.ok(t.saw('info', /still tracks origin\/feature\/login/));
});

scenario('branch: merge creates a merge commit', async (t) => {
  await t.cleanTree();
  await t.run('codegit.branch.merge', [await t.localBranch('feature/search')], [pick('Merge', /Merge feature\/search into main/)]);
  assert.equal(t.rev('HEAD^2'), t.rev('feature/search'));
});

scenario('branch: merge fast-forwards, or always creates a commit with --no-ff', async (t) => {
  await t.checkout('merged/old-experiment');
  await t.run('codegit.branch.merge', [await t.localBranch('release/1.x')], [pick('Merge')]);
  assert.equal(t.rev('HEAD'), t.rev('release/1.x'), 'fast-forward');
  await t.run('codegit.branch.merge', [await t.localBranch('main')], [pick('Merge, Always Create a Merge Commit')]);
  assert.equal(t.rev('HEAD^2'), t.rev('main'), 'merge commit');
});

scenario('branch: squash merge stages the changes', async (t) => {
  await t.cleanTree();
  const head = t.rev('HEAD');
  await t.run('codegit.branch.merge', [await t.localBranch('feature/search')], [pick('Squash Merge')]);
  assert.equal(t.rev('HEAD'), head);
  assert.match(t.sh('diff', '--cached', '--name-only'), /search\.txt/);
  assert.ok(t.saw('info', /staged/));
});

scenario('branch: merge conflict, resolve and continue', async (t) => {
  await t.cleanTree();
  await t.run('codegit.branch.merge', [await t.localBranch('conflict/status-line')], [pick('Merge'), dismiss(/Merge stopped/)]);
  assert.ok(t.operationInProgress());
  fs.writeFileSync(path.join(t.repo, 'app.txt'), RESOLVED_APP);
  t.sh('add', 'app.txt');
  await t.run('codegit.operation.continue');
  assert.ok(!t.operationInProgress());
  assert.equal(t.rev('HEAD^2'), t.rev('conflict/status-line'));
});

scenario('branch: rebase current branch onto another', async (t) => {
  await t.checkout('feature/search');
  await t.run('codegit.branch.rebase', [await t.localBranch('main')], [pick('Simple Rebase', /Rebase feature\/search onto main/)]);
  assert.equal(t.sh('rev-list', '--count', 'main..HEAD'), '4');
  assert.equal(t.sh('merge-base', 'main', 'HEAD'), t.rev('main'));
});

scenario('branch: rebase conflict, abort from the prompt', async (t) => {
  await t.checkout('conflict/status-line');
  const before = t.rev('HEAD');
  await t.run('codegit.branch.rebase', [await t.localBranch('main')], [pick('Simple Rebase'), button('Abort', /Rebase stopped/)]);
  assert.ok(!t.operationInProgress(), 'the rebase was aborted');
  assert.equal(t.rev('HEAD'), before);
});

scenario('branch: rebase conflict, continue from the prompt after resolving', async (t) => {
  await t.checkout('conflict/status-line');
  await t.run('codegit.branch.rebase', [await t.localBranch('main')], [pick('Simple Rebase'), dismiss(/Rebase stopped/)]);
  assert.ok(t.operationInProgress());
  fs.writeFileSync(path.join(t.repo, 'app.txt'), RESOLVED_APP);
  t.sh('add', 'app.txt');
  await t.run('codegit.operation.menu', [], [pick('Continue')]);
  assert.ok(!t.operationInProgress());
  assert.equal(t.subjects(1)[0], 'Change status line');
  assert.equal(t.rev('HEAD^'), t.rev('main'));
});

scenario('branch: rebase only the commits after a marked base', async (t) => {
  await t.checkout('feature/login-ui');
  await t.run('codegit.commit.markBase', [await t.commit('Login: error messages')]);
  await t.run('codegit.branch.rebase', [await t.localBranch('main')], [pick('Rebase from Marked Base')]);
  assert.equal(t.sh('rev-list', '--count', 'main..HEAD'), '2');
  assert.deepEqual(t.subjects(2), ['Login UI: colors', 'Login UI: layout']);
  assert.equal(t.rev('HEAD~2'), t.rev('main'));
});

scenario('branch: interactive rebase pauses first so steps can be changed', async (t) => {
  await t.checkout('feature/search');
  await t.run('codegit.branch.rebase', [await t.localBranch('main')], [pick('Interactive Rebase')]);
  assert.ok(t.operationInProgress(), 'the rebase is paused');
  assert.equal(t.rev('HEAD'), t.rev('main'), 'nothing is applied yet');
  const todos = await t.todos();
  assert.deepEqual(todos.map((n) => n.subject), ['Add sorting', 'fixup! Add search', 'Add filters', 'Add search']);
  await t.run('codegit.todo.setAction', [todos[0]], [pick('drop')]);
  await t.run('codegit.operation.continue');
  assert.ok(!t.operationInProgress());
  assert.deepEqual(t.subjects(3), ['fixup! Add search', 'Add filters', 'Add search']);
  assert.equal(t.rev('HEAD~3'), t.rev('main'));
});

scenario('branch: interactive rebase from a marked base', async (t) => {
  await t.checkout('feature/login-ui');
  await t.run('codegit.commit.markBase', [await t.commit('Login: error messages')]);
  await t.run('codegit.branch.rebase', [await t.localBranch('main')], [pick('Interactive Rebase from Marked Base')]);
  assert.deepEqual((await t.todos()).map((n) => n.subject), ['Login UI: colors', 'Login UI: layout']);
  await t.run('codegit.operation.continue');
  assert.deepEqual(t.subjects(2), ['Login UI: colors', 'Login UI: layout']);
  assert.equal(t.rev('HEAD~2'), t.rev('main'));
});

scenario('commit: rewriting a stacked branch moves the branch it is stacked on', async (t) => {
  await vscode.workspace.getConfiguration('codegit').update('updateStackedBranches', 'always', vscode.ConfigurationTarget.Global);
  await t.checkout('feature/login-ui');
  await t.run('codegit.commit.reword', [await t.commit('Login: validate input')], [input('Login: validate all input')]);
  assert.deepEqual(t.subjects(3, 'feature/login'), ['Login: error messages', 'Login: remember me', 'Login: validate all input']);
  assert.equal(t.rev('HEAD~2'), t.rev('feature/login'), 'feature/login-ui is still stacked on it');
});

scenario('commits: colored by merged into main, pushed, not pushed', async (t) => {
  await t.checkout('feature/login');
  const color = async (subject: string) => {
    const item = t.api.providers.commits.getTreeItem(await t.commit(subject)) as vscode.TreeItem;
    return ((item.iconPath as vscode.ThemeIcon).color as { id?: string } | undefined)?.id;
  };
  assert.equal(await color('Login: error messages'), 'charts.red');
  assert.equal(await color('Login: validate input'), 'charts.yellow');
  assert.equal(await color('Add config'), 'charts.green', 'already on origin/main');
});

scenario('branch: move unpushed commits to a new branch', async (t) => {
  await t.checkout('feature/login');
  await t.run('codegit.branch.moveCommitsToNewBranch', [], [input('feature/login-errors', /unpushed commits of feature\/login \(1 not pushed\)/)]);
  assert.equal(t.branch(), 'feature/login-errors');
  assert.equal(t.subjects(1)[0], 'Login: error messages');
  assert.equal(t.rev('feature/login'), t.rev('origin/feature/login'));
  assert.ok(t.saw('info', /Moved 1 commit to feature\/login-errors/));
});

scenario('branch: rebasing pushed commits warns', async (t) => {
  await t.checkout('feature/login');
  await t.run('codegit.branch.rebase', [await t.localBranch('main')], [pick('Simple Rebase'), button('Rebase', /already pushed/)]);
  assert.equal(t.rev('HEAD~3'), t.rev('main'));
});

scenario('branch: fast-forward a branch that is not checked out', async (t) => {
  await t.run('codegit.branch.fastForward', [await t.localBranch('release/1.x')]);
  assert.equal(t.rev('release/1.x'), t.rev('origin/release/1.x'));
  assert.equal(t.branch(), 'main');
});

scenario('branch: fast-forward the current branch', async (t) => {
  await t.checkout('release/1.x');
  await t.run('codegit.branch.fastForward', [await t.localBranch('release/1.x')]);
  assert.equal(t.rev('HEAD'), t.rev('origin/release/1.x'));
});

scenario('branch: fast-forward with a deleted upstream warns', async (t) => {
  await t.run('codegit.branch.fastForward', [await t.localBranch('chore/gone-upstream')]);
  assert.ok(t.saw('warning', /no longer exists/));
});

scenario('branch: set, unset and adopt upstream', async (t) => {
  await t.run('codegit.branch.setUpstream', [await t.localBranch('feature/search')], [pick('origin/main')]);
  assert.equal(t.sh('rev-parse', '--abbrev-ref', 'feature/search@{u}'), 'origin/main');
  await t.run('codegit.branch.unsetUpstream', [await t.localBranch('chore/gone-upstream')]);
  assert.ok(!t.exists('chore/gone-upstream@{u}'));
  await t.run('codegit.branch.setAsUpstream', [await t.remoteBranch('origin/feature/login')]);
  assert.equal(t.sh('rev-parse', '--abbrev-ref', 'main@{u}'), 'origin/feature/login');
});

scenario('branch: push a branch that is ahead', async (t) => {
  await t.run('codegit.branch.push', [await t.localBranch('feature/login')]);
  assert.equal(t.git(t.origin, 'rev-parse', 'feature/login'), t.rev('feature/login'));
});

scenario('branch: push a new branch asks for the remote and sets upstream', async (t) => {
  await t.run('codegit.branch.push', [await t.localBranch('feature/search')], [pick('origin', /Push feature\/search to/)]);
  assert.equal(t.git(t.origin, 'rev-parse', 'feature/search'), t.rev('feature/search'));
  assert.equal(t.sh('rev-parse', '--abbrev-ref', 'feature/search@{u}'), 'origin/feature/search');
});

scenario('branch: force push with lease', async (t) => {
  const rewritten = t.sh('commit-tree', 'feature/login~2^{tree}', '-p', 'feature/login~2', '-m', 'Rewritten');
  t.sh('update-ref', 'refs/heads/feature/login', rewritten);
  await t.refresh();
  await t.run('codegit.branch.forcePush', [await t.localBranch('feature/login')], [button('Force Push', /will be lost/)]);
  assert.equal(t.git(t.origin, 'rev-parse', 'feature/login'), rewritten);
});

scenario('branch: reset current branch to a tag (soft)', async (t) => {
  await t.run('codegit.branch.reset', [await t.tag('v1.0')], [pick('Soft')]);
  assert.equal(t.rev('HEAD'), t.rev('v1.0^{commit}'));
  assert.match(t.sh('diff', '--cached', '--name-only'), /profile\.txt/);
});

scenario('branch: hard reset asks first', async (t) => {
  await t.run('codegit.branch.reset', [await t.localBranch('feature/search')], [pick('Hard'), button('Reset', /discards/)]);
  assert.equal(t.rev('HEAD'), t.rev('feature/search'));
  assert.equal(t.status(), '');
});

scenario('branch: compare with current opens a diff', async (t) => {
  await t.run('codegit.branch.compare', [await t.localBranch('feature/search')]);
  await waitFor('the compare editor', () => activeTabLabel().includes('feature/search'));
});

scenario('branch: copy name', async (t) => {
  await t.run('codegit.branch.copyName', [await t.localBranch('feature/login')]);
  assert.equal(await clipboard(), 'feature/login');
});

scenario('branch: create pull request', async (t) => {
  t.sh('remote', 'set-url', 'origin', 'https://github.com/acme/playground.git');
  await t.refresh();
  await t.run('codegit.branch.createPullRequest', [await t.localBranch('feature/login')]);
  assert.equal(prompts.opened.length, 1);
  assert.match(prompts.opened[0], /^https:\/\/github\.com\/acme\/playground\/compare\/main\.\.\.feature\/login/);
});

scenario('branch: pull request for an unpushed branch offers to push', async (t) => {
  await t.run('codegit.branch.createPullRequest', [await t.localBranch('feature/search')], [dismiss(/Push "feature\/search"/)]);
  assert.equal(prompts.opened.length, 0);
});

scenario('branch: pull request without a web remote warns', async (t) => {
  await t.run('codegit.branch.createPullRequest', [await t.localBranch('feature/login')]);
  assert.ok(t.saw('warning', /no recognisable web URL/));
});

scenario('branch: delete merged branches', async (t) => {
  await t.run('codegit.branch.deleteMerged', [], [pick(['merged/old-experiment'], /merged into main/)]);
  assert.ok(!t.exists('refs/heads/merged/old-experiment'));
  assert.ok(t.exists('refs/heads/release/1.x'), 'unpicked branches are kept');
});

scenario('branch: sort by name', async (t) => {
  await t.run('codegit.branch.sort', [], [pick('Name')]);
  await t.refresh();
  const [current, ...others] = await t.localBranchNames();
  assert.equal(current, 'main');
  assert.deepEqual(others, [...others].sort());
});

// --- Remotes --------------------------------------------------------------------------------

scenario('remote: fetch one remote, and all remotes', async (t) => {
  t.git(t.origin, 'update-ref', 'refs/heads/extra', t.git(t.origin, 'rev-parse', 'main~1'));
  t.git(t.upstream, 'update-ref', 'refs/heads/extra', t.git(t.upstream, 'rev-parse', 'main~1'));
  await t.run('codegit.remote.fetch', [await t.remote('origin')]);
  assert.ok(t.exists('refs/remotes/origin/extra'));
  assert.ok(!t.exists('refs/remotes/upstream/extra'));
  await t.run('codegit.fetchAll');
  assert.ok(t.exists('refs/remotes/upstream/extra'));
});

scenario('remote: add fetches it', async (t) => {
  await t.run('codegit.remote.add', [], [input('third', /Add remote/), input(t.upstream, /URL for third/)]);
  assert.match(t.sh('remote'), /third/);
  assert.ok(t.exists('refs/remotes/third/main'));
});

scenario('remote: rename, edit URL, copy URL', async (t) => {
  await t.run('codegit.remote.rename', [await t.remote('upstream')], [input('mirror')]);
  assert.deepEqual(t.sh('remote').split('\n').sort(), ['mirror', 'origin']);
  await t.refresh();
  await t.run('codegit.remote.editUrl', [await t.remote('mirror')], [input('https://example.com/mirror.git')]);
  assert.equal(t.sh('remote', 'get-url', 'mirror'), 'https://example.com/mirror.git');
  await t.refresh();
  await t.run('codegit.remote.copyUrl', [await t.remote('mirror')]);
  assert.equal(await clipboard(), 'https://example.com/mirror.git');
});

scenario('remote: remove', async (t) => {
  await t.run('codegit.remote.remove', [await t.remote('upstream')], [button('Remove', /nothing changes on the server/)]);
  assert.equal(t.sh('remote'), 'origin');
});

// --- Tags -----------------------------------------------------------------------------------

scenario('tag: create lightweight at HEAD', async (t) => {
  await t.run('codegit.tag.create', [], [input('v2', /New tag at main/), input('')]);
  assert.equal(t.sh('cat-file', '-t', 'v2'), 'commit');
  assert.equal(t.rev('v2'), t.rev('HEAD'));
});

scenario('tag: create annotated at a commit', async (t) => {
  const config = await t.commit('Add config');
  await t.run('codegit.commit.createTag', [config], [input('v-config'), input('Config release')]);
  assert.equal(t.sh('cat-file', '-t', 'v-config'), 'tag');
  assert.equal(t.rev('v-config^{commit}'), config.sha);
});

scenario('tag: push to a remote', async (t) => {
  await t.run('codegit.tag.push', [await t.tag('v0.9')], [pick('origin')]);
  assert.ok(t.exists('refs/tags/v0.9', t.origin));
});

scenario('tag: delete locally and on a remote', async (t) => {
  await t.run('codegit.tag.delete', [await t.tag('v1.0')], [pick('Delete Local Tag and from a Remote'), pick('origin')]);
  assert.ok(!t.exists('refs/tags/v1.0'));
  assert.ok(!t.exists('refs/tags/v1.0', t.origin));
});

// --- Worktrees ------------------------------------------------------------------------------

scenario('worktree: add for an existing branch', async (t) => {
  const dir = path.join(t.playground, 'wt-search');
  await t.run('codegit.worktree.add', [await t.localBranch('feature/search')], [input(dir), dismiss(/Created a worktree/)]);
  assert.ok(fs.existsSync(path.join(dir, 'search.txt')));
  assert.match(t.sh('worktree', 'list'), /wt-search/);
});

scenario('worktree: add with a new branch and open it', async (t) => {
  const dir = path.join(t.playground, 'wt-new');
  await t.run('codegit.worktree.add', [], [input('wt/new', /New branch for the worktree/), input(dir), button('Open in New Window')]);
  assert.ok(t.exists('refs/heads/wt/new'));
  // VS Code lower-cases the drive letter in fsPath.
  assert.ok(prompts.opened.some((o) => o.toLowerCase() === `folder:${dir}`.toLowerCase()), `opened ${prompts.opened}`);
});

scenario('worktree: open, copy path', async (t) => {
  const node = await t.worktree('hotfix-worktree');
  await t.run('codegit.worktree.open', [node]);
  await t.run('codegit.worktree.openHere', [node]);
  assert.equal(prompts.opened.length, 2);
  await t.run('codegit.worktree.copyPath', [node]);
  assert.equal(path.resolve(await clipboard()), path.resolve(node.worktree.path));
});

scenario('worktree: remove keeps the branch', async (t) => {
  await t.run('codegit.worktree.remove', [await t.worktree('hotfix-worktree')], [button('Remove', /Its branch is kept/)]);
  assert.doesNotMatch(t.sh('worktree', 'list'), /hotfix-worktree/);
  assert.ok(t.exists('refs/heads/hotfix/crash'));
});

scenario('worktree: remove with changes asks to force', async (t) => {
  fs.writeFileSync(path.join(t.playground, 'hotfix-worktree', 'dirty.txt'), 'x');
  await t.run('codegit.worktree.remove', [await t.worktree('hotfix-worktree')], [button('Remove'), button('Force Remove', /uncommitted changes/)]);
  assert.doesNotMatch(t.sh('worktree', 'list'), /hotfix-worktree/);
});

scenario('worktree: prune a deleted folder', async (t) => {
  fs.rmSync(path.join(t.playground, 'hotfix-worktree'), { recursive: true, force: true });
  await t.refresh();
  await t.run('codegit.worktree.prune');
  assert.doesNotMatch(t.sh('worktree', 'list'), /hotfix-worktree/);
});

// --- Commits view: rewriting history -----------------------------------------------------------

scenario('commit: squash into previous', async (t) => {
  await t.run('codegit.commit.squash', [await t.commit('Fix typo in docs')]);
  assert.deepEqual(t.subjects(2), ['Add profile page', 'Add settings page']);
  assert.match(t.sh('log', '-1', '--format=%B', 'HEAD~1'), /Fix typo in docs/);
  assert.equal(t.status(), BASELINE);
});

scenario('commit: fixup into previous', async (t) => {
  await t.run('codegit.commit.fixup', [await t.commit('Add profile page')]);
  assert.equal(t.subjects(1)[0], 'Fix typo in docs');
  assert.match(t.sh('show', '--name-only', '--format=', 'HEAD'), /profile\.txt/);
  assert.equal(t.status(), BASELINE);
});

scenario('commit: drop', async (t) => {
  await t.run('codegit.commit.drop', [await t.commit('Add settings page')], [button('Continue', /Drop 1 commit/)]);
  assert.deepEqual(t.subjects(3), ['Add profile page', 'Fix typo in docs', 'Bump version']);
  assert.equal(t.status(), BASELINE);
});

scenario('commit: drop several selected commits', async (t) => {
  await t.checkout('feature/search');
  const a = await t.commit('Add filters');
  const b = await t.commit('Add sorting');
  await t.run('codegit.commit.drop', [a, [a, b]], [button('Continue', /Drop 2 commits/)]);
  assert.deepEqual(t.subjects(2), ['fixup! Add search', 'Add search']);
});

scenario('commit: drop with a conflict, abort from the prompt', async (t) => {
  const before = t.rev('HEAD');
  await t.run('codegit.commit.drop', [await t.commit('Fix typo in docs')], [button('Continue'), button('Abort', /Rebase stopped/)]);
  assert.ok(!t.operationInProgress(), 'the rebase was aborted');
  assert.equal(t.rev('HEAD'), before);
  assert.equal(t.status(), BASELINE);
});

scenario('commit: conflict, skip the commit', async (t) => {
  await t.cleanTree();
  await t.run('codegit.commit.drop', [await t.commit('Fix typo in docs')], [button('Continue'), dismiss(/Rebase stopped/)]);
  assert.ok(t.operationInProgress());
  await t.run('codegit.operation.skip');
  assert.ok(!t.operationInProgress());
  assert.deepEqual(t.subjects(2), ['Add settings page', 'Bump version']);
});

scenario('commit: conflict, abort from the operation menu', async (t) => {
  const before = t.rev('HEAD');
  await t.run('codegit.commit.drop', [await t.commit('Fix typo in docs')], [button('Continue'), dismiss(/Rebase stopped/)]);
  await t.run('codegit.operation.menu', [], [pick('Abort')]);
  assert.ok(!t.operationInProgress());
  assert.equal(t.rev('HEAD'), before);
  assert.equal(t.status(), BASELINE);
});

scenario('commit: reword', async (t) => {
  await t.run('codegit.commit.reword', [await t.commit('Add settings page')], [input('Add settings screen', /Reword/)]);
  assert.deepEqual(t.subjects(3), ['Add profile page', 'Fix typo in docs', 'Add settings screen']);
  assert.equal(t.status(), BASELINE);
});

scenario('commit: reword keeps the message body', async (t) => {
  await t.run('codegit.commit.reword', [await t.commit('Add profile page')], [input('Add profile screen')]);
  const message = t.sh('log', '-1', '--format=%B');
  assert.match(message, /^Add profile screen\n\nThis commit has a longer message body/);
  assert.match(message, /Refs: #42/);
});

scenario('commit: reword in editor', async (t) => {
  const running = vscode.commands.executeCommand('codegit.commit.rewordInEditor', await t.commit('Add profile page'));
  const editor = await waitFor('the message editor', () =>
    vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath.endsWith('CODEGIT_EDITMSG')),
  );
  assert.match(editor.document.getText(), /Refs: #42/);
  await editor.edit((b) =>
    b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), 'Profile page\n\nRewritten body.\n# a comment\n'),
  );
  await editor.document.save();
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.label.includes('CODEGIT_EDITMSG'));
  assert.ok(tab);
  await vscode.window.tabGroups.close(tab);
  await running;
  t.check('reword in editor');
  assert.equal(t.sh('log', '-1', '--format=%B').trim(), 'Profile page\n\nRewritten body.');
});

scenario('commit: rewording a pushed commit asks first', async (t) => {
  const before = t.rev('HEAD');
  await t.run('codegit.commit.reword', [await t.commit('Bump version')], [input('Bump version to 2'), dismiss(/already pushed/)]);
  assert.equal(t.rev('HEAD'), before, 'cancelled');
  await t.refresh();
  await t.run('codegit.commit.reword', [await t.commit('Bump version')], [input('Bump version to 2'), button('Rewrite History')]);
  assert.equal(t.subjects(4)[3], 'Bump version to 2');
});

scenario('commit: the pushed-commit warning can be turned off', async (t) => {
  await vscode.workspace.getConfiguration('codegit').update('confirmRewritingPushedCommits', false, vscode.ConfigurationTarget.Global);
  try {
    await t.run('codegit.commit.reword', [await t.commit('Bump version')], [input('Bump version to 2')]);
    assert.equal(t.subjects(4)[3], 'Bump version to 2');
  } finally {
    await vscode.workspace.getConfiguration('codegit').update('confirmRewritingPushedCommits', undefined, vscode.ConfigurationTarget.Global);
  }
});

scenario('commit: rewriting below a merge commit keeps the merge', async (t) => {
  await t.checkout('feature/with-merge');
  await t.run('codegit.commit.reword', [await t.commit('Side work')], [input('Side work, reworded')]);
  assert.deepEqual(t.sh('log', '--first-parent', '--format=%s', '-3').split('\n'), [
    'After merge',
    "Merge branch 'feature/merged-in' into feature/with-merge",
    'Side work, reworded',
  ]);
  assert.equal(t.sh('log', '-1', '--format=%s', 'HEAD^^2'), 'Merged-in work');
});

scenario('commit: reword, revert and drop a merge commit', async (t) => {
  await t.checkout('feature/with-merge');
  const merge = async () => {
    const found = (await t.commits()).find((c) => c.parents.length === 2);
    assert.ok(found, 'a merge commit in the Commits view');
    return found;
  };
  await t.run('codegit.commit.reword', [await merge()], [input('Merge the merged-in work')]);
  assert.deepEqual(t.sh('log', '--first-parent', '--format=%s', '-3').split('\n'), ['After merge', 'Merge the merged-in work', 'Side work']);
  assert.equal(t.sh('log', '-1', '--format=%s', 'HEAD^^2'), 'Merged-in work');

  await t.run('codegit.commit.revert', [await merge()], [pick('Keep parent 1: Side work', /which side to keep/)]);
  assert.equal(t.subjects(1)[0], 'Revert "Merge the merged-in work"');
  assert.equal(fs.existsSync(path.join(t.repo, 'merged-in.txt')), false);

  t.sh('reset', '-q', '--hard', 'HEAD~1');
  await t.refresh();
  await t.run('codegit.commit.drop', [await merge()], [button('Continue', /Drop 1 commit/)]);
  assert.deepEqual(t.subjects(2), ['After merge', 'Side work']);
  assert.equal(t.sh('rev-list', '--merges', '--count', 'HEAD'), '0');
  assert.equal(fs.existsSync(path.join(t.repo, 'merged-in.txt')), false);
});

scenario('commit: edit, amend, continue', async (t) => {
  await t.run('codegit.commit.edit', [await t.commit('Add settings page')]);
  assert.ok(t.operationInProgress());
  assert.equal(t.subjects(1)[0], 'Add settings page');
  fs.writeFileSync(path.join(t.repo, 'settings.txt'), 'edited\n');
  t.sh('add', 'settings.txt');
  await t.run('codegit.operation.continue');
  assert.ok(!t.operationInProgress());
  assert.equal(t.sh('show', 'HEAD~2:settings.txt'), 'edited');
  assert.deepEqual(t.subjects(3), ['Add profile page', 'Fix typo in docs', 'Add settings page']);
  assert.equal(t.status(), BASELINE);
});

scenario('commit: amend staged changes into an older commit', async (t) => {
  await t.run('codegit.commit.amendStaged', [await t.commit('Add settings page')]);
  assert.match(t.sh('show', '--name-only', '--format=', 'HEAD~2'), /notes\.txt/);
  assert.equal(t.status(), ' M README.md');
});

scenario('commit: amend staged with nothing staged warns', async (t) => {
  t.sh('reset', '-q', 'notes.txt');
  await t.refresh();
  await t.run('codegit.commit.amendStaged', [await t.commit('Add settings page')]);
  assert.ok(t.saw('warning', /no staged changes/));
});

scenario('commit: create a fixup commit, then squash it in', async (t) => {
  await t.run('codegit.commit.createFixup', [await t.commit('Add settings page')]);
  assert.equal(t.subjects(1)[0], 'fixup! Add settings page');
  await t.run('codegit.commit.autosquash', [await t.commit('Add settings page')]);
  assert.deepEqual(t.subjects(3), ['Add profile page', 'Fix typo in docs', 'Add settings page']);
  assert.match(t.sh('show', '--name-only', '--format=', 'HEAD~2'), /notes\.txt/);
  assert.equal(t.status(), ' M README.md');
});

scenario('commit: squash existing fixup commits above', async (t) => {
  await t.checkout('feature/search');
  await t.run('codegit.commit.autosquash', [await t.commit('Add search')]);
  assert.deepEqual(t.subjects(3), ['Add sorting', 'Add filters', 'Add search']);
  assert.match(t.sh('show', 'HEAD~2:search.txt'), /fixed typo/);
});

scenario('commit: amend author (reset, set, co-author)', async (t) => {
  await t.run('codegit.commit.amendAuthor', [await t.commit('Fix typo in docs')], [pick('Reset Author')]);
  assert.equal(t.sh('log', '-1', '--format=%an', 'HEAD~1'), 'Playground User');
  await t.run('codegit.commit.amendAuthor', [await t.commit('Fix typo in docs')], [
    pick('Set Author…'),
    input('Ada Lovelace <ada@example.com>'),
  ]);
  assert.equal(t.sh('log', '-1', '--format=%an <%ae>', 'HEAD~1'), 'Ada Lovelace <ada@example.com>');
  await t.run('codegit.commit.amendAuthor', [await t.commit('Add profile page')], [
    pick('Add Co-Author…'),
    input('Grace Hopper <grace@example.com>'),
  ]);
  assert.match(t.sh('log', '-1', '--format=%B'), /Co-authored-by: Grace Hopper <grace@example.com>/);
  const shown = await t.commit('Add profile page');
  assert.deepEqual(shown.coAuthors, [{ name: 'Grace Hopper', email: 'grace@example.com' }], 'the Commits view lists the co-author');
  assert.equal(t.status(), BASELINE);
});

scenario('commit: move up and down', async (t) => {
  await t.run('codegit.commit.moveUp', [await t.commit('Add settings page')]);
  assert.deepEqual(t.subjects(3), ['Add profile page', 'Add settings page', 'Fix typo in docs']);
  await t.run('codegit.commit.moveDown', [await t.commit('Add settings page')]);
  assert.deepEqual(t.subjects(3), ['Add profile page', 'Fix typo in docs', 'Add settings page']);
  await t.run('codegit.commit.moveUp', [await t.commit('Add profile page')]);
  assert.ok(t.saw('warning', /already the newest/));
  assert.equal(t.status(), BASELINE);
});

scenario('commit: rewrites that need the full history refuse while filtered', async (t) => {
  await t.run('codegit.commits.showFileHistory', [vscode.Uri.file(path.join(t.repo, 'app.txt'))]);
  const before = t.rev('HEAD');
  await t.run('codegit.commit.squash', [await t.commit('Bump version')]);
  assert.ok(t.saw('warning', /full history/));
  assert.equal(t.rev('HEAD'), before);
});

// --- Commits view: other actions -------------------------------------------------------------

scenario('commit: cherry-pick from another branch', async (t) => {
  await t.cleanTree();
  const commits = (await t.children('branches', await t.localBranch('feature/search'))) as CommitNode[];
  const sorting = commits.find((c) => c.subject === 'Add sorting');
  assert.ok(sorting);
  await t.run('codegit.commit.copyForCherryPick', [sorting]);
  await t.run('codegit.commit.pasteCherryPick', [], [button('Cherry-Pick', /Cherry-pick 1 commit/)]);
  assert.equal(t.subjects(1)[0], 'Add sorting');
});

scenario('commit: reset mixed and hard', async (t) => {
  const typo = await t.commit('Fix typo in docs');
  await t.run('codegit.commit.reset', [typo], [pick('Mixed')]);
  assert.equal(t.rev('HEAD'), typo.sha);
  assert.match(t.status(), /\?\? profile\.txt|\?\? avatar\.txt/);
  await t.refresh();
  await t.run('codegit.commit.reset', [await t.commit('Add settings page')], [pick('Hard'), button('Reset')]);
  assert.equal(t.subjects(1)[0], 'Add settings page');
  assert.equal(t.sh('status', '--porcelain', '--untracked-files=no'), '');
});

scenario('commit: checkout, create branch', async (t) => {
  await t.cleanTree();
  const config = await t.commit('Add config');
  await t.run('codegit.commit.checkout', [config]);
  assert.equal(t.branch(), '');
  assert.equal(t.rev('HEAD'), config.sha);
  await t.run('codegit.commit.createBranch', [config], [input('from-config', /New branch at/)]);
  assert.equal(t.branch(), 'from-config');
});

scenario('commit: revert', async (t) => {
  await t.cleanTree();
  await t.run('codegit.commit.revert', [await t.commit('Add settings page')], [button('Revert', /Revert 1 commit/)]);
  assert.equal(t.subjects(1)[0], 'Revert "Add settings page"');
});

scenario('commit: copy menu, SHA and message', async (t) => {
  const profile = await t.commit('Add profile page');
  await t.run('codegit.commit.copy', [profile], [pick('Subject')]);
  assert.equal(await clipboard(), 'Add profile page');
  await t.run('codegit.commit.copy', [profile], [pick('Author')]);
  assert.equal(await clipboard(), 'Playground User <you@example.com>');
  await t.run('codegit.commit.copy', [profile], [pick('Diff')]);
  assert.match(await clipboard(), /^diff --git/);
  await t.run('codegit.commit.copySha', [profile]);
  assert.equal(await clipboard(), profile.sha);
  await t.run('codegit.commit.copyMessage', [profile]);
  assert.match(await clipboard(), /Refs: #42/);
});

scenario('commit: open in browser', async (t) => {
  t.sh('remote', 'set-url', 'origin', 'git@github.com:acme/playground.git');
  await t.refresh();
  const profile = await t.commit('Add profile page');
  await t.run('codegit.commit.openInBrowser', [profile]);
  assert.deepEqual(prompts.opened, [`https://github.com/acme/playground/commit/${profile.sha}`]);
});

scenario('commit: open all changes', async (t) => {
  await t.run('codegit.commit.openChanges', [await t.commit('Add settings page')]);
  await waitFor('the multi-diff editor', () => activeTabLabel().includes('Add settings page'));
});

// --- Commit files -----------------------------------------------------------------------------

scenario('file: remove from commit', async (t) => {
  const file = await t.file(await t.commit('Add settings page'), 'config.json');
  await t.run('codegit.file.removeFromCommit', [file], [button('Remove', /Discard the changes to config.json/)]);
  assert.equal(t.sh('show', '--name-only', '--format=', 'HEAD~2'), 'settings.txt');
  assert.equal(t.sh('show', 'HEAD:config.json'), '{ "debug": false }');
  assert.equal(t.status(), BASELINE);
});

scenario('file: move out of commit into the index', async (t) => {
  const file = await t.file(await t.commit('Add settings page'), 'config.json');
  await t.run('codegit.file.moveToIndex', [file], [button('Move to Index')]);
  assert.equal(t.sh('show', '--name-only', '--format=', 'HEAD~2'), 'settings.txt');
  assert.deepEqual(t.sh('diff', '--cached', '--name-only').split('\n').sort(), ['config.json', 'notes.txt']);
  assert.equal(t.read('config.json'), '{ "debug": true }\n');
  assert.match(t.status(), / M README\.md/);
});

scenario('file: check out from a commit', async (t) => {
  const file = await t.file(await t.commit('Add config'), 'config.json');
  await t.run('codegit.file.checkout', [file], [button('Checkout File', /Replace config.json/)]);
  assert.equal(t.read('config.json'), '{ "debug": false }\n');
});

scenario('patch: take selected lines out of a commit from its diff', async (t) => {
  await t.cleanTree();
  const write = (content: string) => fs.writeFileSync(path.join(t.repo, 'lines.txt'), content);
  write('a\nb\nc\nd\ne\nf\ng\nh\n');
  t.sh('add', 'lines.txt');
  t.sh('commit', '-q', '-m', 'Add lines');
  write('a\nb\nC\nd\ne\nN1\nN2\nf\ng\nh\n');
  t.sh('commit', '-q', '-am', 'Change lines');
  fs.writeFileSync(path.join(t.repo, 'later.txt'), 'later\n');
  t.sh('add', 'later.txt');
  t.sh('commit', '-q', '-m', 'Later');
  await t.refresh();

  const commitSide = (text: string) =>
    waitFor('the commit side of the diff', () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.scheme === 'git' && editor.document.getText().includes(text) ? editor : undefined;
    });

  // Select the two inserted lines and move them to a new commit.
  await t.run('codegit.openFileDiff', [await t.file(await t.commit('Change lines'), 'lines.txt')]);
  const editor = await commitSide('N1');
  editor.selection = new vscode.Selection(5, 0, 6, 2);
  await t.run('codegit.patch.moveToNewCommit', [], [input('Insert N lines', /New commit after/)]);
  assert.deepEqual(t.subjects(3), ['Later', 'Insert N lines', 'Change lines']);
  assert.equal(t.sh('show', 'HEAD~2:lines.txt'), 'a\nb\nC\nd\ne\nf\ng\nh');
  assert.equal(t.read('lines.txt'), 'a\nb\nC\nd\ne\nN1\nN2\nf\ng\nh\n', 'the end result is unchanged');

  // With only a cursor on the changed line, that change is taken out and the original line comes back.
  await t.run('codegit.openFileDiff', [await t.file(await t.commit('Change lines'), 'lines.txt')]);
  const rewritten = await commitSide('C\nd\ne\nf');
  rewritten.selection = new vscode.Selection(2, 0, 2, 0);
  await t.run('codegit.patch.remove', [], [button('Remove', /Discard the selected changes to lines.txt/)]);
  assert.equal(t.sh('show', 'HEAD~2:lines.txt'), 'a\nb\nc\nd\ne\nf\ng\nh');
  assert.deepEqual(t.subjects(3), ['Later', 'Insert N lines', 'Change lines']);
});

scenario('patch: build a custom patch across files, move it into another commit, apply it in reverse', async (t) => {
  await t.cleanTree();
  const write = (file: string, content: string) => fs.writeFileSync(path.join(t.repo, file), content);
  write('lines.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n');
  t.sh('add', 'lines.txt');
  t.sh('commit', '-q', '-m', 'Add lines');
  write('lines.txt', 'a\nb\nC\nd\ne\nN1\nN2\nf\ng\nh\n');
  write('extra.txt', 'extra\n');
  t.sh('add', '.');
  t.sh('commit', '-q', '-m', 'Change lines');
  write('later.txt', 'later\n');
  t.sh('add', 'later.txt');
  t.sh('commit', '-q', '-m', 'Later');
  await t.refresh();

  // The two inserted lines, and all of extra.txt.
  await t.run('codegit.openFileDiff', [await t.file(await t.commit('Change lines'), 'lines.txt')]);
  const editor = await waitFor('the commit side of the diff', () => {
    const active = vscode.window.activeTextEditor;
    return active?.document.uri.scheme === 'git' && active.document.getText().includes('N1') ? active : undefined;
  });
  editor.selection = new vscode.Selection(5, 0, 6, 2);
  await t.run('codegit.patch.add');
  await t.run('codegit.file.addToPatch', [await t.file(await t.commit('Change lines'), 'extra.txt')]);

  await t.run('codegit.commit.movePatchHere', [await t.commit('Later')]);
  assert.deepEqual(t.subjects(3), ['Later', 'Change lines', 'Add lines']);
  assert.equal(t.sh('show', 'HEAD~1:lines.txt'), 'a\nb\nC\nd\ne\nf\ng\nh');
  assert.equal(t.sh('show', '--name-only', '--format=', 'HEAD~1'), 'lines.txt');
  assert.equal(t.sh('show', '--name-only', '--format=', 'HEAD').split('\n').sort().join(' '), 'extra.txt later.txt lines.txt');
  assert.equal(t.read('lines.txt'), 'a\nb\nC\nd\ne\nN1\nN2\nf\ng\nh\n', 'the end result is unchanged');

  // Undo later.txt in the working tree only.
  const head = t.rev('HEAD');
  await t.run('codegit.file.addToPatch', [await t.file(await t.commit('Later'), 'later.txt')]);
  await t.run('codegit.patch.menu', [], [pick('Apply in Reverse to Working Tree', /Custom patch from/)]);
  assert.equal(t.rev('HEAD'), head);
  assert.equal(fs.existsSync(path.join(t.repo, 'later.txt')), false);
  await t.run('codegit.patch.reset');
});

scenario('file: open diff and open at revision', async (t) => {
  const file = await t.file(await t.commit('Add settings page'), 'settings.txt');
  await t.run('codegit.openFileDiff', [file]);
  await waitFor('the diff editor', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
  await t.run('codegit.file.openAtRevision', [file]);
  const doc = await waitFor('the file at its revision', () =>
    vscode.window.activeTextEditor?.document.uri.scheme === 'git' ? vscode.window.activeTextEditor.document : undefined,
  );
  assert.equal(doc.getText(), 'settings\n');
});

// --- Search, all branches, graph ----------------------------------------------------------------

const subjectsShown = async (t: Context) => (await t.commits()).map((c) => c.subject);

scenario('commits: search by message, author and SHA', async (t) => {
  await t.run('codegit.commits.search', [], [input('LOGIN', /Search commits/)]);
  assert.deepEqual(await subjectsShown(t), ['Add login page'], 'case-insensitive message search on this branch');
  await t.run('codegit.commits.search', [], [input('someone else')]);
  assert.deepEqual(await subjectsShown(t), ['Fix typo in docs'], 'author search');
  const sha = t.rev('v0.9').slice(0, 7);
  await t.run('codegit.commits.search', [], [input(sha)]);
  assert.deepEqual(await subjectsShown(t), ['Add config'], 'SHA prefix');
  await t.run('codegit.commits.clearSearch');
  assert.ok((await t.commits()).length > 5);
});

scenario('commits: squash and move refuse while searching', async (t) => {
  await t.run('codegit.commits.search', [], [input('page')]);
  const before = t.rev('HEAD');
  await t.run('codegit.commit.squash', [await t.commit('Add profile page')]);
  assert.ok(t.saw('warning', /Clear the search first/));
  assert.equal(t.rev('HEAD'), before);
  // Rewrites of a single commit still work.
  await t.run('codegit.commit.reword', [await t.commit('Add settings page')], [input('Add settings screen')]);
  assert.equal(t.subjects(3)[2], 'Add settings screen');
});

scenario('commits: all branches lists other branches, which cannot be rewritten', async (t) => {
  await t.run('codegit.commits.showAllBranches');
  const sorting = await t.commit('Add sorting');
  assert.equal(sorting.onHead, false, 'feature/search commits are marked as not on HEAD');
  assert.equal((await t.commit('Add profile page')).onHead, true);
  const item = await t.api.providers.commits.getTreeItem(sorting);
  assert.match(String(item.contextValue), /:other/, 'rewrite menu items are hidden for it');
  await t.run('codegit.commit.drop', [sorting]);
  assert.ok(t.saw('warning', /not on the current branch/));
  assert.equal(t.rev('feature/search'), sorting.sha, 'feature/search is untouched');
  // Non-rewriting actions work on any commit. (Creating a branch checks it out: needs a clean tree.)
  await t.cleanTree();
  await t.run('codegit.commit.createBranch', [sorting], [input('from-sorting')]);
  assert.equal(t.rev('from-sorting'), sorting.sha);
  // from-sorting is now checked out, so the view lists exactly its history again.
  await t.run('codegit.commits.showCurrentBranch');
  const shown = await t.commits();
  assert.ok(shown.every((c) => c.onHead !== false), 'no other-branch commits');
  assert.deepEqual(shown.map((c) => c.subject), t.subjects(shown.length));
});

scenario('commits: merge commits are marked', async (t) => {
  await t.checkout('feature/with-merge');
  const merge = (await t.commits()).find((c) => c.parents.length === 2);
  assert.ok(merge);
  const item = await t.api.providers.commits.getTreeItem(merge);
  assert.equal((item.iconPath as vscode.ThemeIcon).id, 'git-merge');
  assert.match(String(item.contextValue), /:merge/);
});

const graphArg = (sha: string) => ({ webview: 'codegit.graph', webviewSection: 'commit', sha, codegitOnHead: true });

scenario('graph: opens, and its context menu runs commit commands', async (t) => {
  await t.run('codegit.graph.open');
  await waitFor('the graph panel', () => activeTabLabel().startsWith('Commit Graph'));
  const profile = await t.commit('Add profile page');
  // The panel loads asynchronously; once it has, a context-menu command on its rows works.
  await waitFor('the graph to list commits', async () => {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('codegit.commit.copySha', graphArg(profile.sha));
    return (await clipboard()) === profile.sha;
  });
  assert.match(activeTabLabel(), /Commit Graph: main/);
  await t.run('codegit.commit.reword', [graphArg(t.rev('HEAD~1'))], [input('Fix typo in the docs', /Reword/)]);
  assert.equal(t.subjects(2)[1], 'Fix typo in the docs');
});

scenario('graph: other branches are listed and protected', async (t) => {
  await t.run('codegit.graph.open');
  const sorting = t.rev('feature/search');
  await waitFor('the graph to list feature/search', async () => {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('codegit.commit.copySha', graphArg(sorting));
    return (await clipboard()) === sorting;
  });
  await t.run('codegit.commit.drop', [graphArg(sorting)]);
  assert.ok(t.saw('warning', /not on the current branch/));
  assert.equal(t.rev('feature/search'), sorting);
});

// --- Filter, todo list, bisect, compare --------------------------------------------------------

scenario('commits: filter by file and clear', async (t) => {
  await t.run('codegit.commits.showFileHistory', [vscode.Uri.file(path.join(t.repo, 'app.txt'))]);
  assert.deepEqual(
    (await t.commits()).map((c) => c.subject),
    ['Bump version', 'Refactor parser', 'Initial commit'],
  );
  await t.run('codegit.commits.clearFilter');
  assert.ok((await t.commits()).length > 3);
});

scenario('rebase todo: change a step before continuing', async (t) => {
  await t.cleanTree();
  await t.run('codegit.commit.edit', [await t.commit('Add settings page')]);
  const todos = await t.todos();
  assert.deepEqual(todos.map((n) => n.subject), ['Add profile page', 'Fix typo in docs']);
  await t.run('codegit.todo.setAction', [todos[0]], [pick('drop')]);
  assert.equal((await t.todos())[0].action, 'drop');
  await t.run('codegit.operation.continue');
  assert.ok(!t.operationInProgress());
  assert.deepEqual(t.subjects(2), ['Fix typo in docs', 'Add settings page']);
});

scenario('rebase todo: reword a step before continuing', async (t) => {
  await t.cleanTree();
  await t.run('codegit.commit.edit', [await t.commit('Add settings page')]);
  const step = (await t.todos()).find((n) => n.subject === 'Add profile page');
  assert.ok(step);
  await t.run('codegit.todo.setAction', [step], [pick('reword'), input('Add the profile page', /Reword/)]);
  assert.equal((await t.todos()).find((n) => n.sha === step.sha)?.action, 'reword');
  await t.run('codegit.operation.continue');
  assert.ok(!t.operationInProgress());
  assert.deepEqual(t.subjects(3), ['Add the profile page', 'Fix typo in docs', 'Add settings page']);
  assert.ok(t.sh('log', '-1', '--format=%b', 'HEAD').trim().length > 0, 'the multi-line body is kept');
});

scenario('rebase todo: reorder steps', async (t) => {
  await t.checkout('feature/search');
  await t.run('codegit.commit.edit', [await t.commit('Add search')]);
  const filters = (await t.todos()).find((n) => n.subject === 'Add filters');
  assert.ok(filters);
  await t.run('codegit.todo.moveUp', [filters]);
  await t.run('codegit.operation.continue');
  assert.deepEqual(t.subjects(4), ['Add sorting', 'Add filters', 'fixup! Add search', 'Add search']);
});

async function bisectUntilFound(t: Context): Promise<void> {
  for (let step = 0; step < 10; step++) {
    if (!fs.existsSync(path.join(t.repo, '.git', 'BISECT_START'))) return;
    const bad = t.read('app.txt').includes('BUG');
    const node = await t.commitAt(t.rev('HEAD'));
    prompts.queue.push(button('Reset Bisect', /is the first '?bad'? commit/));
    await vscode.commands.executeCommand(bad ? 'codegit.bisect.markBad' : 'codegit.bisect.markGood', node);
    prompts.queue.splice(0); // only the last mark shows the result
    t.check('bisect step');
  }
  throw new Error('bisect did not finish');
}

scenario('bisect: finds the commit that introduced the bug', async (t) => {
  await t.cleanTree();
  await t.run('codegit.bisect.markBad', [await t.commit('Add profile page')]);
  await t.run('codegit.bisect.markGood', [await t.commit('Add config')]);
  assert.ok(t.saw('info', /Test the checked-out commit/));
  await bisectUntilFound(t);
  const culprit = t.sh('log', '--format=%H', '--grep=^Refactor parser$', 'main');
  assert.ok(t.saw('info', new RegExp(`${culprit}.*is the first '?bad'? commit`)), 'git names Refactor parser');
  assert.equal(t.branch(), 'main', 'reset afterwards');
});

scenario('bisect: skip, rewrites refuse, reset', async (t) => {
  await t.cleanTree();
  await t.run('codegit.bisect.markBad', [await t.commit('Add profile page')]);
  await t.run('codegit.bisect.markGood', [await t.commit('Add config')]);
  const before = t.rev('HEAD');
  await t.run('codegit.bisect.skip', [await t.commitAt(before)]);
  assert.notEqual(t.rev('HEAD'), before);
  await t.run('codegit.commit.reword', [await t.commit('Add profile page')]);
  assert.ok(t.saw('warning', /bisect/));
  await t.run('codegit.bisect.reset');
  assert.equal(t.branch(), 'main');
});

scenario('compare: a tag with a branch, and two commits', async (t) => {
  await t.run('codegit.compare.select', [await t.tag('v0.9')]);
  await t.run('codegit.compare.withSelected', [await t.localBranch('feature/search')]);
  await waitFor('the compare editor', () => activeTabLabel().includes('v0.9 ↔ feature/search'));
  const a = await t.commit('Add config');
  await t.run('codegit.compare.select', [a]);
  await t.run('codegit.compare.withSelected', [await t.commit('Add logout')]);
  await waitFor('the compare editor', () => activeTabLabel().startsWith(a.shortSha));
});

// --- Undo / redo --------------------------------------------------------------------------------

scenario('undo/redo: a reword, keeping uncommitted changes', async (t) => {
  const before = t.rev('HEAD');
  await t.run('codegit.commit.reword', [await t.commit('Add settings page')], [input('Add settings screen')]);
  const after = t.rev('HEAD');
  await t.run('codegit.undo', [], [button('Undo', /Undo/)]);
  assert.equal(t.rev('HEAD'), before);
  assert.equal(t.status(), BASELINE);
  await t.run('codegit.redo', [], [button('Redo', /Redo/)]);
  assert.equal(t.rev('HEAD'), after);
  assert.equal(t.status(), BASELINE);
});

scenario('undo: a checkout', async (t) => {
  await t.cleanTree();
  await t.run('codegit.branch.checkout', [await t.localBranch('feature/search')]);
  await t.run('codegit.undo', [], [button('Undo', /checks out/)]);
  assert.equal(t.branch(), 'main');
});

scenario('undo: a squash is one step', async (t) => {
  const before = t.rev('HEAD');
  await t.run('codegit.commit.squash', [await t.commit('Fix typo in docs')]);
  await t.run('codegit.undo', [], [button('Undo')]);
  assert.equal(t.rev('HEAD'), before);
});

scenario('undo: a commit made outside CodeGit', async (t) => {
  const before = t.rev('HEAD');
  t.sh('commit', '-q', '-m', 'Outside commit');
  await t.refresh();
  await t.run('codegit.undo', [], [button('Undo', /Outside commit.*leaves the commit's changes staged/)]);
  assert.equal(t.rev('HEAD'), before);
  assert.equal(t.status(), BASELINE, 'the commit is undone into the index, as with lazygit');
  await t.run('codegit.redo', [], [button('Redo', /files are not touched/)]);
  assert.equal(t.subjects(1)[0], 'Outside commit');
  assert.equal(t.status(), ' M README.md');
});

scenario('redo: nothing to redo', async (t) => {
  await t.run('codegit.redo');
  assert.ok(t.saw('info', /Nothing to redo/));
});

// --- Stashes and reflog ---------------------------------------------------------------------------

scenario('stash: push everything', async (t) => {
  await t.run('codegit.stash.push', [], [input('e2e stash')]);
  assert.equal(t.status(), '');
  assert.match(t.sh('stash', 'list', '-1'), /e2e stash/);
});

scenario('stash: push staged only, and keeping the index', async (t) => {
  await t.run('codegit.stash.pushStaged', [], [input('staged only')]);
  assert.equal(t.status(), ' M README.md');
  assert.equal(t.sh('stash', 'show', '--name-only', 'stash@{0}'), 'notes.txt');
  t.sh('stash', 'pop', '-q', '--index');
  await t.refresh();
  await t.run('codegit.stash.pushKeepIndex', [], [input('')]);
  assert.equal(t.status(), 'A  notes.txt');
});

scenario('stash: apply, pop, drop', async (t) => {
  await t.cleanTree();
  await t.run('codegit.stash.apply', [await t.stash('WIP settings')]);
  assert.ok(fs.existsSync(path.join(t.repo, 'scratch.txt')), 'untracked file restored');
  assert.equal(t.sh('stash', 'list').split('\n').length, 2);
  await t.cleanTree();
  await t.run('codegit.stash.pop', [await t.stash('WIP settings')]);
  assert.equal(t.sh('stash', 'list').split('\n').length, 1);
  await t.run('codegit.stash.drop', [await t.stash('Only staged')], [button('Drop')]);
  assert.equal(t.sh('stash', 'list'), '');
});

scenario('stash: rename', async (t) => {
  await t.run('codegit.stash.rename', [await t.stash('WIP settings')], [input('Renamed stash')]);
  const list = t.sh('stash', 'list');
  assert.match(list, /Renamed stash/);
  assert.equal(list.split('\n').length, 2);
});

scenario('stash: create a branch from a stash', async (t) => {
  await t.cleanTree();
  await t.run('codegit.stash.branch', [await t.stash('WIP settings')], [input('from-stash')]);
  assert.equal(t.branch(), 'from-stash');
  assert.ok(fs.existsSync(path.join(t.repo, 'scratch.txt')));
  assert.equal(t.sh('stash', 'list').split('\n').length, 1);
});

scenario('reflog: check out, branch from and cherry-pick an entry', async (t) => {
  await t.cleanTree();
  t.sh('switch', '-q', 'feature/search');
  t.sh('switch', '-q', 'main');
  await t.refresh();
  const entry = (await t.reflog()).find((n: Node) => n.kind === 'commit' && n.sha === t.rev('feature/search')) as CommitNode;
  assert.ok(entry, 'the reflog lists the feature/search checkout');
  await t.run('codegit.commit.copyForCherryPick', [entry]);
  await t.run('codegit.commit.pasteCherryPick', [], [button('Cherry-Pick')]);
  assert.equal(t.subjects(1)[0], 'Add sorting');
  await t.run('codegit.commit.createBranch', [entry], [input('from-reflog')]);
  assert.equal(t.rev('from-reflog'), t.rev('feature/search'));
  await t.run('codegit.commit.checkout', [entry]);
  assert.equal(t.rev('HEAD'), t.rev('feature/search'));
});

export default scenarios;
