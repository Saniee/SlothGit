# Manual testing

Everything in the checklist below is also covered by `npm run e2e`. It opens a separate VS Code window on a fresh playground, runs each item with scripted answers to CodeGit's prompts, and checks the resulting git state. The window's status bar and the terminal show progress; the repository visibly resets between scenarios. Manual testing is still useful for what automation can't judge, such as layout, wording and how the workflow feels.

## Get a playground

```bash
npm run playground
```

This creates `../codegit-playground/repo` (pass a folder to put it elsewhere: `npm run playground -- D:\tmp\pg`). Open that `repo` folder in VS Code with CodeGit installed. The remotes `origin` and `upstream` are bare repositories next to it, so pushing, fetching and deleting remote branches are safe and need no login.

Re-run the command whenever you want to start over. It replaces the previous playground (close VS Code windows on it first).

**Undo** (↶ on the Commits view) is a quick way back after most experiments, and it is worth testing in its own right.

## What's in it

| Ref | State | Try |
| --- | --- | --- |
| `main` | 3 unpushed commits on top of pushed history; staged + unstaged changes; 2 stashes | Commit colors, every rewrite (dirty tree must survive), push |
| `main` history | "Refactor parser" puts `BUG` in `app.txt` | Bisect: bad on HEAD, good on "Add config", and see whether git finds "Refactor parser". Try it once with the dirty tree (git refuses; the error should be readable), then stash and retry |
| "Fix typo in docs" | Different author | Amend author → reset / set / co-author |
| "Add profile page" | Multi-line message | Reword in Editor; Copy… → message |
| "Add settings page" | Touches 2 files | Remove one file from the commit; move it to the index |
| "Rename logout to signout" | Rename | File list and diff of a rename |
| `feature/login` | Pushed, ahead 1 | Push, force push, create pull request (opens a URL; the remote is local, so expect nothing useful). Move Unpushed Commits to New Branch: the new branch gets "Login: error messages", `feature/login` matches `origin/feature/login` again |
| `feature/login-ui` | Stacked on `feature/login` | Mark "Login: error messages" as base, then rebase onto `main` with the marked base, so only the 2 UI commits move. With `codegit.updateStackedBranches` set to `always`, reword a `feature/login` commit from here: `feature/login` moves too, and an interactive rebase lists "Update branch feature/login" |
| `conflict/status-line` | Edits the same line as `main` | Merge into `main`, or rebase it onto `main`, to get a conflict; Continue / Abort from the status bar |
| `feature/search` | Has a `fixup!` commit | Squash Fixup Commits Above on "Add search"; Create Fixup Commit |
| `feature/with-merge` | Contains a merge commit | Reword or drop "Side work" below the merge: the merge is recreated. Reword, drop and revert the merge itself (revert asks which parent to keep). Squashing or moving the merge, or squashing "Merged-in work", should refuse with a clear message |
| `chore/gone-upstream` | Upstream deleted on remote | Shows "upstream gone"; Unset Upstream; Delete |
| `origin/remote-only` | No local branch | Checkout creates a tracking branch |
| `release/1.x` | Behind its upstream by 1 | Fast-forward without checking it out |
| `merged/old-experiment` | Already in `main` | Delete Merged Branches |
| `hotfix/crash` | Checked out in `../hotfix-worktree` | Checkout offers to open the worktree; worktree open / remove / prune |
| `v1.0`, `v0.9` | Annotated and lightweight tags | Expand, checkout, push, delete (also on remote) |
| `upstream` remote | Second remote | Fetch one remote, rename, edit URL, remove |

## Checklist

Tick off what you tried and note anything odd, such as wrong labels, missing refreshes, confusing prompts or errors in **Output → CodeGit**.

### Branches view
- [ ] Sort order: recency, date, name
- [ ] Checkout, checkout previous, new branch, rename, delete (local / remote / both; unmerged asks to force)
- [ ] Merge: regular, `--no-ff`, squash
- [ ] Rebase onto, plain and with a marked base
- [ ] Interactive rebase onto, plain and with a marked base: pauses first, change / reorder steps, Continue or Abort
- [ ] Fast-forward, set / unset upstream, set remote branch as upstream
- [ ] Push, force push with lease, fetch, fetch all
- [ ] Compare with current, reset current to this, copy name
- [ ] Remote: add, rename, edit URL, copy URL, remove
- [ ] Tags: create (lightweight / annotated), push, delete
- [ ] Worktrees: add (existing / new branch), open in new or current window, copy path, remove (dirty asks), prune

### Commits view
- [ ] Squash, fixup, drop (multi-select), reword, reword in editor, move up / down
- [ ] Edit (pause), then change files, stage, Continue
- [ ] Amend staged changes into an older commit
- [ ] Create fixup commit, squash fixup commits above
- [ ] Amend author (all three)
- [ ] Cherry-pick copy on one branch, paste on another; clear
- [ ] Reset soft / mixed / hard, checkout, revert, branch or tag here
- [ ] Copy… (each item), open in browser
- [ ] Commit files: open diff, open at revision, checkout file, remove from commit, move to index, Open All Changes
- [ ] Line-level patches in a commit's diff (both sides, cursor only, several selections, Open All Changes): remove, move to index, move to new commit
- [ ] Custom patch: add lines from two files of a commit (and a whole file from its context menu); from the status bar, move it into an older and a newer commit, apply it (and in reverse) to the working tree, show it, reset it. Adding from another commit asks to start over
- [ ] Filter by file (toolbar, Explorer context menu, editor tab context menu), clear filter
- [ ] Search by message, author and SHA; clear search
- [ ] All branches: other branches' commits are dimmed and can't be rewritten
- [ ] Commit Graph: lanes for `feature/with-merge` and all branches, labels, search, details pane, file diffs, double-click, right-click actions
- [ ] Commit Graph next to GitLens's graph: what's missing or worse?
- [ ] During a paused rebase: todo list at the top; change actions (including reword) / reorder; Continue / Skip / Abort
- [ ] Bisect: bad / good / skip, marks shown, status bar, reset
- [ ] Compare: select, compare with selected (commits, branches, tags mixed)
- [ ] Undo / redo across: commit, amend, reset, rebase, checkout, merge

### Stashes and reflog
- [ ] Stash: all / include untracked / staged only / keep index; apply, pop, drop, rename, branch from stash
- [ ] Reflog: checkout, reset, branch, cherry-pick copy from an entry

### General
- [ ] Fetch / Pull / Push buttons on the Source Control "Changes" title bar (setting `codegit.showSyncButtons`)
- [ ] Rewriting pushed commits asks first (setting `codegit.confirmRewritingPushedCommits`)
- [ ] Views refresh after you commit or switch branches outside CodeGit
- [ ] Multi-root workspace / several repositories: Switch Repository
