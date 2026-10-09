// Pure rewriting of git's interactive rebase todo list. Used by rebaseEditor.ts, which git runs as GIT_SEQUENCE_EDITOR.
//
// With --rebase-merges the list also has `label`, `reset` and `merge` lines that rebuild the branch structure.
// Those are never changed here, and changes that would cross them (squashing into another branch's commit,
// moving a commit past a merge or a branch point) are refused, which makes git abort the rebase.

export type TodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebasePlan {
  /** Full SHA -> new action. */
  actions?: Record<string, TodoAction>;
  /** Swap a commit with its neighbour. "up" means towards newer commits, as in the commit list. */
  move?: { sha: string; direction: 'up' | 'down' };
  /** Move `sha` directly after `target` and mark it as a fixup. */
  fixupInto?: { sha: string; target: string };
  /** Stop before the first step (a `break` line), so the steps can be changed before anything is applied. */
  pauseFirst?: boolean;
}

const COMMIT_LINE = /^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)(\s+)([0-9a-fA-F]{4,64})\b(.*)$/;
/** `merge [-C <sha> | -c <sha>] <label> [# <subject>]` */
const MERGE_LINE = /^(?:merge|m)\s+(?:-[cC]\s+([0-9a-fA-F]{4,64})\s+)?(\S+)(.*)$/;
/** Lines that rebuild the branch structure; HEAD jumps at them, so commits can't be squashed or moved across. */
const STRUCTURE_LINE = /^(label|l|reset|t|merge|m)\s/;

interface CommitLine {
  sha: string;
  rest: string;
}

const ACTION_NAMES: Record<string, TodoAction> = {
  p: 'pick', pick: 'pick', r: 'reword', reword: 'reword', e: 'edit', edit: 'edit',
  s: 'squash', squash: 'squash', f: 'fixup', fixup: 'fixup', d: 'drop', drop: 'drop',
};

export interface TodoEntry {
  /** 'merge' steps recreate a merge commit; they are shown but can't be changed. */
  action: TodoAction | 'merge';
  /** Abbreviated SHA as written in the todo list; for a merge, the original merge commit's (may be empty). */
  sha: string;
  subject: string;
}

/** "rest" is " <subject>" or " # <subject>" depending on git version. */
const subjectOf = (rest: string) => rest.replace(/^\s*(#\s*)?/, '');

/** Commit and merge lines of a rebase todo list, in file order (the next one to apply first). */
export function parseTodo(todo: string): TodoEntry[] {
  return todo.split(/\r?\n/).flatMap((line): TodoEntry[] => {
    const m = COMMIT_LINE.exec(line);
    if (m) return [{ action: ACTION_NAMES[m[1]], sha: m[3].toLowerCase(), subject: subjectOf(m[4]) }];
    const merge = MERGE_LINE.exec(line);
    if (merge) return [{ action: 'merge', sha: merge[1]?.toLowerCase() ?? '', subject: subjectOf(merge[3]) || `Merge ${merge[2]}` }];
    return [];
  });
}

/** Kept next to git-rebase-todo, so git deletes it when the rebase ends: full SHA -> message for its reword step. */
export const REWORD_MESSAGES_FILE = 'codegit-messages.json';

/**
 * The saved message for the step git is applying now, when that is a reword. `done` is rebase-merge/done,
 * whose last commit line is the current step.
 */
export function pendingRewordMessage(done: string, messages: Record<string, string>): string | undefined {
  const entries = parseTodo(done);
  const current = entries[entries.length - 1];
  if (current?.action !== 'reword') return undefined;
  const sha = Object.keys(messages).find((full) => full.toLowerCase().startsWith(current.sha));
  return sha === undefined ? undefined : messages[sha];
}

export function transformTodo(todo: string, plan: RebasePlan): string {
  const eol = todo.includes('\r\n') ? '\r\n' : '\n';
  const lines = todo.split(/\r?\n/);
  const parsed = new Map<number, CommitLine>();
  const merges: string[] = [];
  lines.forEach((line, i) => {
    const m = COMMIT_LINE.exec(line);
    if (m) parsed.set(i, { sha: m[3].toLowerCase(), rest: m[4] });
    const merge = MERGE_LINE.exec(line);
    if (merge?.[1]) merges.push(merge[1].toLowerCase());
  });
  const commitIndexes = [...parsed.keys()];

  const find = (fullSha: string): number => {
    const full = fullSha.toLowerCase();
    const index = commitIndexes.find((i) => full.startsWith(parsed.get(i)!.sha));
    if (index !== undefined) return index;
    if (merges.some((sha) => full.startsWith(sha))) throw new Error(`${fullSha.slice(0, 10)} is a merge commit, which can't be changed here`);
    throw new Error(`commit ${fullSha.slice(0, 10)} is not in the rebase todo list`);
  };
  const render = (i: number, action: TodoAction) => `${action} ${parsed.get(i)!.sha}${parsed.get(i)!.rest}`;
  /** True when a label, reset or merge line lies strictly between lines a and b. */
  const structureBetween = (a: number, b: number) =>
    lines.slice(Math.min(a, b) + 1, Math.max(a, b)).some((line) => STRUCTURE_LINE.test(line));

  for (const [sha, action] of Object.entries(plan.actions ?? {})) {
    const i = find(sha);
    if (action === 'squash' || action === 'fixup') {
      // The commit is melded into whatever was applied just before it, which must be its parent on the same branch.
      const previous = commitIndexes[commitIndexes.indexOf(i) - 1];
      if (previous === undefined || structureBetween(previous, i)) {
        throw new Error(`cannot ${action} ${sha.slice(0, 10)}: the commit before it is on another branch or is a merge`);
      }
    }
    lines[i] = render(i, action);
  }

  if (plan.move) {
    const i = find(plan.move.sha);
    const position = commitIndexes.indexOf(i);
    const other = commitIndexes[plan.move.direction === 'up' ? position + 1 : position - 1];
    if (other === undefined) throw new Error(`cannot move commit ${plan.move.sha.slice(0, 10)} ${plan.move.direction}`);
    if (structureBetween(i, other)) {
      throw new Error(`cannot move commit ${plan.move.sha.slice(0, 10)} ${plan.move.direction} past a merge or branch point`);
    }
    [lines[i], lines[other]] = [lines[other], lines[i]];
  }

  if (plan.fixupInto) {
    const i = find(plan.fixupInto.sha);
    const target = find(plan.fixupInto.target);
    const line = render(i, 'fixup');
    lines.splice(i, 1);
    // Directly after the target, before any label that marks it as a branch point.
    lines.splice(i < target ? target : target + 1, 0, line);
  }

  if (plan.pauseFirst) {
    const first = lines.findIndex((line) => COMMIT_LINE.test(line));
    if (first < 0) throw new Error('there are no commits to rebase');
    lines.splice(first, 0, 'break');
  }

  return lines.join(eol);
}
