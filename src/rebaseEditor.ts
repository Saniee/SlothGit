// Entry point git runs as GIT_SEQUENCE_EDITOR and GIT_EDITOR during CodeGit rebases.
// Usage: rebaseEditor.js <file>. Instructions arrive through environment variables:
//   CODEGIT_REBASE_PLAN     JSON RebasePlan applied to git-rebase-todo
//   CODEGIT_COMMIT_MESSAGE  replacement text for any commit message file (reword)
// A non-zero exit makes git abort the rebase before anything is rewritten.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformTodo, type RebasePlan } from './git/todo';

function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error('missing file argument');

  if (path.basename(file) === 'git-rebase-todo') {
    const plan = process.env.CODEGIT_REBASE_PLAN;
    if (plan) fs.writeFileSync(file, transformTodo(fs.readFileSync(file, 'utf8'), JSON.parse(plan) as RebasePlan));
    return;
  }

  const message = process.env.CODEGIT_COMMIT_MESSAGE;
  if (message !== undefined) fs.writeFileSync(file, message.endsWith('\n') ? message : `${message}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`codegit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
