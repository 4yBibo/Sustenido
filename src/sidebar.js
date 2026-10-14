// Folder tree: lazy (one folder per request), keyboard-navigable (WAI-ARIA tree pattern).
import { call } from './bridge.js';
import { settings, update } from './settings.js';

const ICON = {
  folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.38c.4 0 .78.16 1.06.44l1.12 1.12c.28.28.66.44 1.06.44H16c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5z"/></svg>',
  note: '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" fill-rule="evenodd" d="M5 3h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 4.75v1.5h6v-1.5zm0 3v1.5h4v-1.5z"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 6l4 4-4 4"/></svg>',
};

const basename = p => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const key = p => p.toLowerCase();
export const isInside = (path, dir) => !!dir && key(path).startsWith(key(dir).replace(/[\\/]+$/, '') + '\\');

export function createSidebar({ tree, title, onOpen }) {
  let root = null;
  let activePath = null;
  let renderSeq = 0;
  const expanded = new Set((settings.expanded ?? []).map(key));
  const cache = new Map();

  async function load(dir) {
    if (cache.has(key(dir))) return cache.get(key(dir));
    let entries = [];
    try { entries = await call('list', { dir }); } catch { /* unreadable folder renders empty */ }
    cache.set(key(dir), entries);
    return entries;
  }

  async function level(dir, depth) {
    const ul = document.createElement('ul');
    ul.setAttribute('role', depth ? 'group' : 'none');
    for (const e of await load(dir)) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `node ${e.dir ? 'folder' : 'note'}`;
      node.setAttribute('role', 'treeitem');
      node.tabIndex = -1;
      node.dataset.path = e.path;
      node.dataset.dir = String(e.dir);
      node.style.setProperty('--depth', depth);
      node.title = e.name;
      node.innerHTML = e.dir ? `<span class="twisty">${ICON.chevron}</span>${ICON.folder}<span class="label"></span>` : `${ICON.note}<span class="label"></span>`;
      node.querySelector('.label').textContent = e.name;
      const open = e.dir && expanded.has(key(e.path));
      if (e.dir) node.setAttribute('aria-expanded', String(open));
      if (!e.dir && activePath && key(e.path) === key(activePath)) node.setAttribute('aria-current', 'page');
      li.append(node);
      if (open) li.append(await level(e.path, depth + 1));
      ul.append(li);
    }
    return ul;
  }

  async function render() {
    const seq = ++renderSeq;
    title.textContent = root ? basename(root) : 'Sustenido';
    title.title = root ?? '';
    if (!root) {
      tree.replaceChildren(empty('Nenhuma pasta aberta'));
      return;
    }
    const focused = document.activeElement?.closest?.('.node')?.dataset.path;
    const list = await level(root, 0);
    if (seq !== renderSeq) return; // a newer render won the race
    tree.replaceChildren(list.children.length ? list : empty('Nenhuma nota nesta pasta'));
    const nodes = [...tree.querySelectorAll('.node')];
    const current = nodes.find(n => n.dataset.path === focused) ?? tree.querySelector('[aria-current]') ?? nodes[0];
    if (current) current.tabIndex = 0;
    if (focused && current?.dataset.path === focused) current.focus();
  }

  function empty(text) {
    const box = document.createElement('div');
    box.className = 'tree-empty';
    const p = document.createElement('p');
    p.textContent = text;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = 'Escolher pasta…';
    b.addEventListener('click', pickFolder);
    box.append(p, b);
    return box;
  }

  function toggle(path, open = !expanded.has(key(path))) {
    if (open) expanded.add(key(path)); else expanded.delete(key(path));
    update({ expanded: [...expanded] });
    render();
  }

  async function pickFolder() {
    const dir = await call('pickFolder', { start: root ?? '' }).catch(() => null);
    if (!dir) return;
    update({ root: dir });
    root = dir;
    render();
  }

  tree.addEventListener('click', e => {
    const node = e.target.closest('.node');
    if (!node) return;
    for (const n of tree.querySelectorAll('.node[tabindex="0"]')) n.tabIndex = -1;
    node.tabIndex = 0;
    if (node.dataset.dir === 'true') toggle(node.dataset.path);
    else onOpen(node.dataset.path, { newTab: e.ctrlKey || e.metaKey });
  });
  tree.addEventListener('auxclick', e => {
    const node = e.target.closest('.node.note');
    if (node && e.button === 1) onOpen(node.dataset.path, { newTab: true });
  });
  tree.addEventListener('keydown', e => {
    const nodes = [...tree.querySelectorAll('.node')];
    const node = e.target.closest('.node');
    const i = nodes.indexOf(node);
    if (i < 0) return;
    const focus = n => { if (!n) return; node.tabIndex = -1; n.tabIndex = 0; n.focus(); };
    const isDir = node.dataset.dir === 'true';
    const isOpen = node.getAttribute('aria-expanded') === 'true';
    switch (e.key) {
      case 'ArrowDown': focus(nodes[i + 1]); break;
      case 'ArrowUp': focus(nodes[i - 1]); break;
      case 'Home': focus(nodes[0]); break;
      case 'End': focus(nodes.at(-1)); break;
      case 'ArrowRight':
        if (isDir && !isOpen) toggle(node.dataset.path, true);
        else if (isDir) focus(nodes[i + 1]);
        break;
      case 'ArrowLeft':
        if (isDir && isOpen) toggle(node.dataset.path, false);
        else focus(node.closest('ul[role="group"]')?.previousElementSibling);
        break;
      case 'Enter':
      case ' ':
        node.click();
        break;
      default: return;
    }
    e.preventDefault();
  });

  return {
    get root() { return root; },
    pickFolder,
    setRoot(dir) {
      if (dir && root && key(dir) === key(root)) return;
      root = dir;
      render();
    },
    /** Highlights the open note and expands its ancestors so it is visible. */
    setActive(path) {
      activePath = path;
      if (path && isInside(path, root)) {
        let dir = path.replace(/[\\/][^\\/]+$/, '');
        while (isInside(dir + '\\x', root) && key(dir) !== key(root)) {
          expanded.add(key(dir));
          dir = dir.replace(/[\\/][^\\/]+$/, '');
        }
      }
      render();
    },
    refresh() {
      cache.clear();
      render();
    },
  };
}
