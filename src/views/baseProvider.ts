import * as vscode from 'vscode';
import type { Git } from '../git/runner';
import type { RepoManager } from '../repoManager';
import { fileTreeItem, type Node } from './nodes';

/**
 * Loads root items only while its view is visible, and only notifies the tree when the data
 * actually changed, so frequent repository state events don't cause flicker or lost selection.
 */
export abstract class BaseProvider<TRoot extends Node> implements vscode.TreeDataProvider<Node> {
  protected roots: TRoot[] = [];
  private key = '';
  private stale = true;
  private view: vscode.TreeView<Node> | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** The queued reload that hasn't started yet; later requests join it, as it will see their changes. */
  private pending: { force: boolean; done: Promise<void> } | undefined;

  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    protected readonly repos: RepoManager,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  attach(view: vscode.TreeView<Node>): vscode.Disposable {
    this.view = view;
    return vscode.Disposable.from(
      this.emitter,
      view.onDidChangeVisibility((e) => {
        if (e.visible && this.stale) void this.reload(true);
      }),
    );
  }

  reload(force = false): Promise<void> {
    if (this.pending) {
      this.pending.force ||= force;
      return this.pending.done;
    }
    const pending = { force, done: Promise.resolve() };
    pending.done = this.queue
      .then(() => {
        this.pending = undefined;
        return this.doReload(pending.force);
      })
      .catch((error) => this.output.error(`Failed to load ${this.constructor.name}: ${error}`));
    this.pending = pending;
    this.queue = pending.done;
    return pending.done;
  }

  /** Needed for TreeView.reveal. Only root items are revealed, so children report no parent. */
  getParent(): Node | undefined {
    return undefined;
  }

  /** Re-render existing items without reloading data. */
  redraw(): void {
    this.emitter.fire();
  }

  private async doReload(force: boolean): Promise<void> {
    if (this.view && !this.view.visible) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const git = this.repos.git();
    const roots = git ? await this.load(git) : [];
    const key = `${git?.cwd}\n${this.keyOf(roots)}`;
    if (!force && key === this.key) return;
    this.roots = roots;
    this.key = key;
    if (this.view) this.view.description = this.description();
    this.emitter.fire();
  }

  /** Text shown next to the view title, e.g. an active filter. */
  protected description(): string | undefined {
    return undefined;
  }

  protected abstract load(git: Git): Promise<TRoot[]>;
  protected abstract keyOf(roots: TRoot[]): string;
  /** Tree item for any non-file node this provider produces. */
  protected abstract item(node: Node): vscode.TreeItem;
  /** Children of any non-file node this provider produces. */
  protected abstract children(git: Git, node: Node): Promise<Node[]>;

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') return fileTreeItem(node, this.repos.repository!.rootUri);
    return this.item(node);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.roots;
    const git = this.repos.git();
    if (!git || node.kind === 'file') return [];
    return this.children(git, node);
  }
}
