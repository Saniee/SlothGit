// The rebase editor page (see views/rebasePanel.ts): the commits to rebase, newest first, each with an action.
// Every change to the order or the actions asks the extension which steps would conflict.
import { planProblem, type PlannedStep, type TodoAction } from '../../git/todo';
import type { FromRebase, RebaseCommit, RebaseEditorState, ToRebase } from '../messages';
import './style.css';

const vscode = acquireVsCodeApi<FromRebase>();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $<HTMLHeadingElement>('title');
const list = $<HTMLOListElement>('steps');
const status = $<HTMLDivElement>('status');
const startButton = $<HTMLButtonElement>('start');
const pauseButton = $<HTMLButtonElement>('pause');

const ACTIONS: { action: TodoAction; help: string }[] = [
  { action: 'pick', help: 'Keep the commit as it is' },
  { action: 'reword', help: 'Keep the changes, change the message' },
  { action: 'edit', help: 'Stop after applying it, so you can amend or split it' },
  { action: 'squash', help: 'Combine into the commit below, keeping both messages' },
  { action: 'fixup', help: 'Combine into the commit below, discarding this message' },
  { action: 'drop', help: 'Remove the commit and its changes' },
];
const combines = (action: TodoAction) => action === 'squash' || action === 'fixup';

let commits = new Map<string, RebaseCommit>();
let original: string[] = [];
/** Display order: newest first. */
let order: string[] = [];
let actions = new Map<string, TodoAction>();
/** Edited messages of reword steps. */
let messages = new Map<string, string>();

let conflicts: Record<string, string[]> = {};
let checkError: string | undefined;
let checking = false;
let checkId = 0;
let checkTimer: ReturnType<typeof setTimeout> | undefined;

/** The plan as git applies it: oldest first. */
const steps = (): PlannedStep[] => [...order].reverse().map((sha) => ({ sha, action: actions.get(sha)! }));

function load(state: RebaseEditorState): void {
  title.textContent = `Interactive Rebase: ${state.title}`;
  pauseButton.classList.toggle('hidden', !state.canPause);
  commits = new Map(state.commits.map((c) => [c.sha, c]));
  original = state.commits.map((c) => c.sha).reverse();
  reset();
}

function reset(): void {
  order = [...original];
  actions = new Map(original.map((sha) => [sha, 'pick']));
  messages = new Map();
  conflicts = {};
  changed();
}

/** After a change to the order or the actions: draw, then check for conflicts once the changes settle. */
function changed(): void {
  checking = true;
  checkError = undefined;
  render();
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => vscode.postMessage({ type: 'check', id: ++checkId, steps: steps() }), 250);
}

function move(sha: string, to: number): void {
  const from = order.indexOf(sha);
  to = Math.max(0, Math.min(order.length - 1, to));
  if (from === to) return;
  order.splice(from, 1);
  order.splice(to, 0, sha);
  changed();
  list.querySelector<HTMLElement>(`[data-sha="${sha}"]`)?.focus();
}

function render(): void {
  // Keep focus and the cursor in a message being typed while the list is redrawn.
  const active = document.activeElement as HTMLElement | null;
  const focused = active?.closest<HTMLElement>('.step')?.dataset.sha;
  const inMessage = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : undefined;

  list.replaceChildren(...order.map((sha, i) => row(sha, i)));

  if (focused) {
    const item = list.querySelector<HTMLElement>(`[data-sha="${focused}"]`);
    const textarea = item?.querySelector('textarea');
    if (inMessage && textarea) {
      textarea.focus();
      textarea.setSelectionRange(inMessage[0], inMessage[1]);
    } else if (active?.tagName === 'SELECT') item?.querySelector('select')?.focus();
    else item?.focus();
  }
  renderStatus();
}

function row(sha: string, index: number): HTMLLIElement {
  const commit = commits.get(sha)!;
  const action = actions.get(sha)!;
  const item = element('li', `step ${action}${combines(action) ? ' combine' : ''}`);
  item.dataset.sha = sha;
  item.tabIndex = 0;

  const handle = element('span', 'handle', '⠿');
  handle.title = 'Drag to reorder';
  const select = element('select');
  select.title = 'What happens to this commit';
  select.setAttribute('aria-label', `Action for ${commit.subject}`);
  for (const { action: value, help } of ACTIONS) {
    const option = element('option', '', value);
    option.value = value;
    option.title = help;
    select.append(option);
  }
  select.value = action;
  select.addEventListener('change', () => {
    actions.set(sha, select.value as TodoAction);
    changed();
  });

  const meta = element('span', 'meta', `${commit.author}, ${commit.relDate}`);
  if (commit.pushed) {
    const pushed = element('span', 'pushed', 'pushed');
    pushed.title = 'Already on the upstream branch: rewriting it means a force push';
    meta.append(pushed);
  }
  const moves = element('span', 'moves');
  for (const [label, delta] of [['↑', -1], ['↓', 1]] as const) {
    const button = element('button', '', label);
    button.title = delta < 0 ? 'Move Up (Alt+↑)' : 'Move Down (Alt+↓)';
    button.setAttribute('aria-label', button.title);
    button.disabled = delta < 0 ? index === 0 : index === order.length - 1;
    button.addEventListener('click', () => move(sha, index + delta));
    moves.append(button);
  }
  const subject = element('span', 'subject', action === 'reword' ? firstLine(messages.get(sha) ?? commit.message) : commit.subject);
  subject.title = commit.message;
  item.append(handle, select, element('span', 'sha', commit.shortSha), subject, meta, moves);

  if (combines(action)) {
    const into = order.slice(index + 1).find((other) => actions.get(other) !== 'drop');
    item.append(element('div', 'note', into ? `Combined into ${commits.get(into)!.subject}` : 'There is no commit below to combine it with.'));
  }
  if (action === 'reword') {
    const textarea = element('textarea');
    textarea.value = messages.get(sha) ?? commit.message;
    textarea.setAttribute('aria-label', `New message for ${commit.subject}`);
    textarea.addEventListener('input', () => {
      messages.set(sha, textarea.value);
      subject.textContent = firstLine(textarea.value);
      renderStatus();
    });
    item.append(textarea);
  }
  const files = action === 'drop' ? undefined : conflicts[sha];
  if (files?.length) item.append(element('div', 'conflict', `⚠ Likely to conflict in ${files.join(', ')}`));

  draggable(item, sha);
  item.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    move(sha, order.indexOf(sha) + (e.key === 'ArrowUp' ? -1 : 1));
  });
  return item;
}

let dragged: string | undefined;

function draggable(item: HTMLLIElement, sha: string): void {
  // Only drags from the row itself, so text in the message box and the action list can still be selected.
  item.addEventListener('mousedown', (e) => {
    item.draggable = !(e.target as HTMLElement).closest('select, textarea, button');
  });
  item.addEventListener('dragstart', (e) => {
    dragged = sha;
    item.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', sha);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => {
    dragged = undefined;
    item.draggable = false;
    list.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  item.addEventListener('dragover', (e) => {
    if (!dragged || dragged === sha) return;
    e.preventDefault();
    const after = isLowerHalf(item, e);
    item.classList.toggle('drop-before', !after);
    item.classList.toggle('drop-after', after);
  });
  item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragged || dragged === sha) return;
    const target = order.indexOf(sha) + (isLowerHalf(item, e) ? 1 : 0);
    // Removing the dragged row first shifts the rows below it up by one.
    move(dragged, order.indexOf(dragged) < target ? target - 1 : target);
  });
}

const isLowerHalf = (item: HTMLElement, e: DragEvent) => {
  const box = item.getBoundingClientRect();
  return e.clientY > box.top + box.height / 2;
};

function renderStatus(): void {
  const current = steps();
  const problem = planProblem(current);
  const count = current.filter((s) => s.action !== 'drop' && conflicts[s.sha]?.length).length;
  let text: string;
  let kind = '';
  if (problem) {
    [text, kind] = [problem, 'error'];
  } else if (checking) {
    text = 'Checking for conflicts…';
  } else if (checkError) {
    [text, kind] = [checkError, 'warn'];
  } else if (count) {
    text =
      `${count === 1 ? '1 commit is' : `${count} commits are`} likely to conflict (marked ⚠). You can still start: ` +
      'the rebase stops at each one so you can resolve it. Steps after a conflict were checked as if you kept the commit’s version.';
    kind = 'warn';
  } else {
    text = 'No conflicts expected.';
  }
  status.textContent = text;
  status.className = `status ${kind}`;
  startButton.disabled = !!problem;
  vscode.postMessage({
    type: 'rendered',
    rows: order.map((sha) => {
      const action = actions.get(sha)!;
      const conflict = action !== 'drop' && conflicts[sha]?.length ? ' ⚠' : '';
      return `${action} ${firstLine(messages.get(sha) ?? commits.get(sha)!.subject)}${conflict}`;
    }),
    status: text,
  });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

const firstLine = (message: string) => message.split('\n')[0];

$<HTMLButtonElement>('reset').addEventListener('click', reset);
$<HTMLButtonElement>('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
pauseButton.addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
startButton.addEventListener('click', () => {
  const current = steps();
  const edited = Object.fromEntries(current.filter((s) => s.action === 'reword' && messages.has(s.sha)).map((s) => [s.sha, messages.get(s.sha)!]));
  vscode.postMessage({ type: 'start', steps: current, messages: edited });
});

window.addEventListener('message', (event: MessageEvent<ToRebase>) => {
  const message = event.data;
  if (message.type === 'state') load(message.state);
  else if (message.type === 'apply') {
    order = message.steps.map((s) => s.sha).reverse();
    actions = new Map(message.steps.map((s) => [s.sha, s.action]));
    changed();
  }
  else if (message.type === 'conflicts' && message.id === checkId) {
    conflicts = message.conflicts;
    checkError = message.error;
    checking = false;
    render();
  }
});
vscode.postMessage({ type: 'ready' });
