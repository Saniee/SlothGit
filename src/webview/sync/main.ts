// The Sync view page (see views/syncView.ts): the current branch, its upstream and Pull / Push split buttons.
import type { FromSync, SyncButton, SyncMenu, SyncState, ToSync } from '../messages';
import './style.css';

const vscode = acquireVsCodeApi<FromSync>();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const name = $<HTMLSpanElement>('name');
const upstream = $<HTMLSpanElement>('upstream');
const fetchButton = $<HTMLButtonElement>('fetch');
const buttons = $<HTMLDivElement>('buttons');
const pull = document.querySelector<HTMLDivElement>('[data-menu="pull"]')!;
const push = document.querySelector<HTMLDivElement>('[data-menu="push"]')!;
const pullButton = pull.querySelector<HTMLButtonElement>('.main')!;
const pushButton = push.querySelector<HTMLButtonElement>('.main')!;

document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((b) =>
  b.addEventListener('click', () => vscode.postMessage({ type: 'run', command: b.dataset.command as SyncButton })),
);
fetchButton.addEventListener('click', () => vscode.postMessage({ type: 'run', command: 'slothgit.sync.fetch' }));
document.querySelectorAll<HTMLButtonElement>('.more').forEach((b) =>
  b.addEventListener('click', () =>
    vscode.postMessage({ type: 'menu', menu: b.closest<HTMLElement>('[data-menu]')!.dataset.menu as SyncMenu }),
  ),
);

function render({ branch, detached, hasRemotes }: SyncState): void {
  fetchButton.classList.toggle('hidden', !hasRemotes);
  buttons.classList.toggle('hidden', !branch);
  upstream.classList.remove('warn');
  if (!branch) {
    name.textContent = detached ? `Detached HEAD at ${detached}` : 'No repository';
    upstream.textContent = '';
  } else {
    const up = branch.upstream;
    const tracking = !!up && !branch.gone;
    name.textContent = branch.name;
    name.title = branch.name;
    upstream.classList.toggle('warn', branch.gone);
    upstream.textContent = !up ? (hasRemotes ? 'not published' : 'no remote') : `→ ${up.name}${branch.gone ? ' (gone)' : ''}`;
    upstream.title = upstream.textContent;

    pullButton.textContent = `↓ Pull${tracking && branch.behind ? ` ${branch.behind}` : ''}`;
    pullButton.disabled = !tracking;
    pullButton.title = tracking ? `Pull from ${up.name}` : 'The branch has no upstream to pull from';
    pull.classList.toggle('primary', tracking && branch.behind > 0);

    pushButton.textContent = tracking ? `↑ Push${branch.ahead ? ` ${branch.ahead}` : ''}` : '↑ Publish Branch';
    pushButton.disabled = !hasRemotes;
    pushButton.title = tracking ? `Push to ${up.name}` : `Push ${branch.name} to a remote and track it`;
    // The button to press next stands out: Pull when behind, otherwise Push when there is something to push.
    push.classList.toggle('primary', tracking ? branch.ahead > 0 && branch.behind === 0 : hasRemotes);
  }
  const visible = [name, upstream, ...(branch ? [pullButton, pushButton] : [])].map((e) => e.textContent).filter(Boolean);
  vscode.postMessage({ type: 'rendered', text: visible.join(' | ') });
}

window.addEventListener('message', (event: MessageEvent<ToSync>) => {
  if (event.data.type === 'state') render(event.data.state);
});
vscode.postMessage({ type: 'ready' });
