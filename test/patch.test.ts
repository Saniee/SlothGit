import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFileDiff, removalPatch, selectionPatch, type LineRange, type Side } from '../src/git/patch';

// Parent:  a b c d e f g h
// Commit:  a b C d e N1 N2 f g     (c changed, N1 N2 inserted, h deleted)
const COMMIT = ['a', 'b', 'C', 'd', 'e', 'N1', 'N2', 'f', 'g'];
const DIFF = [
  'diff --git a/x.txt b/x.txt',
  'index 1111111..2222222 100644',
  '--- a/x.txt',
  '+++ b/x.txt',
  '@@ -1,8 +1,9 @@',
  ' a',
  ' b',
  '-c',
  '+C',
  ' d',
  ' e',
  '+N1',
  '+N2',
  ' f',
  ' g',
  '-h',
  '',
].join('\n');

/** Minimal `git apply` for these tests: checks each hunk's preimage at its stated position. */
function apply(lines: string[], patch: string): string[] {
  const result = [...lines];
  let offset = 0;
  for (const hunk of patch.split(/^(?=@@ )/m).slice(1)) {
    const [header, ...body] = hunk.replace(/\n$/, '').split('\n');
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header)!;
    const before = body.filter((l) => l[0] !== '+').map((l) => l.slice(1));
    const after = body.filter((l) => l[0] !== '-').map((l) => l.slice(1));
    const start = (m[2] === '0' ? Number(m[1]) : Number(m[1]) - 1) + offset;
    assert.deepEqual(result.slice(start, start + before.length), before, `preimage of ${header}`);
    assert.equal(before.length, Number(m[2]), `old count of ${header}`);
    assert.equal(after.length, Number(m[4]), `new count of ${header}`);
    assert.equal((Number(m[4]) === 0 ? Number(m[3]) : Number(m[3]) - 1), start, `new start of ${header}`);
    result.splice(start, before.length, ...after);
    offset += after.length - before.length;
  }
  return result;
}

function remove(side: Side, ranges: LineRange[], diff = DIFF, lines = COMMIT): string[] {
  const patch = removalPatch(parseFileDiff(diff, 'x.txt'), side, ranges);
  assert.ok(patch, 'a patch');
  return apply(lines, patch);
}

test('picking some added lines takes only those out', () => {
  assert.deepEqual(remove('new', [{ start: 6, end: 6 }]), ['a', 'b', 'C', 'd', 'e', 'N2', 'f', 'g']);
});

test('a cursor picks the whole change block under it', () => {
  assert.deepEqual(remove('new', [{ start: 7, end: 7, whole: true }]), ['a', 'b', 'C', 'd', 'e', 'f', 'g']);
});

test('picking a changed line also restores the line it replaced', () => {
  assert.deepEqual(remove('new', [{ start: 3, end: 3 }]), ['a', 'b', 'c', 'd', 'e', 'N1', 'N2', 'f', 'g']);
  assert.deepEqual(remove('old', [{ start: 3, end: 3 }]), ['a', 'b', 'c', 'd', 'e', 'N1', 'N2', 'f', 'g']);
});

test('a deletion is picked from the parent side, or next to where it was on the commit side', () => {
  const restored = ['a', 'b', 'C', 'd', 'e', 'N1', 'N2', 'f', 'g', 'h'];
  assert.deepEqual(remove('old', [{ start: 8, end: 8 }]), restored);
  assert.deepEqual(remove('new', [{ start: 9, end: 9, whole: true }]), restored);
});

test('everything selected undoes the whole commit for the file', () => {
  assert.deepEqual(remove('new', [{ start: 1, end: 9 }]), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});

test('selections without changes give no patch', () => {
  assert.equal(removalPatch(parseFileDiff(DIFF, 'x.txt'), 'new', [{ start: 1, end: 2 }]), undefined);
});

test('later hunks start where the earlier ones left the file', () => {
  const parent = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const commit = [...parent.slice(0, 2), 'i1', 'i2', ...parent.slice(2, 24), 'L25', ...parent.slice(25)];
  const diff = [
    'diff --git a/x.txt b/x.txt',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,5 +1,7 @@',
    ' l1', ' l2', '+i1', '+i2', ' l3', ' l4', ' l5',
    '@@ -22,7 +24,7 @@',
    ' l22', ' l23', ' l24', '-l25', '+L25', ' l26', ' l27', ' l28',
    '',
  ].join('\n');
  assert.deepEqual(remove('new', [{ start: 1, end: 30 }], diff, commit), parent);
  assert.deepEqual(remove('new', [{ start: 27, end: 27 }], diff, commit), [...parent.slice(0, 2), 'i1', 'i2', ...parent.slice(2)]);
  assert.deepEqual(remove('new', [{ start: 3, end: 3, whole: true }], diff, commit), [...parent.slice(0, 24), 'L25', ...parent.slice(25)]);
});

test('a file the commit added: some lines, or all of them, which removes the file', () => {
  const diff = ['diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n');
  assert.deepEqual(remove('new', [{ start: 2, end: 2 }], diff, ['one', 'two']), ['one']);
  const all = removalPatch(parseFileDiff(diff, 'n.txt'), 'new', [{ start: 1, end: 2 }])!;
  assert.match(all, /deleted file mode 100644\n--- a\/n.txt\n\+\+\+ \/dev\/null\n@@ -1,2 \+0,0 @@\n-one\n-two\n/);
});

test('deleted and binary files are refused', () => {
  const deleted = ['diff --git a/d.txt b/d.txt', 'deleted file mode 100644', '--- a/d.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n');
  assert.throws(() => removalPatch(parseFileDiff(deleted, 'd.txt'), 'old', [{ start: 1, end: 1 }]), /deletes this file/);
  const binary = ['diff --git a/b.bin b/b.bin', 'Binary files a/b.bin and b/b.bin differ', ''].join('\n');
  assert.throws(() => removalPatch(parseFileDiff(binary, 'b.bin'), 'new', [{ start: 1, end: 1 }]), /Binary/);
});

test('a selection on both sides of the same file makes one patch', () => {
  const diff = parseFileDiff(DIFF, 'x.txt');
  const both = selectionPatch(diff, { old: [{ start: 3, end: 3 }], new: [{ start: 6, end: 6, whole: true }] })!;
  // c comes back (picked on the parent's side), N1 N2 go (picked on the commit's side); h stays deleted.
  assert.deepEqual(apply(COMMIT, both), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});
