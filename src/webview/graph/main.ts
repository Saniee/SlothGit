// The Commit Graph page (see views/graphPanel.ts). Rows are built with DOM APIs, never innerHTML, so commit
// messages can't inject markup.
import type { FromGraph, GraphCommit, GraphFile, GraphState, ToGraph } from '../messages';
import './style.css';

const vscode = acquireVsCodeApi<FromGraph>();
const ROW = 26;
const LANE = 14;
const PAD = 7;
const COLORS = 8;
const SVG = 'http://www.w3.org/2000/svg';
const REF_KINDS: Record<string, string> = { head: 'Current branch', local: 'Branch', remote: 'Remote branch', tag: 'Tag' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLDivElement>('list');
const details = $<HTMLDivElement>('details');
const search = $<HTMLInputElement>('search');
const all = $<HTMLInputElement>('all');
const statusEl = $<HTMLSpanElement>('status');

let rows: GraphCommit[] = [];
let selected = -1;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const color = (i: number) => `var(--l${i % COLORS})`;
const x = (lane: number) => PAD + lane * LANE;

function graphSvg(row: GraphCommit, width: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(ROW));
  const mid = ROW / 2;
  for (const line of row.graph.lines) {
    const p = document.createElementNS(SVG, 'path');
    const x1 = x(line.from);
    const x2 = x(line.to);
    let d: string;
    if (line.part === 'through') d = `M${x1} 0 V${ROW}`;
    else if (line.part === 'top') d = x1 === x2 ? `M${x1} 0 V${mid}` : `M${x1} 0 C${x1} ${mid} ${x2} 0 ${x2} ${mid}`;
    else d = x1 === x2 ? `M${x1} ${mid} V${ROW}` : `M${x1} ${mid} C${x1} ${ROW} ${x2} ${mid} ${x2} ${ROW}`;
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-width', '2');
    p.style.stroke = color(line.color);
    svg.appendChild(p);
  }
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', String(x(row.graph.lane)));
  dot.setAttribute('cy', String(mid));
  dot.setAttribute('r', row.head ? '5.5' : '4');
  dot.setAttribute('stroke-width', '2');
  dot.style.stroke = color(row.graph.color);
  // Merge commits and HEAD are drawn as rings.
  dot.style.fill = row.parents.length > 1 || row.head ? 'var(--vscode-editor-background)' : color(row.graph.color);
  svg.appendChild(dot);
  return svg;
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function hue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

/** The SHA's colour class and tooltip suffix, as in the Commits view's icons. */
function pushState(r: GraphCommit): { cls: string; note: string } {
  if (r.merged) return { cls: ' merged', note: ' (on the main branch)' };
  if (r.pushed === false) return { cls: ' unpushed', note: ' (not pushed yet)' };
  if (r.pushed) return { cls: ' pushed', note: ' (pushed)' };
  return { cls: '', note: '' };
}

function rowElement(r: GraphCommit, i: number, width: number): HTMLDivElement {
  const push = pushState(r);
  const row = el('div', `row${r.onHead ? '' : ' other'}${r.head ? ' head' : ''}${push.cls}`);
  row.setAttribute('role', 'option');
  row.dataset.index = String(i);
  // VS Code's webview context menu (package.json webview/context) reads this.
  row.dataset.vscodeContext = JSON.stringify({
    webviewSection: 'commit',
    sha: r.sha,
    slothgitOnHead: r.onHead,
    preventDefaultContextMenuItems: true,
  });

  const graph = el('div');
  graph.appendChild(graphSvg(r, width));

  const desc = el('div', 'desc');
  for (const ref of r.refs) {
    const pill = el('span', `pill ${ref.kind}`, ref.name);
    pill.title = `${REF_KINDS[ref.kind]}: ${ref.name}`;
    desc.appendChild(pill);
  }
  const subject = el('span', 'subject', r.subject);
  subject.title = r.subject;
  desc.appendChild(subject);

  const author = el('div', 'author');
  const people = [{ name: r.author, email: r.email }, ...r.coAuthors];
  const avatars = el('span', 'avatars');
  for (const p of people) {
    const avatar = el('span', 'avatar', initials(p.name));
    avatar.style.background = `hsl(${hue(p.email || p.name)}, 55%, 60%)`;
    avatars.appendChild(avatar);
  }
  author.append(avatars, el('span', 'names', people.map((p) => p.name).join(', ')));
  author.title = people.map((p, i) => `${i ? 'Co-author' : 'Author'}: ${p.name}${p.email ? ` <${p.email}>` : ''}`).join('\n');

  const date = el('div', 'date', r.relDate);
  date.title = new Date(r.date).toLocaleString();
  const sha = el('div', 'sha', r.shortSha);
  sha.title = r.sha + push.note;

  row.append(graph, desc, author, date, sha);
  return row;
}

function render(state: GraphState): void {
  list.textContent = '';
  details.className = '';
  selected = -1;
  const width = Math.max(1, ...rows.map((r) => r.graph.width)) * LANE + PAD;
  document.documentElement.style.setProperty('--graph-width', `${width}px`);
  if (!rows.length) list.appendChild(el('div', 'empty', state.search ? `No commits match "${state.search}".` : 'No commits.'));
  rows.forEach((r, i) => list.appendChild(rowElement(r, i, width)));
  const count = `${rows.length}${state.limit ? '+' : ''} commits`;
  statusEl.textContent = (state.search ? `${count} matching` : count) + (state.all ? ' on all branches' : ' on this branch');
  vscode.postMessage({ type: 'rendered', rows: rows.length });
}

function select(i: number, scroll: boolean): void {
  if (i < 0 || i >= rows.length) return;
  list.children[selected]?.classList.remove('selected');
  selected = i;
  const row = list.children[i];
  row.classList.add('selected');
  if (scroll) row.scrollIntoView({ block: 'nearest' });
  vscode.postMessage({ type: 'select', sha: rows[i].sha });
}

function showDetails(m: { sha: string; message: string; files: GraphFile[] }): void {
  const r = rows[selected];
  if (!r || r.sha !== m.sha) return;
  details.textContent = '';
  const lines = m.message.split('\n');
  details.appendChild(el('h3', '', lines[0]));
  const parents = r.parents.map((p) => p.slice(0, 7)).join(', ');
  const coAuthors = r.coAuthors.map((p) => `, with ${p.name}${p.email ? ` <${p.email}>` : ''}`).join('');
  details.appendChild(
    el(
      'div',
      'meta',
      `${r.author} <${r.email}>${coAuthors}, ${new Date(r.date).toLocaleString()} · ${r.sha.slice(0, 10)}${parents ? ` · parents ${parents}` : ''}`,
    ),
  );
  const body = lines.slice(1).join('\n').trim();
  if (body) details.appendChild(el('pre', '', body));
  for (const f of m.files) {
    const file = el('div', 'file');
    file.append(el('span', `st st-${f.status[0]}`, f.status[0]), el('span', '', f.oldPath ? `${f.oldPath} → ${f.path}` : f.path));
    file.title = 'Open diff';
    file.addEventListener('click', () => vscode.postMessage({ type: 'openFile', sha: m.sha, path: f.path }));
    details.appendChild(file);
  }
  details.className = 'open';
}

const rowIndex = (target: EventTarget | null) => {
  const row = (target as Element | null)?.closest<HTMLElement>('.row');
  return row ? Number(row.dataset.index) : undefined;
};

list.addEventListener('mousedown', (e) => {
  const i = rowIndex(e.target);
  if (i !== undefined) select(i, false);
});
list.addEventListener('dblclick', (e) => {
  const i = rowIndex(e.target);
  if (i !== undefined) vscode.postMessage({ type: 'open', sha: rows[i].sha });
});
list.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    select(Math.min(rows.length - 1, selected + 1), true);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    select(Math.max(0, selected - 1), true);
    e.preventDefault();
  } else if (e.key === 'Enter' && rows[selected]) {
    vscode.postMessage({ type: 'open', sha: rows[selected].sha });
  }
});
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', query: search.value }), 300);
});
all.addEventListener('change', () => vscode.postMessage({ type: 'allBranches', value: all.checked }));
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

window.addEventListener('message', (event: MessageEvent<ToGraph>) => {
  const m = event.data;
  if (m.type === 'rows') {
    const keep = rows[selected]?.sha;
    rows = m.rows;
    all.checked = m.state.all;
    render(m.state);
    const again = rows.findIndex((r) => r.sha === keep);
    if (again >= 0) select(again, false);
  } else if (m.type === 'details') {
    showDetails(m);
  }
});
vscode.postMessage({ type: 'ready' });
