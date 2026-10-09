import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTodo, transformTodo } from '../src/git/todo';

const A = 'aaaaaaa1111111111111111111111111111111111';
const B = 'bbbbbbb2222222222222222222222222222222222';
const C = 'ccccccc3333333333333333333333333333333333';
const todo = ['pick aaaaaaa first', 'pick bbbbbbb second', 'pick ccccccc third', '', '# Rebase ...', ''].join('\n');

test('changes actions by full sha', () => {
  const out = transformTodo(todo, { actions: { [B]: 'drop', [C]: 'fixup' } });
  assert.deepEqual(out.split('\n').slice(0, 3), ['pick aaaaaaa first', 'drop bbbbbbb second', 'fixup ccccccc third']);
});

test('handles abbreviated commands and CRLF', () => {
  const out = transformTodo('p aaaaaaa first\r\np bbbbbbb second\r\n', { actions: { [A]: 'reword' } });
  assert.equal(out, 'reword aaaaaaa first\r\np bbbbbbb second\r\n');
});

test('moves commits up and down', () => {
  const up = transformTodo(todo, { move: { sha: A, direction: 'up' } });
  assert.deepEqual(up.split('\n').slice(0, 3), ['pick bbbbbbb second', 'pick aaaaaaa first', 'pick ccccccc third']);
  const down = transformTodo(todo, { move: { sha: C, direction: 'down' } });
  assert.deepEqual(down.split('\n').slice(0, 3), ['pick aaaaaaa first', 'pick ccccccc third', 'pick bbbbbbb second']);
  assert.throws(() => transformTodo(todo, { move: { sha: C, direction: 'up' } }));
});

test('moves a fixup directly after its target', () => {
  const out = transformTodo(todo, { fixupInto: { sha: C, target: A } });
  assert.deepEqual(out.split('\n').slice(0, 3), ['pick aaaaaaa first', 'fixup ccccccc third', 'pick bbbbbbb second']);
});

test('fails when a commit is missing, so git aborts the rebase', () => {
  assert.throws(() => transformTodo(todo, { actions: { ['d'.repeat(40)]: 'drop' } }), /not in the rebase todo/);
});

test('leaves non-commit lines alone', () => {
  const withRefs = 'pick aaaaaaa first\nupdate-ref refs/heads/x\npick bbbbbbb second\n';
  const out = transformTodo(withRefs, { actions: { [B]: 'squash' } });
  assert.equal(out, 'pick aaaaaaa first\nupdate-ref refs/heads/x\nsquash bbbbbbb second\n');
});

// A --rebase-merges todo list for: main c1 - [side s1 - s2] merged - c3.
const M = 'eeeeeee5555555555555555555555555555555555';
const S1 = 'aaaaaaa1111111111111111111111111111111111';
const S2 = 'bbbbbbb2222222222222222222222222222222222';
const C3 = 'ccccccc3333333333333333333333333333333333';
const merges = [
  'label onto',
  '',
  '# Branch: side',
  'reset onto',
  'pick aaaaaaa s1',
  'pick bbbbbbb s2',
  'label side',
  '',
  'reset onto',
  'merge -C eeeeeee side # Merge branch side',
  'pick ccccccc c3',
  '',
].join('\n');

test('parses merge steps', () => {
  assert.deepEqual(parseTodo(merges), [
    { action: 'pick', sha: 'aaaaaaa', subject: 's1' },
    { action: 'pick', sha: 'bbbbbbb', subject: 's2' },
    { action: 'merge', sha: 'eeeeeee', subject: 'Merge branch side' },
    { action: 'pick', sha: 'ccccccc', subject: 'c3' },
  ]);
  assert.deepEqual(parseTodo('merge other\n'), [{ action: 'merge', sha: '', subject: 'Merge other' }]);
});

test('with merges: changes within a branch work, changes across the structure are refused', () => {
  assert.match(transformTodo(merges, { actions: { [S2]: 'fixup', [S1]: 'reword' } }), /reword aaaaaaa s1\nfixup bbbbbbb s2\nlabel side/);
  assert.match(transformTodo(merges, { move: { sha: S1, direction: 'up' } }), /pick bbbbbbb s2\npick aaaaaaa s1\nlabel side/);
  assert.throws(() => transformTodo(merges, { actions: { [S1]: 'squash' } }), /another branch or is a merge/);
  assert.throws(() => transformTodo(merges, { actions: { [C3]: 'fixup' } }), /another branch or is a merge/);
  assert.throws(() => transformTodo(merges, { move: { sha: S2, direction: 'up' } }), /past a merge or branch point/);
  assert.throws(() => transformTodo(merges, { move: { sha: C3, direction: 'down' } }), /past a merge or branch point/);
  assert.throws(() => transformTodo(merges, { actions: { [M]: 'drop' } }), /is a merge commit/);
});

test('pauses before the first step', () => {
  const out = transformTodo(todo, { pauseFirst: true, actions: { [A]: 'reword' } });
  assert.deepEqual(out.split('\n').slice(0, 4), ['break', 'reword aaaaaaa first', 'pick bbbbbbb second', 'pick ccccccc third']);
  assert.throws(() => transformTodo('noop\n', { pauseFirst: true }), /no commits to rebase/);
});
