# Where SlothGit lives

SlothGit adds five views to the **Source Control** sidebar, under VS Code's own **Changes** view:

| View | What it shows | You use it to… |
| --- | --- | --- |
| **Sync** | The branch you're on and how far it is ahead (↑) or behind (↓) its copy on the remote | Pull, push, fetch; the ⌄ arrows hold the other ways to do it |
| **Branches** | Your branches, the remotes (such as GitHub) and their branches, tags and worktrees | Switch branches, merge, rebase, push, pull |
| **Commits** | The history of the branch you're on, newest at the top | Change commits: reword, squash, drop, reorder, undo |
| **Reflog** | Every place your branch has pointed to recently | Get back something you lost |
| **Stashes** | Work you put aside without committing | Bring that work back later |

Tip: drag the **Sync** view's title above **Changes** to keep Pull and Push right next to the commit box. VS Code remembers where you put it.

Staging files and making new commits still happens in VS Code's **Changes** view, as before. SlothGit is for everything after that.

**Right-click** anything in these views to see what you can do with it. Hover over a commit or branch for its details.

## Simple Mode

New to Git? Turn on **Simple Mode** with the eye button on the **Changes** title bar (or **Switch to Simple Mode** in any SlothGit view's **…** menu). It hides the advanced actions (bisect, custom patches, worktrees, compare, resets and the Reflog view) so the menus show only everyday things. Press the button again to bring them back. Everything stays available from the Command Palette.
