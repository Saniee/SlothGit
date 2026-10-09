import * as vscode from 'vscode';
import {
  getBisectState,
  getCommitFiles,
  getLog,
  getOperation,
  getRebaseTodo,
  getReflog,
  getStashes,
  getStashFiles,
  getUnpushed,
  type BisectState,
} from '../git/queries';
import type { TodoAction } from '../git/todo';
import type { Git } from '../git/runner';
import type { RepoManager } from '../repoManager';
import { BaseProvider } from './baseProvider';
import type { CherryPickClipboard } from './cherryPickClipboard';
import type { CommitNode, FileNode, Node, StashNode, TodoNode } from './nodes';

export function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('codegit').get<T>(key, fallback);
}

export async function commitFiles(git: Git, node: CommitNode): Promise<FileNode[]> {
  const pairs = await getCommitFiles(git, node.sha, node.parents[0]);
  return pairs.map((pair) => ({ kind: 'file', pair, label: node.shortSha, commit: node }));
}

const TODO_ICONS: Record<TodoAction, string> = {
  pick: 'circle-large-outline',
  reword: 'edit',
  edit: 'debug-pause',
  squash: 'fold-up',
  fixup: 'fold-up',
  drop: 'trash',
};

export class CommitsProvider extends BaseProvider<CommitNode | TodoNode> {
  private unpushed: Set<string> | null = null;
  private head: string | undefined;
  /** Commit marked with "Mark as Base Commit"; rebasing onto a branch then only moves the commits after it. */
  baseSha: string | undefined;
  /** Repository-relative path the log is filtered to (lazygit's "filter by path"). */
  filterPath: string | undefined;
  /** Set while `git bisect` is running. */
  bisect: BisectState | undefined;
  private todoCount = 0;

  constructor(
    repos: RepoManager,
    output: vscode.LogOutputChannel,
    private readonly clipboard: CherryPickClipboard,
  ) {
    super(repos, output);
  }

  get commits(): readonly CommitNode[] {
    return this.roots.filter((n): n is CommitNode => n.kind === 'commit');
  }

  /** True when the commit is already on the upstream branch. */
  isPushed(sha: string): boolean {
    return this.unpushed !== null && !this.unpushed.has(sha);
  }

  protected async load(git: Git): Promise<(CommitNode | TodoNode)[]> {
    const [bisect, operation] = await Promise.all([getBisectState(git), getOperation(git)]);
    this.bisect = bisect;
    void vscode.commands.executeCommand('setContext', 'codegit.bisecting', !!bisect);
    void vscode.commands.executeCommand('setContext', 'codegit.commitsFiltered', !!this.filterPath);

    // While bisecting HEAD jumps around; keep showing the branch the bisect started from.
    const ref = bisect ? bisect.start : 'HEAD';
    const paths = this.filterPath ? [this.filterPath] : [];
    const [log, unpushed, head, todo] = await Promise.all([
      getLog(git, config('commitLimit', 300), ref, paths),
      getUnpushed(git),
      git.exec(['rev-parse', '-q', '--verify', 'HEAD'], { allowedExitCodes: [1, 128] }),
      operation === 'rebase' ? getRebaseTodo(git) : Promise.resolve([]),
    ]);
    this.unpushed = unpushed;
    this.head = head.stdout.trim() || undefined;
    this.todoCount = todo.length;

    // The todo list runs oldest first; show it newest first, above the commits.
    const todoNodes = todo.map((t): TodoNode => ({ kind: 'todo', ...t })).reverse();
    const commits = log.map((c, index): CommitNode => ({ kind: 'commit', source: 'log', index, ...c }));
    return [...todoNodes, ...commits];
  }

  protected keyOf(roots: (CommitNode | TodoNode)[]): string {
    const unpushed = this.unpushed ? [...this.unpushed].join(',') : 'none';
    const state = JSON.stringify([this.head, this.bisect, this.filterPath]);
    const items = roots.map((n) => (n.kind === 'todo' ? `${n.action} ${n.sha}` : `${n.sha} ${n.refs?.join(',')}`));
    return `${unpushed}\n${state}\n${items.join('\n')}`;
  }

  protected description(): string | undefined {
    const parts = [
      this.todoCount && `rebasing · ${this.todoCount} left`,
      this.bisect && 'bisecting',
      this.filterPath && `file: ${this.filterPath}`,
    ];
    return parts.filter(Boolean).join(' · ') || undefined;
  }

  protected item(n: Node): vscode.TreeItem {
    if (n.kind === 'todo') return this.todoItem(n);
    const node = n as CommitNode;
    const item = new vscode.TreeItem(node.subject, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `log:${node.sha}`;
    const refs = node.refs?.length ? `(${node.refs.join(', ')}) ` : '';
    item.description = `${node.shortSha} ${refs}· ${node.author}, ${node.relDate}`;

    const pushed = this.isPushed(node.sha);
    const copied = this.clipboard.has(node.sha);
    const isBase = node.sha === this.baseSha;
    const bisect = this.bisectMark(node.sha);
    if (bisect) {
      item.iconPath = new vscode.ThemeIcon(bisect.icon, new vscode.ThemeColor(bisect.color));
      item.description = `${bisect.label} · ${item.description}`;
    } else if (isBase) {
      item.iconPath = new vscode.ThemeIcon('debug-breakpoint', new vscode.ThemeColor('charts.purple'));
      item.description = `base · ${item.description}`;
    } else if (copied) {
      item.iconPath = new vscode.ThemeIcon('clippy', new vscode.ThemeColor('charts.blue'));
    } else {
      const color = this.unpushed === null ? undefined : new vscode.ThemeColor(pushed ? 'charts.green' : 'charts.yellow');
      item.iconPath = new vscode.ThemeIcon('git-commit', color);
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escape(node.subject)}**\n\n`);
    tooltip.appendMarkdown(`\`${node.sha}\`\n\n${escape(node.author ?? '')}, ${node.relDate}\n\n`);
    if (node.refs?.length) tooltip.appendMarkdown(`${escape(node.refs.join(', '))}\n\n`);
    if (this.unpushed !== null) tooltip.appendMarkdown(pushed ? '$(cloud) Pushed' : '$(cloud-upload) Not pushed yet');
    if (copied) tooltip.appendMarkdown('\n\n$(clippy) Copied for cherry-pick');
    if (isBase) tooltip.appendMarkdown('\n\n$(debug-breakpoint) Marked as base: rebasing onto a branch moves only the commits above this one');
    if (bisect) tooltip.appendMarkdown(`\n\n$(${bisect.icon}) Bisect: ${bisect.label}`);
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;

    const flags = [node.sha === this.head && 'head', node.parents.length === 0 && 'root'].filter(Boolean);
    item.contextValue = ['commit', ...flags].join(':');
    return item;
  }

  private bisectMark(sha: string): { label: string; icon: string; color: string } | undefined {
    const b = this.bisect;
    if (!b) return undefined;
    if (sha === b.bad) return { label: b.terms.bad, icon: 'bug', color: 'charts.red' };
    if (b.good.includes(sha)) return { label: b.terms.good, icon: 'pass', color: 'charts.green' };
    if (b.skipped.includes(sha)) return { label: 'skipped', icon: 'debug-step-over', color: 'disabledForeground' };
    if (sha === this.head) return { label: 'testing', icon: 'arrow-right', color: 'charts.yellow' };
    return undefined;
  }

  private todoItem(node: TodoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.subject, vscode.TreeItemCollapsibleState.None);
    item.id = `todo:${node.sha}`;
    item.description = `${node.action} · ${node.sha}`;
    item.tooltip = `Pending rebase step: ${node.action} ${node.sha}\n${node.subject}`;
    const color = node.action === 'drop' ? 'disabledForeground' : 'charts.orange';
    item.iconPath = new vscode.ThemeIcon(TODO_ICONS[node.action], new vscode.ThemeColor(color));
    item.contextValue = 'todo';
    return item;
  }

  protected async children(git: Git, n: Node): Promise<Node[]> {
    return n.kind === 'commit' ? commitFiles(git, n) : [];
  }
}

export class ReflogProvider extends BaseProvider<CommitNode> {
  protected async load(git: Git): Promise<CommitNode[]> {
    const entries = await getReflog(git, config('reflogLimit', 200));
    return entries.map((e, index) => ({ kind: 'commit', source: 'reflog', index, ...e }));
  }

  protected keyOf(roots: CommitNode[]): string {
    return roots.map((e) => `${e.sha} ${e.subject}`).join('\n');
  }

  protected item(n: Node): vscode.TreeItem {
    const node = n as CommitNode;
    const item = new vscode.TreeItem(node.subject, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `reflog:${node.index}:${node.sha}`;
    item.description = `${node.shortSha} · ${node.relDate}`;
    item.tooltip = `${node.selector}  ${node.sha}\n${node.subject}`;
    item.iconPath = new vscode.ThemeIcon('history');
    item.contextValue = 'reflog';
    return item;
  }

  protected children(git: Git, n: Node): Promise<Node[]> {
    const node = n as CommitNode;
    return commitFiles(git, node);
  }
}

export class StashProvider extends BaseProvider<StashNode> {
  protected async load(git: Git): Promise<StashNode[]> {
    return (await getStashes(git)).map((stash) => ({ kind: 'stash', stash }));
  }

  protected keyOf(roots: StashNode[]): string {
    return roots.map((s) => `${s.stash.sha} ${s.stash.message}`).join('\n');
  }

  protected item(n: Node): vscode.TreeItem {
    const node = n as StashNode;
    const { stash } = node;
    const item = new vscode.TreeItem(stash.message, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `stash:${stash.sha}`;
    item.description = `${stash.ref} · ${stash.relDate}`;
    item.tooltip = `${stash.ref}  ${stash.sha}\n${stash.message}`;
    item.iconPath = new vscode.ThemeIcon('archive');
    item.contextValue = 'stash';
    return item;
  }

  protected async children(git: Git, n: Node): Promise<Node[]> {
    const node = n as StashNode;
    const pairs = await getStashFiles(git, node.stash);
    return pairs.map((pair) => ({ kind: 'file', pair, label: node.stash.ref }));
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
