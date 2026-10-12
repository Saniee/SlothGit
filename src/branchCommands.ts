import * as path from 'node:path';
import * as vscode from 'vscode';
import { createTag, openMultiDiff, webRepo } from './commands';
import { pullRequestUrl } from './git/hosting';
import { getCommitFiles, getRemoteDefaultBranch, headSha } from './git/queries';
import { GitError } from './git/runner';
import type { RepoManager } from './repoManager';
import type { Runner } from './runner';
import { ForcePushMode } from './types/git';
import type { BranchesProvider } from './views/branches';
import type { FileNode, Node, RefNode, RemoteNode, WorktreeNode } from './views/nodes';
import type { CommitsProvider } from './views/providers';

export interface BranchCommandDeps {
  repos: RepoManager;
  branches: BranchesProvider;
  branchesView: vscode.TreeView<Node>;
  commits: CommitsProvider;
  runner: Runner;
}

type LocalRef = Extract<RefNode, { type: 'local' }>;
type TagRef = Extract<RefNode, { type: 'tag' }>;

export function registerBranchCommands(deps: BranchCommandDeps): vscode.Disposable[] {
  const { repos, branches, branchesView, commits, runner } = deps;
  const { run, confirm } = runner;

  // --- target resolution ------------------------------------------------------

  /** The clicked node, or the view selection when run from the Command Palette. */
  function target(arg?: Node): Node | undefined {
    return arg ?? branchesView.selection[0];
  }

  function refTarget<T extends RefNode['type']>(arg: Node | undefined, ...types: T[]): Extract<RefNode, { type: T }> | undefined {
    const node = target(arg);
    if (node?.kind === 'ref' && (types as string[]).includes(node.type)) return node as Extract<RefNode, { type: T }>;
    void vscode.window.showInformationMessage('Select a branch or tag in the Branches view first.');
    return undefined;
  }

  function remoteTarget(arg?: Node): RemoteNode | undefined {
    const node = target(arg);
    if (node?.kind === 'remote') return node;
    void vscode.window.showInformationMessage('Select a remote in the Branches view first.');
    return undefined;
  }

  function worktreeTarget(arg?: Node): WorktreeNode | undefined {
    const node = target(arg);
    if (node?.kind === 'worktree') return node;
    void vscode.window.showInformationMessage('Select a worktree in the Branches view first.');
    return undefined;
  }

  async function openFolder(dir: string, newWindow: boolean): Promise<void> {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: newWindow });
  }

  function currentBranch(): string | undefined {
    return branches.localBranches.find((b) => b.current)?.name;
  }

  function currentLabel(): string {
    return currentBranch() ?? 'HEAD';
  }

  async function pickRemote(title: string): Promise<string | undefined> {
    const names = branches.remoteNames;
    if (!names.length) {
      void vscode.window.showWarningMessage('This repository has no remotes. Add one in the Branches view first.');
      return undefined;
    }
    if (names.length === 1) return names[0];
    const sorted = [...names].sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
    return vscode.window.showQuickPick(sorted, { title });
  }

  // --- branch operations ---------------------------------------------------------

  async function deleteLocalBranch(node: LocalRef, alsoRemote: boolean): Promise<void> {
    const b = node.branch;
    let unmerged = false;
    const ok = await run(`Deleting ${b.name}…`, async (ops) => {
      try {
        await ops.deleteBranch(b.name, false);
      } catch (error) {
        if (!(error instanceof GitError) || !/not fully merged/.test(error.stderr)) throw error;
        unmerged = true;
      }
    });
    if (!ok) return;
    if (unmerged) {
      const question = `"${b.name}" is not fully merged. Delete it anyway? Its commits stay reachable from the Reflog for a while.`;
      if (!(await confirm(question, 'Force Delete'))) return;
      if (!(await run(`Deleting ${b.name}…`, (ops) => ops.deleteBranch(b.name, true)))) return;
    }
    if (alsoRemote && b.upstream) await deleteRemoteRef(b.upstream.remote, b.upstream.remoteRef);
  }

  function deleteRemoteRef(remote: string, remoteRef: string): Promise<boolean> {
    return run(`Deleting ${remoteRef.replace(/^refs\/(heads|tags)\//, '')} on ${remote}…`, (_ops, repo) =>
      repo.push(remote, `:${remoteRef}`),
    );
  }

  async function confirmPushedRewrite(exclude: string): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('codegit').get('confirmRewritingPushedCommits', true)) return true;
    const ops = repos.ops();
    const count = ops ? await ops.countPushedCommitsAfter(exclude).catch(() => 0) : 0;
    if (!count) return true;
    return confirm(
      `This rebase rewrites ${count === 1 ? '1 commit' : `${count} commits`} already pushed to the upstream branch. You will need to force push afterwards.`,
      'Rebase',
    );
  }

  async function pushBranch(node: LocalRef, force: boolean): Promise<void> {
    const b = node.branch;
    const upstream = b.upstream && !b.gone ? b.upstream : undefined;
    const remote = upstream?.remote ?? (await pickRemote(`Push ${b.name} to`));
    if (!remote) return;
    const refspec = `refs/heads/${b.name}:${upstream?.remoteRef ?? `refs/heads/${b.name}`}`;
    const destination = upstream?.name ?? `${remote}/${b.name}`;
    if (force && !(await confirm(`Force push ${b.name} to ${destination}? Commits on the remote that you don't have locally will be lost.`, 'Force Push'))) {
      return;
    }
    await run(`Pushing ${b.name}…`, async (_ops, repo) => {
      await repo.push(remote, refspec, !upstream, force ? ForcePushMode.ForceWithLease : undefined);
      return `Pushed ${b.name} to ${destination}.`;
    });
  }

  // --- commands ---------------------------------------------------------------

  const commands: Record<string, (...args: any[]) => unknown> = {
    'codegit.branch.checkout': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote', 'tag');
      if (!node) return;
      if (node.type === 'local') {
        if (node.branch.current) return;
        const worktree = node.branch.worktreePath;
        if (worktree) {
          // git refuses to check out a branch that another worktree has; offer to go there instead (as lazygit does).
          const choice = await vscode.window.showInformationMessage(
            `"${node.name}" is checked out in the worktree ${worktree}.`,
            'Open Worktree',
          );
          if (choice) await openFolder(worktree, true);
          return;
        }
        await run(`Checking out ${node.name}…`, (ops) => ops.switchBranch(node.name));
      } else if (node.type === 'remote') {
        await run(`Checking out ${node.name}…`, async (ops) => {
          const result = await ops.checkoutRemoteBranch(node.name, node.branch.branch);
          if (result === 'switched') return `Switched to the existing local branch "${node.branch.branch}".`;
        });
      } else {
        await run(`Checking out ${node.name}…`, (ops) => ops.checkout(node.rev));
      }
    },
    'codegit.branch.checkoutPrevious': () => run('Checking out previous branch…', (ops) => ops.switchPrevious()),

    'codegit.branch.create': async (arg?: Node) => {
      const node = target(arg);
      const from = node?.kind === 'ref' ? node : undefined;
      const label = from?.name ?? currentLabel();
      const suggestion = from?.type === 'remote' ? from.branch.branch : undefined;
      const name = await runner.askBranchName(`New branch from ${label}`, suggestion);
      if (name) await run('Creating branch…', (ops) => ops.createBranch(name, from?.rev ?? 'HEAD', true));
    },

    'codegit.branch.moveCommitsToNewBranch': async () => {
      const current = branches.localBranches.find((b) => b.current);
      if (!current) {
        void vscode.window.showInformationMessage('Check out the branch the commits were made on first.');
        return;
      }
      const ahead = current.upstream ? ` (${current.ahead} not pushed)` : '';
      const name = await runner.askBranchName(`New branch for the unpushed commits of ${current.name}${ahead}; ${current.name} goes back to its upstream`);
      if (!name) return;
      await run('Moving commits to a new branch…', async (ops) => {
        const count = await ops.moveCommitsToNewBranch(name);
        return `Moved ${count} commit${count === 1 ? '' : 's'} to ${name}, and reset ${current.name} to ${current.upstream?.name}.`;
      });
    },

    'codegit.branch.delete': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote');
      if (!node) return;
      if (node.type === 'remote') {
        const b = node.branch;
        if (!(await confirm(`Delete the branch "${b.branch}" on ${b.remote}? This affects everyone using that remote.`, 'Delete'))) return;
        await deleteRemoteRef(b.remote, `refs/heads/${b.branch}`);
        return;
      }
      const b = node.branch;
      if (b.current) {
        void vscode.window.showWarningMessage('You cannot delete the branch that is checked out.');
        return;
      }
      if (b.upstream && !b.gone) {
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'Delete Local Branch', local: true, remote: false },
            { label: `Delete Remote Branch`, description: b.upstream.name, local: false, remote: true },
            { label: 'Delete Local and Remote Branch', description: b.upstream.name, local: true, remote: true },
          ],
          { title: `Delete ${b.name}` },
        );
        if (!picked) return;
        if (picked.remote && !(await confirm(`Delete "${b.upstream.name}" on the remote? This affects everyone using it.`, 'Delete'))) return;
        if (picked.local) await deleteLocalBranch(node, picked.remote);
        else await deleteRemoteRef(b.upstream.remote, b.upstream.remoteRef);
        return;
      }
      if (await confirm(`Delete the local branch "${b.name}"?`, 'Delete')) await deleteLocalBranch(node, false);
    },

    'codegit.branch.rename': async (arg?: Node) => {
      const node = refTarget(arg, 'local');
      if (!node) return;
      const name = await runner.askBranchName(`Rename ${node.name}`, node.name);
      if (!name || name === node.name) return;
      await run('Renaming branch…', async (ops) => {
        await ops.renameBranch(node.name, name);
        if (node.branch.upstream) {
          return `Renamed to "${name}". It still tracks ${node.branch.upstream.name}; the branch on the remote was not renamed.`;
        }
      });
    },

    'codegit.branch.merge': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote', 'tag');
      if (!node) return;
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Fast-forward when possible', mode: 'default' as const },
          { label: 'Merge, Always Create a Merge Commit', description: '--no-ff', mode: 'noFastForward' as const },
          { label: 'Squash Merge', description: 'Stage the combined changes without committing', mode: 'squash' as const },
        ],
        { title: `Merge ${node.name} into ${currentLabel()}` },
      );
      if (!picked) return;
      await run(`Merging ${node.name}…`, async (ops) => {
        await ops.merge(node.rev, picked.mode);
        if (picked.mode === 'squash') return `The changes from ${node.name} are staged. Commit them in Source Control.`;
      });
    },

    'codegit.branch.rebase': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote', 'tag');
      if (!node) return;
      if (node.type === 'local' && node.branch.current) {
        void vscode.window.showInformationMessage('Pick a different branch to rebase the current branch onto.');
        return;
      }
      // lazygit's rebase menu: simple or interactive, each also from the marked base commit when there is one.
      const base = commits.baseSha;
      const options: (vscode.QuickPickItem & { useBase: boolean; interactive: boolean })[] = [
        { label: 'Simple Rebase', description: `Move every commit not on ${node.name}`, useBase: false, interactive: false },
        {
          label: 'Interactive Rebase',
          description: 'Pause first to reorder, squash or drop commits',
          useBase: false,
          interactive: true,
        },
      ];
      if (base) {
        const after = `the commits after ${base.slice(0, 7)}`;
        options.unshift(
          { label: 'Rebase from Marked Base', description: `Move only ${after}`, useBase: true, interactive: false },
          { label: 'Interactive Rebase from Marked Base', description: `Plan ${after} first`, useBase: true, interactive: true },
        );
      }
      const picked = await vscode.window.showQuickPick(options, { title: `Rebase ${currentLabel()} onto ${node.name}` });
      if (!picked) return;
      const { useBase, interactive } = picked;
      if (!(await confirmPushedRewrite(useBase ? base! : node.rev))) return;
      const ok = await run(`Rebasing onto ${node.name}…`, async (ops) => {
        await ops.rebaseOnto(node.rev, useBase ? base : undefined, interactive);
        if (interactive) {
          void vscode.commands.executeCommand('codegit.commits.focus');
          return 'Rebase paused before the first commit. Right-click the steps at the top of the Commits view to change them, then Continue.';
        }
      });
      if (ok && useBase) await vscode.commands.executeCommand('codegit.commit.clearBase');
    },

    'codegit.branch.fastForward': async (arg?: Node) => {
      const node = refTarget(arg, 'local');
      const upstream = node?.branch.upstream;
      if (!node || !upstream) return;
      if (node.branch.gone) {
        void vscode.window.showWarningMessage(`The upstream ${upstream.name} no longer exists on the remote.`);
        return;
      }
      await run(`Fast-forwarding ${node.name}…`, async (ops, repo) => {
        if (node.branch.current) {
          await repo.fetch({ remote: upstream.remote, ref: upstream.remoteRef });
          await ops.fastForwardCurrent();
        } else {
          // Updates the local branch without checking it out; git refuses if it is not a fast-forward.
          await repo.fetch({ remote: upstream.remote, ref: `${upstream.remoteRef}:refs/heads/${node.name}` });
        }
      });
    },

    'codegit.branch.setUpstream': async (arg?: Node) => {
      const node = refTarget(arg, 'local');
      if (!node) return;
      const names = branches.remoteBranchNames;
      if (!names.length) {
        void vscode.window.showWarningMessage('There are no remote branches. Fetch or push first.');
        return;
      }
      const preferred = names.filter((n) => n.endsWith(`/${node.name}`));
      const items = [...preferred, ...names.filter((n) => !preferred.includes(n))];
      const upstream = await vscode.window.showQuickPick(items, { title: `Upstream for ${node.name}` });
      if (upstream) await run('Setting upstream…', (ops) => ops.setUpstream(node.name, upstream));
    },
    'codegit.branch.unsetUpstream': async (arg?: Node) => {
      const node = refTarget(arg, 'local');
      if (node) await run('Unsetting upstream…', (ops) => ops.setUpstream(node.name, undefined));
    },
    'codegit.branch.setAsUpstream': async (arg?: Node) => {
      const node = refTarget(arg, 'remote');
      const current = currentBranch();
      if (!node) return;
      if (!current) {
        void vscode.window.showWarningMessage('HEAD is detached; check out a branch first.');
        return;
      }
      await run('Setting upstream…', async (ops) => {
        await ops.setUpstream(current, node.name);
        return `${current} now tracks ${node.name}.`;
      });
    },

    'codegit.branch.push': async (arg?: Node) => {
      const node = refTarget(arg, 'local');
      if (node) await pushBranch(node, false);
    },
    'codegit.branch.forcePush': async (arg?: Node) => {
      const node = refTarget(arg, 'local');
      if (node) await pushBranch(node, true);
    },

    'codegit.branch.reset': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote', 'tag');
      if (node) await runner.resetTo(node.rev, node.name);
    },
    'codegit.branch.compare': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote', 'tag');
      const git = repos.git();
      if (!node || !git) return;
      const head = await headSha(git);
      const pairs = await getCommitFiles(git, node.sha, head);
      const files: FileNode[] = pairs.map((pair) => ({ kind: 'file', pair, label: `${currentLabel()} ↔ ${node.name}` }));
      await openMultiDiff(repos, `${currentLabel()} ↔ ${node.name}`, files);
    },
    'codegit.branch.copyName': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote', 'tag');
      if (node) await vscode.env.clipboard.writeText(node.name);
    },

    // --- remotes ---------------------------------------------------------------

    // Buttons on the Source Control "Changes" title bar. They forward to the built-in Git commands; the
    // argument is the SourceControl the button belongs to, which the Git extension maps to its repository.
    'codegit.scm.fetch': (sourceControl?: unknown) => vscode.commands.executeCommand('git.fetch', sourceControl),
    'codegit.scm.pull': (sourceControl?: unknown) => vscode.commands.executeCommand('git.pull', sourceControl),
    'codegit.scm.push': (sourceControl?: unknown) => vscode.commands.executeCommand('git.push', sourceControl),

    'codegit.fetchAll': () =>
      run('Fetching all remotes…', (_ops, repo) => repo.fetch({ all: true, prune: true })),
    'codegit.remote.fetch': async (arg?: Node) => {
      const node = remoteTarget(arg);
      if (node) await run(`Fetching ${node.remote.name}…`, (_ops, repo) => repo.fetch({ remote: node.remote.name, prune: true }));
    },
    'codegit.remote.add': async () => {
      const existing = branches.remoteNames;
      const name = await vscode.window.showInputBox({
        title: 'Add remote',
        value: existing.includes('origin') ? '' : 'origin',
        placeHolder: 'Remote name',
        validateInput: (v) =>
          !/^\S+$/.test(v) ? 'Enter a name without spaces.' : existing.includes(v) ? `"${v}" already exists.` : undefined,
      });
      if (!name) return;
      const url = await vscode.window.showInputBox({ title: `URL for ${name}`, placeHolder: 'https://… or git@…' });
      if (!url) return;
      if (await run('Adding remote…', (ops) => ops.addRemote(name, url))) {
        await run(`Fetching ${name}…`, (_ops, repo) => repo.fetch({ remote: name }));
      }
    },
    'codegit.remote.remove': async (arg?: Node) => {
      const node = remoteTarget(arg);
      if (!node) return;
      const question = `Remove the remote "${node.remote.name}"? Its remote-tracking branches are deleted locally; nothing changes on the server.`;
      if (await confirm(question, 'Remove')) await run('Removing remote…', (ops) => ops.removeRemote(node.remote.name));
    },
    'codegit.remote.rename': async (arg?: Node) => {
      const node = remoteTarget(arg);
      if (!node) return;
      const name = await vscode.window.showInputBox({ title: `Rename ${node.remote.name}`, value: node.remote.name });
      if (name && name !== node.remote.name) await run('Renaming remote…', (ops) => ops.renameRemote(node.remote.name, name));
    },
    'codegit.remote.editUrl': async (arg?: Node) => {
      const node = remoteTarget(arg);
      if (!node) return;
      const url = await vscode.window.showInputBox({ title: `URL for ${node.remote.name}`, value: node.remote.url });
      if (url && url !== node.remote.url) await run('Updating remote URL…', (ops) => ops.setRemoteUrl(node.remote.name, url));
    },
    'codegit.remote.copyUrl': async (arg?: Node) => {
      const node = remoteTarget(arg);
      if (node) await vscode.env.clipboard.writeText(node.remote.url);
    },

    'codegit.branch.createPullRequest': async (arg?: Node) => {
      const node = refTarget(arg, 'local', 'remote');
      const git = repos.git();
      if (!node || !git) return;
      // The branch as known on the remote.
      const remoteSide =
        node.type === 'remote'
          ? { remote: node.branch.remote, branch: node.branch.branch }
          : node.branch.upstream && !node.branch.gone
            ? { remote: node.branch.upstream.remote, branch: node.branch.upstream.remoteRef.replace(/^refs\/heads\//, '') }
            : undefined;
      if (!remoteSide) {
        const choice = await vscode.window.showInformationMessage(`Push "${node.name}" before creating a pull request.`, 'Push');
        if (choice) await vscode.commands.executeCommand('codegit.branch.push', node);
        return;
      }
      const web = await webRepo(git, remoteSide.remote);
      if (!web) {
        void vscode.window.showWarningMessage(`The remote "${remoteSide.remote}" has no recognisable web URL.`);
        return;
      }
      const base = await getRemoteDefaultBranch(git, remoteSide.remote);
      await vscode.env.openExternal(vscode.Uri.parse(pullRequestUrl(web, remoteSide.branch, base)));
    },

    'codegit.branch.deleteMerged': async () => {
      const ops = repos.ops();
      if (!ops) return;
      const merged = (await ops.mergedBranches()).filter(
        (name) => !branches.localBranches.find((b) => b.name === name)?.worktreePath,
      );
      if (!merged.length) {
        void vscode.window.showInformationMessage(`No other branches are fully merged into ${currentLabel()}.`);
        return;
      }
      const keep = new Set(['main', 'master', 'develop', 'dev', 'trunk']);
      const picked = await vscode.window.showQuickPick(
        merged.map((name) => ({ label: name, picked: !keep.has(name) })),
        { title: `Delete branches merged into ${currentLabel()}`, canPickMany: true },
      );
      if (!picked?.length) return;
      await run('Deleting merged branches…', async (o) => {
        for (const item of picked) await o.deleteBranch(item.label, false);
        return `Deleted ${picked.length === 1 ? '1 branch' : `${picked.length} branches`}.`;
      });
    },

    'codegit.branch.sort': async () => {
      const current = vscode.workspace.getConfiguration('codegit').get<string>('branchSort', 'recency');
      const options = [
        { label: 'Recently Checked Out', value: 'recency' },
        { label: 'Latest Commit', value: 'date' },
        { label: 'Name', value: 'name' },
      ].map((o) => ({ ...o, description: o.value === current ? 'current' : undefined }));
      const picked = await vscode.window.showQuickPick(options, { title: 'Sort local branches by' });
      if (picked) await vscode.workspace.getConfiguration('codegit').update('branchSort', picked.value, vscode.ConfigurationTarget.Global);
    },

    // --- worktrees -----------------------------------------------------------------

    'codegit.worktree.add': async (arg?: Node) => {
      const root = repos.repository?.rootUri.fsPath;
      if (!root) return;
      const node = target(arg);
      const from = node?.kind === 'ref' ? node : undefined;

      // A local branch not checked out anywhere can be used directly; anything else needs a new branch.
      const usable = from?.type === 'local' && !from.branch.current && !from.branch.worktreePath ? from.name : undefined;
      let options: { branch: string } | { newBranch: string; start: string };
      if (usable) {
        options = { branch: usable };
      } else {
        const suggestion = from?.type === 'remote' ? from.branch.branch : undefined;
        const name = await runner.askBranchName(`New branch for the worktree (from ${from?.name ?? currentLabel()})`, suggestion);
        if (!name) return;
        options = { newBranch: name, start: from?.rev ?? 'HEAD' };
      }
      const branch = 'branch' in options ? options.branch : options.newBranch;
      const suggestedDir = path.join(path.dirname(root), `${path.basename(root)}-${branch.replace(/[\\/:*?"<>|]/g, '-')}`);
      const dir = await vscode.window.showInputBox({ title: `Folder for the "${branch}" worktree`, value: suggestedDir });
      if (!dir) return;
      const ok = await run('Creating worktree…', (ops) => ops.addWorktree(dir, options));
      if (!ok) return;
      const choice = await vscode.window.showInformationMessage(`Created a worktree for "${branch}".`, 'Open in New Window');
      if (choice) await openFolder(dir, true);
    },
    'codegit.worktree.open': async (arg?: Node) => {
      const node = worktreeTarget(arg);
      if (node) await openFolder(node.worktree.path, true);
    },
    'codegit.worktree.openHere': async (arg?: Node) => {
      const node = worktreeTarget(arg);
      if (node) await openFolder(node.worktree.path, false);
    },
    'codegit.worktree.remove': async (arg?: Node) => {
      const node = worktreeTarget(arg);
      if (!node) return;
      const w = node.worktree;
      if (w.main || w.current) {
        void vscode.window.showWarningMessage('The main worktree and the one open in this window cannot be removed here.');
        return;
      }
      if (!(await confirm(`Remove the worktree at ${w.path}? Its branch is kept.`, 'Remove'))) return;
      let dirty = false;
      await run('Removing worktree…', async (ops) => {
        try {
          await ops.removeWorktree(w.path, false);
        } catch (error) {
          if (!(error instanceof GitError) || !/modified or untracked|is dirty|use --force/.test(error.stderr)) throw error;
          dirty = true;
        }
      });
      if (dirty && (await confirm('The worktree has uncommitted changes. Remove it anyway and lose them?', 'Force Remove'))) {
        await run('Removing worktree…', (ops) => ops.removeWorktree(w.path, true));
      }
    },
    'codegit.worktree.prune': () => run('Pruning worktrees…', (ops) => ops.pruneWorktrees()),
    'codegit.worktree.copyPath': async (arg?: Node) => {
      const node = worktreeTarget(arg);
      if (node) await vscode.env.clipboard.writeText(node.worktree.path);
    },

    // --- tags --------------------------------------------------------------------

    'codegit.tag.create': async (arg?: Node) => {
      const node = target(arg);
      if (node?.kind === 'ref') await createTag(runner, node.rev, node.name);
      else await createTag(runner, 'HEAD', currentLabel());
    },
    'codegit.tag.delete': async (arg?: Node) => {
      const node: TagRef | undefined = refTarget(arg, 'tag');
      if (!node) return;
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Delete Local Tag', remote: false },
          { label: 'Delete Local Tag and from a Remote', remote: true },
        ],
        { title: `Delete tag ${node.name}` },
      );
      if (!picked) return;
      const remote = picked.remote ? await pickRemote(`Delete ${node.name} from`) : undefined;
      if (picked.remote && !remote) return;
      if (!(await run('Deleting tag…', (ops) => ops.deleteTag(node.name)))) return;
      if (remote) await deleteRemoteRef(remote, `refs/tags/${node.name}`);
    },
    'codegit.tag.push': async (arg?: Node) => {
      const node: TagRef | undefined = refTarget(arg, 'tag');
      if (!node) return;
      const remote = await pickRemote(`Push ${node.name} to`);
      if (!remote) return;
      await run(`Pushing ${node.name}…`, async (_ops, repo) => {
        await repo.push(remote, `refs/tags/${node.name}`);
        return `Pushed tag ${node.name} to ${remote}.`;
      });
    },
  };

  return Object.entries(commands).map(([id, handler]) => vscode.commands.registerCommand(id, handler));
}
