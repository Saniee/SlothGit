import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = tests
  ? [
      {
        ...common,
        entryPoints: fs
          .readdirSync('test')
          .filter((f) => f.endsWith('.test.ts'))
          .map((f) => `test/${f}`),
        outdir: 'out-test',
      },
      // Runs inside VS Code via scripts/smoke.mjs; not picked up by `node --test`.
      { ...common, entryPoints: ['test/smoke/index.ts'], outfile: 'out-test/smoke/index.js', external: ['vscode'] },
      { ...common, entryPoints: ['test/e2e/index.ts'], outfile: 'out-test/e2e/index.js', external: ['vscode'] },
    ]
  : [
      { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
      // Runs as GIT_SEQUENCE_EDITOR / GIT_EDITOR during rebases; must not depend on vscode.
      { ...common, entryPoints: ['src/rebaseEditor.ts'], outfile: 'dist/rebaseEditor.js' },
    ];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
