// Packages the extension and publishes it to Open VSX (https://open-vsx.org).
//
//   OVSX_PAT=<token> npm run publish:ovsx
//
// The token comes from https://open-vsx.org/user-settings/tokens. The namespace (package.json "publisher") must
// exist first: npx ovsx create-namespace <publisher> -p <token>. Versions with a suffix (1.1.0-beta.1) are
// published as pre-releases. Publishing a version that is already on Open VSX is skipped, not an error.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));

if (!process.env.OVSX_PAT) {
  console.error('Set OVSX_PAT to an Open VSX access token (https://open-vsx.org/user-settings/tokens).');
  process.exit(1);
}

const vsix = path.join(project, `${name}-${version}.vsix`);
// Windows needs a shell to run npx (a .cmd file), and the shell joins arguments unquoted: quote paths with spaces.
const windows = process.platform === 'win32';
const npx = (...args) =>
  execFileSync('npx', windows ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, { cwd: project, stdio: 'inherit', shell: windows });

npx('vsce', 'package', '--out', vsix);
npx('ovsx', 'publish', vsix, '--skip-duplicate', ...(version.includes('-') ? ['--pre-release'] : []));
console.log(`\nPublished ${name} ${version} to Open VSX.`);
