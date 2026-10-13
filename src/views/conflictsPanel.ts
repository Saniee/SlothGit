// The conflicts panel: every conflicted file of a stopped rebase, merge, cherry-pick or revert in one editor tab,
// each hunk with both sides, and buttons to keep one side or both, per hunk or per file. Continue, Skip and Abort
// go on from there. It follows the repository: saving a file, staging it or continuing updates the list.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConflicts, getStoppedOperation, parseConflicts, resolveHunk, type ConflictHunk, type HunkChoice, type StoppedOperation } from '../git/conflicts';
import type { RepoManager } from '../repoManager';
import type { Runner } from '../runner';
import type { ConflictFileState, ConflictsState, FromConflicts, ToConflicts } from '../webview/messages';
import { pageHtml, webviewOptions } from './webviewShell';
import body from '../webview/conflicts/body.html';

const RELOAD_DELAY_MS = 200;

export class ConflictsPanel implements vscode.Disposable {
  private static current: ConflictsPanel | undefined;

  /** Opens the panel, or brings it forward and reloads it. */
  static show(context: vscode.ExtensionContext, repos: RepoManager, runner: Runner): void {
    if (ConflictsPanel.current) {
      ConflictsPanel.current.panel.reveal();
      ConflictsPanel.current.scheduleReload();
      return;
    }
    ConflictsPanel.current = new ConflictsPanel(context, repos, runner);
  }

  static isOpen(): boolean {
    return !!ConflictsPanel.current;
  }

  /** The open panel, for tests. */
  static active(): ConflictsPanel | undefined {
    return ConflictsPanel.current;
  }

  /** What the page last drew, for tests. */
  rendered: { files: string[]; status: string } | undefined;
  /** The state last sent to the page. */
  state: ConflictsState | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  /** Files seen conflicted during the current stop, so they stay listed (as resolved) after they are staged. */
  private seen = { stop: '', paths: new Set<string>() };

  private constructor(
    context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly runner: Runner,
  ) {
    this.panel = vscode.window.createWebviewPanel('slothgit.conflicts', 'Resolve Conflicts', vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = pageHtml(this.panel.webview, context.extensionUri, 'conflicts', 'Resolve Conflicts', body);
    const inRepo = (uri: vscode.Uri) => {
      const root = this.repos.repository?.rootUri.fsPath;
      const relative = root && path.relative(root, uri.fsPath);
      return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromConflicts) => this.onMessage(m)),
      repos.onDidChange(() => this.scheduleReload()),
      // Staging and edits in other editors (including the merge editor) don't always change the git directory.
      vscode.workspace.onDidSaveTextDocument((d) => inRepo(d.uri) && this.scheduleReload()),
      vscode.workspace.onDidChangeTextDocument((e) => inRepo(e.document.uri) && e.contentChanges.length > 0 && this.scheduleReload()),
    );
    const repo = repos.repository;
    if (repo) this.disposables.push(repo.state.onDidChange(() => this.scheduleReload()));
    context.subscriptions.push(this);
  }

  private post(message: ToConflicts): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: FromConflicts): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.reload();
        return;
      case 'rendered':
        this.rendered = { files: message.files, status: message.status };
        return;
      case 'take':
        return this.take(message.path, message.side);
      case 'hunk':
        return this.resolveHunk(message.path, message.index, message.choice, message.hunk);
      case 'markResolved':
        return this.markResolved(message.path);
      case 'reopen':
        return this.reopen(message.path);
      case 'openFile':
        await vscode.window.showTextDocument(this.uri(message.path), { viewColumn: vscode.ViewColumn.Beside, preview: false });
        return;
      case 'openMerge':
        return this.openMergeEditor(message.path);
      case 'operation':
        return this.runOperation(message.action);
    }
  }

  /** Continue, Skip or Abort; the panel closes when the operation is over, and shows the next stop's conflicts. */
  async runOperation(action: 'continue' | 'skip' | 'abort'): Promise<void> {
    await vscode.commands.executeCommand(`slothgit.operation.${action}`);
    await this.reload();
  }

  /** Opens `file` in the three-way merge editor, or as a plain file when that isn't available. */
  async openMergeEditor(file: string): Promise<void> {
    // The built-in Git extension's command; it opens the merge editor for a conflicted file.
    await vscode.commands
      .executeCommand('git.openMergeEditor', this.uri(file))
      .then(undefined, () => vscode.window.showTextDocument(this.uri(file), { viewColumn: vscode.ViewColumn.Beside }));
  }

  /** Stages `file` as it is in the working tree. */
  async markResolved(file: string): Promise<void> {
    await this.act(`Marking ${path.posix.basename(file)} resolved…`, (ops) => ops.markResolved(file));
  }

  /** Puts a resolved file back in conflict. */
  async reopen(file: string): Promise<void> {
    await this.act(`Reopening ${path.posix.basename(file)}…`, (ops) => ops.reopenConflict(file));
  }

  /** Resolves `file` by taking one side whole. */
  async take(file: string, side: 'current' | 'incoming'): Promise<void> {
    await this.act(`Keeping the ${side} version of ${path.posix.basename(file)}…`, (ops) => ops.takeSide(file, side));
  }

  /**
   * Replaces one hunk of `file` with the chosen side. An editor with unsaved changes is edited (and saved) so those
   * changes are kept; otherwise the file on disk is, since an unchanged open document may not have caught up with
   * what git wrote. When it was the last hunk, the file is marked resolved. `expected` is the hunk as shown; if the
   * file has changed since, nothing is edited.
   */
  async resolveHunk(file: string, index: number, choice: HunkChoice, expected?: ConflictHunk): Promise<void> {
    const uri = this.uri(file);
    const document = this.dirtyDocument(uri.fsPath);
    const text = document ? document.getText() : fs.readFileSync(uri.fsPath, 'utf8');
    const hunk = parseConflicts(text)[index];
    if (!hunk || (expected && JSON.stringify(hunk) !== JSON.stringify(expected))) {
      void vscode.window.showWarningMessage(`${file} changed since the conflicts were listed. Check it again.`);
      await this.reload();
      return;
    }
    const resolved = resolveHunk(text, index, choice);
    if (document) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), resolved);
      if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
        void vscode.window.showWarningMessage(`Couldn't change ${file}.`);
        return;
      }
    } else {
      fs.writeFileSync(uri.fsPath, resolved);
    }
    if (parseConflicts(resolved).length === 0) {
      await this.markResolved(file);
    } else {
      await this.reload();
    }
  }

  /** The open document for `fsPath` if it has unsaved changes. */
  private dirtyDocument(fsPath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.fsPath === vscode.Uri.file(fsPath).fsPath);
  }

  private async act(title: string, fn: Parameters<Runner['run']>[1]): Promise<void> {
    await this.runner.run(title, fn);
    await this.reload();
  }

  private uri(file: string): vscode.Uri {
    return vscode.Uri.joinPath(this.repos.repository!.rootUri, ...file.split('/'));
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_DELAY_MS);
  }

  /** Reads the conflicts again and sends them to the page; closes the panel once nothing is in progress. */
  async reload(): Promise<ConflictsState | undefined> {
    clearTimeout(this.reloadTimer);
    const git = this.repos.git();
    const stopped = git && (await getStoppedOperation(git).catch(() => undefined));
    if (!git || !stopped) {
      this.dispose();
      return undefined;
    }
    const stop = `${stopped.operation} ${stopped.incoming?.sha ?? ''}`;
    if (this.seen.stop !== stop) this.seen = { stop, paths: new Set() };
    const conflicts = await getConflicts(git);
    conflicts.forEach((c) => this.seen.paths.add(c.path));
    const files = conflicts.map((c): ConflictFileState => ({ path: c.path, kind: c.kind, ...this.hunks(git.cwd, c.path) }));
    const resolved = [...this.seen.paths].filter((p) => !conflicts.some((c) => c.path === p)).sort();
    this.state = { ...labels(stopped), files: [...files, ...resolved.map((p): ConflictFileState => ({ path: p, hunks: [] }))] };
    this.post({ type: 'state', state: this.state });
    return this.state;
  }

  /** The file's conflict hunks, from an editor with unsaved changes when there is one. */
  private hunks(root: string, file: string): Pick<ConflictFileState, 'hunks' | 'binary'> {
    const full = path.join(root, file);
    const document = this.dirtyDocument(full);
    if (document) return { hunks: parseConflicts(document.getText()) };
    if (!fs.existsSync(full)) return { hunks: [] };
    const content = fs.readFileSync(full);
    if (content.subarray(0, 8000).includes(0)) return { hunks: [], binary: true };
    return { hunks: parseConflicts(content.toString('utf8')) };
  }

  dispose(): void {
    if (ConflictsPanel.current === this) ConflictsPanel.current = undefined;
    clearTimeout(this.reloadTimer);
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.panel.dispose();
  }
}

/** The panel's title and what "current" and "incoming" mean for the stopped operation. */
function labels(stopped: StoppedOperation): Omit<ConflictsState, 'files'> {
  const commit = (c: StoppedOperation['incoming']) => (c ? `${c.shortSha} ${c.subject}` : 'a commit');
  const branch = stopped.branch ?? 'HEAD';
  switch (stopped.operation) {
    case 'rebase': {
      const step = stopped.step ? ` (step ${stopped.step.number} of ${stopped.step.total})` : '';
      return {
        title: 'Rebase stopped',
        detail: `Rebasing ${branch} onto ${commit(stopped.onto)}: applying ${commit(stopped.incoming)}${step}.`,
        current: `the new base with the commits applied before this one`,
        incoming: `${commit(stopped.incoming)}, the commit being applied`,
        canSkip: true,
      };
    }
    case 'merge': {
      const name = stopped.incomingName ?? commit(stopped.incoming);
      return {
        title: 'Merge stopped',
        detail: `Merging ${name} into ${branch}.`,
        current: `${branch}, your branch`,
        incoming: `${name}, the branch being merged in`,
        canSkip: false,
      };
    }
    case 'cherry-pick':
      return {
        title: 'Cherry-pick stopped',
        detail: `Copying ${commit(stopped.incoming)} onto ${branch}.`,
        current: `${branch}, your branch`,
        incoming: `${commit(stopped.incoming)}, the commit being copied`,
        canSkip: true,
      };
    case 'revert':
      return {
        title: 'Revert stopped',
        detail: `Undoing ${commit(stopped.incoming)} on ${branch}.`,
        current: `${branch}, your branch`,
        incoming: `the undo of ${commit(stopped.incoming)}`,
        canSkip: true,
      };
  }
}
