If empty check roadmap.

## Fixes

- **Check the Sync view's right-click menus by hand.** Right-clicking Pull or Push should show the same entries as their ⌄ quick picks. The entries come from package.json `webview/context`, and `test/contributions.test.ts` keeps them in step with `src/webview/syncMenus.ts`, but no automated test opens the native menu.
- **License wording.** package.json says `GPL-3.0-only`. If "or any later version" was meant, change it to `GPL-3.0-or-later` (and add the usual notice to the README).
- Fix Marketplace "Your extension has suspicious content. Please fix your extension metadata, or contact support if you need assistance."
- Trim unneeded comments.

## Maintenance

From the 1.0.0 tech-debt review and code review, not done yet:

- **Test the webview pages' rendering directly.** e2e checks that each page loads and draws (the `rendered` messages), but not what it draws in detail. With the pages now in `src/webview/<page>/main.ts`, their `render` functions can be unit tested against a DOM library such as happy-dom: graph rows, pills, push colours, the Sync view's labels and disabled states.
- **Generate the menus in package.json.** It is about 2,250 lines; the Simple Mode condition repeats 48 times and the Commit Graph's menu copies the Commits view's by hand. `test/contributions.test.ts` now catches drift, but a small script that builds `contributes.menus` from a TypeScript table would remove the repetition.
- **Split `src/commands.ts`** (about 920 lines) by area (rewrites, files and patches, cherry-pick, the rest) next time it needs real changes. `branchCommands.ts` and `git/operations.ts` are around 700 lines each.
- **`historyCommands.ts` `describe()`** takes the branch name for undo/redo messages from the built-in Git extension's `state.HEAD`. It's only a label, but `currentBranch(git)` in `git/queries.ts` is the one source for everything else.
- **Remove the CodeGit migration after 2.0.0:** `migrateSettings` in `extension.ts` and the legacy `[codegit undo]` / `[codegit redo]` markers in `git/undo.ts` (both marked in the code).
- **Watch the `braces` advisory** (GHSA-vfj7-8cjw-p6xm). It reaches us through `@vscode/vsce` → `secretlint` → `globby`, only at packaging time; nothing in the .vsix uses it. Update `@vscode/vsce` once a fixed version is out.

## Features

- **Conflicts panel: try the Merge Editor button by hand.** It runs the built-in Git extension's `git.openMergeEditor` (falling back to opening the file); no automated test opens the merge editor.
- **Rebase editor: drag by hand once in VS Code.** Dropping rows was tested with synthetic drag events in a browser, and the e2e tests set the plan through a test message; no automated test drags with a real mouse.
