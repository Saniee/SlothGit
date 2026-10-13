# Copy commits to another branch

## Cherry-pick

**Cherry-pick** copies one or more commits onto the branch you're on, without bringing anything else from their branch. Use it to take a single bug fix from one branch into another.

1. Find the commits: in the **Commits** view, or under any branch in the **Branches** view (expand the branch). Right-click → **Copy for Cherry-Pick**. Copied commits get a blue clipboard icon.
2. Check out the branch that should receive them.
3. Press **Paste Copied Commits** on the Commits view's title bar.

They're applied oldest first. To un-copy one, right-click it → **Remove from Cherry-Pick**.

## Committed on the wrong branch?

If you made commits on `main` that should have been on a new branch: in the **Branches** view, right-click the current branch → **Move Unpushed Commits to New Branch**. The new branch gets the commits (and your uncommitted changes), and `main` goes back to match the remote.
