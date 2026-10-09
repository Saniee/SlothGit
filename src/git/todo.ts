// Pure rewriting of git's interactive rebase todo list. Used by rebaseEditor.ts, which git runs as GIT_SEQUENCE_EDITOR.

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

interface CommitLine {
  sha: string;
  rest: string;
}

const ACTION_NAMES: Record<string, TodoAction> = {
  p: 'pick', pick: 'pick', r: 'reword', reword: 'reword', e: 'edit', edit: 'edit',
  s: 'squash', squash: 'squash', f: 'fixup', fixup: 'fixup', d: 'drop', drop: 'drop',
};

export interface TodoEntry {
  action: TodoAction;
  /** Abbreviated SHA as written in the todo list. */
  sha: string;
  subject: string;
}

/** Commit lines of a rebase todo list, in file order (the next one to apply first). */
export function parseTodo(todo: string): TodoEntry[] {
  return todo.split(/\r?\n/).flatMap((line) => {
    const m = COMMIT_LINE.exec(line);
    // "rest" is " <subject>" or " # <subject>" depending on git version.
    return m ? [{ action: ACTION_NAMES[m[1]], sha: m[3].toLowerCase(), subject: m[4].replace(/^\s*(#\s*)?/, '') }] : [];
  });
}

export function transformTodo(todo: string, plan: RebasePlan): string {
  const eol = todo.includes('\r\n') ? '\r\n' : '\n';
  const lines = todo.split(/\r?\n/);
  const parsed = new Map<number, CommitLine>();
  lines.forEach((line, i) => {
    const m = COMMIT_LINE.exec(line);
    if (m) parsed.set(i, { sha: m[3].toLowerCase(), rest: m[4] });
  });
  const commitIndexes = [...parsed.keys()];

  const find = (fullSha: string): number => {
    const full = fullSha.toLowerCase();
    const index = commitIndexes.find((i) => full.startsWith(parsed.get(i)!.sha));
    if (index === undefined) throw new Error(`commit ${fullSha.slice(0, 10)} is not in the rebase todo list`);
    return index;
  };
  const render = (i: number, action: TodoAction) => `${action} ${parsed.get(i)!.sha}${parsed.get(i)!.rest}`;

  for (const [sha, action] of Object.entries(plan.actions ?? {})) {
    const i = find(sha);
    lines[i] = render(i, action);
  }

  if (plan.move) {
    const i = find(plan.move.sha);
    const position = commitIndexes.indexOf(i);
    const other = commitIndexes[plan.move.direction === 'up' ? position + 1 : position - 1];
    if (other === undefined) throw new Error(`cannot move commit ${plan.move.sha.slice(0, 10)} ${plan.move.direction}`);
    [lines[i], lines[other]] = [lines[other], lines[i]];
  }

  if (plan.fixupInto) {
    const i = find(plan.fixupInto.sha);
    const target = find(plan.fixupInto.target);
    const line = render(i, 'fixup');
    lines.splice(i, 1);
    lines.splice(i < target ? target : target + 1, 0, line);
  }

  if (plan.pauseFirst) {
    const first = lines.findIndex((line) => COMMIT_LINE.test(line));
    if (first < 0) throw new Error('there are no commits to rebase');
    lines.splice(first, 0, 'break');
  }

  return lines.join(eol);
}
