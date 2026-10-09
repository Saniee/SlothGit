// Entry point git runs as GIT_SEQUENCE_EDITOR and GIT_EDITOR during CodeGit rebases.
// Usage: rebaseEditor.js <file>. Instructions arrive through environment variables:
//   CODEGIT_REBASE_PLAN     JSON RebasePlan applied to git-rebase-todo
//   CODEGIT_COMMIT_MESSAGE  replacement text for any commit message file (reword)
// Without CODEGIT_COMMIT_MESSAGE, a reword step of a paused rebase gets the message saved for it in
// rebase-merge/codegit-messages.json; any other message is left as git prepared it.
// A non-zero exit makes git abort the rebase before anything is rewritten.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pendingRewordMessage, REWORD_MESSAGES_FILE, transformTodo, type RebasePlan } from './git/todo';

function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error('missing file argument');

  if (path.basename(file) === 'git-rebase-todo') {
    const plan = process.env.CODEGIT_REBASE_PLAN;
    if (plan) fs.writeFileSync(file, transformTodo(fs.readFileSync(file, 'utf8'), JSON.parse(plan) as RebasePlan));
    return;
  }

  const message = process.env.CODEGIT_COMMIT_MESSAGE ?? savedRewordMessage(file);
  if (message !== undefined) fs.writeFileSync(file, message.endsWith('\n') ? message : `${message}\n`);
}

/** The message file lives in the git directory, next to rebase-merge/. */
function savedRewordMessage(file: string): string | undefined {
  const dir = path.join(path.dirname(path.resolve(file)), 'rebase-merge');
  const saved = path.join(dir, REWORD_MESSAGES_FILE);
  const done = path.join(dir, 'done');
  if (!fs.existsSync(saved) || !fs.existsSync(done)) return undefined;
  return pendingRewordMessage(fs.readFileSync(done, 'utf8'), JSON.parse(fs.readFileSync(saved, 'utf8')));
}

try {
  main();
} catch (error) {
  process.stderr.write(`codegit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
