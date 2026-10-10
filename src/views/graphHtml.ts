import * as crypto from 'node:crypto';
import type * as vscode from 'vscode';

// The graph page. Rows are built with DOM APIs (never innerHTML), so commit messages can't inject markup.
// The script below avoids backticks and "${" so it can live inside this template string.

export function graphHtml(webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Commit Graph</title>
<style>
  :root {
    --row: 26px;
    --lane: 14px;
    --l0: var(--vscode-charts-blue);
    --l1: var(--vscode-charts-green);
    --l2: var(--vscode-charts-orange);
    --l3: var(--vscode-charts-purple);
    --l4: var(--vscode-charts-red);
    --l5: var(--vscode-charts-yellow);
    --l6: var(--vscode-terminal-ansiCyan);
    --l7: var(--vscode-terminal-ansiMagenta);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column; overflow: hidden;
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  }
  header {
    display: flex; gap: 8px; align-items: center; padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  header input[type=search] {
    flex: 0 1 320px; min-width: 120px; padding: 3px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  header input[type=search]:focus { border-color: var(--vscode-focusBorder); }
  header label { display: flex; gap: 4px; align-items: center; cursor: pointer; user-select: none; }
  header button {
    padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  header button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  header .status { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  /* The graph column is at least as wide as its header, however few lanes there are. */
  .columns, .row { display: grid; grid-template-columns: max(var(--graph-width, 40px), 56px) minmax(200px, 1fr) 160px 110px 72px; align-items: center; }
  .columns > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .columns > span + span { padding-left: 8px; }
  .columns {
    padding: 0 10px; height: 24px; color: var(--vscode-descriptionForeground);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  #list { flex: 1 1 auto; overflow: auto; outline: none; }
  .row { height: var(--row); padding: 0 10px; cursor: default; white-space: nowrap; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  #list:focus .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .row.other .subject, .row.other .author, .row.other .date { opacity: 0.6; }
  .row svg { display: block; overflow: visible; }
  .desc { display: flex; gap: 4px; align-items: center; overflow: hidden; min-width: 0; padding-left: 8px; }
  .subject { overflow: hidden; text-overflow: ellipsis; }
  .row.head .subject { font-weight: 600; }
  .pill {
    flex: none; padding: 0 6px; border-radius: 9px; font-size: 11px; line-height: 16px;
    border: 1px solid currentColor; max-width: 220px; overflow: hidden; text-overflow: ellipsis;
  }
  .pill.head { color: var(--vscode-editor-background); background: var(--vscode-charts-green); border-color: var(--vscode-charts-green); font-weight: 600; }
  .pill.local { color: var(--vscode-charts-green); }
  .pill.remote { color: var(--vscode-charts-blue); }
  .pill.tag { color: var(--vscode-charts-yellow); }
  .author, .date, .sha { overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); padding-left: 8px; }
  .author { display: flex; gap: 6px; align-items: center; }
  .author .avatars { display: flex; flex: none; }
  .author .avatars .avatar + .avatar { margin-left: -5px; box-shadow: 0 0 0 1px var(--vscode-editor-background); }
  .author .names { overflow: hidden; text-overflow: ellipsis; }
  .avatar {
    flex: none; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center;
    font-size: 9px; font-weight: 600; color: var(--vscode-editor-background);
  }
  .sha { font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .merged .sha { color: var(--vscode-charts-green); }
  .pushed .sha { color: var(--vscode-charts-yellow); }
  .unpushed .sha { color: var(--vscode-charts-red); }
  #details {
    flex: 0 0 auto; max-height: 40%; overflow: auto; display: none; padding: 10px 14px;
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-focusBorder));
  }
  #details.open { display: block; }
  #details h3 { margin: 0 0 4px; font-size: 1.05em; }
  #details .meta { color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  #details pre { margin: 0 0 10px; white-space: pre-wrap; font-family: inherit; }
  #details .file { display: flex; gap: 8px; padding: 1px 4px; cursor: pointer; border-radius: 2px; }
  #details .file:hover { background: var(--vscode-list-hoverBackground); }
  #details .st { width: 14px; text-align: center; font-weight: 600; }
  .st-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .st-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .st-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .st-R, .st-C { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .empty { padding: 20px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <input id="search" type="search" placeholder="Search message, author or SHA" aria-label="Search commits">
  <label><input id="all" type="checkbox" checked> All branches</label>
  <button id="refresh" title="Refresh">Refresh</button>
  <span class="status" id="status"></span>
</header>
<div class="columns"><span>Graph</span><span>Description</span><span>Author</span><span>Date</span><span>SHA</span></div>
<div id="list" tabindex="0" role="listbox" aria-label="Commits"></div>
<div id="details" aria-live="polite"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const ROW = 26, LANE = 14, PAD = 7, COLORS = 8;
  const list = document.getElementById('list');
  const details = document.getElementById('details');
  const search = document.getElementById('search');
  const all = document.getElementById('all');
  const statusEl = document.getElementById('status');
  let rows = [];
  let selected = -1;
  let searchTimer;

  const SVG = 'http://www.w3.org/2000/svg';
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function color(i) { return 'var(--l' + (i % COLORS) + ')'; }
  function x(lane) { return PAD + lane * LANE; }

  function graphSvg(row, width) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(ROW));
    const mid = ROW / 2;
    for (const line of row.graph.lines) {
      const p = document.createElementNS(SVG, 'path');
      const x1 = x(line.from), x2 = x(line.to);
      let d;
      if (line.part === 'through') d = 'M' + x1 + ' 0 V' + ROW;
      else if (line.part === 'top') d = x1 === x2 ? 'M' + x1 + ' 0 V' + mid : 'M' + x1 + ' 0 C' + x1 + ' ' + mid + ' ' + x2 + ' 0 ' + x2 + ' ' + mid;
      else d = x1 === x2 ? 'M' + x1 + ' ' + mid + ' V' + ROW : 'M' + x1 + ' ' + mid + ' C' + x1 + ' ' + ROW + ' ' + x2 + ' ' + mid + ' ' + x2 + ' ' + ROW;
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

  function initials(name) {
    const parts = name.split(/\\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function hue(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
    return h;
  }

  function render(state) {
    list.textContent = '';
    details.className = '';
    selected = -1;
    const width = Math.max(1, ...rows.map(function (r) { return r.graph.width; })) * LANE + PAD;
    document.documentElement.style.setProperty('--graph-width', width + 'px');
    if (!rows.length) {
      list.appendChild(el('div', 'empty', state.search ? 'No commits match "' + state.search + '".' : 'No commits.'));
    }
    rows.forEach(function (r, i) {
      const row = el('div', 'row' + (r.onHead ? '' : ' other') + (r.head ? ' head' : '') + (r.merged ? ' merged' : r.pushed === false ? ' unpushed' : r.pushed ? ' pushed' : ''));
      row.setAttribute('role', 'option');
      row.dataset.index = String(i);
      row.dataset.vscodeContext = JSON.stringify({
        webviewSection: 'commit', sha: r.sha, codegitOnHead: r.onHead, preventDefaultContextMenuItems: true,
      });
      const graph = el('div');
      graph.appendChild(graphSvg(r, width));
      const desc = el('div', 'desc');
      for (const ref of r.refs) {
        const pill = el('span', 'pill ' + ref.kind, ref.name);
        pill.title = { head: 'Current branch', local: 'Branch', remote: 'Remote branch', tag: 'Tag' }[ref.kind] + ': ' + ref.name;
        desc.appendChild(pill);
      }
      const subject = el('span', 'subject', r.subject);
      subject.title = r.subject;
      desc.appendChild(subject);
      const author = el('div', 'author');
      const people = [{ name: r.author, email: r.email }].concat(r.coAuthors);
      const avatars = el('span', 'avatars');
      for (const p of people) {
        const avatar = el('span', 'avatar', initials(p.name));
        avatar.style.background = 'hsl(' + hue(p.email || p.name) + ', 55%, 60%)';
        avatars.appendChild(avatar);
      }
      author.appendChild(avatars);
      author.appendChild(el('span', 'names', people.map(function (p) { return p.name; }).join(', ')));
      author.title = people.map(function (p, i) { return (i ? 'Co-author: ' : 'Author: ') + p.name + (p.email ? ' <' + p.email + '>' : ''); }).join('\\n');
      const date = el('div', 'date', r.relDate);
      date.title = new Date(r.date).toLocaleString();
      const sha = el('div', 'sha', r.shortSha);
      sha.title = r.sha + (r.merged ? ' (on the main branch)' : r.pushed === false ? ' (not pushed yet)' : r.pushed ? ' (pushed)' : '');
      row.append(graph, desc, author, date, sha);
      list.appendChild(row);
    });
    const count = rows.length + (state.limit ? '+' : '') + ' commits';
    statusEl.textContent = (state.search ? count + ' matching' : count) + (state.all ? ' on all branches' : ' on this branch');
  }

  function select(i, scroll) {
    if (i < 0 || i >= rows.length) return;
    const prev = list.children[selected];
    if (prev) prev.classList.remove('selected');
    selected = i;
    const row = list.children[i];
    row.classList.add('selected');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
    vscode.postMessage({ type: 'select', sha: rows[i].sha });
  }

  function showDetails(m) {
    const r = rows[selected];
    if (!r || r.sha !== m.sha) return;
    details.textContent = '';
    const lines = m.message.split('\\n');
    details.appendChild(el('h3', '', lines[0]));
    const parents = r.parents.map(function (p) { return p.slice(0, 7); }).join(', ');
    details.appendChild(el('div', 'meta',
      r.author + ' <' + r.email + '>' + r.coAuthors.map(function (p) { return ', with ' + p.name + (p.email ? ' <' + p.email + '>' : ''); }).join('') + ', ' + new Date(r.date).toLocaleString() + ' · ' + r.sha.slice(0, 10) + (parents ? ' · parents ' + parents : '')));
    const body = lines.slice(1).join('\\n').trim();
    if (body) details.appendChild(el('pre', '', body));
    for (const f of m.files) {
      const file = el('div', 'file');
      file.appendChild(el('span', 'st st-' + f.status[0], f.status[0]));
      file.appendChild(el('span', '', f.oldPath ? f.oldPath + ' → ' + f.path : f.path));
      file.title = 'Open diff';
      file.addEventListener('click', function () { vscode.postMessage({ type: 'openFile', sha: m.sha, path: f.path }); });
      details.appendChild(file);
    }
    details.className = 'open';
  }

  list.addEventListener('mousedown', function (e) {
    const row = e.target.closest('.row');
    if (row) select(Number(row.dataset.index), false);
  });
  list.addEventListener('dblclick', function (e) {
    const row = e.target.closest('.row');
    if (row) vscode.postMessage({ type: 'open', sha: rows[Number(row.dataset.index)].sha });
  });
  list.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { select(Math.min(rows.length - 1, selected + 1), true); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { select(Math.max(0, selected - 1), true); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[selected]) vscode.postMessage({ type: 'open', sha: rows[selected].sha });
  });
  search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { vscode.postMessage({ type: 'search', query: search.value }); }, 300);
  });
  all.addEventListener('change', function () { vscode.postMessage({ type: 'allBranches', value: all.checked }); });
  document.getElementById('refresh').addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); });

  window.addEventListener('message', function (event) {
    const m = event.data;
    if (m.type === 'rows') {
      const keep = rows[selected] && rows[selected].sha;
      rows = m.rows;
      all.checked = m.state.all;
      render(m.state);
      const again = rows.findIndex(function (r) { return r.sha === keep; });
      if (again >= 0) select(again, false);
    } else if (m.type === 'details') {
      showDetails(m);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
