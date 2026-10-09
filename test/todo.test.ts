import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformTodo } from '../src/git/todo';

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
