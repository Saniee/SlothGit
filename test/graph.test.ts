import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutGraph, type GraphRow } from '../src/git/graph';

const c = (sha: string, ...parents: string[]) => ({ sha, parents });
const lanes = (rows: GraphRow[]) => rows.map((r) => r.lane);
const parts = (row: GraphRow) => row.lines.map((l) => `${l.part}:${l.from}>${l.to}`).sort();

test('graph: linear history stays in one lane', () => {
  const rows = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
  assert.deepEqual(lanes(rows), [0, 0, 0]);
  assert.deepEqual(parts(rows[0]), ['bottom:0>0']);
  assert.deepEqual(parts(rows[1]), ['bottom:0>0', 'top:0>0']);
  assert.deepEqual(parts(rows[2]), ['top:0>0']);
  assert.ok(rows.every((r) => r.width === 1 && r.color === rows[0].color));
});

test('graph: a merge opens a lane for the second parent and closes it at the fork', () => {
  //   m        merge of x into b
  //   |\
  //   b x
  //   |/
  //   a
  const rows = layoutGraph([c('m', 'b', 'x'), c('b', 'a'), c('x', 'a'), c('a')]);
  assert.deepEqual(lanes(rows), [0, 0, 1, 0]);
  assert.deepEqual(parts(rows[0]), ['bottom:0>0', 'bottom:0>1']);
  assert.deepEqual(parts(rows[1]), ['bottom:0>0', 'through:1>1', 'top:0>0']);
  // x's parent a already has lane 0 waiting for it: x joins it.
  assert.deepEqual(parts(rows[2]), ['bottom:1>0', 'through:0>0', 'top:1>1']);
  assert.deepEqual(parts(rows[3]), ['top:0>0']);
  assert.equal(rows[0].width, 2);
  assert.equal(rows[3].width, 1);
  assert.notEqual(rows[2].color, rows[1].color, 'the merged branch has its own colour');
});

test('graph: two branch tips sharing history (all-branches mode)', () => {
  //   f    feature tip
  //   | m  main tip
  //   |/
  //   a
  const rows = layoutGraph([c('f', 'a'), c('m', 'a'), c('a')]);
  assert.deepEqual(lanes(rows), [0, 1, 0]);
  assert.deepEqual(parts(rows[1]), ['bottom:1>0', 'through:0>0']);
  assert.deepEqual(parts(rows[2]), ['top:0>0']);
});

test('graph: lanes are reused once free', () => {
  const rows = layoutGraph([c('m2', 'm1', 'y'), c('y', 'm0'), c('m1', 'm0'), c('m0', 'r'), c('t2', 'r'), c('r')]);
  assert.ok(rows.every((r) => r.width <= 2), `widths ${rows.map((r) => r.width)}`);
});

test('graph: commits whose parents are beyond the limit keep their lanes open', () => {
  const rows = layoutGraph([c('b', 'a')]);
  assert.deepEqual(parts(rows[0]), ['bottom:0>0']);
});
