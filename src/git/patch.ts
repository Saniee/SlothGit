// Partial patches from a commit's diff (lazygit's custom patches, at line level). Pure, so it can be unit tested.
//
// The input is `git diff parent commit -- <file>` for one file. Lines are picked by their number on one side of
// the diff: "old" (the parent's version, the left side of a diff editor) or "new" (the commit's version, the right
// side). Picking works by change block (a run of removed and added lines between context lines), as VS Code's
// "Stage Selected Ranges" does: picking some added lines of a block also picks the lines it replaced, and an empty
// selection picks the whole block under the cursor.
//
// The result is a patch that, applied to the commit's version of the file, takes the picked changes back out.

export type Side = 'old' | 'new';

/** 1-based line ranges, inclusive. `whole` ranges come from an empty selection (a cursor) and pick whole blocks. */
export interface LineRange {
  start: number;
  end: number;
  whole?: boolean;
}

/** Lines picked on either side of one file's diff. */
export type Selection = Partial<Record<Side, LineRange[]>>;

/** Picks every change in a file. */
export const WHOLE_FILE: Selection = { new: [{ start: 1, end: Number.MAX_SAFE_INTEGER }] };

interface DiffLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** Line number in the parent's version (context and removed lines). */
  old?: number;
  /** Line number in the commit's version (context and added lines). */
  new?: number;
}

interface Hunk {
  lines: DiffLine[];
}

export interface FileDiff {
  /** Path in the commit. */
  path: string;
  /** Mode of the file in the commit, when the commit added it ("new file mode"). */
  newFileMode?: string;
  deleted: boolean;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseFileDiff(diff: string, path: string): FileDiff {
  const result: FileDiff = { path, deleted: false, binary: false, hunks: [] };
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = { lines: [] };
      result.hunks.push(hunk);
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[3], 10);
      // A zero-length side's start is the line before the hunk.
      if (header[2] === '0') oldLine++;
      if (header[4] === '0') newLine++;
      continue;
    }
    if (!hunk) {
      const mode = /^new file mode (\d+)/.exec(line);
      if (mode) result.newFileMode = mode[1];
      if (line.startsWith('deleted file mode')) result.deleted = true;
      if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) result.binary = true;
      continue;
    }
    const kind = line[0];
    const text = line.slice(1);
    if (kind === ' ') hunk.lines.push({ kind, text, old: oldLine++, new: newLine++ });
    else if (kind === '-') hunk.lines.push({ kind, text, old: oldLine++ });
    else if (kind === '+') hunk.lines.push({ kind, text, new: newLine++ });
    else if (kind === '\\') hunk.lines.push({ kind, text });
    // Anything else ends the file's diff (e.g. the trailing empty line).
  }
  return result;
}

interface Block {
  /** Indexes into the hunk's lines. */
  removed: number[];
  added: number[];
  /** Where a pure insertion or deletion sits on the other side: the number of the line just after it. */
  oldAnchor: number;
  newAnchor: number;
}

function blocksOf(hunk: Hunk): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  let nextOld = 1;
  let nextNew = 1;
  hunk.lines.forEach((line, i) => {
    if (line.kind === '-' || line.kind === '+') {
      if (!current) {
        current = { removed: [], added: [], oldAnchor: 0, newAnchor: 0 };
        blocks.push(current);
      }
      (line.kind === '-' ? current.removed : current.added).push(i);
    } else if (line.kind === ' ') {
      current = undefined;
    }
    if (line.old !== undefined) nextOld = line.old + 1;
    if (line.new !== undefined) nextNew = line.new + 1;
    if (current && line.kind !== '\\') {
      // Updated as the block grows, so it ends up as the first line after the block on each side.
      current.oldAnchor = nextOld;
      current.newAnchor = nextNew;
    }
  });
  return blocks;
}

function inRanges(line: number | undefined, ranges: LineRange[]): boolean {
  return line !== undefined && ranges.some((r) => line >= r.start && line <= r.end);
}

/** Indexes of the hunk lines picked by `ranges` on `side`. */
function pick(hunk: Hunk, side: Side, ranges: LineRange[]): Set<number> {
  const picked = new Set<number>();
  for (const block of blocksOf(hunk)) {
    const ownLines = side === 'new' ? block.added : block.removed;
    const otherLines = side === 'new' ? block.removed : block.added;
    const number = (i: number) => (side === 'new' ? hunk.lines[i].new : hunk.lines[i].old);
    const anchor = side === 'new' ? block.newAnchor : block.oldAnchor;
    const hit = ownLines.filter((i) => inRanges(number(i), ranges));
    // A block with nothing on this side sits between two lines; picking either of them picks it.
    const touched = hit.length > 0 || (ownLines.length === 0 && (inRanges(anchor, ranges) || inRanges(anchor - 1, ranges)));
    if (!touched) continue;
    const whole = ranges.some((r) => r.whole && (ownLines.length === 0 || ownLines.some((i) => inRanges(number(i), [r]))));
    (whole ? ownLines : hit).forEach((i) => picked.add(i));
    otherLines.forEach((i) => picked.add(i));
  }
  return picked;
}

/** Adds `ranges` on `side` to a selection. */
export function addToSelection(selection: Selection, side: Side, ranges: LineRange[]): Selection {
  return { ...selection, [side]: [...(selection[side] ?? []), ...ranges] };
}

/**
 * A patch that removes the picked changes from the commit's version of the file, or undefined when the ranges
 * pick no changes. Throws for files the commit deleted and for binary files.
 */
export function removalPatch(diff: FileDiff, side: Side, ranges: LineRange[]): string | undefined {
  return selectionPatch(diff, { [side]: ranges });
}

/** removalPatch for lines picked on both sides. */
export function selectionPatch(diff: FileDiff, selection: Selection): string | undefined {
  if (diff.binary) throw new Error('Binary files can only be removed from a commit as a whole.');
  if (diff.deleted) throw new Error('The commit deletes this file. Use "Remove from Commit" on the file to bring it back.');

  const out: string[] = [];
  let delta = 0;
  const picks = diff.hunks.map((hunk) => new Set([...pick(hunk, 'old', selection.old ?? []), ...pick(hunk, 'new', selection.new ?? [])]));
  // Taking every line out of a file the commit added removes the file.
  const removesFile =
    !!diff.newFileMode && diff.hunks.every((hunk, h) => hunk.lines.every((line, i) => line.kind !== '+' || picks[h].has(i)));
  for (const [h, hunk] of diff.hunks.entries()) {
    const picked = picks[h];
    const lines: string[] = [];
    let oldStart: number | undefined;
    let oldCount = 0;
    let newCount = 0;
    let changed = false;
    let lastKept = false;
    for (const [i, line] of hunk.lines.entries()) {
      if (line.kind === '\\') {
        if (lastKept) lines.push(`\\${line.text}`);
        continue;
      }
      lastKept = true;
      if (line.kind === ' ' || (line.kind === '+' && !picked.has(i))) {
        // Lines of the commit that stay.
        lines.push(` ${line.text}`);
        oldStart ??= line.new;
        oldCount++;
        newCount++;
      } else if (line.kind === '+') {
        // Picked added line: take it out.
        lines.push(`-${line.text}`);
        oldStart ??= line.new;
        oldCount++;
        changed = true;
      } else if (picked.has(i)) {
        // Picked removed line: put it back.
        lines.push(`+${line.text}`);
        newCount++;
        changed = true;
      } else {
        lastKept = false;
      }
    }
    if (!changed) continue;
    // Where the hunk starts in the commit's version when it has no lines there: just after the previous one.
    const start = oldStart ?? anchorIn(hunk);
    const newStart = start + delta;
    out.push(`@@ -${oldCount ? start : start - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`, ...lines);
    delta += newCount - oldCount;
  }
  if (!out.length) return undefined;

  const header = [`diff --git a/${diff.path} b/${diff.path}`];
  if (removesFile) header.push(`deleted file mode ${diff.newFileMode}`, `--- a/${diff.path}`, '+++ /dev/null');
  else header.push(`--- a/${diff.path}`, `+++ b/${diff.path}`);
  return `${[...header, ...out].join('\n')}\n`;
}

/** First line number on the commit's side for a hunk without context or added lines. */
function anchorIn(hunk: Hunk): number {
  const blocks = blocksOf(hunk);
  return blocks.length ? blocks[0].newAnchor : 1;
}
