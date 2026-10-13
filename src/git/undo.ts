// Reflog-based undo/redo, modelled on lazygit's. Pure logic; GitOps applies the result.
//
// The HEAD reflog is replayed oldest to newest as a stack of user actions. SlothGit's own undo and
// redo steps are recorded in the reflog with GIT_REFLOG_ACTION set to the markers below, so a later
// replay knows which actions are already undone. A new action after an undo clears the redo stack.

export const UNDO_MARKER = '[slothgit undo]';
export const REDO_MARKER = '[slothgit redo]';

// Written before the extension was renamed from CodeGit, and still recognised. Remove after 2.0.0, together
// with migrateSettings in extension.ts.
const LEGACY_UNDO_MARKER = '[codegit undo]';
const LEGACY_REDO_MARKER = '[codegit redo]';

export interface ReflogItem {
  sha: string;
  /** The reflog message (%gs), e.g. "commit: fix typo" or "checkout: moving from main to dev". */
  subject: string;
}

export interface UndoAction {
  /**
   * checkout: switch between branches/commits. commit: a commit or amend, undone with a soft reset so its
   * changes come back staged (as lazygit does). reset: anything else that moved the current branch.
   */
  kind: 'checkout' | 'commit' | 'reset';
  /** State before the action: a branch name or commit for checkouts, a commit for resets. */
  from: string;
  /** State after the action. */
  to: string;
  /** The reflog message of the action, for confirmations. */
  description: string;
}

export interface UndoPlan {
  undo?: UndoAction;
  redo?: UndoAction;
  /** The newest reflog entries belong to a rebase that has not finished. */
  rebaseInProgress: boolean;
}

const CHECKOUT = /^checkout: moving from (\S+) to (\S+)$/;
// "commit: …", "commit (amend): …", "commit (merge): …": lazygit's COMMIT kind.
const COMMIT = /^commit\b/;
// "rebase (start)", "rebase -i (start)", "pull --rebase (start)", likewise finish/abort.
const REBASE_START = /^[^:]*\brebase\b[^:]*\(start\)/;
const REBASE_END = /^[^:]*\brebase\b[^:]*\((finish|abort)\)/;

/** @param entries HEAD reflog, newest first (as `git reflog` prints it). */
export function planUndo(entries: ReflogItem[]): UndoPlan {
  const items = [...entries].reverse();
  const done: UndoAction[] = [];
  let redo: UndoAction[] = [];
  let rebaseFrom: string | undefined;
  let inRebase = false;

  const record = (action: UndoAction) => {
    if (action.from === action.to) return;
    done.push(action);
    redo = [];
  };

  items.forEach((entry, i) => {
    const previous = items[i - 1]?.sha;
    if (entry.subject.startsWith(UNDO_MARKER) || entry.subject.startsWith(LEGACY_UNDO_MARKER)) {
      const action = done.pop();
      if (action) redo.push(action);
    } else if (entry.subject.startsWith(REDO_MARKER) || entry.subject.startsWith(LEGACY_REDO_MARKER)) {
      const action = redo.pop();
      if (action) done.push(action);
    } else if (inRebase) {
      // Everything between start and finish is one action.
      if (REBASE_END.test(entry.subject)) {
        inRebase = false;
        if (rebaseFrom) record({ kind: 'reset', from: rebaseFrom, to: entry.sha, description: 'rebase' });
      }
    } else if (REBASE_START.test(entry.subject)) {
      inRebase = true;
      rebaseFrom = previous;
    } else {
      const checkout = CHECKOUT.exec(entry.subject);
      if (checkout) {
        record({ kind: 'checkout', from: checkout[1], to: checkout[2], description: entry.subject });
      } else if (previous) {
        const kind = COMMIT.test(entry.subject) ? 'commit' : 'reset';
        record({ kind, from: previous, to: entry.sha, description: entry.subject });
      }
    }
  });

  return { undo: done.at(-1), redo: redo.at(-1), rebaseInProgress: inRebase };
}
