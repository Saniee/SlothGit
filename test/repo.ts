// Throwaway repositories for the tests that run real git. Building one takes a dozen git processes, which is
// slow (on Windows especially), so each kind is built once per test file and every test gets a copy.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function writeFile(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content);
}

/** Each test makes its own repository and mostly waits on git, so a file's tests can run side by side. */
export const concurrency = os.availableParallelism();

const templates = new Map<string, string>();

/**
 * A new repository on branch main with a test identity, as `build` leaves it. `build` runs once per `key`
 * (it must always make the same repository for a key); later calls copy that result.
 */
export function newRepo(key: string, build: (dir: string) => void = () => {}): string {
  let template = templates.get(key);
  if (!template) {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'slothgit-template-'));
    git(template, 'init', '-q', '-b', 'main');
    for (const [name, value] of [
      ['user.name', 'Test'],
      ['user.email', 'test@example.com'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      // No background gc or maintenance after commits: it repacks objects while the template is being
      // copied (seen on CI as ENOENT on .git/objects).
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
    ]) {
      git(template, 'config', name, value);
    }
    build(template);
    templates.set(key, template);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slothgit-'));
  // Same timestamps, so git's index still matches the files and doesn't re-read them all.
  fs.cpSync(template, dir, { recursive: true, preserveTimestamps: true });
  return dir;
}
