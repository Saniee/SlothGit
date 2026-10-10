// "Pretty mode": the commit history as a graph in an editor panel, for when the Commits view's plain list
// isn't enough to see how branches relate. Data comes from the same queries; right-click actions are the
// Commits view's own commands, through VS Code's webview context menu.
import * as vscode from 'vscode';
import { layoutGraph, parseRefs, type GraphRef, type GraphRow } from '../git/graph';
import { getCommitMessage, getLog, getMainRefs, getRemotes, getUnpushed, notOnHead, reachableFrom, type Commit, type Person } from '../git/queries';
import type { RepoManager } from '../repoManager';
import { graphHtml } from './graphHtml';
import type { CommitNode, FileNode } from './nodes';
import { commitFiles, config } from './providers';

/** One row as the page receives it. */
export interface GraphCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  email: string;
  coAuthors: Person[];
  relDate: string;
  date: string;
  parents: string[];
  refs: GraphRef[];
  onHead: boolean;
  /** null when the branch has no upstream. */
  pushed: boolean | null;
  /** On a main branch (codegit.mainBranches). */
  merged: boolean;
  head: boolean;
  graph: GraphRow;
}

type FromPage =
  | { type: 'ready' | 'refresh' }
  | { type: 'search'; query: string }
  | { type: 'allBranches'; value: boolean }
  | { type: 'select'; sha: string }
  | { type: 'open'; sha: string }
  | { type: 'openFile'; sha: string; path: string };

export class GraphPanel implements vscode.Disposable {
  private static current: GraphPanel | undefined;

  /** Commits currently shown, by SHA, for commands run from the panel's context menu. */
  private nodes = new Map<string, CommitNode>();
  private search = '';
  private all = true;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, repos: RepoManager): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    GraphPanel.current = new GraphPanel(context, repos);
  }

  /** The commit a graph context-menu command was run on. */
  static commit(sha: string): CommitNode | undefined {
    return GraphPanel.current?.nodes.get(sha);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
  ) {
    this.panel = vscode.window.createWebviewPanel('codegit.graph', 'Commit Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    this.panel.webview.html = graphHtml(this.panel.webview);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromPage) => this.onMessage(m)),
      this.panel.onDidChangeViewState((e) => e.webviewPanel.visible && this.load()),
      repos.onDidChange(() => this.panel.visible && this.load()),
    );
    context.subscriptions.push(this);
  }

  private async onMessage(message: FromPage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        return this.load();
      case 'search':
        this.search = message.query.trim();
        return this.load();
      case 'allBranches':
        this.all = message.value;
        return this.load();
      case 'select':
        return this.details(message.sha);
      case 'open': {
        const node = this.nodes.get(message.sha);
        if (node) await vscode.commands.executeCommand('codegit.commit.openChanges', node);
        return;
      }
      case 'openFile': {
        const node = this.nodes.get(message.sha);
        const git = this.repos.git();
        if (!node || !git) return;
        const file = (await commitFiles(git, node)).find((f: FileNode) => f.pair.change.path === message.path);
        if (file) await vscode.commands.executeCommand('codegit.openFileDiff', file);
        return;
      }
    }
  }

  private async load(): Promise<void> {
    const git = this.repos.git();
    if (!git) {
      void this.panel.webview.postMessage({ type: 'rows', rows: [], state: this.state(undefined) });
      return;
    }
    const limit = config('commitLimit', 300);
    const [log, remotes, unpushed, head, branch, mainRefs] = await Promise.all([
      getLog(git, limit, 'HEAD', [], { all: this.all, search: this.search }),
      getRemotes(git),
      getUnpushed(git),
      git.exec(['rev-parse', '-q', '--verify', 'HEAD'], { allowedExitCodes: [1, 128] }),
      git.exec(['branch', '--show-current'], { allowedExitCodes: [128] }),
      getMainRefs(git, config<string[]>('mainBranches', ['main', 'master'])),
    ]);
    const shas = log.map((c) => c.sha);
    const [others, merged] = await Promise.all([notOnHead(git, shas), reachableFrom(git, shas, mainRefs)]);
    const headSha = head.stdout.trim();
    const remoteNames = remotes.map((r) => r.name);
    // Lanes only make sense for an unbroken history; a search result is drawn as single dots.
    const graph = this.search ? log.map((): GraphRow => ({ lane: 0, color: 0, lines: [], width: 1 })) : layoutGraph(log);

    this.nodes = new Map(
      log.map((c, index): [string, CommitNode] => [c.sha, { kind: 'commit', source: 'log', index, ...c, onHead: !others.has(c.sha) }]),
    );
    const rows = log.map((c: Commit, i): GraphCommit => ({
      sha: c.sha,
      shortSha: c.shortSha,
      subject: c.subject,
      author: c.author,
      email: c.authorEmail,
      coAuthors: c.coAuthors,
      relDate: c.relDate,
      date: c.date,
      parents: c.parents,
      refs: parseRefs(c.refs, remoteNames),
      onHead: !others.has(c.sha),
      pushed: unpushed === null || others.has(c.sha) ? null : !unpushed.has(c.sha),
      merged: merged.has(c.sha),
      head: c.sha === headSha,
      graph: graph[i],
    }));
    this.panel.title = `Commit Graph${branch.stdout.trim() ? `: ${branch.stdout.trim()}` : ''}`;
    void this.panel.webview.postMessage({ type: 'rows', rows, state: this.state(rows.length === limit ? limit : undefined) });
  }

  private state(limit: number | undefined) {
    return {
      search: this.search,
      all: this.all,
      limit,
      repository: this.repos.repository?.rootUri.fsPath ?? '',
    };
  }

  private async details(sha: string): Promise<void> {
    const node = this.nodes.get(sha);
    const git = this.repos.git();
    if (!node || !git) return;
    const [message, files] = await Promise.all([getCommitMessage(git, sha), commitFiles(git, node)]);
    void this.panel.webview.postMessage({
      type: 'details',
      sha,
      message,
      files: files.map((f) => ({ status: f.pair.change.status, path: f.pair.change.path, oldPath: f.pair.change.oldPath })),
    });
  }

  dispose(): void {
    if (GraphPanel.current === this) GraphPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.panel.dispose();
  }
}

interface WebviewContext {
  webview: string;
  sha?: string;
}

/**
 * Commands run from the graph's context menu receive VS Code's webview context ({ webview, sha, … }) instead
 * of a tree node; swap it for the commit node so every command works unchanged.
 */
export function fromGraph(args: unknown[]): unknown[] {
  const [first] = args;
  if (first && typeof first === 'object' && (first as WebviewContext).webview === 'codegit.graph') {
    const node = (first as WebviewContext).sha ? GraphPanel.commit((first as WebviewContext).sha!) : undefined;
    return node ? [node] : [];
  }
  return args;
}
