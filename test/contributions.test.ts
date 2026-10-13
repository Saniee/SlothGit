// package.json's contributions are written by hand. These checks catch what VS Code itself would silently ignore:
// menu entries for commands that don't exist, commands nothing registers, and menus that drift apart.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { SYNC_MENUS } from '../src/webview/syncMenus';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes;
const commands = new Set<string>(contributes.commands.map((c: { command: string }) => c.command));
const submenus = new Set<string>(contributes.submenus.map((s: { id: string }) => s.id));
const menus: Record<string, MenuEntry[]> = contributes.menus;

/** All TypeScript under src, as one string to search for ids. */
function sources(dir = path.join(root, 'src')): string {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? fs.readFileSync(path.join(dir, e.name), 'utf8') : ''))
    .join('\n');
}
const src = sources();

test('every menu entry points at a contributed command or submenu', () => {
  for (const [menu, entries] of Object.entries(menus)) {
    for (const e of entries) {
      if (e.command) assert.ok(commands.has(e.command), `${menu}: unknown command ${e.command}`);
      if (e.submenu) assert.ok(submenus.has(e.submenu), `${menu}: unknown submenu ${e.submenu}`);
    }
  }
  for (const id of submenus) assert.ok(menus[id]?.length, `submenu ${id} has no entries`);
});

test('every contributed command is registered in the code, and every registered one is contributed', () => {
  for (const id of commands) assert.ok(src.includes(`'${id}'`), `${id} is contributed but never registered`);
  // Registrations are object keys ('slothgit.x': handler) or registerCommand('slothgit.x', …).
  const registered = [...src.matchAll(/'(slothgit\.[\w.]+)'\s*(?::|,\s*\()/g)].map((m) => m[1]);
  for (const id of registered) {
    if (/\.(focus|commits|branches|stashes|reflog|sync|graph)$/.test(id) && !commands.has(id)) continue; // view ids
    assert.ok(commands.has(id), `${id} is registered but not in package.json contributes.commands`);
  }
});

test('every view is created in the code', () => {
  for (const view of contributes.views.scm) assert.ok(src.includes(`'${view.id}'`), `view ${view.id} is never created`);
});

test("the Sync view's right-click menus match its ⌄ quick picks", () => {
  for (const [menu, items] of Object.entries(SYNC_MENUS)) {
    const entries = menus['webview/context'].filter((e) => e.when?.includes(`webviewSection == '${menu}'`) && e.when.includes("'slothgit.sync'"));
    assert.deepEqual(
      entries.map((e) => e.command),
      items.map((i) => i.command),
      `${menu} menu: same commands in the same order`,
    );
    for (const [i, item] of items.entries()) {
      assert.equal(entries[i].when!.includes('!config.slothgit.simpleMode'), !!item.advanced, `${item.command}: hidden in Simple Mode`);
    }
  }
});

test("the Commit Graph's context menu only offers commands the Commits view has", () => {
  // Entries for commit rows: viewItem == commit, a viewItem pattern naming commit (not only refcommit), or anything
  // in the Commits view not limited to some kind of row.
  const commitMenu = (when = '') =>
    /viewItem (=~ \/[^/]*\bcommit\b|== commit\b)/.test(when) || (when.includes('view == slothgit.commits') && !when.includes('viewItem'));
  const inTree = new Set<string>();
  for (const e of menus['view/item/context']) {
    if (!commitMenu(e.when)) continue;
    if (e.command) inTree.add(e.command);
    if (e.submenu) for (const s of menus[e.submenu]) if (s.command) inTree.add(s.command);
  }
  for (const e of menus['webview/context'].filter((x) => x.when?.includes("'slothgit.graph'"))) {
    const ids = e.command ? [e.command] : (menus[e.submenu!] ?? []).map((s) => s.command!);
    for (const id of ids) assert.ok(inTree.has(id), `the graph offers ${id}, which the Commits view's commit menu doesn't`);
  }
});

test('Simple Mode hides the same actions everywhere they appear', () => {
  // An action hidden in Simple Mode in one menu should not show up ungated in another (the Command Palette aside).
  const isGated = (e: MenuEntry) => !!e.when?.includes('!config.slothgit.simpleMode');
  // A submenu hidden wherever it is referenced hides everything in it.
  const hiddenSubmenus = new Set(
    [...submenus].filter((id) =>
      Object.values(menus)
        .flat()
        .filter((e) => e.submenu === id)
        .every(isGated),
    ),
  );
  const gated = new Set<string>();
  const ungated = new Map<string, string>();
  for (const [menu, entries] of Object.entries(menus)) {
    if (menu === 'commandPalette') continue;
    for (const e of entries) {
      const id = e.command ?? e.submenu!;
      if (isGated(e) || hiddenSubmenus.has(menu)) gated.add(id);
      else ungated.set(id, menu);
    }
  }
  // Ways out: leaving Simple Mode, and stopping a bisect that was started before it was turned on.
  const allowed = new Set(['slothgit.simpleMode.off', 'slothgit.bisect.reset']);
  for (const id of gated) {
    if (ungated.has(id) && !allowed.has(id)) assert.fail(`${id} is hidden in Simple Mode but still shown in ${ungated.get(id)}`);
  }
});
