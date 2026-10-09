import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EMPTY_TREE,
  getBisectState,
  getOperation,
  getReflog,
  rebaseTodoPath,
  hasStagedChanges,
  headSha,
  isDirty,
  type FileChange,
  type Operation,
} from './queries';
import { Git } from './runner';
import { REWORD_MESSAGES_FILE, transformTodo, type RebasePlan, type TodoAction } from './todo';
import { planUndo, REDO_MARKER, UNDO_MARKER, type UndoAction, type UndoPlan } from './undo';

const ROOT = '--root';

/**
 * Builds the shell command git runs as its (sequence) editor. Git executes editors through `sh`
 * (bundled with Git for Windows too), so POSIX quoting and forward slashes work everywhere.
 * ELECTRON_RUN_AS_NODE lets VS Code's own executable act as node; plain node ignores it.
 */
export function buildEditorCommand(runtime: string, script: string): string {
  const quote = (p: string) => {
    const normalized = process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
    return `'${normalized.replace(/'/g, `'\\''`)}'`;
  };
  return `ELECTRON_RUN_AS_NODE=1 ${quote(runtime)} ${quote(script)}`;
}

export class UserError extends Error {}

export type ResetMode = 'soft' | 'mixed' | 'hard';

/** History-rewriting and housekeeping operations. Callers are expected to refresh UI afterwards. */
export class GitOps {
  constructor(
    readonly git: Git,
    private readonly editorCommand: string,
  ) {}

  // --- interactive rebase -------------------------------------------------

  /** `sha~depth`, or ROOT when that commit does not exist (rebase from the root commit). */
  private async ancestor(sha: string, depth: number): Promise<string> {
    const result = await this.git.exec(['rev-parse', '--verify', '-q', `${sha}~${depth}^{commit}`], {
      allowedExitCodes: [1],
    });
    return result.exitCode === 0 ? result.stdout.trim() : ROOT;
  }

  private async hasParent(sha: string): Promise<boolean> {
    return (await this.ancestor(sha, 1)) !== ROOT;
  }

  /** For commits on a linear history, the oldest of them. */
  private async oldest(shas: string[]): Promise<string> {
    if (shas.length === 1) return shas[0];
    return (await this.git.run(['merge-base', '--octopus', ...shas])).trim();
  }

  private async hasMerges(base: string): Promise<boolean> {
    const range = base === ROOT ? 'HEAD' : `${base}..HEAD`;
    return parseInt(await this.git.run(['rev-list', '--merges', '--count', range]), 10) > 0;
  }

  /** Merge commits are recreated by the rebase, but can't be the target of a change themselves. */
  private async assertNotMerges(shas: string[]): Promise<void> {
    if (!shas.length) return;
    const merges = (await this.git.run(['rev-list', '--no-walk', '--merges', ...shas])).trim();
    if (merges) {
      throw new UserError(
        "CodeGit can't change a merge commit itself yet (only the newest commit, by amending it). Commits before and after merges can be rewritten.",
      );
    }
  }

  /**
   * Runs `git rebase --interactive` with `plan` applied to the todo list. When the commits to rewrite include
   * merges, --rebase-merges recreates them; merges whose parents changed are merged again, so conflicts
   * resolved in them come back.
   */
  private async rebase(
    base: string,
    plan: RebasePlan,
    options: { message?: string; autosquash?: boolean; onto?: string } = {},
  ): Promise<void> {
    await this.assertNotMerges([
      ...Object.keys(plan.actions ?? {}),
      ...(plan.move ? [plan.move.sha] : []),
      ...(plan.fixupInto ? [plan.fixupInto.target] : []),
    ]);
    const merges = (await this.hasMerges(base)) ? ['--rebase-merges'] : [];
    const env: Record<string, string> = {
      GIT_SEQUENCE_EDITOR: this.editorCommand,
      GIT_EDITOR: this.editorCommand,
      CODEGIT_REBASE_PLAN: JSON.stringify(plan),
    };
    if (options.message !== undefined) env.CODEGIT_COMMIT_MESSAGE = options.message;
    const autosquash = options.autosquash ? '--autosquash' : '--no-autosquash';
    const range = options.onto ? ['--onto', options.onto, base] : [base];
    await this.git.exec(['rebase', '--interactive', '--autostash', autosquash, ...merges, ...range], { env });
  }

  /**
   * Stops an interactive rebase at `sha`, runs `fn` (which typically amends HEAD), then continues.
   * If `fn` fails the rebase is aborted, so history is left untouched.
   */
  private async atCommit(sha: string, fn: () => Promise<void>): Promise<void> {
    await this.rebase(await this.ancestor(sha, 1), { actions: { [sha]: 'edit' } });
    if ((await getOperation(this.git)) !== 'rebase' || (await headSha(this.git)) !== sha) {
      throw new Error(`The rebase did not stop at ${sha.slice(0, 10)} as expected.`);
    }
    try {
      await fn();
    } catch (error) {
      await this.git.exec(['rebase', '--abort']).catch(() => undefined);
      throw error;
    }
    await this.continueOperation('rebase');
  }

  /** Amends only the commit metadata of `sha` (never staged changes). */
  private async amendMetadata(sha: string, args: string[]): Promise<void> {
    const amend = ['commit', '--amend', '--only', '--no-edit', '--allow-empty', ...args];
    if (sha === (await headSha(this.git)) && !(await getOperation(this.git))) {
      await this.git.exec(amend);
      return;
    }
    await this.atCommit(sha, () => this.git.exec(amend).then(() => undefined));
  }

  private static actions(shas: string[], action: TodoAction): Record<string, TodoAction> {
    return Object.fromEntries(shas.map((sha) => [sha, action]));
  }

  async drop(shas: string[]): Promise<void> {
    const base = await this.ancestor(await this.oldest(shas), 1);
    await this.rebase(base, { actions: GitOps.actions(shas, 'drop') });
  }

  /** Squash or fixup each commit into the commit before it. */
  async squash(shas: string[], action: 'squash' | 'fixup'): Promise<void> {
    const oldest = await this.oldest(shas);
    if (!(await this.hasParent(oldest))) throw new UserError('The first commit has no previous commit to squash into.');
    const parents = (await this.git.run(['rev-parse', ...shas.map((sha) => `${sha}^`)])).split(/\s+/).filter(Boolean);
    if ((await this.git.run(['rev-list', '--no-walk', '--merges', ...parents])).trim()) {
      throw new UserError("The commit before it is a merge commit, which can't be squashed into.");
    }
    const base = await this.ancestor(oldest, 2);
    await this.rebase(base, { actions: GitOps.actions(shas, action) });
  }

  async reword(sha: string, message: string): Promise<void> {
    if (sha === (await headSha(this.git))) {
      await this.git.exec(['commit', '--amend', '--only', '--allow-empty', '-m', message]);
      return;
    }
    await this.rebase(await this.ancestor(sha, 1), { actions: { [sha]: 'reword' } }, { message });
  }

  async edit(sha: string): Promise<void> {
    await this.rebase(await this.ancestor(sha, 1), { actions: { [sha]: 'edit' } });
  }

  async move(sha: string, direction: 'up' | 'down'): Promise<void> {
    if (direction === 'up') {
      if (sha === (await headSha(this.git))) throw new UserError('This is already the newest commit.');
      await this.rebase(await this.ancestor(sha, 1), { move: { sha, direction } });
    } else {
      if (!(await this.hasParent(sha))) throw new UserError('This is already the oldest commit.');
      await this.rebase(await this.ancestor(sha, 2), { move: { sha, direction } });
    }
  }

  /** Fold the staged changes into `sha` (lazygit's "amend commit with staged changes"). */
  async amendStaged(sha: string): Promise<void> {
    if (!(await hasStagedChanges(this.git))) throw new UserError('There are no staged changes to amend.');
    if (sha === (await headSha(this.git))) {
      await this.git.exec(['commit', '--amend', '--no-edit']);
      return;
    }
    const base = await this.ancestor(sha, 1);
    await this.assertNotMerges([sha]);
    // Temporary commit; it is folded into the target and its message discarded, so skip hooks.
    await this.git.exec(['commit', '--no-verify', '-m', `codegit: amend ${sha}`]);
    const temp = await headSha(this.git);
    try {
      await this.rebase(base, { fixupInto: { sha: temp, target: sha } });
    } catch (error) {
      // If the rebase never started, put the changes back in the index.
      if (!(await getOperation(this.git))) await this.git.exec(['reset', '--soft', 'HEAD~1']);
      throw error;
    }
  }

  /** Creates a "fixup! <subject>" commit for `sha` from the staged changes (lazygit's F). */
  async createFixupCommit(sha: string): Promise<void> {
    if (!(await hasStagedChanges(this.git))) throw new UserError('Stage the changes for the fixup commit first.');
    await this.git.exec(['commit', `--fixup=${sha}`]);
  }

  /** Squashes every "fixup!"/"squash!" commit above `sha` into its target (lazygit's S). */
  async autosquash(sha: string): Promise<void> {
    await this.rebase(await this.ancestor(sha, 1), {}, { autosquash: true });
  }

  async resetAuthor(sha: string): Promise<void> {
    await this.amendMetadata(sha, ['--reset-author']);
  }

  /** `author` in the form "Name <email>". */
  async setAuthor(sha: string, author: string): Promise<void> {
    await this.amendMetadata(sha, [`--author=${author}`]);
  }

  async addCoAuthor(sha: string, coAuthor: string): Promise<void> {
    await this.amendMetadata(sha, ['--trailer', `Co-authored-by: ${coAuthor}`]);
  }

  /**
   * Removes the changes to `changes` from commit `sha`. With `keep`, the removed changes are then
   * applied to the index and working tree instead of being discarded (lazygit's "move patch out into index").
   */
  async removeFilesFromCommit(sha: string, changes: FileChange[], keep: boolean): Promise<string | void> {
    let patchFile: string | undefined;
    if (keep) {
      const parent = (await this.hasParent(sha)) ? `${sha}^` : EMPTY_TREE;
      const paths = changes.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]));
      const patch = await this.git.run(['diff', '--binary', parent, sha, '--', ...paths]);
      patchFile = path.resolve(this.git.cwd, (await this.git.run(['rev-parse', '--git-path', 'codegit-uncommit.patch'])).trim());
      fs.writeFileSync(patchFile, patch);
    }

    await this.atCommit(sha, async () => {
      for (const change of changes) {
        if (change.status === 'A' || change.status === 'C' || change.status === 'R') {
          await this.git.exec(['rm', '-q', '--', change.path]);
        }
        const restore = change.status === 'R' ? change.oldPath : change.status === 'A' || change.status === 'C' ? undefined : change.path;
        if (restore) await this.git.exec(['checkout', 'HEAD^', '--', restore]);
      }
      await this.git.exec(['commit', '--amend', '--no-edit', '--allow-empty', '--no-verify']);
    });

    if (patchFile) {
      try {
        await this.git.exec(['apply', '--3way', patchFile]);
        fs.rmSync(patchFile, { force: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        return `The changes were removed from the commit but could not be applied to your working tree (${reason}). They are saved in ${patchFile}.`;
      }
    }
  }

  /** Overwrites a file in the working tree and index with its version from `sha`. */
  async checkoutFileFrom(sha: string, file: string): Promise<void> {
    await this.git.exec(['checkout', sha, '--', file]);
  }

  // --- other commit operations ---------------------------------------------

  /** `shas` in the order they should be applied (oldest first). */
  async cherryPick(shas: string[]): Promise<void> {
    await this.git.exec(['cherry-pick', ...shas]);
  }

  async revert(shas: string[]): Promise<void> {
    await this.git.exec(['revert', '--no-edit', ...shas]);
  }

  async reset(sha: string, mode: ResetMode): Promise<void> {
    await this.git.exec(['reset', `--${mode}`, sha]);
  }

  async checkout(sha: string): Promise<void> {
    await this.git.exec(['checkout', '--detach', sha]);
  }

  async createBranch(name: string, sha: string, checkout: boolean): Promise<void> {
    await this.git.exec(checkout ? ['checkout', '-b', name, sha] : ['branch', name, sha]);
  }

  // --- branches ---------------------------------------------------------------

  async switchBranch(name: string): Promise<void> {
    await this.git.exec(['switch', name]);
  }

  async switchPrevious(): Promise<void> {
    await this.git.exec(['switch', '-']);
  }

  /** Checks out a local branch for `remoteBranch`, creating a tracking branch when none exists. Returns the local name. */
  async checkoutRemoteBranch(remoteBranch: string, localName: string): Promise<'switched' | 'created'> {
    const exists = await this.git.exec(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], {
      allowedExitCodes: [1],
    });
    if (exists.exitCode === 0) {
      await this.switchBranch(localName);
      return 'switched';
    }
    await this.git.exec(['switch', '-c', localName, '--track', remoteBranch]);
    return 'created';
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    await this.git.exec(['branch', force ? '-D' : '-d', name]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git.exec(['branch', '-m', oldName, newName]);
  }

  async setUpstream(branch: string, upstream: string | undefined): Promise<void> {
    await this.git.exec(
      upstream ? ['branch', `--set-upstream-to=${upstream}`, branch] : ['branch', '--unset-upstream', branch],
    );
  }

  async merge(ref: string, mode: 'default' | 'noFastForward' | 'squash'): Promise<void> {
    const flags = { default: ['--no-edit'], noFastForward: ['--no-ff', '--no-edit'], squash: ['--squash'] }[mode];
    await this.git.exec(['merge', ...flags, ref], { env: { GIT_EDITOR: ':' } });
  }

  /**
   * Rebase the current branch onto `target`; with `base`, only the commits after `base` are moved (`--onto`).
   * `interactive` stops before the first commit is applied, so the todo list can be changed first.
   */
  async rebaseOnto(target: string, base?: string, interactive = false): Promise<void> {
    if (interactive) {
      const count = parseInt(await this.git.run(['rev-list', '--count', `${base ?? target}..HEAD`]), 10);
      if (count === 0) throw new UserError('There are no commits to rebase: the current branch has no commits that are not on the target.');
      await this.rebase(base ?? target, { pauseFirst: true }, base ? { onto: target } : {});
      return;
    }
    const args = base ? ['--onto', target, base] : [target];
    await this.git.exec(['rebase', '--autostash', ...args], { env: { GIT_EDITOR: ':' } });
  }

  /**
   * Number of commits a rebase would rewrite that are already on the current branch's upstream,
   * i.e. commits in `exclude..HEAD` that are also reachable from @{upstream}.
   */
  async countPushedCommitsAfter(exclude: string): Promise<number> {
    const mergeBase = await this.git.exec(['merge-base', 'HEAD', '@{upstream}'], { allowedExitCodes: [1, 128] });
    if (mergeBase.exitCode !== 0) return 0;
    const count = await this.git.run(['rev-list', '--count', `${exclude}..${mergeBase.stdout.trim()}`]);
    return parseInt(count, 10);
  }

  /** Fast-forward the current branch to its upstream, without fetching. */
  async fastForwardCurrent(): Promise<void> {
    await this.git.exec(['merge', '--ff-only', '@{upstream}']);
  }

  // --- remotes -------------------------------------------------------------------

  async addRemote(name: string, url: string): Promise<void> {
    await this.git.exec(['remote', 'add', name, url]);
  }

  async removeRemote(name: string): Promise<void> {
    await this.git.exec(['remote', 'remove', name]);
  }

  async renameRemote(oldName: string, newName: string): Promise<void> {
    await this.git.exec(['remote', 'rename', oldName, newName]);
  }

  async setRemoteUrl(name: string, url: string): Promise<void> {
    await this.git.exec(['remote', 'set-url', name, url]);
  }

  // --- tags ------------------------------------------------------------------------

  /** Creates an annotated tag when `message` is non-empty, otherwise a lightweight one. */
  async createTag(name: string, ref: string, message: string): Promise<void> {
    await this.git.exec(message ? ['tag', '-a', name, '-m', message, ref] : ['tag', name, ref]);
  }

  async deleteTag(name: string): Promise<void> {
    await this.git.exec(['tag', '-d', name]);
  }

  // --- undo / redo ---------------------------------------------------------------

  async planUndo(): Promise<UndoPlan> {
    const entries = await getReflog(this.git, 1000);
    return planUndo(entries.map((e) => ({ sha: e.sha, subject: e.subject })));
  }

  /** Reverts (undo) or re-applies (redo) a reflog action. Uncommitted changes are carried over. */
  async applyUndo(action: UndoAction, direction: 'undo' | 'redo'): Promise<void> {
    const env = { GIT_REFLOG_ACTION: direction === 'undo' ? UNDO_MARKER : REDO_MARKER };
    const target = direction === 'undo' ? action.from : action.to;
    if (action.kind === 'checkout') {
      await this.git.exec(['checkout', target, '--'], { env });
      return;
    }
    if (action.kind === 'commit') {
      // Moves the branch only: undoing leaves the commit's changes staged, redoing commits them again.
      await this.git.exec(['reset', '--soft', target], { env });
      return;
    }
    const stash = await isDirty(this.git);
    if (stash) await this.git.exec(['stash', 'push', '--include-untracked', '-m', `codegit: autostash for ${direction}`]);
    try {
      await this.git.exec(['reset', '--hard', target], { env });
    } finally {
      if (stash) {
        const pop = await this.git.exec(['stash', 'pop', '--index'], { allowedExitCodes: [1] });
        if (pop.exitCode !== 0) {
          throw new UserError(
            `Your uncommitted changes conflict with the ${direction}. They were kept in the stash (stash@{0}); resolve the conflicts in Source Control.`,
          );
        }
      }
    }
  }

  // --- bisect -------------------------------------------------------------------------

  /** Marks `sha` as bad/good/skip, starting a bisect first if needed. Returns git's summary line. */
  async bisectMark(sha: string, mark: 'bad' | 'good' | 'skip'): Promise<string> {
    const state = await getBisectState(this.git);
    if (!state) await this.git.exec(['bisect', 'start']);
    const term = mark === 'skip' ? 'skip' : state ? state.terms[mark] : mark;
    const output = await this.git.run(['bisect', term, sha]);
    return output
      .split(/\r?\n/)
      .find((line) => /Bisecting:|is the first|There are only|bisect run|needs testing|Some good revs/.test(line))
      ?.trim() ?? output.split(/\r?\n/)[0];
  }

  async bisectReset(): Promise<void> {
    await this.git.exec(['bisect', 'reset']);
  }

  // --- worktrees ----------------------------------------------------------------------

  /** Adds a worktree at `dir`, for `branch`, or for a new branch `newBranch` starting at `start`. */
  async addWorktree(dir: string, options: { branch: string } | { newBranch: string; start: string }): Promise<void> {
    const args =
      'branch' in options ? [dir, options.branch] : ['-b', options.newBranch, dir, options.start];
    await this.git.exec(['worktree', 'add', ...args]);
  }

  async removeWorktree(dir: string, force: boolean): Promise<void> {
    await this.git.exec(['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  }

  async pruneWorktrees(): Promise<void> {
    await this.git.exec(['worktree', 'prune']);
  }

  /** Local branches fully merged into HEAD, excluding the current one. */
  async mergedBranches(): Promise<string[]> {
    const output = await this.git.run(['branch', '--merged', 'HEAD', '--format=%(HEAD) %(refname:short)']);
    return output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('  '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
  }

  // --- in-progress operations ----------------------------------------------

  /**
   * Sets a step of the paused rebase to reword. The message is saved next to the todo list and written by
   * rebaseEditor.js when git reaches the step.
   */
  async rewordTodo(sha: string, message: string): Promise<void> {
    const full = (await this.git.run(['rev-parse', '--verify', `${sha}^{commit}`])).trim();
    const todoFile = await rebaseTodoPath(this.git);
    if (!fs.existsSync(todoFile)) throw new UserError('No interactive rebase is paused.');
    fs.writeFileSync(todoFile, transformTodo(fs.readFileSync(todoFile, 'utf8'), { actions: { [full]: 'reword' } }));
    const savedFile = path.join(path.dirname(todoFile), REWORD_MESSAGES_FILE);
    const saved = fs.existsSync(savedFile) ? (JSON.parse(fs.readFileSync(savedFile, 'utf8')) as Record<string, string>) : {};
    saved[full] = message;
    fs.writeFileSync(savedFile, JSON.stringify(saved));
  }

  /**
   * Rebases run rebaseEditor.js, which applies saved reword messages and otherwise keeps git's prepared message.
   * For the others ':' tells git not to launch an editor and keep the prepared message.
   */
  private continueEnv(operation: Operation): Record<string, string> {
    return { GIT_EDITOR: operation === 'rebase' ? this.editorCommand : ':' };
  }

  async continueOperation(operation: Operation): Promise<void> {
    await this.git.exec([operation, '--continue'], { env: this.continueEnv(operation) });
  }

  async abortOperation(operation: Operation): Promise<void> {
    await this.git.exec([operation, '--abort']);
  }

  async skipOperation(operation: Operation): Promise<void> {
    await this.git.exec([operation, '--skip'], { env: this.continueEnv(operation) });
  }

  // --- stashes ---------------------------------------------------------------

  async stashPush(mode: 'all' | 'staged' | 'keepIndex', message: string): Promise<void> {
    const flags = { all: ['--include-untracked'], staged: ['--staged'], keepIndex: ['--keep-index', '--include-untracked'] }[mode];
    await this.git.exec(['stash', 'push', ...flags, ...(message ? ['-m', message] : [])]);
  }

  async stashApply(ref: string, pop: boolean): Promise<void> {
    await this.git.exec(['stash', pop ? 'pop' : 'apply', ref]);
  }

  async stashDrop(ref: string): Promise<void> {
    await this.git.exec(['stash', 'drop', ref]);
  }

  async stashRename(ref: string, sha: string, message: string): Promise<void> {
    await this.git.exec(['stash', 'drop', ref]);
    await this.git.exec(['stash', 'store', '-m', message, sha]);
  }

  async stashBranch(name: string, ref: string): Promise<void> {
    await this.git.exec(['stash', 'branch', name, ref]);
  }
}
