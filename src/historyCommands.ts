import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { openMultiDiff } from './commands';
import { getCommitFiles, getOperation, rebaseTodoPath } from './git/queries';
import { transformTodo, type TodoAction } from './git/todo';
import type { UndoAction } from './git/undo';
import type { RepoManager } from './repoManager';
import type { Runner } from './runner';
import type { CommitNode, FileNode, Node, RefNode, TodoNode } from './views/nodes';
import type { CommitsProvider } from './views/providers';

export interface HistoryCommandDeps {
  repos: RepoManager;
  commits: CommitsProvider;
  commitsView: vscode.TreeView<Node>;
  runner: Runner;
  refreshAll(force: boolean): Promise<void>;
}

/** Something that can be compared: a commit or a branch/tag. */
interface Revision {
  rev: string;
  label: string;
}

function revisionOf(node: Node | undefined): Revision | undefined {
  if (node?.kind === 'commit') return { rev: node.sha, label: node.shortSha };
  if (node?.kind === 'ref') return { rev: (node as RefNode).rev, label: (node as RefNode).name };
  return undefined;
}

export function registerHistoryCommands(deps: HistoryCommandDeps): vscode.Disposable[] {
  const { repos, commits, commitsView, runner } = deps;
  const { run, confirm } = runner;
  let compareBase: Revision | undefined;

  // --- undo / redo -----------------------------------------------------------------

  function describe(action: UndoAction, direction: 'undo' | 'redo'): string {
    const target = direction === 'undo' ? action.from : action.to;
    const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : rev);
    const branch = repos.repository?.state.HEAD?.name ?? 'HEAD';
    const verb = direction === 'undo' ? 'Undo' : 'Redo';
    return action.kind === 'checkout'
      ? `${verb} "${action.description}"? This checks out ${short(target)}.`
      : `${verb} "${action.description}"? This resets ${branch} to ${short(target)}. Uncommitted changes are kept.`;
  }

  async function undoRedo(direction: 'undo' | 'redo'): Promise<void> {
    const ops = repos.ops();
    if (!ops) return;
    if (await getOperation(ops.git)) {
      void vscode.window.showWarningMessage('Finish or abort the operation in progress before undoing.');
      return;
    }
    if (commits.bisect) {
      void vscode.window.showWarningMessage('Reset the bisect before undoing.');
      return;
    }
    const plan = await ops.planUndo();
    const action = direction === 'undo' ? plan.undo : plan.redo;
    if (!action) {
      void vscode.window.showInformationMessage(direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.');
      return;
    }
    if (!(await confirm(describe(action, direction), direction === 'undo' ? 'Undo' : 'Redo'))) return;
    await run(direction === 'undo' ? 'Undoing…' : 'Redoing…', (o) => o.applyUndo(action, direction));
  }

  // --- bisect ------------------------------------------------------------------------

  async function bisect(mark: 'bad' | 'good' | 'skip', arg?: Node): Promise<void> {
    const node = arg?.kind === 'commit' ? arg : (commitsView.selection.find((n) => n.kind === 'commit') as CommitNode | undefined);
    if (!node) {
      void vscode.window.showInformationMessage('Select a commit first.');
      return;
    }
    let summary = '';
    const ok = await run('Bisecting…', async (ops) => {
      summary = await ops.bisectMark(node.sha, mark);
    });
    if (!ok) return;
    if (/is the first/.test(summary)) {
      const choice = await vscode.window.showInformationMessage(summary, 'Reset Bisect');
      if (choice) await run('Resetting bisect…', (ops) => ops.bisectReset());
    } else if (summary) {
      void vscode.window.showInformationMessage(`${summary} Test the checked-out commit, then mark it.`);
    }
  }

  // --- rebase todo -------------------------------------------------------------------

  async function editTodo(arg: Node | undefined, change: (node: TodoNode) => Parameters<typeof transformTodo>[1] | undefined) {
    const node = arg?.kind === 'todo' ? arg : (commitsView.selection.find((n) => n.kind === 'todo') as TodoNode | undefined);
    const git = repos.git();
    if (!node || !git) return;
    const plan = change(node);
    if (!plan) return;
    try {
      const file = await rebaseTodoPath(git);
      fs.writeFileSync(file, transformTodo(fs.readFileSync(file, 'utf8'), plan));
    } catch (error) {
      void vscode.window.showWarningMessage(`Could not update the rebase todo list: ${error instanceof Error ? error.message : error}`);
    }
    await deps.refreshAll(true);
  }

  // --- commands ------------------------------------------------------------------------

  const commands: Record<string, (...args: any[]) => unknown> = {
    'codegit.undo': () => undoRedo('undo'),
    'codegit.redo': () => undoRedo('redo'),

    'codegit.bisect.markBad': (arg?: Node) => bisect('bad', arg),
    'codegit.bisect.markGood': (arg?: Node) => bisect('good', arg),
    'codegit.bisect.skip': (arg?: Node) => bisect('skip', arg),
    'codegit.bisect.reset': () => run('Resetting bisect…', (ops) => ops.bisectReset()),

    'codegit.compare.select': (arg?: Node) => {
      compareBase = revisionOf(arg ?? commitsView.selection[0]);
      void vscode.commands.executeCommand('setContext', 'codegit.hasCompareBase', !!compareBase);
      if (compareBase) {
        void vscode.window.showInformationMessage(
          `Selected ${compareBase.label} for comparison. Pick another commit or branch and choose "Compare with Selected".`,
        );
      }
    },
    'codegit.compare.withSelected': async (arg?: Node) => {
      const other = revisionOf(arg ?? commitsView.selection[0]);
      const git = repos.git();
      if (!compareBase || !other || !git) return;
      const pairs = await getCommitFiles(git, other.rev, compareBase.rev);
      const title = `${compareBase.label} ↔ ${other.label}`;
      const files: FileNode[] = pairs.map((pair) => ({ kind: 'file', pair, label: title }));
      await openMultiDiff(repos, title, files);
    },
    'codegit.compare.clear': () => {
      compareBase = undefined;
      void vscode.commands.executeCommand('setContext', 'codegit.hasCompareBase', false);
    },

    'codegit.commits.filterByFile': async () => {
      const root = repos.repository?.rootUri;
      if (!root) return;
      const active = vscode.window.activeTextEditor?.document.uri;
      const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [];
      if (active?.scheme === 'file') {
        items.push({ label: '$(file) Current File', description: vscode.workspace.asRelativePath(active, false), uri: active });
      }
      items.push({ label: '$(folder-opened) Choose File or Folder…' });
      const picked = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: 'Filter commits by path' });
      if (!picked) return;
      let uri = picked.uri;
      if (!uri) {
        const chosen = await vscode.window.showOpenDialog({ defaultUri: root, canSelectFolders: true, canSelectFiles: true });
        uri = chosen?.[0];
      }
      if (uri) await vscode.commands.executeCommand('codegit.commits.showFileHistory', uri);
    },
    'codegit.commits.showFileHistory': async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const repo = target && repos.api.getRepository(target);
      const root = repo?.rootUri;
      if (!target || !root) {
        void vscode.window.showInformationMessage('That file is not in a Git repository.');
        return;
      }
      const relative = vscode.workspace.asRelativePath(target, false);
      const rel = target.fsPath.startsWith(root.fsPath)
        ? target.fsPath.slice(root.fsPath.length + 1).replace(/\\/g, '/')
        : relative;
      commits.filterPath = rel || '.';
      await deps.refreshAll(true);
      await vscode.commands.executeCommand('codegit.commits.focus');
    },
    'codegit.commits.clearFilter': async () => {
      commits.filterPath = undefined;
      await deps.refreshAll(true);
    },

    'codegit.todo.moveUp': (arg?: Node) => editTodo(arg, (node) => ({ move: { sha: node.sha, direction: 'up' } })),
    'codegit.todo.moveDown': (arg?: Node) => editTodo(arg, (node) => ({ move: { sha: node.sha, direction: 'down' } })),
    'codegit.todo.setAction': async (arg?: Node) => {
      const node = arg?.kind === 'todo' ? arg : (commitsView.selection.find((n) => n.kind === 'todo') as TodoNode | undefined);
      if (!node) return;
      const actions: { label: TodoAction; description: string }[] = [
        { label: 'pick', description: 'Keep the commit' },
        { label: 'squash', description: 'Meld into the previous commit, combining messages' },
        { label: 'fixup', description: "Meld into the previous commit, keeping the previous commit's message" },
        { label: 'edit', description: 'Stop after applying it' },
        { label: 'drop', description: 'Remove the commit' },
      ];
      const picked = await vscode.window.showQuickPick(
        actions.filter((a) => a.label !== node.action),
        { title: `Rebase step for ${node.sha}: ${node.subject}` },
      );
      if (picked) await editTodo(node, (n) => ({ actions: { [n.sha]: picked.label } }));
    },
  };

  return Object.entries(commands).map(([id, handler]) => vscode.commands.registerCommand(id, handler));
}
