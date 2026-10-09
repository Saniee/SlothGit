// End-to-end test: builds the playground repository (scripts/playground.mjs) in a temp folder, opens it in
// the installed VS Code with a throwaway profile, and runs test/e2e/index.ts, which drives every CodeGit
// command with scripted answers to its prompts and checks the resulting git state.
//
//   npm run e2e                       all scenarios
//   npm run e2e -- squash reword      only scenarios whose name contains one of the words
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build, root, runInVSCode } from './vscode-run.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegit-e2e-'));
const playground = path.join(tmp, 'playground');
execFileSync('node', [path.join(root, 'scripts', 'playground.mjs'), playground], { stdio: 'ignore' });
const repo = path.join(playground, 'repo');
// Scenarios restore the repository by copying refs back; never let git delete objects behind our back.
execFileSync('git', ['config', 'gc.auto', '0'], { cwd: repo });

build();
const report = path.join(tmp, 'e2e-report.json');
const result = await runInVSCode({
  tag: 'e2e',
  workspace: repo,
  testsPath: path.join(root, 'out-test', 'e2e', 'index.js'),
  profile: tmp,
  timeout: 15 * 60_000,
  env: {
    CODEGIT_E2E_PLAYGROUND: playground,
    CODEGIT_E2E_REPORT: report,
    CODEGIT_E2E_FILTER: process.argv.slice(2).join(' '),
  },
});

if (!fs.existsSync(report)) {
  console.log(`E2E FAILED: no report (exit ${result.status})`);
  process.exit(1);
}
const { results } = JSON.parse(fs.readFileSync(report, 'utf8'));
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nFailed:');
  for (const r of failed) console.log(`  ${r.name}\n${r.error.replace(/^/gm, '      ')}`);
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Playground: ${playground}`);
process.exit(failed.length ? 1 : 0);
