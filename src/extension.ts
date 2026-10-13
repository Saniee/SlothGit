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
import { CustomPatch } from './views/customPatch';
import { GraphPanel } from './views/graphPanel';
import { RebasePanel, type RebaseTarget } from './views/rebasePanel';
import { SyncViewProvider } from './views/syncView';
import { initLearn, learn, type LearnTopic } from './learn';
import type { Node } from './views/nodes';
import { CommitsProvider, ReflogProvider, StashProvider } from './views/providers';

const OPERATION_LABELS: Record<Operation, string> = {
  rebase: 'Rebasing',
  'cherry-pick': 'Cherry-picking',
  revert: 'Reverting',
  merge: 'Merging',
};

/** Returned from activate() for the smoke test; not a stable API. */
export interface SlothGitTestApi {
  providers: Record<string, vscode.TreeDataProvider<Node>>;
  views: Record<string, vscode.TreeView<Node>>;
  sync: SyncViewProvider;
  /** Rows the open Commit Graph page last drew. */
  graphRenderedRows(): number | undefined;
  /** The open rebase editor. */
  rebaseEditor(): RebasePanel | undefined;
  refreshAll(force: boolean): Promise<void>;
  /** Runs the CodeGit settings migration again, as on a first start. */
  migrateSettings(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<SlothGitTestApi | undefined> {
  const output = vscode.window.createOutputChannel('SlothGit', { log: true });
  context.subscriptions.push(output);
  initLearn(context.extension.id);
  void migrateSettings(context, output);

  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const gitExtension = extension && (extension.isActive ? extension.exports : await extension.activate());
  if (!gitExtension?.enabled) {
    output.warn('The built-in Git extension is disabled; SlothGit is inactive.');
    return;
  }

  const repos = new RepoManager(gitExtension.getAPI(1), context.asAbsolutePath('dist/rebaseEditor.js'));
  const clipboard = new CherryPickClipboard();
  const patch = new CustomPatch();
  const commits = new CommitsProvider(repos, output, clipboard);
  const stashes = new StashProvider(repos, output);
  const reflog = new ReflogProvider(repos, output);
  const branches = new BranchesProvider(repos, output, clipboard);
  const sync = new SyncViewProvider(context.extension, repos, output);

  const commitsView = vscode.window.createTreeView<Node>('slothgit.commits', {
    treeDataProvider: commits,
    canSelectMany: true,
    showCollapseAll: true,
  });
  const branchesView = vscode.window.createTreeView<Node>('slothgit.branches', { treeDataProvider: branches });
  const stashView = vscode.window.createTreeView<Node>('slothgit.stashes', { treeDataProvider: stashes });
  const reflogView = vscode.window.createTreeView<Node>('slothgit.reflog', { treeDataProvider: reflog, canSelectMany: true });

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'slothgit.operation.menu';
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  async function updateOperation(): Promise<void> {
    const git = repos.git();
    const [operation, bisect] = git
      ? await Promise.all([getOperation(git).catch(() => undefined), getBisectState(git).catch(() => undefined)])
      : [undefined, undefined];
    await vscode.commands.executeCommand('setContext', 'slothgit.operation', operation ?? '');
    if (operation) {
      statusItem.text = `$(git-merge) ${OPERATION_LABELS[operation]}…`;
      statusItem.tooltip = 'SlothGit: continue, skip or abort';
      statusItem.command = 'slothgit.operation.menu';
      statusItem.show();
    } else if (bisect) {
      statusItem.text = '$(bug) Bisecting…';
      statusItem.tooltip = 'SlothGit: mark the checked-out commit as good or bad in the Commits view';
      statusItem.command = 'slothgit.commits.focus';
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
      sync.reload(),
      updateOperation(),
    ]);
  }

  const runner = createRunner(repos, output, refreshAll);
  const openRebaseEditor = (target: RebaseTarget) => RebasePanel.open(context, repos, runner, target);

  context.subscriptions.push(
    repos,
    clipboard,
    patch,
    commitsView,
    branchesView,
    stashView,
    reflogView,
    statusItem,
    commits.attach(commitsView),
    branches.attach(branchesView),
    stashes.attach(stashView),
    reflog.attach(reflogView),
    vscode.window.registerWebviewViewProvider(SyncViewProvider.viewId, sync),
    repos.onDidChange(() => refreshAll(false)),
    clipboard.onDidChange(() => {
      commits.redraw();
      branches.redraw();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('slothgit')) void refreshAll(true);
    }),
    ...registerCommands({ repos, commits, commitsView, stashView, clipboard, patch, runner, refreshAll, openRebaseEditor }),
    ...registerBranchCommands({ repos, branches, branchesView, commits, runner, openRebaseEditor }),
    ...registerHistoryCommands({ repos, commits, commitsView, runner, refreshAll }),
    vscode.commands.registerCommand('slothgit.graph.open', () => GraphPanel.show(context, repos)),
    vscode.commands.registerCommand('slothgit.simpleMode.on', () => setSimpleMode(true)),
    vscode.commands.registerCommand('slothgit.simpleMode.off', () => setSimpleMode(false)),
    vscode.commands.registerCommand('slothgit.learn', (topic?: LearnTopic) => learn(topic)),
  );

  hideGraphOnce(context, [commitsView, branchesView, stashView, reflogView]);

  void refreshAll(true);
  return {
    providers: { commits, branches, stashes, reflog },
    views: { commits: commitsView, branches: branchesView, stashes: stashView, reflog: reflogView },
    sync,
    graphRenderedRows: () => GraphPanel.renderedRows(),
    rebaseEditor: () => RebasePanel.active(),
    refreshAll,
    migrateSettings: async () => {
      await context.globalState.update(SETTINGS_MIGRATED_KEY, undefined);
      await context.workspaceState.update(SETTINGS_MIGRATED_KEY, undefined);
      await migrateSettings(context, output);
    },
  };
}

/** Simple Mode hides advanced actions from the menus (package.json gates them on config.slothgit.simpleMode). */
function setSimpleMode(on: boolean): Thenable<void> {
  return vscode.workspace.getConfiguration('slothgit').update('simpleMode', on, vscode.ConfigurationTarget.Global);
}

const SETTINGS_MIGRATED_KEY = 'codegitSettingsMigrated';

type SettingsLevel = 'globalValue' | 'workspaceValue' | 'workspaceFolderValue';

/**
 * The extension was called CodeGit before 1.0.0. Copies `codegit.*` settings to `slothgit.*`, unless the new one is
 * already set at that level: user settings once per install, workspace and folder settings once per workspace (each
 * workspace has its own). The old ones stay: VS Code only writes settings some extension declares, so they can't be
 * removed from here (they show up greyed out as unknown).
 *
 * Remove after 2.0.0, together with the legacy undo markers in git/undo.ts.
 */
export async function migrateSettings(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): Promise<void> {
  const keys = Object.keys(context.extension.packageJSON.contributes?.configuration?.properties ?? {}).map((k) =>
    k.replace(/^slothgit\./, ''),
  );
  const copy = async (scope: vscode.WorkspaceFolder | undefined, level: SettingsLevel, target: vscode.ConfigurationTarget) => {
    const old = vscode.workspace.getConfiguration('codegit', scope);
    const current = vscode.workspace.getConfiguration('slothgit', scope);
    for (const key of keys) {
      const value = old.inspect(key)?.[level];
      if (value === undefined || current.inspect(key)?.[level] !== undefined) continue;
      try {
        await current.update(key, value, target);
        output.info(`Copied setting codegit.${key} to slothgit.${key}`);
      } catch (e) {
        output.warn(`Could not copy setting codegit.${key}: ${e}`);
      }
    }
  };
  if (!context.globalState.get(SETTINGS_MIGRATED_KEY)) {
    await copy(undefined, 'globalValue', vscode.ConfigurationTarget.Global);
    await context.globalState.update(SETTINGS_MIGRATED_KEY, true);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length && !context.workspaceState.get(SETTINGS_MIGRATED_KEY)) {
    await copy(undefined, 'workspaceValue', vscode.ConfigurationTarget.Workspace);
    for (const folder of folders) await copy(folder, 'workspaceFolderValue', vscode.ConfigurationTarget.WorkspaceFolder);
    await context.workspaceState.update(SETTINGS_MIGRATED_KEY, true);
  }
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
