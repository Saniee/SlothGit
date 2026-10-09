// Lane layout for the commit graph ("pretty mode"). Pure logic: commits in, per-row drawing instructions out.
//
// Commits come newest first with children before parents (git log --date-order). Each lane waits for one
// commit; a commit takes the lane waiting for it (or a free one if nothing is, i.e. a branch tip), lanes that
// were also waiting for it merge into it, and its parents take over: the first parent continues in the same
// lane, further parents (merges) get lanes of their own.

export interface GraphLine {
  /** Lane the line starts in. */
  from: number;
  /** Lane the line ends in. */
  to: number;
  /** top: row top → commit dot; bottom: commit dot → row bottom; through: row top → row bottom. */
  part: 'top' | 'bottom' | 'through';
  /** Colour index; the renderer picks from a palette. */
  color: number;
}

export interface GraphRow {
  /** Lane of the commit's dot. */
  lane: number;
  color: number;
  lines: GraphLine[];
  /** Number of lanes this row needs to draw. */
  width: number;
}

interface Lane {
  sha: string;
  color: number;
}

export function layoutGraph(commits: { sha: string; parents: string[] }[]): GraphRow[] {
  const lanes: (Lane | null)[] = [];
  let nextColor = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  return commits.map((commit) => {
    const lines: GraphLine[] = [];
    let lane = lanes.findIndex((l) => l?.sha === commit.sha);
    const tip = lane === -1;
    if (tip) {
      lane = free();
      lanes[lane] = { sha: commit.sha, color: nextColor++ };
    }
    const color = lanes[lane]!.color;

    // Top half: lanes waiting for this commit end at its dot; the others pass through.
    lanes.forEach((l, i) => {
      if (!l) return;
      if (l.sha !== commit.sha) {
        lines.push({ from: i, to: i, part: 'through', color: l.color });
      } else if (!(tip && i === lane)) {
        lines.push({ from: i, to: lane, part: 'top', color: l.color });
        if (i !== lane) lanes[i] = null;
      }
    });

    // Bottom half: the parents.
    const [first, ...others] = commit.parents;
    if (first) {
      const existing = lanes.findIndex((l, i) => i !== lane && l?.sha === first);
      if (existing === -1) {
        lanes[lane] = { sha: first, color };
        lines.push({ from: lane, to: lane, part: 'bottom', color });
      } else {
        // Another lane already waits for the parent (a branch point seen from above): join it.
        lines.push({ from: lane, to: existing, part: 'bottom', color: lanes[existing]!.color });
        lanes[lane] = null;
      }
    } else {
      lanes[lane] = null;
    }
    for (const parent of others) {
      let target = lanes.findIndex((l) => l?.sha === parent);
      if (target === -1) {
        target = free();
        lanes[target] = { sha: parent, color: nextColor++ };
      }
      lines.push({ from: lane, to: target, part: 'bottom', color: lanes[target]!.color });
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane, ...lines.flatMap((l) => [l.from, l.to])) + 1;
    return { lane, color, lines, width };
  });
}

export interface GraphRef {
  name: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
}

/** Splits `git log %D` decorations into typed refs. */
export function parseRefs(decorations: string[], remotes: string[]): GraphRef[] {
  const refs: GraphRef[] = [];
  for (const d of decorations) {
    if (d === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (d.startsWith('HEAD -> ')) refs.push({ name: d.slice(8), kind: 'head' });
    else if (d.startsWith('tag: ')) refs.push({ name: d.slice(5), kind: 'tag' });
    else if (d.endsWith('/HEAD')) continue; // origin/HEAD: noise
    else if (remotes.some((r) => d.startsWith(`${r}/`))) refs.push({ name: d, kind: 'remote' });
    else refs.push({ name: d, kind: 'local' });
  }
  return refs;
}
