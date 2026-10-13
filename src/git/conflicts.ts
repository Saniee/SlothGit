// Conflicts of a stopped rebase, merge, cherry-pick or revert: which files, which hunks, and what the two sides are.
// Used by the conflicts panel (views/conflictsPanel.ts). The marker parsing is pure, so it is tested without git.
import * as fs from 'node:fs';
import { getOperation, type Operation } from './queries';
import type { Git } from './runner';

/**
 * How a file conflicts, from `git status`. "Current" is the side being built on (HEAD; during a rebase, the new
 * base plus the commits applied so far), "incoming" the commit being applied or merged in.
 */
export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'deleted-in-current'
  | 'deleted-in-incoming'
  | 'added-in-current'
  | 'added-in-incoming';

const STATUS_KINDS: Record<string, ConflictKind> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  DU: 'deleted-in-current',
  UD: 'deleted-in-incoming',
  AU: 'added-in-current',
  UA: 'added-in-incoming',
};

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
}

/** Files git still lists as unmerged. */
export async function getConflicts(git: Git): Promise<ConflictFile[]> {
  const out = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  return out.split('\0').flatMap((entry): ConflictFile[] => {
    const kind = STATUS_KINDS[entry.slice(0, 2)];
    return kind ? [{ path: entry.slice(3), kind }] : [];
  });
}

// --- conflict markers --------------------------------------------------------------------------------

export interface ConflictHunk {
  /** 0-based line of the `<<<<<<<` marker. */
  line: number;
  current: string[];
  /** The common ancestor's lines, with merge.conflictStyle diff3 or zdiff3. */
  base?: string[];
  incoming: string[];
}

export type HunkChoice = 'current' | 'incoming' | 'both';

const START = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const MIDDLE = /^={7}$/;
const END = /^>{7}(?: |$)/;

/** The conflict hunks in a file's text. Unbalanced markers end the scan; what was found so far is returned. */
export function parseConflicts(text: string): ConflictHunk[] {
  const lines = text.split(/\r?\n/);
  const hunks: ConflictHunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!START.test(lines[i])) continue;
    const hunk: ConflictHunk = { line: i, current: [], incoming: [] };
    let part: string[] = hunk.current;
    let j = i + 1;
    for (; j < lines.length && !END.test(lines[j]); j++) {
      if (BASE.test(lines[j]) && part === hunk.current) part = hunk.base = [];
      else if (MIDDLE.test(lines[j]) && part !== hunk.incoming) part = hunk.incoming;
      else part.push(lines[j]);
    }
    if (j >= lines.length || part !== hunk.incoming) break;
    hunks.push(hunk);
    i = j;
  }
  return hunks;
}

/** `text` with hunk number `index` replaced by the chosen side (or both, current first). */
export function resolveHunk(text: string, index: number, choice: HunkChoice): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const hunk = parseConflicts(text)[index];
  if (!hunk) throw new Error('That conflict is no longer in the file.');
  const end = lines.findIndex((line, i) => i > hunk.line && END.test(line));
  const kept = choice === 'current' ? hunk.current : choice === 'incoming' ? hunk.incoming : [...hunk.current, ...hunk.incoming];
  lines.splice(hunk.line, end - hunk.line + 1, ...kept);
  return lines.join(eol);
}

// --- the stopped operation -----------------------------------------------------------------------------

export interface StoppedCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface StoppedOperation {
  operation: Operation;
  /** The commit being applied (rebase, cherry-pick), undone (revert) or merged in (merge). */
  incoming?: StoppedCommit;
  /** For a merge: the merged branch, from MERGE_MSG. */
  incomingName?: string;
  /** The checked-out branch; during a rebase, the branch being rebased. */
  branch?: string;
  /** For a rebase: the commit it is rebased onto, and the step it stopped at (1-based) of how many. */
  onto?: StoppedCommit;
  step?: { number: number; total: number };
}

/** What is stopped and where, for the conflicts panel's labels; undefined when nothing is in progress. */
export async function getStoppedOperation(git: Git): Promise<StoppedOperation | undefined> {
  const operation = await getOperation(git);
  if (!operation) return undefined;
  const read = async (name: string) => {
    const file = await git.gitDirPath(name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined;
  };
  const commit = async (rev: string | undefined): Promise<StoppedCommit | undefined> => {
    if (!rev) return undefined;
    const result = await git.exec(['log', '-1', '--format=%H%x00%h%x00%s', rev, '--'], { allowedExitCodes: [128] });
    if (result.exitCode !== 0) return undefined;
    const [sha, shortSha, subject] = result.stdout.trim().split('\0');
    return { sha, shortSha, subject };
  };
  const head = (await git.exec(['symbolic-ref', '--short', '-q', 'HEAD'], { allowedExitCodes: [1, 128] })).stdout.trim() || undefined;
  const info: StoppedOperation = { operation, branch: head };

  if (operation === 'rebase') {
    const dir = (await read('rebase-merge/onto')) !== undefined ? 'rebase-merge' : 'rebase-apply';
    const [headName, onto, number, total] = await Promise.all([
      read(`${dir}/head-name`),
      read(`${dir}/onto`),
      read(`${dir}/msgnum`).then((n) => n ?? read(`${dir}/next`)),
      read(`${dir}/end`).then((n) => n ?? read(`${dir}/last`)),
    ]);
    info.branch = headName?.replace(/^refs\/heads\//, '') || undefined;
    info.onto = await commit(onto);
    info.incoming = await commit(fs.existsSync(await git.gitDirPath('REBASE_HEAD')) ? 'REBASE_HEAD' : undefined);
    if (number && total) info.step = { number: parseInt(number, 10), total: parseInt(total, 10) };
  } else if (operation === 'merge') {
    info.incoming = await commit('MERGE_HEAD');
    const message = await read('MERGE_MSG');
    info.incomingName = /^Merge (?:remote-tracking )?(?:branch|tag) '([^']+)'/.exec(message ?? '')?.[1];
  } else {
    const marker = operation === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD';
    info.incoming = await commit(fs.existsSync(await git.gitDirPath(marker)) ? marker : undefined);
  }
  return info;
}
