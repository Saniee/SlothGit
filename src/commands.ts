import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitOps } from './git/operations';
import { commitUrl, toWebRepo, type WebRepo } from './git/hosting';
import { getCommitMessage, getOperation, getRemotes, type Operation } from './git/queries';
import type { Git } from './git/runner';
import type { RepoManager } from './repoManager';
import type { Runner } from './runner';
import type { CherryPickClipboard } from './views/cherryPickClipboard';
import type { CommitNode, FileNode, Node, StashNode } from './views/nodes';
import type { CommitsProvider } from './views/providers';

export interface CommandDeps {
  repos: RepoManager;
  commits: CommitsProvider;
  commitsView: vscode.TreeView<Node>;
  stashView: vscode.TreeView<Node>;
  clipboard: CherryPickClipboard;
  runner: Runner;
  refreshAll(force: boolean): Promise<void>;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { repos, commits, commitsView, stashView, clipboard, runner } = deps;
  const { run, confirm } = runner;

  // --- target resolution ----------------------------------------------------

  /** Nodes a command acts on: the multi-selection, the clicked node, or (when invoked without arguments) the view selection. */
  function resolve<T extends Node>(kind: T['kind'], view: vscode.TreeView<Node>, arg?: Node, all?: Node[]): T[] {
    const nodes = all?.length ? all : arg ? [arg] : [...view.selection];
    return nodes.filter((n): n is T => n.kind === kind);
  }

  function commitTargets(arg?: Node, all?: Node[]): CommitNode[] {
    const nodes = resolve<CommitNode>('commit', commitsView, arg, all);
    if (!nodes.length) void vscode.window.showInformationMessage('Select a commit first.');
    return nodes;
  }

  /** Commits from the Commits view only (history rewriting is meaningless for reflog entries). */
  function logTargets(arg?: Node, all?: Node[]): CommitNode[] {
    return commitTargets(arg, all).filter((n) => n.source === 'log');
  }

  function single<T>(nodes: T[]): T | undefined {
    if (nodes.length > 1) {
      void vscode.window.showInformationMessage('This action works on a single commit.');
      return undefined;
    }
    return nodes[0];
  }

  function stashTarget(arg?: Node): StashNode | undefined {
    const node = resolve<StashNode>('stash', stashView, arg)[0];
    if (!node) void vscode.window.showInformationMessage('Select a stash first.');
    return node;
  }

  async function confirmRewrite(nodes: CommitNode[]): Promise<boolean> {
    const enabled = vscode.workspace.getConfiguration('codegit').get('confirmRewritingPushedCommits', true);
    if (!enabled || !nodes.some((n) => commits.isPushed(n.sha))) return true;
    return confirm(
      'This rewrites commits that are already pushed to the upstream branch. You will need to force push afterwards.',
      'Rewrite History',
    );
  }

  /**
   * Whether history can be rewritten right now. `fullHistory` marks actions that depend on neighbouring
   * commits (squash into previous, move), which a file filter hides.
   */
  async function canRewrite(fullHistory = false): Promise<boolean> {
    if (commits.bisect) {
      void vscode.window.showWarningMessage('Finish or reset the bisect before rewriting history.');
      return false;
    }
    const git = repos.git();
    const operation = git && (await getOperation(git));
    if (operation) {
      void vscode.window.showWarningMessage(`A ${operation} is in progress. Continue or abort it first.`);
      return false;
    }
    if (fullHistory && commits.filterPath) {
      void vscode.window.showWarningMessage('This action needs the full history. Clear the file filter first.');
      return false;
    }
    return true;
  }

  /** Common shape for commands that rewrite history in the Commits view. */
  function rewrite(
    title: string,
    fn: (ops: GitOps, nodes: CommitNode[]) => Promise<string | void>,
    options: { single?: boolean; fullHistory?: boolean; confirm?: (nodes: CommitNode[]) => string | undefined } = {},
  ) {
    return async (arg?: Node, all?: Node[]) => {
      let nodes = logTargets(arg, all);
      if (options.single) {
        const node = single(nodes);
        nodes = node ? [node] : [];
      }
      if (!nodes.length || !(await canRewrite(options.fullHistory))) return;
      const question = options.confirm?.(nodes);
      if (question && !(await confirm(question, 'Continue'))) return;
      if (!(await confirmRewrite(nodes))) return;
      await run(title, (ops) => fn(ops, nodes));
    };
  }

  const shas = (nodes: CommitNode[]) => nodes.map((n) => n.sha);
  const plural = (nodes: unknown[], word: string) => (nodes.length === 1 ? `1 ${word}` : `${nodes.length} ${word}s`);

  // --- commands ---------------------------------------------------------------

  const commands: Record<string, (...args: any[]) => unknown> = {
    'codegit.refresh': () => deps.refreshAll(true),
    'codegit.switchRepository': () => repos.pickRepository(),

    'codegit.commit.squash': rewrite('Squashing…', (ops, nodes) => ops.squash(shas(nodes), 'squash'), {
      fullHistory: true,
    }),
    'codegit.commit.fixup': rewrite('Fixing up…', (ops, nodes) => ops.squash(shas(nodes), 'fixup'), {
      fullHistory: true,
    }),
    'codegit.commit.drop': rewrite('Dropping…', (ops, nodes) => ops.drop(shas(nodes)), {
      confirm: (nodes) => `Drop ${plural(nodes, 'commit')}? You can get it back with Undo or from the Reflog view.`,
    }),
    'codegit.commit.moveUp': rewrite('Moving commit…', (ops, [node]) => ops.move(node.sha, 'up'), {
      single: true,
      fullHistory: true,
    }),
    'codegit.commit.moveDown': rewrite('Moving commit…', (ops, [node]) => ops.move(node.sha, 'down'), {
      single: true,
      fullHistory: true,
    }),
    'codegit.commit.autosquash': rewrite('Squashing fixup commits…', (ops, [node]) => ops.autosquash(node.sha), {
      single: true,
      fullHistory: true,
    }),
    'codegit.commit.createFixup': async (arg?: Node, all?: Node[]) => {
      const node = single(logTargets(arg, all));
      if (node && (await canRewrite())) {
        await run('Creating fixup commit…', async (ops) => {
          await ops.createFixupCommit(node.sha);
          return `Created "fixup! ${node.subject}". Use "Squash Fixup Commits Above" to fold it in.`;
        });
      }
    },
    'codegit.commit.amendAuthor': async (arg?: Node, all?: Node[]) => {
      const node = single(logTargets(arg, all));
      if (!node || !(await canRewrite())) return;
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Reset Author', description: 'Use your current user.name and user.email', id: 'reset' },
          { label: 'Set Author…', description: 'Name <email>', id: 'set' },
          { label: 'Add Co-Author…', description: 'Adds a Co-authored-by trailer', id: 'coauthor' },
        ],
        { title: `Author of ${node.shortSha}` },
      );
      if (!picked) return;
      let value = '';
      if (picked.id !== 'reset') {
        const input = await vscode.window.showInputBox({
          title: picked.id === 'set' ? `Author for ${node.shortSha}` : `Co-author for ${node.shortSha}`,
          value: picked.id === 'set' ? node.author : undefined,
          placeHolder: 'Name <email@example.com>',
          validateInput: (v) => (/^[^<>]+ <[^<>\s]+>$/.test(v.trim()) ? undefined : 'Use the form: Name <email>'),
        });
        if (!input) return;
        value = input.trim();
      }
      if (!(await confirmRewrite([node]))) return;
      await run('Amending author…', (ops) =>
        picked.id === 'reset'
          ? ops.resetAuthor(node.sha)
          : picked.id === 'set'
            ? ops.setAuthor(node.sha, value)
            : ops.addCoAuthor(node.sha, value),
      );
    },
    'codegit.commit.edit': rewrite(
      'Starting rebase…',
      async (ops, [node]) => {
        await ops.edit(node.sha);
        return `Rebase paused at ${node.shortSha}. Make and stage your changes, then run "Continue" to amend the commit.`;
      },
      { single: true },
    ),
    'codegit.commit.amendStaged': rewrite('Amending commit…', (ops, [node]) => ops.amendStaged(node.sha), { single: true }),

    'codegit.commit.reword': async (arg?: Node, all?: Node[]) => {
      const node = single(logTargets(arg, all));
      const git = repos.git();
      if (!node || !git || !(await canRewrite())) return;
      const message = await getCommitMessage(git, node.sha);
      const [subject, ...body] = message.split('\n');
      const newSubject = await vscode.window.showInputBox({
        title: `Reword ${node.shortSha}`,
        value: subject,
        prompt: body.length ? 'The commit body is kept as is.' : undefined,
        validateInput: (v) => (v.trim() ? undefined : 'The message cannot be empty.'),
      });
      if (newSubject === undefined || newSubject === subject) return;
      if (!(await confirmRewrite([node]))) return;
      await run('Rewording…', (ops) => ops.reword(node.sha, [newSubject, ...body].join('\n')));
    },

    'codegit.commit.rewordInEditor': async (arg?: Node, all?: Node[]) => {
      const node = single(logTargets(arg, all));
      const git = repos.git();
      if (!node || !git || !(await canRewrite())) return;
      const original = await getCommitMessage(git, node.sha);
      const file = path.resolve(git.cwd, (await git.run(['rev-parse', '--git-path', 'CODEGIT_EDITMSG'])).trim());
      const edited = await editInEditor(file, original, `Reword ${node.shortSha}`);
      if (edited === undefined || edited === original) return;
      if (!(await confirmRewrite([node]))) return;
      await run('Rewording…', (ops) => ops.reword(node.sha, edited));
    },

    'codegit.commit.copy': async (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      const git = repos.git();
      if (!node || !git) return;
      const web = await webRepo(git);
      const items: (vscode.QuickPickItem & { value: () => Promise<string> })[] = [
        { label: 'SHA', description: node.sha, value: async () => node.sha },
        { label: 'Short SHA', description: node.shortSha, value: async () => node.shortSha },
        { label: 'Subject', description: node.subject, value: async () => node.subject },
        { label: 'Message', value: () => getCommitMessage(git, node.sha) },
        { label: 'Author', value: async () => (await git.run(['log', '-1', '--format=%an <%ae>', node.sha])).trim() },
        { label: 'Diff', description: 'As a patch', value: () => git.run(['show', '--format=', '--binary', node.sha]) },
        ...(web ? [{ label: 'URL', description: commitUrl(web, node.sha), value: async () => commitUrl(web, node.sha) }] : []),
      ];
      const picked = await vscode.window.showQuickPick(items, { title: `Copy from ${node.shortSha}` });
      if (picked) await vscode.env.clipboard.writeText(await picked.value());
    },
    'codegit.commit.openInBrowser': async (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      const git = repos.git();
      if (!node || !git) return;
      const web = await webRepo(git);
      if (!web) {
        void vscode.window.showWarningMessage('No remote with a recognisable web URL was found.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(commitUrl(web, node.sha)));
    },

    'codegit.file.removeFromCommit': (arg?: Node, all?: Node[]) => removeFiles(false, arg, all),
    'codegit.file.moveToIndex': (arg?: Node, all?: Node[]) => removeFiles(true, arg, all),
    'codegit.file.checkout': async (arg?: Node) => {
      const node = resolve<FileNode>('file', commitsView, arg)[0];
      if (!node?.commit) return;
      const { change } = node.pair;
      if (change.status === 'D') {
        void vscode.window.showInformationMessage(`${change.path} was deleted in ${node.label}; there is nothing to check out.`);
        return;
      }
      const question = `Replace ${change.path} in your working tree with its version from ${node.label}? Uncommitted changes to it are lost.`;
      if (await confirm(question, 'Checkout File')) {
        await run('Checking out file…', (ops) => ops.checkoutFileFrom(node.pair.rightRef, change.path));
      }
    },
    'codegit.file.openAtRevision': async (arg?: Node) => {
      const node = resolve<FileNode>('file', commitsView, arg)[0];
      if (!node) return;
      const { right, left } = diffUris(repos, node);
      await vscode.window.showTextDocument(node.pair.change.status === 'D' ? left : right, { preview: true });
    },

    'codegit.commit.copyForCherryPick': (arg?: Node, all?: Node[]) => {
      const nodes = resolve<CommitNode>('commit', commitsView, arg, all);
      if (nodes.length) clipboard.toggle(nodes);
    },
    'codegit.commit.pasteCherryPick': async () => {
      const items = clipboard.items;
      if (!items.length) {
        void vscode.window.showInformationMessage('No commits copied. Use "Copy for Cherry-Pick" first.');
        return;
      }
      if (!(await confirm(`Cherry-pick ${plural([...items], 'commit')} onto the current HEAD?`, 'Cherry-Pick'))) return;
      await run('Cherry-picking…', async (ops) => {
        await ops.cherryPick(items.map((n) => n.sha));
        clipboard.clear();
      });
    },
    'codegit.commit.clearCherryPick': () => clipboard.clear(),

    'codegit.commit.reset': async (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      if (node) await runner.resetTo(node.sha, node.shortSha);
    },
    'codegit.commit.checkout': async (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      if (node) await run('Checking out…', (ops) => ops.checkout(node.sha));
    },
    'codegit.commit.createBranch': async (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      if (!node) return;
      const name = await runner.askBranchName(`New branch at ${node.shortSha}`);
      if (name) await run('Creating branch…', (ops) => ops.createBranch(name, node.sha, true));
    },
    'codegit.commit.createTag': async (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      if (node) await createTag(runner, node.sha, node.shortSha);
    },
    'codegit.commit.markBase': (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      if (!node) return;
      setBase(commits.baseSha === node.sha ? undefined : node.sha);
    },
    'codegit.commit.clearBase': () => setBase(undefined),
    'codegit.commit.revert': async (arg?: Node, all?: Node[]) => {
      const nodes = logTargets(arg, all);
      if (!nodes.length) return;
      if (!(await confirm(`Revert ${plural(nodes, 'commit')}? This creates new commits that undo them.`, 'Revert'))) return;
      await run('Reverting…', (ops) => ops.revert(shas(nodes)));
    },
    'codegit.commit.copySha': async (arg?: Node, all?: Node[]) => {
      const nodes = commitTargets(arg, all);
      if (nodes.length) await vscode.env.clipboard.writeText(shas(nodes).join('\n'));
    },
    'codegit.commit.copyMessage': async (arg?: Node, all?: Node[]) => {
      const node = single(commitTargets(arg, all));
      const git = repos.git();
      if (node && git) await vscode.env.clipboard.writeText(await getCommitMessage(git, node.sha));
    },
    'codegit.commit.openChanges': async (arg?: Node) => {
      const node = single(commitTargets(arg));
      const git = repos.git();
      const root = repos.repository?.rootUri;
      if (!node || !git || !root) return;
      // Any commit node (log, reflog or under a branch) loads its files the same way.
      const files = (await commits.getChildren(node)) as FileNode[];
      await openMultiDiff(repos, `${node.shortSha}: ${node.subject}`, files);
    },
    'codegit.openFileDiff': async (node: FileNode) => {
      const root = repos.repository?.rootUri;
      if (!root) return;
      const { left, right } = diffUris(repos, node);
      const title = `${path.posix.basename(node.pair.change.path)} (${node.label})`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    },

    'codegit.operation.continue': () => withOperation('Continuing…', (ops, op) => ops.continueOperation(op)),
    'codegit.operation.abort': () => withOperation('Aborting…', (ops, op) => ops.abortOperation(op)),
    'codegit.operation.skip': () => withOperation('Skipping…', (ops, op) => ops.skipOperation(op)),
    'codegit.operation.menu': async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(debug-continue) Continue', command: 'codegit.operation.continue' },
          { label: '$(debug-step-over) Skip Current Commit', command: 'codegit.operation.skip' },
          { label: '$(debug-stop) Abort', command: 'codegit.operation.abort' },
          { label: '$(source-control) Open Source Control', command: 'workbench.view.scm' },
        ],
        { placeHolder: 'Operation in progress' },
      );
      if (picked) await vscode.commands.executeCommand(picked.command);
    },

    'codegit.stash.push': () => stashPush('all'),
    'codegit.stash.pushStaged': () => stashPush('staged'),
    'codegit.stash.pushKeepIndex': () => stashPush('keepIndex'),
    'codegit.stash.apply': async (arg?: Node) => {
      const node = stashTarget(arg);
      if (node) await run('Applying stash…', (ops) => ops.stashApply(node.stash.ref, false));
    },
    'codegit.stash.pop': async (arg?: Node) => {
      const node = stashTarget(arg);
      if (node) await run('Popping stash…', (ops) => ops.stashApply(node.stash.ref, true));
    },
    'codegit.stash.drop': async (arg?: Node) => {
      const node = stashTarget(arg);
      if (!node || !(await confirm(`Drop ${node.stash.ref}: "${node.stash.message}"?`, 'Drop'))) return;
      await run('Dropping stash…', (ops) => ops.stashDrop(node.stash.ref));
    },
    'codegit.stash.rename': async (arg?: Node) => {
      const node = stashTarget(arg);
      if (!node) return;
      const message = await vscode.window.showInputBox({ title: `Rename ${node.stash.ref}`, value: node.stash.message });
      if (message === undefined || message === node.stash.message) return;
      await run('Renaming stash…', (ops) => ops.stashRename(node.stash.ref, node.stash.sha, message));
    },
    'codegit.stash.branch': async (arg?: Node) => {
      const node = stashTarget(arg);
      if (!node) return;
      const name = await runner.askBranchName(`New branch from ${node.stash.ref}`);
      if (name) await run('Creating branch from stash…', (ops) => ops.stashBranch(name, node.stash.ref));
    },
  };

  async function stashPush(mode: 'all' | 'staged' | 'keepIndex'): Promise<void> {
    const message = await vscode.window.showInputBox({ title: 'Stash message', placeHolder: 'Optional' });
    if (message === undefined) return;
    await run('Stashing…', (ops) => ops.stashPush(mode, message));
  }

  async function withOperation(title: string, fn: (ops: GitOps, op: Operation) => Promise<void>): Promise<void> {
    const git = repos.git();
    const operation = git && (await getOperation(git));
    if (!operation) {
      void vscode.window.showInformationMessage('No rebase, merge, cherry-pick or revert is in progress.');
      return;
    }
    await run(title, (ops) => fn(ops, operation));
  }

  /** Remove the selected files' changes from their commit, discarding them or moving them to the index. */
  async function removeFiles(keep: boolean, arg?: Node, all?: Node[]): Promise<void> {
    const files = resolve<FileNode>('file', commitsView, arg, all).filter((f) => f.commit?.source === 'log');
    const commit = files[0]?.commit;
    if (!commit) return;
    if (files.some((f) => f.commit?.sha !== commit.sha)) {
      void vscode.window.showInformationMessage('Select files from a single commit.');
      return;
    }
    if (!(await canRewrite())) return;
    const names = files.length === 1 ? files[0].pair.change.path : `${files.length} files`;
    const question = keep
      ? `Take the changes to ${names} out of ${commit.shortSha} and stage them in your working tree?`
      : `Discard the changes to ${names} from ${commit.shortSha}? Later commits touching them may conflict.`;
    if (!(await confirm(question, keep ? 'Move to Index' : 'Remove'))) return;
    if (!(await confirmRewrite([commit]))) return;
    await run(keep ? 'Moving changes out of commit…' : 'Removing changes from commit…', (ops) =>
      ops.removeFilesFromCommit(
        commit.sha,
        files.map((f) => f.pair.change),
        keep,
      ),
    );
  }

  function setBase(sha: string | undefined): void {
    commits.baseSha = sha;
    void vscode.commands.executeCommand('setContext', 'codegit.hasRebaseBase', !!sha);
    commits.redraw();
    if (sha) {
      void vscode.window.showInformationMessage(
        'Base commit marked. "Rebase Current Branch onto This" in the Branches view will now move only the commits above it.',
      );
    }
  }

  return Object.entries(commands).map(([id, handler]) => vscode.commands.registerCommand(id, handler));
}

export function diffUris(repos: RepoManager, node: FileNode) {
  const root = repos.repository!.rootUri;
  const { change, leftRef, rightRef } = node.pair;
  const uri = vscode.Uri.joinPath(root, change.path);
  const leftUri = vscode.Uri.joinPath(root, change.oldPath ?? change.path);
  return {
    uri,
    left: repos.api.toGitUri(leftUri, leftRef),
    right: repos.api.toGitUri(uri, rightRef),
  };
}

export async function openMultiDiff(repos: RepoManager, title: string, files: FileNode[]): Promise<void> {
  if (!files.length) {
    void vscode.window.showInformationMessage('No changes.');
    return;
  }
  const resources = files.map((f) => {
    const { left, right, uri } = diffUris(repos, f);
    return [uri, left, right];
  });
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

export async function createTag(runner: Runner, rev: string, label: string): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: `New tag at ${label}`,
    placeHolder: 'Tag name',
    validateInput: (v) => (/^\S+$/.test(v) ? undefined : 'Enter a tag name without spaces.'),
  });
  if (!name) return;
  const message = await vscode.window.showInputBox({
    title: `Message for tag ${name}`,
    placeHolder: 'Optional: leave empty for a lightweight tag',
  });
  if (message === undefined) return;
  await runner.run('Creating tag…', (ops) => ops.createTag(name, rev, message));
}

/** The web repository for the preferred remote (the given one, else origin, else the first). */
export async function webRepo(git: Git, preferredRemote?: string): Promise<WebRepo | undefined> {
  const remotes = await getRemotes(git);
  const remote =
    remotes.find((r) => r.name === preferredRemote) ?? remotes.find((r) => r.name === 'origin') ?? remotes[0];
  return remote && toWebRepo(remote.url);
}

/**
 * Opens `initial` in an editor tab and resolves with the saved text once the tab is closed, or undefined when
 * the text is unchanged or empty. Lines starting with '#' are dropped, like git's own message editing.
 */
export async function editInEditor(file: string, initial: string, title: string): Promise<string | undefined> {
  const help = [
    '',
    `# ${title}: save and close this tab to apply.`,
    '# Lines starting with # are ignored. Close without changes, or leave it empty, to cancel.',
  ];
  fs.writeFileSync(file, [initial, ...help].join('\n') + '\n');
  const uri = vscode.Uri.file(file);
  const doc = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), 'git-commit');
  await vscode.window.showTextDocument(doc, { preview: false });

  await new Promise<void>((resolve) => {
    const isOurs = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === uri.fsPath;
    const listener = vscode.window.tabGroups.onDidChangeTabs((e) => {
      const stillOpen = vscode.window.tabGroups.all.some((g) => g.tabs.some(isOurs));
      if (e.closed.some(isOurs) && !stillOpen) {
        listener.dispose();
        resolve();
      }
    });
  });

  const text = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
  fs.rmSync(file, { force: true });
  return text ? text : undefined;
}
