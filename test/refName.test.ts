import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { branchNameError } from '../src/git/refName';

// The validator must agree with git itself: a new branch needs a valid refs/heads/<name>, and `git branch` also
// refuses a leading "-". "@" is refused on purpose although git allows it: it also means HEAD.
const NAMES = [
  'main',
  'feature/login',
  'release/1.x',
  'fix-#12',
  'user@host',
  'a.b',
  'bad name',
  'tab\tname',
  'a..b',
  'a:b',
  'a~1',
  'a^',
  'what?',
  'star*',
  'br[acket',
  'back\\slash',
  '@',
  'a@{1}',
  '-dash',
  '/lead',
  'trail/',
  'dou//ble',
  'dot.',
  '.hidden',
  'x/.hidden',
  'name.lock',
  'x.lock/y',
];

test('branchNameError agrees with git', () => {
  for (const name of NAMES) {
    const valid = name !== '@' && !name.startsWith('-') && spawnSync('git', ['check-ref-format', `refs/heads/${name}`]).status === 0;
    assert.equal(branchNameError(name) === undefined, valid, `"${name}" should be ${valid ? 'valid' : 'invalid'}`);
  }
});
