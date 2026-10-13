// Predicts which steps of a planned rebase will stop with conflicts, before anything runs. Each step is replayed
// with `git merge-tree` on trees only, so the working tree, index and refs are untouched; the only side effect is
// a few unreferenced tree objects, which git's garbage collection removes.
import { EMPTY_TREE } from './queries';
import type { Git } from './runner';
import type { PlannedStep } from './todo';

interface Replayed {
  /** The tree after the step. */
  tree: string;
  /** Files the step conflicts in; empty when it applies cleanly. */
  files: string[];
}

export class ConflictCheck {
  /** Results by start tree and the SHAs applied so far, so a change late in the list only replays from there. */
  private readonly replayed = new Map<string, Replayed>();

  /**
   * @param parents Each commit's parent (undefined for a root commit): a step applies the changes from its parent.
   * @param original The commits as they are now, oldest first, and the tree they start from. Steps that keep that
   * order from the start need no replay: the result is the commit's own tree.
   */
  constructor(
    private readonly git: Git,
    private readonly parents: Map<string, string | undefined>,
    private readonly original: { start: string; shas: string[] },
  ) {}

  /**
   * Conflicted files by step SHA, for the steps expected to stop; `start` is the tree the steps are replayed onto.
   * After a conflict, the replay carries on as if it was resolved in favour of the commit being applied.
   * Returns undefined when `cancelled()` turns true (the plan changed meanwhile).
   */
  async check(start: string, steps: PlannedStep[], cancelled: () => boolean = () => false): Promise<Map<string, string[]> | undefined> {
    const conflicts = new Map<string, string[]>();
    let tree = start;
    let key = start;
    let unchanged = start === this.original.start;
    let applied = 0;
    for (const step of steps) {
      if (step.action === 'drop') continue;
      key += ` ${step.sha}`;
      if (unchanged && this.original.shas[applied] === step.sha) {
        tree = `${step.sha}^{tree}`;
        applied++;
        continue;
      }
      unchanged = false;
      let result = this.replayed.get(key);
      if (!result) {
        if (cancelled()) return undefined;
        result = await this.replay(tree, step.sha);
        this.replayed.set(key, result);
      }
      if (result.files.length) conflicts.set(step.sha, result.files);
      tree = result.tree;
    }
    return conflicts;
  }

  private async replay(tree: string, sha: string): Promise<Replayed> {
    const parent = this.parents.get(sha);
    const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${parent ? `${parent}^{tree}` : EMPTY_TREE}`];
    const merged = await this.git.exec([...args, tree, `${sha}^{tree}`], { allowedExitCodes: [1] });
    // -z output: the tree, then each conflicted file, NUL-separated.
    const [result, ...files] = merged.stdout.split('\0').filter(Boolean);
    if (merged.exitCode === 0) return { tree: result, files: [] };
    const resolved = await this.git.exec([...args, '-X', 'theirs', tree, `${sha}^{tree}`], { allowedExitCodes: [1] });
    return { tree: resolved.stdout.split('\0')[0], files: [...new Set(files)] };
  }
}
