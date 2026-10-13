// The conflicts panel page (see views/conflictsPanel.ts): each conflicted file with its hunks, current and
// incoming side by side, and buttons to keep one side or both.
import type { ConflictHunk, ConflictKind, HunkChoice } from '../../git/conflicts';
import type { ConflictFileState, ConflictsState, FromConflicts, ToConflicts } from '../messages';
import './style.css';

const vscode = acquireVsCodeApi<FromConflicts>();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const files = $<HTMLElement>('files');
const status = $<HTMLDivElement>('status');
const continueButton = $<HTMLButtonElement>('continue');
const skipButton = $<HTMLButtonElement>('skip');

const KINDS: Record<ConflictKind, string> = {
  'both-modified': 'changed on both sides',
  'both-added': 'added on both sides',
  'both-deleted': 'deleted on both sides',
  'deleted-in-current': 'deleted in current, changed in incoming',
  'deleted-in-incoming': 'changed in current, deleted in incoming',
  'added-in-current': 'added in current',
  'added-in-incoming': 'added in incoming',
};
/** The kinds where taking a side deletes the file. */
const DELETES: Partial<Record<ConflictKind, 'current' | 'incoming' | 'both'>> = {
  'deleted-in-current': 'current',
  'deleted-in-incoming': 'incoming',
  'both-deleted': 'both',
};

function render(state: ConflictsState): void {
  $('title').textContent = state.title ?? '';
  $('detail').textContent = state.detail;
  $('current').textContent = state.current;
  $('incoming').textContent = state.incoming;
  skipButton.classList.toggle('hidden', !state.canSkip);

  files.replaceChildren(...state.files.map(card));
  const open = state.files.filter((f) => f.kind).length;
  let text: string;
  if (open) text = `${open === 1 ? '1 file still has' : `${open} files still have`} conflicts. Resolve them, then Continue.`;
  else if (state.files.length) text = 'All conflicts are resolved. Continue to go on.';
  else text = 'There are no conflicts. Continue when you are ready.';
  status.textContent = text;
  continueButton.classList.toggle('primary', !open);
  vscode.postMessage({
    type: 'rendered',
    files: state.files.map((f) => `${f.path}: ${stateText(f)}`),
    status: text,
  });
}

function stateText(file: ConflictFileState): string {
  if (!file.kind) return 'resolved';
  if (file.binary) return 'binary file';
  if (file.hunks.length) return file.hunks.length === 1 ? '1 conflict' : `${file.hunks.length} conflicts`;
  return DELETES[file.kind] || file.kind !== 'both-modified' ? 'choose a side' : 'no conflict markers left';
}

function card(file: ConflictFileState): HTMLElement {
  const section = element('section', `file${file.kind ? '' : ' resolved'}`);
  const head = element('div', 'file-head');
  head.append(element('span', 'path', file.path));
  if (file.kind) head.append(element('span', 'kind', KINDS[file.kind]));
  head.append(element('span', `state ${file.kind ? 'open' : 'done'}`, file.kind ? stateText(file) : '✓ resolved'));

  const actions = element('span', 'actions');
  const send = (message: FromConflicts) => () => vscode.postMessage(message);
  if (file.kind) {
    const deletes = DELETES[file.kind];
    const keep = (side: 'current' | 'incoming') => {
      const label = `Keep ${side === 'current' ? 'Current' : 'Incoming'}${deletes === side || deletes === 'both' ? ' (Delete)' : ''}`;
      return button(label, send({ type: 'take', path: file.path, side }), `Resolve the whole file with the ${side} version`);
    };
    actions.append(keep('current'), keep('incoming'));
    if (file.kind === 'both-modified' || file.kind === 'both-added') {
      actions.append(button('Merge Editor', send({ type: 'openMerge', path: file.path }), 'Open in the three-way merge editor'));
    }
    if (!DELETES[file.kind] || file.kind === 'deleted-in-incoming') actions.append(button('Open File', send({ type: 'openFile', path: file.path })));
    if (!file.hunks.length && !file.binary && !DELETES[file.kind]) {
      actions.append(button('Mark Resolved', send({ type: 'markResolved', path: file.path }), 'Stage the file as it is now'));
    }
  } else {
    actions.append(button('Reopen', send({ type: 'reopen', path: file.path }), 'Put the conflict back, with its markers'));
  }
  head.append(actions);
  section.append(head);

  file.hunks.forEach((hunk, index) => section.append(hunkView(file.path, hunk, index)));
  if (file.kind && !file.hunks.length) {
    const deletes = DELETES[file.kind];
    const note = file.binary
      ? 'A binary file: keep one side whole.'
      : deletes
        ? 'One side deleted the file and the other changed it (or both deleted it). Keep the side you want.'
        : file.kind === 'both-modified'
          ? 'No conflict markers are left. Mark it resolved when the file is how you want it.'
          : 'Keep one side, or edit the file and mark it resolved.';
    section.append(element('div', 'note', note));
  }
  return section;
}

function hunkView(file: string, hunk: ConflictHunk, index: number): HTMLElement {
  const view = element('div', 'hunk');
  const head = element('div', 'hunk-head', `Line ${hunk.line + 1}`);
  const choose = (choice: HunkChoice) => () => vscode.postMessage({ type: 'hunk', path: file, index, hunk, choice });
  head.append(
    button('Keep Current', choose('current')),
    button('Keep Incoming', choose('incoming')),
    button('Keep Both', choose('both'), 'Current first, then incoming'),
  );
  const sides = element('div', 'sides');
  const columns: ['before' | 'current' | 'incoming', string, string[]][] = [
    ['current', 'Current', hunk.current],
    ['incoming', 'Incoming', hunk.incoming],
  ];
  // Only when git wrote it (merge.conflictStyle diff3, which SlothGit's own operations use).
  if (hunk.base) columns.unshift(['before', 'Before', hunk.base]);
  for (const [side, label, lines] of columns) {
    const column = element('div', 'side');
    column.append(element('span', `side-label ${side}`, label), code(lines, side === 'before' ? 'nothing (neither side had these lines)' : 'nothing (the lines were removed)'));
    sides.append(column);
  }
  view.append(head, sides);
  return view;
}

function code(lines: string[], empty: string): HTMLPreElement {
  return lines.length ? element('pre', '', lines.join('\n')) : element('pre', 'empty', empty);
}

function button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = element('button', '', label);
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

for (const action of ['continue', 'skip', 'abort'] as const) {
  $<HTMLButtonElement>(action).addEventListener('click', () => vscode.postMessage({ type: 'operation', action }));
}
window.addEventListener('message', (event: MessageEvent<ToConflicts>) => {
  if (event.data.type === 'state') render(event.data.state);
});
vscode.postMessage({ type: 'ready' });
