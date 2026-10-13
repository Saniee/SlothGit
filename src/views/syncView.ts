import * as vscode from 'vscode';
import { getLocalBranches, getRemotes, headSha } from '../git/queries';
import type { RepoManager } from '../repoManager';
import type { FromSync, SyncMenu, SyncState, ToSync } from '../webview/messages';
import { pageHtml, webviewOptions } from './webviewShell';
import body from '../webview/sync/body.html';
import { SYNC_MENUS } from '../webview/syncMenus';

/** Commands the page's buttons may run directly. Anything else it posts is ignored. */
const BUTTONS = new Set<string>(['slothgit.sync.pull', 'slothgit.sync.push', 'slothgit.sync.fetch']);

/**
 * The Sync view in the Source Control sidebar: the current branch, its upstream and ahead / behind counts, with
 * Pull and Push buttons. Like the Commit button, each has a ⌄ with the other ways to do it (pull with rebase,
 * fetch, force push, push to another branch), shown as a quick pick; right-clicking a button shows the same menu.
 */
export class SyncViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'slothgit.sync';

  private view: vscode.WebviewView | undefined;
  private current: SyncState = { hasRemotes: false };
  private loading: Promise<void> | undefined;
  /** The page's visible text after its last render, for tests. */
  renderedText: string | undefined;

  constructor(
    private readonly extension: vscode.Extension<unknown>,
    private readonly repos: RepoManager,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  get state(): SyncState {
    return this.current;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extension.extensionUri);
    view.webview.html = pageHtml(view.webview, this.extension.extensionUri, 'sync', 'Sync', body);
    view.webview.onDidReceiveMessage((message: FromSync) => this.onMessage(message));
    view.onDidChangeVisibility(() => void this.reload());
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    void this.reload();
  }

  private onMessage(message: FromSync): void {
    switch (message.type) {
      case 'ready':
        return this.post();
      case 'run':
        if (BUTTONS.has(message.command)) void vscode.commands.executeCommand(message.command);
        return;
      case 'menu':
        void this.showMenu(message.menu);
        return;
      case 'rendered':
        this.renderedText = message.text;
        return;
    }
  }

  /** The ⌄ next to Pull or Push: the same entries as the right-click menu, as a quick pick. */
  async showMenu(menu: SyncMenu): Promise<void> {
    const simple = vscode.workspace.getConfiguration('slothgit').get('simpleMode', false);
    const commands: { command: string; title: string }[] = this.extension.packageJSON.contributes.commands;
    const titles = new Map(commands.map((c) => [c.command, c.title]));
    const items = SYNC_MENUS[menu]
      .filter((item) => !(simple && item.advanced))
      .map((item) => ({ label: titles.get(item.command) ?? item.command, detail: item.detail, command: item.command }));
    const picked = await vscode.window.showQuickPick(items, { title: menu === 'pull' ? 'Pull' : 'Push' });
    if (picked) await vscode.commands.executeCommand(picked.command);
  }

  /** Reloads while the view is visible. Called with the other views after every change (refreshAll). */
  reload(): Promise<void> {
    return this.view?.visible ? this.refresh().then(() => undefined) : Promise.resolve();
  }

  /** Loads the state now, visible or not. Concurrent calls share one load. */
  async refresh(): Promise<SyncState> {
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    await this.loading;
    return this.current;
  }

  private async load(): Promise<void> {
    const git = this.repos.git();
    if (!git) {
      this.current = { hasRemotes: false };
    } else {
      try {
        const [branches, remotes] = await Promise.all([getLocalBranches(git, 'name'), getRemotes(git)]);
        const branch = branches.find((b) => b.current);
        const detached = branch ? undefined : (await headSha(git).catch(() => '')).slice(0, 7) || undefined;
        this.current = { branch, detached, hasRemotes: remotes.length > 0 };
      } catch (error) {
        // Keep showing the last state rather than a wrong one.
        this.output.warn(`Sync view: could not read the branch state: ${error}`);
      }
    }
    this.post();
  }

  private post(): void {
    const message: ToSync = { type: 'state', state: this.current };
    void this.view?.webview.postMessage(message);
  }
}
