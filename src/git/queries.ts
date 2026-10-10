import * as fs from 'node:fs';
import * as path from 'node:path';
import { Git } from './runner';
import { parseTodo, type TodoEntry } from './todo';

const US = '\x1f';
const RS = '\x1e';

/** Hash of git's empty tree; used as the "parent" of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Person {
  name: string;
  email: string;
}

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  /** From the message's Co-authored-by trailers. */
  coAuthors: Person[];
  relDate: string;
  /** Author date, ISO 8601. */
  date: string;
  /** Committer date, Unix seconds; the order git log uses. */
  timestamp: number;
  parents: string[];
  refs: string[];
  subject: string;
}

export interface LogOptions {
  /** Every branch, remote branch and tag instead of only `ref`. */
  all?: boolean;
  /** Case-insensitive text matched against the message and the author, or a SHA prefix. */
  search?: string;
}

export interface ReflogEntry {
  sha: string;
  shortSha: string;
  selector: string;
  relDate: string;
  parents: string[];
  subject: string;
}

export interface Stash {
  ref: string;
  sha: string;
  relDate: string;
  message: string;
}

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export interface RefPair {
  change: FileChange;
  leftRef: string;
  rightRef: string;
}

export type Operation = 'rebase' | 'cherry-pick' | 'revert' | 'merge';

function records(output: string): string[][] {
  return output
    .split(RS)
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter((r) => r.length > 0)
    .map((r) => r.split(US));
}

function splitList(value: string | undefined, separator: string): string[] {
  return value ? value.split(separator).filter(Boolean) : [];
}

/** Separates co-authors within their field. */
const GS = '\x1d';
const CO_AUTHORS = '%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1d)';
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%ar', '%aI', '%ct', '%P', '%D', CO_AUTHORS, '%s'].join(US) + RS;

/** "Name <email>" (or just a name) from a trailer. */
export function parsePerson(value: string): Person {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(value.trim());
  return m ? { name: m[1] || m[2], email: m[2] } : { name: value.trim(), email: '' };
}

async function runLog(git: Git, args: string[]): Promise<Commit[]> {
  // 128: unborn branch (no commits yet), or a SHA that doesn't exist
  const result = await git.exec(['log', `--format=${LOG_FORMAT}`, ...args], { allowedExitCodes: [128] });
  if (result.exitCode !== 0) return [];
  return records(result.stdout).map((f) => ({
    sha: f[0],
    shortSha: f[1],
    author: f[2],
    authorEmail: f[3],
    relDate: f[4],
    date: f[5],
    timestamp: Number(f[6]),
    parents: splitList(f[7], ' '),
    refs: splitList(f[8], ', '),
    coAuthors: splitList(f[9], GS).map(parsePerson),
    subject: f[10] ?? '',
  }));
}

/**
 * Commits reachable from `ref` (or every branch and tag with `all`), newest first, children always before
 * their parents. With `search`, only commits whose message or author contains the text, or whose SHA starts
 * with it.
 */
export async function getLog(
  git: Git,
  limit: number,
  ref = 'HEAD',
  paths: string[] = [],
  options: LogOptions = {},
): Promise<Commit[]> {
  // HEAD is included in "all" so a detached HEAD still shows up.
  const revs = options.all ? ['--branches', '--remotes', '--tags', ref] : [ref];
  const base = [`-n${limit}`, '--date-order', ...revs];
  const query = options.search?.trim();
  if (!query) return runLog(git, [...base, '--', ...paths]);

  const text = ['--regexp-ignore-case', '--fixed-strings'];
  const [byMessage, byAuthor, bySha] = await Promise.all([
    runLog(git, [...base, ...text, `--grep=${query}`, '--', ...paths]),
    runLog(git, [...base, ...text, `--author=${query}`, '--', ...paths]),
    /^[0-9a-f]{4,40}$/i.test(query) ? runLog(git, ['-n1', `${query}^{commit}`, '--']) : Promise.resolve([]),
  ]);
  const found = new Map<string, Commit>();
  for (const c of [...bySha, ...byMessage, ...byAuthor]) found.set(c.sha, c);
  return [...found.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/** Of `shas`, the ones not reachable from HEAD (for "all branches", where other branches' commits are listed too). */
export async function notOnHead(git: Git, shas: string[]): Promise<Set<string>> {
  if (!shas.length) return new Set();
  const result = await git.exec(['rev-list', '^HEAD', '--stdin'], { input: shas.join('\n') + '\n', allowedExitCodes: [128] });
  return new Set(result.exitCode === 0 ? splitList(result.stdout, '\n').map((s) => s.trim()) : shas);
}

/** Commits on HEAD that are not on its upstream, or null when there is no upstream. */
export async function getUnpushed(git: Git): Promise<Set<string> | null> {
  const result = await git.exec(['rev-list', '@{upstream}..HEAD'], { allowedExitCodes: [128] });
  if (result.exitCode !== 0) return null;
  return new Set(splitList(result.stdout, '\n').map((s) => s.trim()));
}

export async function getReflog(git: Git, limit: number): Promise<ReflogEntry[]> {
  const format = ['%H', '%h', '%gd', '%cr', '%P', '%gs'].join(US) + RS;
  const result = await git.exec(['reflog', 'show', `-n${limit}`, `--format=${format}`, 'HEAD', '--'], {
    allowedExitCodes: [128],
  });
  if (result.exitCode !== 0) return [];
  return records(result.stdout).map((f) => ({
    sha: f[0],
    shortSha: f[1],
    selector: f[2],
    relDate: f[3],
    parents: splitList(f[4], ' '),
    subject: f[5] ?? '',
  }));
}

export async function getStashes(git: Git): Promise<Stash[]> {
  const format = ['%gd', '%H', '%cr', '%gs'].join(US) + RS;
  const output = await git.run(['stash', 'list', `--format=${format}`]);
  return records(output).map((f) => ({ ref: f[0], sha: f[1], relDate: f[2], message: f[3] ?? '' }));
}

export function parseNameStatus(output: string): FileChange[] {
  const tokens = output.split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (!status) break;
    if (status[0] === 'R' || status[0] === 'C') {
      changes.push({ status: status[0], oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      changes.push({ status: status[0], path: tokens[i + 1] });
      i += 2;
    }
  }
  return changes;
}

export async function getCommitFiles(git: Git, sha: string, parent: string | undefined): Promise<RefPair[]> {
  const output = parent
    ? await git.run(['diff', '--name-status', '-z', '-M', parent, sha, '--'])
    : await git.run(['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', '-z', '-M', sha, '--']);
  const leftRef = parent ?? EMPTY_TREE;
  return parseNameStatus(output).map((change) => ({ change, leftRef, rightRef: sha }));
}

export async function getStashFiles(git: Git, stash: Stash): Promise<RefPair[]> {
  const pairs: RefPair[] = [];
  const untracked = new Set<string>();

  const hasUntracked = await git.exec(['rev-parse', '-q', '--verify', `${stash.sha}^3`], { allowedExitCodes: [1] });
  if (hasUntracked.exitCode === 0) {
    const listing = await git.run(['ls-tree', '-r', '--name-only', '-z', `${stash.sha}^3`]);
    for (const file of splitList(listing, '\0')) {
      untracked.add(file);
      pairs.push({ change: { status: 'U', path: file }, leftRef: EMPTY_TREE, rightRef: `${stash.sha}^3` });
    }
  }

  const tracked = parseNameStatus(await git.run(['stash', 'show', '--name-status', '-z', '-M', stash.sha]));
  for (const change of tracked) {
    // stash.showIncludeUntracked may list untracked files here too
    if (untracked.has(change.path)) continue;
    pairs.push({ change, leftRef: `${stash.sha}^1`, rightRef: stash.sha });
  }
  return pairs.sort((a, b) => a.change.path.localeCompare(b.change.path));
}

export async function getOperation(git: Git): Promise<Operation | undefined> {
  const markers: [string, Operation][] = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['MERGE_HEAD', 'merge'],
  ];
  for (const [marker, operation] of markers) {
    if (fs.existsSync(await git.gitDirPath(marker))) return operation;
  }
  return undefined;
}

export async function hasStagedChanges(git: Git): Promise<boolean> {
  const result = await git.exec(['diff', '--cached', '--quiet'], { allowedExitCodes: [1] });
  return result.exitCode === 1;
}

export async function getCommitMessage(git: Git, sha: string): Promise<string> {
  return (await git.run(['log', '-1', '--format=%B', sha])).replace(/\s+$/, '');
}

export async function headSha(git: Git): Promise<string> {
  return (await git.run(['rev-parse', 'HEAD'])).trim();
}

// --- branches, remotes, tags ---------------------------------------------------

export interface Upstream {
  /** Short name, e.g. "origin/feature/x". */
  name: string;
  remote: string;
  /** Full ref on the remote, e.g. "refs/heads/feature/x". */
  remoteRef: string;
}

export interface LocalBranch {
  name: string;
  sha: string;
  current: boolean;
  upstream?: Upstream;
  ahead: number;
  behind: number;
  /** The upstream branch was deleted on the remote. */
  gone: boolean;
  /** Set when the branch is checked out in another worktree. */
  worktreePath?: string;
  relDate: string;
  subject: string;
}

export interface RemoteBranch {
  /** Short name including the remote, e.g. "origin/main". */
  name: string;
  remote: string;
  /** Branch name on the remote, e.g. "main". */
  branch: string;
  sha: string;
  relDate: string;
  subject: string;
}

export interface Remote {
  name: string;
  url: string;
}

export interface Tag {
  name: string;
  /** The commit the tag points at (peeled for annotated tags). */
  sha: string;
  annotated: boolean;
  relDate: string;
  subject: string;
}

export function parseTrack(track: string): Pick<LocalBranch, 'ahead' | 'behind' | 'gone'> {
  return {
    ahead: parseInt(/ahead (\d+)/.exec(track)?.[1] ?? '0', 10),
    behind: parseInt(/behind (\d+)/.exec(track)?.[1] ?? '0', 10),
    gone: track.includes('gone'),
  };
}

export type BranchSort = 'recency' | 'date' | 'name';

export async function getLocalBranches(git: Git, sort: BranchSort = 'date'): Promise<LocalBranch[]> {
  const fields = [
    '%(refname:short)',
    '%(objectname)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(upstream:remotename)',
    '%(upstream:remoteref)',
    '%(upstream:track,nobracket)',
    '%(committerdate:relative)',
    '%(contents:subject)',
    '%(worktreepath)',
  ];
  const order = sort === 'name' ? 'refname' : '-committerdate';
  const [output, recent] = await Promise.all([
    git.run(['for-each-ref', `--sort=${order}`, `--format=${fields.join(US)}${RS}`, 'refs/heads']),
    sort === 'recency' ? getRecentCheckouts(git) : Promise.resolve([]),
  ]);
  const root = path.resolve(git.cwd);
  const branches = records(output).map((f) => ({
    name: f[0],
    sha: f[1],
    current: f[2] === '*',
    upstream: f[3] && f[4] && f[5] ? { name: f[3], remote: f[4], remoteRef: f[5] } : undefined,
    ...parseTrack(f[6] ?? ''),
    relDate: f[7],
    subject: f[8] ?? '',
    worktreePath: f[9] && f[2] !== '*' && path.resolve(f[9]) !== root ? f[9] : undefined,
  }));
  if (sort === 'recency') {
    // lazygit's default: most recently checked out first, from the reflog.
    const rank = (name: string) => {
      const i = recent.indexOf(name);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    branches.sort((a, b) => rank(a.name) - rank(b.name)); // stable: the rest keep commit-date order
  }
  // Current branch first, like lazygit.
  return branches.sort((a, b) => Number(b.current) - Number(a.current));
}

export async function getRemotes(git: Git): Promise<Remote[]> {
  const output = await git.run(['remote', '-v']);
  const remotes = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^(\S+)\t(.+) \(fetch\)$/.exec(line);
    if (m) remotes.set(m[1], m[2]);
  }
  return [...remotes].map(([name, url]) => ({ name, url }));
}

/** `remotes` may still be loading; the refs are read meanwhile. */
export async function getRemoteBranches(git: Git, remotes: Remote[] | Promise<Remote[]>): Promise<RemoteBranch[]> {
  const fields = ['%(refname)', '%(refname:short)', '%(objectname)', '%(symref)', '%(committerdate:relative)', '%(contents:subject)'];
  const output = await git.run(['for-each-ref', '--sort=refname', `--format=${fields.join(US)}${RS}`, 'refs/remotes']);
  // Longest remote name first, in case one remote name is a prefix of another.
  const names = (await remotes).map((r) => r.name).sort((a, b) => b.length - a.length);
  const branches: RemoteBranch[] = [];
  for (const f of records(output)) {
    if (f[3]) continue; // origin/HEAD
    const remote = names.find((n) => f[0].startsWith(`refs/remotes/${n}/`));
    if (!remote) continue;
    branches.push({
      name: f[1],
      remote,
      branch: f[0].slice(`refs/remotes/${remote}/`.length),
      sha: f[2],
      relDate: f[4],
      subject: f[5] ?? '',
    });
  }
  return branches;
}

export async function getTags(git: Git): Promise<Tag[]> {
  const fields = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(creatordate:relative)', '%(contents:subject)'];
  const output = await git.run(['for-each-ref', '--sort=-creatordate', `--format=${fields.join(US)}${RS}`, 'refs/tags']);
  return records(output).map((f) => ({
    name: f[0],
    sha: f[2] || f[1],
    annotated: !!f[2],
    relDate: f[3],
    subject: f[4] ?? '',
  }));
}

/** Branch names in the order they were last checked out, most recent first. */
async function getRecentCheckouts(git: Git): Promise<string[]> {
  const result = await git.exec(['reflog', 'show', '-n1000', '--format=%gs', 'HEAD', '--'], { allowedExitCodes: [128] });
  const names: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(line);
    if (!m) continue;
    for (const name of [m[2], m[1]]) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Default branch of a remote, from refs/remotes/<remote>/HEAD, e.g. "main". */
export async function getRemoteDefaultBranch(git: Git, remote: string): Promise<string | undefined> {
  const result = await git.exec(['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`], {
    allowedExitCodes: [1, 128],
  });
  const ref = result.stdout.trim();
  return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : undefined;
}

export async function isDirty(git: Git): Promise<boolean> {
  return (await git.run(['status', '--porcelain'])).trim().length > 0;
}

// --- worktrees -------------------------------------------------------------------------

export interface Worktree {
  path: string;
  sha?: string;
  /** Short branch name, unless detached. */
  branch?: string;
  main: boolean;
  current: boolean;
  locked: boolean;
  prunable: boolean;
}

export async function getWorktrees(git: Git): Promise<Worktree[]> {
  const output = await git.run(['worktree', 'list', '--porcelain']);
  const root = path.resolve(git.cwd);
  return output
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim())
    .map((block, index) => {
      const lines = block.split(/\r?\n/);
      const value = (key: string) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
      const wtPath = value('worktree') ?? '';
      return {
        path: wtPath,
        sha: value('HEAD'),
        branch: value('branch')?.replace(/^refs\/heads\//, ''),
        main: index === 0,
        current: path.resolve(wtPath) === root,
        locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
        prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
        bare: lines.includes('bare'),
      };
    })
    .filter((w) => !w.bare)
    .map(({ bare: _bare, ...w }) => w);
}

// --- bisect ------------------------------------------------------------------------------

export interface BisectState {
  /** What was checked out when the bisect started (branch name or SHA). */
  start: string;
  bad?: string;
  good: string[];
  skipped: string[];
  terms: { bad: string; good: string };
}

export async function getBisectState(git: Git): Promise<BisectState | undefined> {
  const startFile = await git.gitDirPath('BISECT_START');
  if (!fs.existsSync(startFile)) return undefined;
  const termsFile = await git.gitDirPath('BISECT_TERMS');
  const [badTerm = 'bad', goodTerm = 'good'] = fs.existsSync(termsFile)
    ? fs.readFileSync(termsFile, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const state: BisectState = {
    start: fs.readFileSync(startFile, 'utf8').trim(),
    good: [],
    skipped: [],
    terms: { bad: badTerm, good: goodTerm },
  };
  const refs = await git.run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/bisect']);
  for (const line of refs.split(/\r?\n/)) {
    const [ref, sha] = line.split(' ');
    if (!ref) continue;
    const name = ref.slice('refs/bisect/'.length);
    if (name === badTerm) state.bad = sha;
    else if (name.startsWith(`${goodTerm}-`)) state.good.push(sha);
    else if (name.startsWith('skip-')) state.skipped.push(sha);
  }
  return state;
}

// --- rebase todo -----------------------------------------------------------------------

export async function rebaseTodoPath(git: Git): Promise<string> {
  return git.gitDirPath('rebase-merge/git-rebase-todo');
}

/** Remaining steps of a paused interactive rebase, next one first. */
export async function getRebaseTodo(git: Git): Promise<TodoEntry[]> {
  const file = await rebaseTodoPath(git);
  return fs.existsSync(file) ? parseTodo(fs.readFileSync(file, 'utf8')) : [];
}
