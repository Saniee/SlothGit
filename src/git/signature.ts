import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Git } from './runner';

/** In the worktree's git directory: HEAD and its reflog, and the markers of operations in progress. */
const WORKTREE_FILES = ['HEAD', 'logs/HEAD', 'rebase-merge', 'rebase-merge/git-rebase-todo', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
/** In the shared git directory: packed refs, upstreams and remotes, the stash's reflog, other worktrees. */
const SHARED_FILES = ['packed-refs', 'config', 'logs/refs/stash', 'worktrees'];

function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

/** Every loose ref and every folder of them (a deleted ref only changes its folder). */
function refStamps(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  out.push(`${dir} ${stamp(dir)}`);
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) refStamps(p, out);
    else out.push(`${p} ${stamp(p)}`);
  }
}

/**
 * A fingerprint of what SlothGit's views show (branches, tags, remotes, stashes, HEAD and the reflog, worktrees,
 * operations in progress), from file timestamps in the git directory, so checking it doesn't run git. Changes to
 * the working tree or index don't change it.
 */
export async function repoSignature(git: Git): Promise<string> {
  const { gitDir, commonDir } = await git.dirs();
  const out = [...WORKTREE_FILES.map((f) => stamp(path.join(gitDir, f))), ...SHARED_FILES.map((f) => stamp(path.join(commonDir, f)))];
  const worktrees = path.join(commonDir, 'worktrees');
  if (fs.existsSync(worktrees)) {
    for (const name of fs.readdirSync(worktrees)) out.push(`${name} ${stamp(path.join(worktrees, name, 'HEAD'))}`);
  }
  refStamps(path.join(commonDir, 'refs'), out);
  return out.join('\n');
}
