import * as vscode from 'vscode';

/** The "Get Started with SlothGit" walkthrough (package.json contributes.walkthroughs), as `publisher.name#id`. */
let walkthrough = '';

/** Records the extension id, which the walkthrough id is built from. Called from activate(). */
export function initLearn(extensionId: string): void {
  walkthrough = `${extensionId}#gettingStarted`;
}

export type LearnTopic = 'views' | 'reading' | 'undo' | 'tidy' | 'merge-rebase' | 'cherry-pick' | 'stash' | 'worktrees' | 'bisect';

/** Opens the walkthrough, at `topic` when given. */
export function learn(topic?: LearnTopic): Thenable<unknown> {
  return vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    topic ? { category: walkthrough, step: `${walkthrough}#${topic}` } : walkthrough,
    false,
  );
}

/** A quick pick item that opens the walkthrough at `topic`, for pickers whose choices need explaining. */
export function learnItem(topic: LearnTopic, label: string): vscode.QuickPickItem & { learn: LearnTopic } {
  return { label: `$(question) ${label}`, description: 'Opens the guide', learn: topic, alwaysShow: true };
}
