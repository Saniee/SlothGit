# CodeGit

Lazygit-inspired power tools that fill the gaps in VS Code's built-in Git support. CodeGit adds four views to the Source Control sidebar (Branches, Commits, Reflog and Stashes, in lazygit's order) and builds on the built-in Git extension (same repositories, same diff editors) rather than replacing it. File staging stays with VS Code's own Changes view.

## Features

### Replaces the Graph view
The Commits view does what VS Code's built-in **Graph** view does, and more, so CodeGit hides the Graph the first time you open Source Control. To bring it back, use the **…** menu on the Source Control sidebar and tick **Graph**. CodeGit won't hide it again.

### Fetch / Pull / Push on the Changes view
The Source Control **Changes** title bar gets Fetch, Pull and Push buttons, like the ones on the Graph view. They run the built-in Git commands for that repository. Turn them off with `codegit.showSyncButtons`.

### Undo / redo
The ↶ / ↷ buttons on the Commits view undo and redo your last Git action, like lazygit's `z` / `Z`. That includes commits, amends, resets, rebases (as one step), merges, cherry-picks and checkouts. It works from the reflog, so it also covers actions you ran outside CodeGit. Uncommitted changes are carried across.

### Branches view
lazygit's branches panel, as one tree with four sections:

- **Local Branches.** The current branch comes first, then the rest sorted by most recent checkout (or by latest commit or name: **Sort Branches…**). Each branch shows ahead/behind counts against its upstream (or "upstream gone"), and branches checked out in another worktree are marked. Actions:
  - checkout, checkout previous branch, new branch, new worktree, rename
  - delete (local, remote or both; unmerged branches ask before force-deleting), delete merged branches in bulk
  - merge into current (regular, `--no-ff` or squash), rebase current onto this
  - fast-forward from upstream (works without checking the branch out), push / force push with lease, set or unset upstream
  - create pull request (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea), reset current branch to this, compare with current
- **Remotes.** Each remote expands to its branches. Actions: fetch (one remote or all), add, rename, edit URL and remove. Remote branches can be checked out as a tracking branch, merged, rebased onto, set as the current branch's upstream, or deleted on the remote.
- **Tags.** Create (lightweight or annotated, at HEAD or at any commit), push to a remote, delete locally or also on a remote, check out, and reset to.
- **Worktrees.** Add one (for an existing branch or a new one), open it in a new or the current window, copy its path, remove it (asks before discarding changes), and prune missing ones.

Expand any branch or tag to browse its commits and their files. From there you can copy commits for cherry-picking, check them out, branch from them and so on.

Push, fetch and remote deletes go through VS Code's built-in Git extension, so its credential prompts and `git.pruneOnFetch` apply.

#### Rebasing onto another branch
- **Whole branch:** right-click the target branch (e.g. `origin/main`) and pick **Rebase Current Branch onto This**.
- **Only your commits** (your branch was cut from another feature branch): in the Commits view, right-click the last commit that is *not* yours and pick **Mark as Base Commit for Rebase**. Then run **Rebase Current Branch onto This** on the target and choose **Rebase from Marked Base**. This is `git rebase --onto <target> <base>`.

- **Interactive:** pick **Interactive Rebase** (or **Interactive Rebase from Marked Base**). The rebase pauses before the first commit is applied and lists the steps at the top of the Commits view. Reorder them, or change each to pick, squash, fixup, edit or drop, then **Continue**. **Abort** leaves the branch as it was.

CodeGit warns before rebasing commits that are already pushed. Conflicts are handled the same way as for other rewrites (see below).

### Commits view
Rewrite history straight from the commit list, with no todo file to edit by hand:

| Action | Notes |
| --- | --- |
| Squash / fixup into previous commit | Squash combines the messages; fixup keeps the older one |
| Drop commit | Works on multiple selected commits |
| Reword commit | Quick subject edit, or **Reword in Editor** for the full multi-line message |
| Edit commit (pause rebase) | Stage changes, then **Continue** amends it |
| Amend staged changes into commit | Folds staged changes into any older commit; unstaged changes are preserved |
| Create fixup commit / squash fixup commits above | `git commit --fixup` and `--autosquash` (lazygit `F` / `S`) |
| Amend author | Reset author, set author, or add a `Co-authored-by` trailer |
| Move commit up / down | |
| Copy / paste for cherry-pick | Copy on one branch, paste on another |
| Reset to here (soft / mixed / hard), create branch or tag here, checkout, revert | |
| Copy… / open in browser | Copy the SHA, subject, message, author, diff or web URL |

Expand a commit to see its files. For each file you can open the diff or the file at that revision, or check the file out from that commit. You can also **remove its changes from the commit**, or **move them out of the commit into the index**, which is lazygit's custom-patch "move patch out" at file level. Use **Open All Changes** to see a whole commit in the multi-diff editor.

Commit icons are green when the commit is already on the upstream branch and yellow when it isn't. CodeGit asks for confirmation before rewriting pushed commits.

All rewrites use `git rebase --interactive --autostash`, so a dirty working tree is fine. When a rebase stops (on conflicts, or at a commit you chose to edit), the status bar and the view toolbar offer **Continue / Skip / Abort**. The remaining rebase steps appear at the top of the Commits view, where you can reorder them or change their action (pick, squash, fixup, edit, drop) before continuing.

Each commit shows its SHA, author initials and message, as in lazygit, followed by its relative date, branches and tags. In a narrow view only the end of the message is cut off; the tooltip has the full message, author, date and email. Merge commits get a merge icon.

**Search:** the search button matches text in the message or author name (case-insensitive), or a SHA prefix. Squash and move are disabled while searching, since the neighbouring commits are hidden.

**All branches:** the branch button lists every branch, remote branch and tag together. Other branches' commits are dimmed; you can check them out, branch from them or cherry-pick them, but not rewrite them.

**Commit Graph ("pretty mode"):** the graph button opens the history as a graph in an editor tab: branch lanes, branch and tag labels, author and date columns, search and an all-branches switch. Click a commit for its message and files (click a file for its diff), double-click to open all its changes, and right-click for the same actions as the Commits view.

**Filter by file:** the filter button on the Commits view, or **Show File History in CodeGit** in the Explorer or an editor tab's context menu, limits the log to commits touching that file or folder.

**Bisect:** right-click commits to mark them bad, good or skipped. CodeGit starts the bisect if needed, marks the commits in the list, and offers to reset once git names the first bad commit.

**Compare:** **Select for Compare** on any commit, branch or tag, then **Compare with Selected** on another. This is lazygit's diffing mode, shown in the multi-diff editor.

### Stashes view
List stashes and browse their files, including untracked ones. You can apply, pop, drop or rename a stash, or create a branch from it. New stashes can include untracked files, contain only staged changes, or leave the staged changes in place.

### Reflog view
Browse `HEAD`'s reflog to recover dropped commits or undo resets. From any entry you can check it out, reset to it, branch from it, or copy it for cherry-picking.

## How it works

The extension calls the git CLI (the binary the built-in Git extension uses). For interactive rebases, git runs `dist/rebaseEditor.js` as `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR`; VS Code's own runtime executes it via `ELECTRON_RUN_AS_NODE`. The script rewrites the todo list according to a plan passed in an environment variable. If anything doesn't match, it exits non-zero and git aborts the rebase before touching history.

Undo/redo replays the HEAD reflog as a stack of actions. CodeGit's own undo and redo steps are recorded with `GIT_REFLOG_ACTION` markers, so later replays know what is already undone.

## Development

```bash
npm install
npm test          # builds, then runs unit tests plus real-git integration tests
npm run playground  # builds ../codegit-playground: a repo with a scenario for every feature (see TESTING.md)
npm run smoke     # opens your installed VS Code with a throwaway profile and walks every view in a scratch repo
npm run e2e       # runs every TESTING.md item against the playground in VS Code (~7 min; `npm run e2e -- stash` for a subset)
npm run watch     # rebuild on change
```

Press `F5` to launch an Extension Development Host.

### Releases

Pushing a version tag builds the extension, runs the tests and attaches the `.vsix` to a GitHub Release (see `.github/workflows/release.yml`). Nothing is published to the Marketplace.

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

The tag must match `version` in `package.json`. Tags with a suffix, such as `v0.1.0-beta.1`, become pre-releases. Install a release with **Extensions: Install from VSIX…**.

## Roadmap ideas

- Line/hunk-level custom patches from old commits (file level is done)
- Rewriting history that contains merge commits (`--rebase-merges`)
- Submodules
- Custom commands (lazygit's `customCommands`)
