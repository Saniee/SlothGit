// Messages between the extension and its webview pages (src/webview/<page>/main.ts). Both sides import these
// types, so a change on one side that the other doesn't handle is a type error, not a silent no-op.
import type { GraphRef, GraphRow } from '../git/graph';
import type { LocalBranch, Person } from '../git/queries';

// --- Commit Graph -------------------------------------------------------------------------------

/** One row as the graph page receives it. */
export interface GraphCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  email: string;
  coAuthors: Person[];
  relDate: string;
  date: string;
  parents: string[];
  refs: GraphRef[];
  onHead: boolean;
  /** null when the branch has no upstream. */
  pushed: boolean | null;
  /** On a main branch (slothgit.mainBranches). */
  merged: boolean;
  head: boolean;
  graph: GraphRow;
}

export interface GraphState {
  search: string;
  all: boolean;
  /** Set when the log was cut off at slothgit.commitLimit. */
  limit?: number;
}

export interface GraphFile {
  status: string;
  path: string;
  oldPath?: string;
}

export type ToGraph =
  | { type: 'rows'; rows: GraphCommit[]; state: GraphState }
  | { type: 'details'; sha: string; message: string; files: GraphFile[] };

export type FromGraph =
  | { type: 'ready' | 'refresh' }
  | { type: 'search'; query: string }
  | { type: 'allBranches'; value: boolean }
  | { type: 'select'; sha: string }
  | { type: 'open'; sha: string }
  | { type: 'openFile'; sha: string; path: string }
  /** After each render, so tests can tell the page really drew the rows. */
  | { type: 'rendered'; rows: number };

// --- Sync view ----------------------------------------------------------------------------------

/** What the Sync view shows: the checked-out branch and how it stands against its upstream. */
export interface SyncState {
  /** The checked-out branch, or undefined when HEAD is detached (or there is no repository). */
  branch?: LocalBranch;
  /** Short SHA of a detached HEAD. */
  detached?: string;
  hasRemotes: boolean;
}

/** The commands the Sync view's buttons run directly. */
export type SyncButton = 'slothgit.sync.pull' | 'slothgit.sync.push' | 'slothgit.sync.fetch';
export type SyncMenu = 'pull' | 'push';

export type ToSync = { type: 'state'; state: SyncState };

export type FromSync =
  | { type: 'ready' }
  | { type: 'run'; command: SyncButton }
  /** The ⌄ next to Pull or Push: the extension shows that menu as a quick pick. */
  | { type: 'menu'; menu: SyncMenu }
  /** After each render: the visible text, so tests can tell the page really drew the state. */
  | { type: 'rendered'; text: string };
