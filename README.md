# SlothGit

Lazygit-inspired power tools that fill the gaps in VS Code's built-in Git support. SlothGit adds four views to the Source Control sidebar (Branches, Commits, Reflog and Stashes, in lazygit's order) and builds on the built-in Git extension (same repositories, same diff editors) rather than replacing it. File staging stays with VS Code's own Changes view.

## Getting started

Open **Get Started with SlothGit** on VS Code's Welcome page, or **Learn Git Concepts…** in any SlothGit view's **…** menu. It explains what each view shows and, in plain language, what squash, fixup, rebase, cherry-pick, stashes, worktrees and bisect are for.

**Right-click** anything in the views to see what you can do with it. New to Git? The eye button on the Source Control **Changes** title bar turns on **Simple Mode**, which hides the advanced actions until you press it again.

## Features

- **Undo / redo** (↶ / ↷ on the Commits view) for commits, amends, resets, rebases, merges, cherry-picks and checkouts, like lazygit's `z` / `Z`. It works from the reflog, so it covers actions run outside SlothGit too.
- **Branches:** local branches (current first, then most recently used) with ahead/behind counts, remotes, tags and worktrees in one tree. Checkout, merge, rebase (whole branch, from a marked base, or interactive), fast-forward without checking out, push / force push with lease, upstreams, pull requests, delete merged branches, and moving commits made on the wrong branch to a new one.
- **Commits:** rewrite history from the commit list: squash, fixup, drop, reword, edit, move up / down, amend staged changes into an older commit, fixup commits and autosquash, amend author and co-authors, cherry-pick, revert, reset. Works across merge commits (`--rebase-merges`) and can move stacked branches along (`slothgit.updateStackedBranches`).
- **Rebase editor:** **Interactive Rebase from Here…** on a commit, or **Interactive Rebase** when rebasing onto a branch, lists the commits in an editor tab. Drag them to reorder, pick, reword, edit, squash, fixup or drop each, and see which ones are likely to conflict before you start. Start Rebase runs the whole plan at once.
- **Conflicts panel:** when a rebase, merge, cherry-pick or revert stops on conflicts, **Resolve Conflicts** lists every conflicted file in one tab, with current and incoming side by side, next to the lines as they were before either change: keep either or both per conflict or per file, open the merge editor, then Continue, Skip or Abort.
- **Patches:** remove or move a file's changes, or selected lines in a commit's diff, out of a commit, to the index or a new commit. Collect several into a custom patch (status bar) and move it into any other commit.
- **Paused rebases:** the remaining steps are listed at the top of the Commits view. Right-click to change them (pick, reword, squash, fixup, edit, drop), reorder with ↑ / ↓, then Continue, Skip or Abort from the title bar or status bar.
- **Commit colours** as in lazygit: green when on the main branch (`slothgit.mainBranches`), yellow when pushed, red when not. Rewriting pushed commits asks first, and afterwards offers the force push that replaces the old commits on the remote (pulling would merge them back in).
- **Commit Graph:** history as a graph in an editor tab, with branch lanes, labels, search, details and the same right-click actions.
- **Search, filter by file, all branches, bisect and compare** in the Commits view.
- **Stashes:** apply, pop, drop, rename, branch from a stash; stash untracked or only staged changes.
- **Reflog:** recover dropped commits or undo resets from any entry.
- **Sync view:** the current branch, its upstream and ↑↓ counts, with Pull and Push buttons. Like the Commit button, each has a ⌄ (also on right-click) with Pull (Rebase), Fetch and Fetch All Remotes; Force Push, Push to Another Branch and Set Upstream. Drag it above **Changes** to keep it next to the commit box.

The Commits view covers what VS Code's built-in **Graph** view does, so SlothGit hides the Graph once. Tick **Graph** in the Source Control **…** menu to bring it back.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `slothgit.simpleMode` | `false` | Hide advanced actions from the menus |
| `slothgit.branchSort` | `recency` | Order of local branches: `recency`, `date` or `name` |
| `slothgit.mainBranches` | `main`, `master` | Branches whose commits are shown green |
| `slothgit.confirmRewritingPushedCommits` | `true` | Ask before rewriting pushed commits, and offer a force push after |
| `slothgit.updateStackedBranches` | `gitConfig` | Move stacked branches along when rewriting (`always`, `never`, or git's `rebase.updateRefs`) |
| `slothgit.commitLimit` / `slothgit.reflogLimit` | `300` / `200` | How many entries the views load |

SlothGit was called CodeGit before 1.0.0. `codegit.*` settings are copied over on first start.

## How it works

SlothGit calls the git CLI that the built-in Git extension uses. Every rewrite is a `git rebase --interactive --autostash`. Git runs `dist/rebaseEditor.js` as the sequence editor, and it rewrites the todo list from a plan. If anything doesn't match the plan, it exits non-zero and git aborts before touching history. Undo replays the HEAD reflog as a stack of actions.

The Commit Graph, the Sync view, the rebase editor and the conflicts panel are webview pages. Each lives in `src/webview/<page>/` as markup (`body.html`), styles (`style.css`) and a script (`main.ts`, type-checked against the DOM by `src/webview/tsconfig.json`). esbuild bundles them into `dist/webview/`. The rebase editor predicts conflicts by replaying the planned order with `git merge-tree` on trees only (Git 2.45 or newer), so nothing in the repository changes until you start. The messages between a page and the extension are typed in `src/webview/messages.ts`, which both sides import.

## Development

```bash
npm install
npm test            # unit tests plus real-git integration tests
npm run e2e         # every TESTING.md item against a playground in VS Code (`npm run e2e -- stash` for a subset)
npm run playground  # builds ../slothgit-playground for trying things by hand (see TESTING.md)
npm run watch       # rebuild on change
```

Press `F5` to launch an Extension Development Host.

### Releases

Pushing a version tag (matching `version` in `package.json`, with or without a leading `v`) builds the extension, runs the tests and attaches the `.vsix` to a GitHub Release. The release notes are that version's section of [CHANGELOG.md](CHANGELOG.md). Tags with a suffix, such as `1.1.0-beta.1`, become pre-releases.

```bash
git tag 1.0.0
```

```bash
git push origin 1.0.0
```

To publish to [Open VSX](https://open-vsx.org) by hand, create an access token in your Open VSX settings and create the `Saniee` namespace once (`npx ovsx create-namespace Saniee -p <token>`). Then run:

```bash
npm run publish:ovsx
```

The script reads the token from `OVSX_PAT`, either set in your shell or in a `.env` file in the project folder (`OVSX_PAT=<token>`). `.env` is ignored by git and left out of the package.

The release workflow does the same automatically when the repository has an `OVSX_PAT` secret.

## Roadmap

- Visual interactive rebase editor, like GitLens's: drag commits to reorder them, mark them to squash, reword or drop, see ahead of time which steps will conflict, and resolve every conflicted file from one panel [[feature/actually-interactive-rebase]](https://github.com/Saniee/SlothGit/tree/feature/actually-interactive-rebase)
- Submodules
- Custom commands (lazygit's `customCommands`)
- Git blame [[feature/git-blame]](https://github.com/Saniee/SlothGit/tree/feature/git-blame)
- Issues and pull requests dashboard[[feature/issues-pullrequest-dashboard]](https://github.com/Saniee/SlothGit/tree/feature/issues-pullrequest-dashboard)
