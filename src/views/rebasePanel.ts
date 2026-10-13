// The rebase editor: an editor panel listing the commits of an interactive rebase before it starts. Drag them to
// reorder, pick an action for each, and see which steps are likely to conflict (git/conflictCheck.ts) before
// anything runs. Start Rebase runs it in one go through rebaseEditor.js, like the Commits view's rewrites.
import * as vscode from 'vscode';
import { ConflictCheck } from '../git/conflictCheck';
import { ROOT, UserError } from '../git/operations';
import { currentBranch, EMPTY_TREE, getOperation, getUnpushed, headSha } from '../git/queries';
import type { Git } from '../git/runner';
import { planProblem, type PlannedStep } from '../git/todo';
import type { RepoManager } from '../repoManager';
import type { Runner } from '../runner';
import type { FromRebase, RebaseCommit, RebaseEditorState, ToRebase } from '../webview/messages';
import { pageHtml, webviewOptions } from './webviewShell';
import body from '../webview/rebase/body.html';

export interface RebaseTarget {
  /** The commits after this one are rebased (git rebase's <upstream>); ROOT for every commit. */
  upstream: string;
  /** Where they are replayed (rebase --onto); by default they stay on `upstream`. */
  onto?: string;
  /** Says what is rebased, after the branch name: "onto main", "from 1a2b3c4 Add search". */
  label: string;
  /** Runs once the rebase has started, e.g. to clear the marked base it used. */
  afterStart?: () => unknown;
}

interface Loaded {
  state: RebaseEditorState;
  /** HEAD when the commits were listed; a different HEAD at Start means the plan is out of date. */
  head: string;
  /** Tree the steps are replayed onto. */
  start: string;
  /** True when the commits stay on the commit they are on now (not rebased onto another branch). */
  inPlace: boolean;
  check: ConflictCheck;
}

export class RebasePanel implements vscode.Disposable {
  private static current: RebasePanel | undefined;

  /** Opens the editor for `target`, replacing one already open. */
  static async open(context: vscode.ExtensionContext, repos: RepoManager, runner: Runner, target: RebaseTarget): Promise<void> {
    const git = repos.git();
    if (!git) {
      void vscode.window.showWarningMessage('SlothGit: no Git repository is open.');
      return;
    }
    let loaded: Loaded;
    try {
      loaded = await load(git, target);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      void vscode.window.showWarningMessage(error.message);
      return;
    }
    RebasePanel.current?.dispose();
    RebasePanel.current = new RebasePanel(context, repos, runner, target, loaded);
  }

  /** The open editor, for tests. */
  static active(): RebasePanel | undefined {
    return RebasePanel.current;
  }

  /** What the page last drew, for tests. */
  rendered: { rows: string[]; status: string } | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private checkId = 0;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly runner: Runner,
    private readonly target: RebaseTarget,
    private loaded: Loaded,
  ) {
    this.panel = vscode.window.createWebviewPanel('slothgit.rebase', 'Interactive Rebase', vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = pageHtml(this.panel.webview, context.extensionUri, 'rebase', 'Interactive Rebase', body);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromRebase) => this.onMessage(m)),
      repos.onDidChange(() => this.reloadIfMoved()),
    );
    context.subscriptions.push(this);
  }

  private post(message: ToRebase): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: FromRebase): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'state', state: this.loaded.state });
        return;
      case 'rendered':
        this.rendered = { rows: message.rows, status: message.status };
        return;
      case 'check': {
        this.checkId = message.id;
        const result = await this.check(message.steps, () => this.checkId !== message.id);
        if (result) this.post({ type: 'conflicts', id: message.id, ...result });
        return;
      }
      case 'start':
        return this.start(message.steps, message.messages);
      case 'pause':
        return this.pause();
      case 'cancel':
        return this.dispose();
    }
  }

  /** Shows `steps` (oldest first) on the page as if they were planned there; for tests. */
  apply(steps: PlannedStep[]): void {
    this.post({ type: 'apply', steps });
  }

  /** Conflicted files by step SHA for `steps` (oldest first), or why they couldn't be checked. */
  async check(steps: PlannedStep[], cancelled?: () => boolean): Promise<{ conflicts: Record<string, string[]>; error?: string } | undefined> {
    try {
      const conflicts = await this.loaded.check.check(this.loaded.start, steps, cancelled);
      return conflicts && { conflicts: Object.fromEntries(conflicts) };
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return { conflicts: {}, error: `Couldn't check for conflicts (this needs Git 2.45 or newer): ${reason}` };
    }
  }

  /** Runs the plan: `steps` oldest first, `messages` the new message for each reword step by SHA. */
  async start(steps: PlannedStep[], messages: Record<string, string>): Promise<void> {
    const git = this.repos.git();
    if (!git) return;
    const problem = planProblem(steps);
    if (problem) {
      void vscode.window.showWarningMessage(problem);
      return;
    }
    if (!(await this.stillCurrent(git))) return;
    const original = this.loaded.state.commits;
    const unchanged = steps.every((s, i) => s.sha === original[i].sha && s.action === 'pick');
    if (unchanged && this.loaded.inPlace) {
      void vscode.window.showInformationMessage('Nothing to change: every commit is picked, in the same order.');
      return;
    }
    if (!(await this.confirmPushed())) return;
    const rewords = Object.fromEntries(steps.filter((s) => s.action === 'reword' && messages[s.sha] !== undefined).map((s) => [s.sha, messages[s.sha]]));
    const ok = await this.runner.run('Rebasing…', async (ops) => {
      await ops.rebaseSteps(this.target.upstream, steps, rewords, this.target.onto);
      if (await getOperation(ops.git)) {
        void vscode.commands.executeCommand('slothgit.commits.focus');
        return 'The rebase stopped at a commit marked Edit. Change it (amend, split, …), then Continue.';
      }
    });
    if (ok) {
      await this.target.afterStart?.();
      this.dispose();
    }
  }

  /** The old way: start the rebase paused before the first step, and plan it in the Commits view. */
  async pause(): Promise<void> {
    const git = this.repos.git();
    if (!git || !(await this.stillCurrent(git)) || !(await this.confirmPushed())) return;
    const { upstream, onto } = this.target;
    const ok = await this.runner.run('Rebasing…', async (ops) => {
      await ops.rebaseOnto(onto ?? upstream, onto ? upstream : undefined, true);
      void vscode.commands.executeCommand('slothgit.commits.focus');
      return 'Rebase paused before the first commit. Right-click the steps at the top of the Commits view to change them, then Continue.';
    });
    if (ok) {
      await this.target.afterStart?.();
      this.dispose();
    }
  }

  /** False (after reloading the list) when the branch moved since the commits were listed. */
  private async stillCurrent(git: Git): Promise<boolean> {
    if ((await headSha(git).catch(() => '')) === this.loaded.head) return true;
    void vscode.window.showWarningMessage('The branch changed since the rebase editor opened. Its commits are listed again; check the plan.');
    await this.reload(git);
    return false;
  }

  private async confirmPushed(): Promise<boolean> {
    const enabled = vscode.workspace.getConfiguration('slothgit').get('confirmRewritingPushedCommits', true);
    const pushed = this.loaded.state.commits.filter((c) => c.pushed).length;
    if (!enabled || !pushed) return true;
    return this.runner.confirm(
      `This rebase rewrites ${pushed === 1 ? '1 commit' : `${pushed} commits`} already pushed to the upstream branch. You will need to force push afterwards.`,
      'Rebase',
    );
  }

  private async reloadIfMoved(): Promise<void> {
    const git = this.repos.git();
    if (!git || (await getOperation(git).catch(() => undefined))) return;
    if ((await headSha(git).catch(() => this.loaded.head)) !== this.loaded.head) await this.reload(git);
  }

  private async reload(git: Git): Promise<void> {
    try {
      this.loaded = await load(git, this.target);
      this.post({ type: 'state', state: this.loaded.state });
    } catch (error) {
      if (error instanceof UserError) void vscode.window.showWarningMessage(error.message);
      this.dispose();
    }
  }

  dispose(): void {
    if (RebasePanel.current === this) RebasePanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.panel.dispose();
  }
}

const FIELD = '\x1f';

/** Lists the commits `target` rebases and prepares the conflict check. */
async function load(git: Git, target: RebaseTarget): Promise<Loaded> {
  const range = target.upstream === ROOT ? 'HEAD' : `${target.upstream}..HEAD`;
  const [log, head, branch, unpushed] = await Promise.all([
    // -z ends each commit with NUL, which a message can't contain.
    git.run(['log', '--reverse', '-z', `--format=%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%ar${FIELD}%B`, range]),
    headSha(git),
    currentBranch(git),
    getUnpushed(git),
  ]);
  const parsed = log
    .split('\0')
    .filter((entry) => entry.trim())
    .map((entry) => {
      const [sha, shortSha, parents, author, relDate, ...message] = entry.replace(/^\n/, '').split(FIELD);
      return { sha, shortSha, parents: parents.split(' ').filter(Boolean), author, relDate, message: message.join(FIELD).trimEnd() };
    });
  if (!parsed.length) throw new UserError('There are no commits to rebase.');
  if (parsed.some((c) => c.parents.length > 1)) {
    throw new UserError(
      "These commits include a merge commit. The rebase editor works on a straight line of commits; use the Commits view's actions on merges.",
    );
  }

  const destination = target.onto ?? target.upstream;
  const parent: string | undefined = parsed[0].parents[0];
  const tree = (rev: string | undefined) => (rev && rev !== ROOT ? `${rev}^{tree}` : EMPTY_TREE);
  const resolve = destination === ROOT ? [] : [`${destination}^{commit}`];
  const [start, originalStart, destinationSha] = (await git.run(['rev-parse', tree(destination), tree(parent), ...resolve]))
    .trim()
    .split(/\r?\n/);
  const commits = parsed.map(
    (c): RebaseCommit => ({
      sha: c.sha,
      shortSha: c.shortSha,
      subject: c.message.split('\n')[0],
      message: c.message,
      author: c.author,
      relDate: c.relDate,
      pushed: unpushed !== null && !unpushed.has(c.sha),
    }),
  );
  return {
    state: { title: `${branch ?? 'HEAD'} ${target.label}`, commits, canPause: target.upstream !== ROOT },
    head,
    start,
    inPlace: destinationSha === parent,
    check: new ConflictCheck(git, new Map(parsed.map((c) => [c.sha, c.parents[0]])), {
      start: originalStart,
      shas: parsed.map((c) => c.sha),
    }),
  };
}
