import * as vscode from 'vscode';
import { registerBranchCommands } from './branchCommands';
import { registerCommands } from './commands';
import { getBisectState, getOperation, type Operation } from './git/queries';
import { registerHistoryCommands } from './historyCommands';
import { RepoManager } from './repoManager';
import { createRunner } from './runner';
import type { GitExtension } from './types/git';
import { BranchesProvider } from './views/branches';
import { CherryPickClipboard } from './views/cherryPickClipboard';
import { GraphPanel } from './views/graphPanel';
import type { Node } from './views/nodes';
import { CommitsProvider, ReflogProvider, StashProvider } from './views/providers';

const OPERATION_LABELS: Record<Operation, string> = {
  rebase: 'Rebasing',
  'cherry-pick': 'Cherry-picking',
  revert: 'Reverting',
  merge: 'Merging',
};

/** Returned from activate() for the smoke test; not a stable API. */
export interface CodeGitTestApi {
  providers: Record<string, vscode.TreeDataProvider<Node>>;
  refreshAll(force: boolean): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<CodeGitTestApi | undefined> {
  const output = vscode.window.createOutputChannel('CodeGit', { log: true });
  context.subscriptions.push(output);

  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const gitExtension = extension && (extension.isActive ? extension.exports : await extension.activate());
  if (!gitExtension?.enabled) {
    output.warn('The built-in Git extension is disabled; CodeGit is inactive.');
    return;
  }

  const repos = new RepoManager(gitExtension.getAPI(1), context.asAbsolutePath('dist/rebaseEditor.js'));
  const clipboard = new CherryPickClipboard();
  const commits = new CommitsProvider(repos, output, clipboard);
  const stashes = new StashProvider(repos, output);
  const reflog = new ReflogProvider(repos, output);
  const branches = new BranchesProvider(repos, output);

  const commitsView = vscode.window.createTreeView<Node>('codegit.commits', {
    treeDataProvider: commits,
    canSelectMany: true,
    showCollapseAll: true,
  });
  const branchesView = vscode.window.createTreeView<Node>('codegit.branches', { treeDataProvider: branches });
  const stashView = vscode.window.createTreeView<Node>('codegit.stashes', { treeDataProvider: stashes });
  const reflogView = vscode.window.createTreeView<Node>('codegit.reflog', { treeDataProvider: reflog, canSelectMany: true });

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'codegit.operation.menu';
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  async function updateOperation(): Promise<void> {
    const git = repos.git();
    const [operation, bisect] = git
      ? await Promise.all([getOperation(git).catch(() => undefined), getBisectState(git).catch(() => undefined)])
      : [undefined, undefined];
    await vscode.commands.executeCommand('setContext', 'codegit.operation', operation ?? '');
    if (operation) {
      statusItem.text = `$(git-merge) ${OPERATION_LABELS[operation]}…`;
      statusItem.tooltip = 'CodeGit: continue, skip or abort';
      statusItem.command = 'codegit.operation.menu';
      statusItem.show();
    } else if (bisect) {
      statusItem.text = '$(bug) Bisecting…';
      statusItem.tooltip = 'CodeGit: mark the checked-out commit as good or bad in the Commits view';
      statusItem.command = 'codegit.commits.focus';
      statusItem.show();
    } else {
      statusItem.hide();
    }
  }

  async function refreshAll(force: boolean): Promise<void> {
    await repos.markLoaded();
    await Promise.all([
      commits.reload(force),
      branches.reload(force),
      stashes.reload(force),
      reflog.reload(force),
      updateOperation(),
    ]);
  }

  const runner = createRunner(repos, output, refreshAll);

  context.subscriptions.push(
    repos,
    clipboard,
    commitsView,
    branchesView,
    stashView,
    reflogView,
    statusItem,
    commits.attach(commitsView),
    branches.attach(branchesView),
    stashes.attach(stashView),
    reflog.attach(reflogView),
    repos.onDidChange(() => refreshAll(false)),
    clipboard.onDidChange(() => commits.redraw()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codegit')) void refreshAll(true);
    }),
    ...registerCommands({ repos, commits, commitsView, stashView, clipboard, runner, refreshAll }),
    ...registerBranchCommands({ repos, branches, branchesView, commits, runner }),
    ...registerHistoryCommands({ repos, commits, commitsView, runner, refreshAll }),
    vscode.commands.registerCommand('codegit.graph.open', () => GraphPanel.show(context, repos)),
  );

  hideGraphOnce(context, [commitsView, branchesView, stashView, reflogView]);

  void refreshAll(true);
  return { providers: { commits, branches, stashes, reflog }, refreshAll };
}

const GRAPH_HIDDEN_KEY = 'graphViewHidden';

/**
 * The Commits view replaces the built-in Graph view, so hide that once, the first time the Source Control
 * sidebar is open (VS Code only hides views in an open container). If the user shows it again, it stays.
 */
function hideGraphOnce(context: vscode.ExtensionContext, views: vscode.TreeView<Node>[]): void {
  if (context.globalState.get(GRAPH_HIDDEN_KEY)) return;
  let done = false;
  const hide = async () => {
    if (done) return;
    done = true;
    listeners.forEach((l) => l.dispose());
    try {
      await vscode.commands.executeCommand('workbench.scm.history.removeView');
    } catch {
      // Older VS Code without the Graph view.
    }
    await context.globalState.update(GRAPH_HIDDEN_KEY, true);
  };
  const listeners = views.map((v) => v.onDidChangeVisibility((e) => e.visible && void hide()));
  context.subscriptions.push(...listeners);
  if (views.some((v) => v.visible)) void hide();
}

export function deactivate(): void {}
