import { Text } from '@codemirror/state';
import { redo, selectAll, undo } from '@codemirror/commands';
import { findNext, findPrevious, gotoLine, openSearchPanel } from '@codemirror/search';
import { call, on } from './bridge.js';
import { EditorView } from '@codemirror/view';
import { createEditor, currentBlock, dateTime, insertLink, insertText, outline, setBlock, setHighlight, setTextColor, stats, toggleInline } from './editor.js';
import { MARK_COLORS, TEXT_COLORS } from './markdown.js';
import WELCOME from './welcome.md';
import { createSidebar, isInside } from './sidebar.js';
import { applySettings, flushSettings, isDark, isGlass, onSettingsChange, openSettings, setGlassAvailable, settings, update } from './settings.js';
import { renderHtml, renderProperties, splitFrontmatter } from './properties.js';
import { fillDiagram, hydrateDiagrams } from './diagrams.js';
import { highlightBlocks } from './highlight.js';

const $ = id => document.getElementById(id);
const num = new Intl.NumberFormat('pt-BR');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const basename = p => p.split(/[\\/]/).pop();
const parentDir = p => p.replace(/[\\/][^\\/]+$/, '');
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const ENCODINGS = [
  { id: 'utf-8', name: 'UTF-8' }, { id: 'utf-8-bom', name: 'UTF-8 com BOM' },
  { id: 'utf-16le', name: 'UTF-16 LE' }, { id: 'utf-16be', name: 'UTF-16 BE' }, { id: 'ansi', name: 'ANSI' },
];
const EOLS = [{ id: 'crlf', name: 'Windows (CRLF)' }, { id: 'lf', name: 'Unix (LF)' }];
const BLOCK_NAMES = { p: 'Parágrafo', h1: 'Título 1', h2: 'Título 2', h3: 'Título 3', quote: 'Citação', bullet: 'Lista', number: 'Lista numerada', task: 'Tarefas' };

applySettings();

const scroller = $('scroller');
const view = $('view');
const titleEl = $('inline-title');
const bubble = $('bubble');
const popover = $('popover');

// ── Editor ──────────────────────────────────────────

let wordCount = 0;
const editor = createEditor({
  parent: $('editor'),
  preview: {
    renderBlock: renderHtml,
    renderProperties,
    renderDiagram: fillDiagram,
    isDark,
    openLink: href => followLink(href),
  },
  onDocChange: () => {
    if (!active) return;
    wordCount = countWords(editor.view.state.doc);
    const dirty = !editor.view.state.doc.eq(active.savedDoc);
    if (dirty !== active.dirty) { active.dirty = dirty; renderTabs(); renderTitle(); }
    scheduleSession();
    scheduleOutline();
  },
  onSelection: () => { if (active) { updateStatus(); queueBubble(); } },
  onImages: files => insertImages(files),
  onFiles: files => dropFiles(files),
});
editor.configure({ wrap: settings.wrap, spellcheck: settings.spellcheck, autoPairMd: settings.autoPairMd, typewriter: settings.typewriter });
window.sustenido = { text: () => editor.view.state.doc.toString() };

function countWords(doc) {
  let n = 0;
  for (const chunk of doc.iter()) n += chunk.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return n;
}

// ── Tabs ────────────────────────────────────────────

let tabs = [];
let active = null;
let primary = false;
let tabSeq = 0;

function makeTab({ path = null, name = 'Sem título', dir = null, base = null, text = '', saved = text, encoding = 'utf-8', eol = 'crlf' } = {}) {
  const savedDoc = Text.of(saved.split('\n'));
  const state = editor.createState(text);
  return { id: ++tabSeq, path, name, dir, base, encoding, eol, state, savedDoc, dirty: !state.doc.eq(savedDoc), scroll: 0 };
}

const stateOf = tab => (tab === active ? editor.view.state : tab.state);
const text = () => editor.view.state.doc.toString();
const isBlank = tab => !tab.path && !tab.dirty && stateOf(tab).doc.length === 0;

function activate(tab, { focus = false } = {}) {
  if (active && active !== tab && tabs.includes(active)) {
    active.state = editor.view.state;
    active.scroll = scroller.scrollTop;
  }
  active = tab;
  recordNav(tab);
  document.querySelector('base').href = tab.base ?? 'https://sustenido.app/'; // before anything renders relative images
  editor.setState(tab.state);
  editor.configure({ wrap: settings.wrap, spellcheck: settings.spellcheck, autoPairMd: settings.autoPairMd, typewriter: settings.typewriter });
  wordCount = countWords(tab.state.doc);
  renderTabs();
  renderChrome();
  renderMode();
  updateStatus();
  renderOutline();
  followInSidebar(tab);
  requestAnimationFrame(() => { scroller.scrollTop = tab.scroll; });
  if (focus && settings.mode === 'edit') editor.view.focus();
  scheduleSession();
}

/** Puts a tab on screen: replaces a blank/explicit tab, or opens next to the active one. */
function place(tab, replace = null) {
  const target = replace ?? (active && isBlank(active) ? active : null);
  if (target) {
    tabs[tabs.indexOf(target)] = tab;
    if (active === target) active = null;
  } else {
    tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab);
  }
  activate(tab, { focus: true });
}

function newTab() {
  place(makeTab({ dir: active?.dir ?? sidebar.root }));
  setMode('edit');
}

async function readDoc(path) {
  try {
    const doc = await call('read', { path });
    return doc.kind === 'import' ? await importDoc(doc) : makeTab({ ...doc, saved: doc.text });
  } catch (err) {
    toast(`Não foi possível abrir: ${err.message}`);
    return null;
  }
}

async function openPath(path) {
  const existing = tabs.find(t => samePath(t.path, path));
  if (existing) return activate(existing, { focus: true });
  const tab = await readDoc(path);
  if (tab) place(tab);
}

/** Obsidian-style navigation: a link opens inside the current tab (unless it has unsaved edits). */
async function openInPlace(path) {
  const current = active;
  if (current.dirty) return openPath(path); // never discard edits: unsaved notes keep their tab
  const existing = tabs.find(t => samePath(t.path, path));
  if (existing && existing !== current) return activate(existing, { focus: true });
  const tab = await readDoc(path);
  if (tab) place(tab, current);
}

// Browser-like history of visited notes across tabs (Alt+← / Alt+→): a closed note is reopened.
const nav = { list: [], idx: -1, busy: false };
function recordNav(tab) {
  if (nav.busy || nav.list[nav.idx]?.id === tab.id) return;
  nav.list = nav.list.slice(0, nav.idx + 1);
  nav.list.push({ id: tab.id, path: tab.path });
  nav.idx = nav.list.length - 1;
}
const navTarget = e => tabs.find(t => t.id === e.id) ?? (e.path ? tabs.find(t => samePath(t.path, e.path)) : null);
function canNav(step) {
  for (let i = nav.idx + step; i >= 0 && i < nav.list.length; i += step) if (navTarget(nav.list[i]) || nav.list[i].path) return true;
  return false;
}
async function goNav(step) {
  for (let i = nav.idx + step; i >= 0 && i < nav.list.length; i += step) {
    const e = nav.list[i];
    const open = navTarget(e);
    if (!open && !e.path) continue;
    nav.busy = true;
    try {
      if (open) activate(open, { focus: true });
      else {
        const tab = await readDoc(e.path);
        if (!tab) continue;
        e.id = tab.id;
        place(tab);
      }
      nav.idx = i;
    } finally { nav.busy = false; }
    renderTabs();
    return;
  }
}
const goBack = () => goNav(-1);
const goForward = () => goNav(1);

async function pickOpen() {
  const paths = await call('pickOpen', { dir: active?.dir ?? sidebar.root ?? '' }).catch(() => null);
  for (const p of paths ?? []) await openPath(p);
}

async function importDoc(doc) {
  toast(`Importando ${doc.format.toUpperCase()}…`);
  try {
    const bytes = Uint8Array.from(atob(doc.data), c => c.charCodeAt(0));
    const { htmlToMarkdown, pdfToMarkdown } = await import('./importers.js');
    const md = doc.format === 'pdf' ? await pdfToMarkdown(bytes) : htmlToMarkdown(decodeText(bytes));
    toast(`Importado de ${doc.format.toUpperCase()} — salve para criar o .md`);
    return makeTab({ name: doc.name, dir: doc.dir, base: doc.base, text: md, saved: '' });
  } catch (err) {
    toast(`Não foi possível importar: ${err.message}`);
    return null;
  }
}

function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

async function save(tab = active, { saveAs = false } = {}) {
  const doc = stateOf(tab).doc;
  let r;
  try {
    r = await call('save', { path: tab.path, text: doc.toString(), encoding: tab.encoding, eol: tab.eol, saveAs, name: tab.name, dir: tab.dir ?? sidebar.root });
  } catch (err) {
    toast(`Não foi possível salvar: ${err.message}`);
    return false;
  }
  if (!r) return false;
  const isNew = !samePath(tab.path, r.path);
  Object.assign(tab, { path: r.path, name: r.name, dir: r.dir, base: r.base, encoding: r.encoding, savedDoc: doc });
  for (const e of nav.list) if (e.id === tab.id) e.path = tab.path;
  tab.dirty = !stateOf(tab).doc.eq(doc); // typing during the save keeps the tab dirty
  if (tab === active) {
    document.querySelector('base').href = tab.base;
    editor.refresh(); // relative images now resolve against the saved location
    renderChrome();
    updateStatus();
    if (isNew) followInSidebar(tab);
  }
  if (isNew) sidebar.refresh();
  renderTabs();
  scheduleSession();
  return true;
}

async function saveAll() {
  for (const t of tabs) {
    if (!t.dirty) continue;
    if (!t.path) activate(t);
    if (!(await save(t))) return;
  }
}

/** Notepad's prompt for one dirty tab. Resolves false if the user cancels. */
async function settleTab(tab) {
  if (!tab.dirty) return true;
  activate(tab);
  const answer = await call('confirmClose', { name: tab.name });
  if (answer === 'cancel') return false;
  return answer === 'discard' || save(tab);
}

async function closeTab(tab) {
  if (!(await settleTab(tab))) return;
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (!tabs.length) return closeWindow(); // like Notepad, closing the last tab closes the window
  if (active === tab) {
    active = null;
    activate(tabs[Math.min(i, tabs.length - 1)]);
  } else renderTabs();
  scheduleSession();
}

async function closeTabs(keep) {
  for (const t of tabs.filter(t => !keep(t))) {
    if (!(await settleTab(t))) return;
    tabs.splice(tabs.indexOf(t), 1);
  }
  if (!tabs.includes(active)) { active = null; activate(tabs[0]); } else renderTabs();
  scheduleSession();
}

async function closeWindow() {
  if (!(primary && settings.session)) {
    for (const t of [...tabs]) if (!(await settleTab(t))) return;
  }
  await Promise.all([persistSession(), flushSettings()]);
  call('closeWindow');
}

// ── Session (Notepad's "continue where you left off") ─

let sessionTimer;
function snapshot() {
  return JSON.stringify({
    version: 1,
    active: tabs.indexOf(active),
    tabs: tabs.filter(t => t.path || t.dirty).map(t => ({ // a clean unsaved tab (the welcome note) is not worth keeping
      path: t.path, name: t.name, dir: t.dir, encoding: t.encoding, eol: t.eol,
      text: t.dirty || !t.path ? stateOf(t).doc.toString() : null, // unsaved work is kept, clean files are re-read
    })),
  });
}

function scheduleSession() {
  if (!primary) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(persistSession, 800);
}

async function persistSession() {
  clearTimeout(sessionTimer);
  if (!primary) return;
  try { await call('writeSession', { json: settings.session ? snapshot() : '{"tabs":[]}' }); } catch { /* next change retries */ }
}

async function restore(json) {
  let session;
  try { session = JSON.parse(json); } catch { return 0; }
  const saved = session?.tabs ?? [];
  const docs = await Promise.all(saved.map(t => (t.path ? call('read', { path: t.path }).catch(() => null) : null))); // all files at once
  saved.forEach((t, i) => {
    const doc = docs[i];
    if (t.path) {
      if (doc?.kind === 'doc') {
        tabs.push(makeTab({ ...doc, text: t.text ?? doc.text, saved: doc.text, ...(t.text != null && { encoding: t.encoding, eol: t.eol }) }));
      } else if (t.text != null) {
        tabs.push(makeTab({ ...t, saved: '' })); // file vanished: keep the unsaved text, saving recreates it
      }
    } else {
      tabs.push(makeTab({ name: t.name, dir: t.dir, text: t.text ?? '', saved: '', encoding: t.encoding, eol: t.eol }));
    }
  });
  return Math.max(0, Math.min(session?.active ?? 0, tabs.length - 1));
}

// ── Rendering ───────────────────────────────────────

function renderTabs() {
  const strip = $('tabs');
  strip.replaceChildren(...tabs.map((t, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(t === active));
    tab.tabIndex = t === active ? 0 : -1;
    tab.draggable = true;
    tab.dataset.index = i;
    tab.title = t.path ?? t.name;
    tab.innerHTML = `<span class="tab-label"></span><span class="tab-dot" aria-hidden="true"></span>
      <button class="tab-close" type="button" tabindex="-1" aria-label="Fechar aba"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8"/></svg></button>`;
    tab.querySelector('.tab-label').textContent = t.name;
    tab.classList.toggle('dirty', t.dirty);
    return tab;
  }));
  $('back').disabled = !canNav(-1);
  $('forward').disabled = !canNav(1);
  renderTitle();
  strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTabScroll();
}

// With many tabs the strip scrolls: arrows at both ends (like Notepad) and a list of every open tab.
function updateTabScroll() {
  const strip = $('tabs');
  const overflow = strip.scrollWidth > strip.clientWidth + 1;
  $('tabs-prev').hidden = $('tabs-next').hidden = !overflow;
  $('tabs-list').hidden = tabs.length < 2;
}

let titleTimer;
function renderTitle() {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => call('title', { text: `${active.dirty ? '● ' : ''}${active.name} — Sustenido` }), 50);
}

function renderChrome() {
  titleEl.textContent = active.name;
  const crumbs = $('crumbs');
  const parts = [];
  const root = sidebar.root;
  if (active.path && root && isInside(active.path, root)) {
    parts.push(basename(root), ...parentDir(active.path).slice(root.replace(/[\\/]+$/, '').length + 1).split(/[\\/]/).filter(Boolean));
  } else if (active.path) {
    parts.push(basename(parentDir(active.path)));
  } else if (active.dir) {
    parts.push(basename(active.dir));
  }
  crumbs.innerHTML = [...parts.slice(-3).map(p => `<span class="crumb">${esc(p)}</span>`), `<span class="crumb current" aria-current="page">${esc(active.name)}</span>`]
    .join('<svg class="crumb-sep" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 6l4 4-4 4"/></svg>');
}

async function renderRead() {
  const html = renderHtml(text());
  view.innerHTML = html;
  await Promise.all([hydrateDiagrams(view, isDark()), highlightBlocks(view)]);
}

function renderMode() {
  document.body.dataset.mode = settings.mode;
  for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  if (settings.mode === 'read') renderRead();
  queueBubble();
}

function setMode(mode) {
  if (mode === settings.mode) return;
  update({ mode });
  renderMode();
  updateStatus();
  if (mode === 'edit') editor.view.focus();
}

// ── Outline (headings panel) ────────────────────────

let outlineTimer;
function renderOutline() {
  if (!settings.outline) return;
  const list = $('outline');
  const items = outline(editor.view.state);
  list.replaceChildren(...items.map((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'node outline-item';
    b.style.setProperty('--depth', it.level - 1);
    b.dataset.index = i;
    b.dataset.pos = it.pos;
    b.title = it.text;
    b.innerHTML = '<span class="label"></span>';
    b.querySelector('.label').textContent = it.text;
    return b;
  }));
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'tree-empty';
    p.textContent = 'Nenhum título nesta nota. Use # Título para criar seções.';
    list.replaceChildren(p);
  }
}
const scheduleOutline = () => { clearTimeout(outlineTimer); outlineTimer = setTimeout(renderOutline, 250); };

function jumpToHeading(index, pos) {
  if (settings.mode === 'read') {
    view.querySelectorAll('h1, h2, h3, h4, h5, h6')[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  editor.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
  editor.view.focus();
}

function showSidebarView(name) {
  for (const b of document.querySelectorAll('.side-tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === name));
  $('tree').hidden = name !== 'tree';
  $('outline').hidden = name !== 'outline';
  if (name === 'outline') renderOutline();
}

const toggleMode = () => setMode(settings.mode === 'read' ? 'edit' : 'read');

function updateStatus() {
  const st = editor.view.state;
  const sel = st.selection.main;
  const line = st.doc.lineAt(sel.head);
  const selected = st.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
  $('st-pos').textContent = `Ln ${num.format(line.number)}, Col ${num.format(sel.head - line.from + 1)}`;
  $('st-words').textContent = `${num.format(wordCount)} ${wordCount === 1 ? 'palavra' : 'palavras'}`;
  const minutes = Math.max(1, Math.round(wordCount / 200));
  $('st-words').title = `Cerca de ${minutes} min de leitura — clique para detalhes`;
  $('st-chars').textContent = selected
    ? `${num.format(selected)} de ${num.format(st.doc.length)} caracteres`
    : `${num.format(st.doc.length)} caracteres`;
  $('st-zoom').textContent = `${settings.zoom}%`;
  $('st-eol').textContent = EOLS.find(e => e.id === active.eol)?.name ?? '';
  $('st-enc').textContent = ENCODINGS.find(e => e.id === active.encoding)?.name ?? '';
}

// ── Sidebar ─────────────────────────────────────────

const sidebar = createSidebar({
  tree: $('tree'),
  title: $('ws-name'),
  onOpen: (path, { newTab: inNew }) => (inNew ? openPath(path) : openInPlace(path)),
});

function followInSidebar(tab) {
  if (!tab.path) {
    if (!sidebar.root && settings.root) sidebar.setRoot(settings.root);
    sidebar.setActive(null);
    return;
  }
  const root = settings.root && isInside(tab.path, settings.root) ? settings.root
    : sidebar.root && isInside(tab.path, sidebar.root) ? sidebar.root
    : parentDir(tab.path);
  sidebar.setRoot(root);
  sidebar.setActive(tab.path);
  renderChrome();
}

function toggleSidebar() {
  update({ sidebar: !settings.sidebar });
  document.body.classList.toggle('no-sidebar', !settings.sidebar);
}

// ── Links ───────────────────────────────────────────

async function followLink(href, inNewTab = false) {
  if (!href || href.startsWith('#')) return;
  let r;
  try { r = await call('resolveLink', { href, from: active.path, root: sidebar.root ?? active.dir }); } catch (err) { return toast(err.message); }
  if (r?.missing) return toast(`A nota “${r.missing}” não existe.`);
  if (r?.path) return inNewTab ? openPath(r.path) : openInPlace(r.path);
}

view.addEventListener('click', e => {
  const a = e.target.closest('a[href], [data-href]');
  if (!a) return;
  e.preventDefault();
  followLink(a.getAttribute('data-href') ?? a.getAttribute('href'), e.ctrlKey);
});

// ── Images & drag-and-drop ──────────────────────────

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

async function attach(payload) {
  if (!active.path) { toast('Salve a nota antes de inserir imagens.'); return; }
  try {
    const src = await call('attachImage', { doc: active.path, ...payload });
    if (src) insertText(editor.view, `![](${encodeURI(src)})`);
  } catch (err) { toast(err.message); }
}

async function insertImages(files) {
  setMode('edit');
  for (const file of files) {
    const data = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
    await attach({ data, ext: file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png' });
  }
}

async function dropFiles(files, intoEditor = true) {
  const paths = await call('drop', {}, files).catch(() => []);
  for (const p of paths) {
    if (IMAGE.test(p)) {
      if (intoEditor) await attach({ source: p });
      else toast('Solte imagens dentro do texto da nota.');
    } else await openPath(p);
  }
}

let dragDepth = 0;
const dropOverlay = $('drop');
document.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  const onlyImages = [...e.dataTransfer.items].every(i => i.type.startsWith('image/'));
  dropOverlay.hidden = onlyImages && settings.mode === 'edit';
});
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.hidden = true; } });
document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  dragDepth = 0;
  dropOverlay.hidden = true;
  if (!e.dataTransfer?.files.length || e.defaultPrevented) return;
  e.preventDefault();
  dropFiles([...e.dataTransfer.files], false);
});

// ── Clipboard ───────────────────────────────────────

const selectionText = () => editor.view.state.selection.ranges.map(r => editor.view.state.sliceDoc(r.from, r.to)).join('\n');

async function copy() {
  if (settings.mode === 'read') return document.execCommand('copy');
  await navigator.clipboard.writeText(selectionText());
}
async function cut() {
  if (settings.mode === 'read') return;
  await copy();
  editor.view.dispatch(editor.view.state.replaceSelection(''));
}
async function paste() {
  setMode('edit');
  try {
    const clip = await navigator.clipboard.readText();
    editor.view.dispatch(editor.view.state.replaceSelection(clip));
  } catch { toast('Use Ctrl+V para colar.'); }
  editor.view.focus();
}

// Markdown for plain-text targets, rendered HTML for rich ones (Word, Gmail, Notion).
async function copyAll() {
  const md = text();
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([md], { type: 'text/plain' }),
      'text/html': new Blob([renderHtml(md)], { type: 'text/html' }),
    })]);
    toast('Conteúdo copiado');
  } catch { toast('Não foi possível copiar'); }
}

// ── Export & print ──────────────────────────────────

async function renderPrint() {
  const sheet = $('print');
  sheet.innerHTML = `<h1 class="print-title">${esc(active.name)}</h1><article class="prose">${renderHtml(text())}</article>`;
  await Promise.all([hydrateDiagrams(sheet, false), highlightBlocks(sheet)]);
}

async function standaloneHtml() {
  const article = document.createElement('article');
  article.className = 'prose';
  article.innerHTML = renderHtml(text());
  await Promise.all([hydrateDiagrams(article, false), highlightBlocks(article)]);
  const css = await fetch('https://sustenido.app/style.css').then(r => r.text());
  const katex = article.querySelector('.katex') ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.css">\n' : '';
  return `<!doctype html>
<html lang="pt-BR" data-theme="light" data-font="${settings.font}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(active.name)}</title>
${katex}<style>${css}</style>
<style>:root{${document.documentElement.style.cssText}}</style>
</head>
<body class="exported">
<main class="exported-page">
<h1 class="print-title">${esc(active.name)}</h1>
${article.outerHTML}
</main>
</body>
</html>
`;
}

async function exportAs(format) {
  const meta = { name: active.name, dir: active.dir ?? sidebar.root };
  try {
    let target;
    if (format === 'md') target = await call('export', { ...meta, format, text: text(), encoding: active.encoding, eol: active.eol });
    else if (format === 'html') target = await call('export', { ...meta, format, html: await standaloneHtml() });
    else if (format === 'docx') {
      const { toDocx } = await import('./docx.js');
      target = await call('export', { ...meta, format, data: await toDocx(text(), active.name) });
    } else {
      await renderPrint();
      target = await call('export', { ...meta, format: 'pdf' });
    }
    if (target) toast(`Exportado: ${basename(target)}`);
  } catch (err) { toast(`Não foi possível exportar: ${err.message}`); }
}

async function print() {
  await renderPrint();
  window.print();
}

// ── Insert ──────────────────────────────────────────

function withEditor(fn) {
  setMode('edit');
  editor.view.focus();
  fn(editor.view);
}

async function insertImageFromDisk() {
  if (!active.path) return toast('Salve a nota antes de inserir imagens.');
  try {
    const src = await call('pickImage', { doc: active.path });
    if (src) withEditor(v => insertText(v, `![](${encodeURI(src)})`));
  } catch (err) { toast(err.message); }
}

function openEmoji() {
  withEditor(() => {});
  call('emoji');
}

function insertProperties() {
  withEditor(v => {
    if (splitFrontmatter(v.state.doc.toString()).yaml != null) return toast('Esta nota já tem propriedades.');
    v.dispatch({ changes: { from: 0, insert: '---\ntags: []\ncriado: ' + new Date().toISOString().slice(0, 10) + '\n---\n' }, selection: { anchor: 11 } });
  });
}

// ── Menus ───────────────────────────────────────────

const MENUS = {
  file: () => [
    { label: 'Nova aba', kbd: 'Ctrl+N', run: newTab },
    { label: 'Nova janela', kbd: 'Ctrl+Shift+N', run: () => call('newWindow') },
    { label: 'Abrir…', kbd: 'Ctrl+O', run: pickOpen },
    { label: 'Abrir pasta…', run: () => sidebar.pickFolder() },
    '-',
    { label: 'Salvar', kbd: 'Ctrl+S', run: () => save() },
    { label: 'Salvar como…', kbd: 'Ctrl+Shift+S', run: () => save(active, { saveAs: true }) },
    { label: 'Salvar tudo', kbd: 'Ctrl+Alt+S', run: saveAll },
    '-',
    { label: 'Exportar como PDF…', run: () => exportAs('pdf') },
    { label: 'Exportar como Word…', run: () => exportAs('docx') },
    { label: 'Exportar como HTML…', run: () => exportAs('html') },
    { label: 'Exportar cópia em Markdown…', run: () => exportAs('md') },
    { label: 'Imprimir…', kbd: 'Ctrl+P', run: print },
    '-',
    { label: 'Mostrar no Explorador', disabled: !active.path, run: () => call('reveal', { path: active.path }) },
    { label: 'Fechar aba', kbd: 'Ctrl+W', run: () => closeTab(active) },
    { label: 'Fechar janela', kbd: 'Ctrl+Shift+W', run: closeWindow },
  ],
  edit: () => [
    { label: 'Desfazer', kbd: 'Ctrl+Z', run: () => withEditor(undo) },
    { label: 'Refazer', kbd: 'Ctrl+Y', run: () => withEditor(redo) },
    '-',
    { label: 'Recortar', kbd: 'Ctrl+X', run: cut },
    { label: 'Copiar', kbd: 'Ctrl+C', run: copy },
    { label: 'Colar', kbd: 'Ctrl+V', run: paste },
    { label: 'Excluir', kbd: 'Del', run: () => withEditor(v => v.dispatch(v.state.replaceSelection(''))) },
    '-',
    { label: 'Localizar…', kbd: 'Ctrl+F', run: () => withEditor(openSearchPanel) },
    { label: 'Localizar próxima', kbd: 'F3', run: () => withEditor(findNext) },
    { label: 'Localizar anterior', kbd: 'Shift+F3', run: () => withEditor(findPrevious) },
    { label: 'Substituir…', kbd: 'Ctrl+H', run: () => withEditor(openSearchPanel) },
    { label: 'Ir para a linha…', kbd: 'Ctrl+G', run: () => withEditor(gotoLine) },
    '-',
    { label: 'Selecionar tudo', kbd: 'Ctrl+A', run: () => withEditor(selectAll) },
    { label: 'Hora/data', kbd: 'F5', run: () => withEditor(v => insertText(v, dateTime())) },
    { label: 'Copiar conteúdo formatado', kbd: 'Ctrl+Shift+C', run: copyAll },
  ],
  insert: () => [
    { label: 'Imagem…', run: insertImageFromDisk },
    { label: 'Emoji', kbd: 'Win+.', run: openEmoji },
    { label: 'Link', kbd: 'Ctrl+K', run: () => withEditor(insertLink) },
    '-',
    { label: 'Tabela', run: () => withEditor(v => insertText(v, '| Coluna 1 | Coluna 2 |\n| --- | --- |\n|  |  |\n', { block: true, cursor: 2 })) },
    { label: 'Bloco de código', run: () => withEditor(v => insertText(v, '```\n\n```\n', { block: true, cursor: 4 })) },
    { label: 'Diagrama Mermaid', run: () => withEditor(v => insertText(v, '```mermaid\nflowchart LR\n  A[Ideia] --> B[Rascunho] --> C[Nota]\n```\n', { block: true, cursor: 11 })) },
    { label: 'Fórmula (LaTeX)', run: () => withEditor(v => insertText(v, '$$\n\n$$\n', { block: true, cursor: 3 })) },
    { label: 'Lista de tarefas', run: () => withEditor(v => setBlock(v, 'task')) },
    { label: 'Linha horizontal', run: () => withEditor(v => insertText(v, '---\n', { block: true })) },
    { label: 'Propriedades', run: insertProperties },
    '-',
    { label: 'Hora/data', kbd: 'F5', run: () => withEditor(v => insertText(v, dateTime())) },
  ],
  view: () => [
    { label: 'Modo leitura', kbd: 'Ctrl+E', checked: settings.mode === 'read', run: toggleMode },
    { label: 'Modo foco', kbd: 'F8', checked: settings.focus, run: () => update({ focus: !settings.focus }) },
    { label: 'Máquina de escrever', kbd: 'F9', checked: settings.typewriter, run: () => update({ typewriter: !settings.typewriter }) },
    '-',
    { label: 'Barra lateral', kbd: 'Ctrl+\\', checked: settings.sidebar, run: toggleSidebar },
    { label: 'Estrutura da nota', kbd: 'Ctrl+Shift+O', checked: settings.outline, run: toggleOutline },
    { label: 'Barra de status', checked: settings.statusBar, run: () => update({ statusBar: !settings.statusBar }) },
    { label: 'Quebra automática de linha', checked: settings.wrap, run: () => update({ wrap: !settings.wrap }) },
    '-',
    { label: 'Ampliar', kbd: 'Ctrl++', run: () => zoom(10) },
    { label: 'Reduzir', kbd: 'Ctrl+−', run: () => zoom(-10) },
    { label: 'Restaurar zoom', kbd: 'Ctrl+0', run: () => zoom(0) },
    '-',
    { label: 'Configurações…', kbd: 'Ctrl+,', run: showSettings },
  ],
  export: () => [
    { label: 'PDF', kbd: '.pdf', run: () => exportAs('pdf') },
    { label: 'Word', kbd: '.docx', run: () => exportAs('docx') },
    { label: 'Página da web', kbd: '.html', run: () => exportAs('html') },
    { label: 'Markdown', kbd: '.md', run: () => exportAs('md') },
    '-',
    { label: 'Imprimir…', kbd: 'Ctrl+P', run: print },
  ],
  block: () => Object.entries({ p: 'Parágrafo', h1: 'Título 1', h2: 'Título 2', h3: 'Título 3', quote: 'Citação', bullet: 'Lista', number: 'Lista numerada', task: 'Lista de tarefas' })
    .map(([kind, label]) => ({ label, checked: currentBlock(editor.view.state) === kind, run: () => setBlock(editor.view, kind) })),
  color: () => [
    { label: 'Cor padrão do texto', run: () => setTextColor(editor.view, null) },
    '-',
    ...TEXT_COLORS.map(c => ({ label: c.name, color: c.id, checked: c.id === lastColor, run: () => applyColor(c.id) })),
  ],
  mark: () => [
    { label: 'Cor do tema', checked: lastMark === null, run: () => applyMark(null) },
    '-',
    ...MARK_COLORS.map(c => ({ label: c.name, color: c.id, checked: c.id === lastMark, run: () => applyMark(c.id) })),
  ],
  tabs: () => tabs.map(t => ({ label: t.name + (t.dirty ? ' ●' : ''), checked: t === active, run: () => activate(t, { focus: true }) })),
  counts: () => {
    const s = stats(editor.view.state);
    const row = (label, value) => ({ label, kbd: num.format(value), run: () => {} });
    return [row('Palavras', s.words), row('Caracteres', s.chars), row('Caracteres sem espaços', s.charsNoSpace), row('Linhas', s.lines), row('Parágrafos', s.paragraphs), row('Minutos de leitura', s.minutes)];
  },
  eol: () => EOLS.map(e => ({ label: e.name, checked: active.eol === e.id, run: () => setFormat({ eol: e.id }) })),
  encoding: () => ENCODINGS.map(e => ({ label: e.name, checked: active.encoding === e.id, run: () => setFormat({ encoding: e.id }) })),
};

// The main buttons re-apply the last color used; the chevron beside them opens the palette.
let lastColor = '#e5484d';
let lastMark = null; // null = the theme/default highlight (==texto==)
function applyColor(color) {
  setTextColor(editor.view, color);
  lastColor = color;
  document.documentElement.style.setProperty('--last-color', color);
}
function applyMark(color) {
  setHighlight(editor.view, color);
  lastMark = color;
  document.documentElement.style.setProperty('--last-mark', color ?? 'var(--mark)');
}
function toggleOutline() {
  update({ outline: !settings.outline });
  if (settings.outline && !settings.sidebar) toggleSidebar();
  showSidebarView(settings.outline ? 'outline' : 'tree');
}

function setFormat(patch) {
  Object.assign(active, patch);
  active.dirty = true; // the bytes on disk will differ on the next save
  renderTabs();
  updateStatus();
  scheduleSession();
}

let menuAnchor = null;
function openMenu(anchor, items) {
  closeMenu();
  menuAnchor = anchor;
  popover.replaceChildren(...items.map(item => {
    if (item === '-') return Object.assign(document.createElement('div'), { className: 'menu-sep', role: 'separator' });
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
    b.disabled = !!item.disabled;
    b.innerHTML = `<span class="mi-check" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M5 10.5l3 3 7-7"/></svg></span><span class="mi-label"></span>${item.kbd ? '<kbd></kbd>' : ''}`;
    b.querySelector('.mi-label').textContent = item.label;
    if (item.color) {
      const dot = Object.assign(document.createElement('span'), { className: 'mi-color' });
      dot.style.background = item.color;
      b.querySelector('.mi-check').replaceWith(dot);
    }
    if (item.kbd) b.querySelector('kbd').textContent = item.kbd;
    b.addEventListener('click', () => { closeMenu(); item.run(); });
    return b;
  }));
  popover.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  const a = anchor.getBoundingClientRect();
  const p = popover.getBoundingClientRect();
  const left = Math.min(Math.max(8, a.left), innerWidth - p.width - 8);
  const below = a.bottom + 6;
  popover.style.left = `${left}px`;
  popover.style.top = `${below + p.height > innerHeight - 8 ? Math.max(8, a.top - p.height - 6) : below}px`;
  popover.querySelector('button:not(:disabled)')?.focus();
}

function closeMenu() {
  if (popover.hidden) return;
  popover.hidden = true;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
}

popover.addEventListener('keydown', e => {
  const items = [...popover.querySelectorAll('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  const move = n => items[(i + n + items.length) % items.length]?.focus();
  if (e.key === 'ArrowDown') move(1);
  else if (e.key === 'ArrowUp') move(-1);
  else if (e.key === 'Home') items[0]?.focus();
  else if (e.key === 'End') items.at(-1)?.focus();
  else if (e.key === 'Escape' || e.key === 'Tab') { const a = menuAnchor; closeMenu(); a?.focus(); }
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && menuAnchor?.dataset.menu) {
    const bar = [...document.querySelectorAll('.menus [data-menu]')];
    const next = bar[(bar.indexOf(menuAnchor) + (e.key === 'ArrowRight' ? 1 : -1) + bar.length) % bar.length];
    openMenu(next, MENUS[next.dataset.menu]());
  } else return;
  e.preventDefault();
});
document.addEventListener('mousedown', e => {
  if (!popover.hidden && !popover.contains(e.target) && !e.target.closest('[aria-expanded="true"]')) closeMenu();
});
window.addEventListener('blur', closeMenu);

document.addEventListener('click', e => {
  const trigger = e.target.closest('[data-menu]');
  if (!trigger) return;
  if (menuAnchor === trigger) return closeMenu();
  openMenu(trigger, MENUS[trigger.dataset.menu]());
});

// ── Floating format bar ─────────────────────────────

let bubbleFrame = 0;
const queueBubble = () => { cancelAnimationFrame(bubbleFrame); bubbleFrame = requestAnimationFrame(placeBubble); };

function placeBubble() {
  const v = editor.view;
  const sel = v.state.selection.main;
  const menuOwned = menuAnchor && bubble.contains(menuAnchor);
  if (settings.mode !== 'edit' || sel.empty || !(v.hasFocus || menuOwned)) { bubble.hidden = true; return; }
  const a = v.coordsAtPos(sel.from);
  const b = v.coordsAtPos(sel.to, -1);
  if (!a || !b) { bubble.hidden = true; return; }
  bubble.hidden = false;
  $('b-block-label').textContent = BLOCK_NAMES[currentBlock(v.state)];
  for (const [mark, id] of [['**', 'b-bold'], ['*', 'b-italic'], ['~~', 'b-strike'], ['==', 'b-mark'], ['`', 'b-code']]) {
    const n = mark.length;
    const on = v.state.sliceDoc(sel.from - n, sel.from) === mark && v.state.sliceDoc(sel.to, sel.to + n) === mark;
    $(id).classList.toggle('on', on);
  }
  const card = $('card').getBoundingClientRect();
  const w = bubble.offsetWidth, h = bubble.offsetHeight;
  const center = a.top === b.top ? (a.left + b.right) / 2 : a.left + 120;
  const left = Math.min(Math.max(center - w / 2, card.left + 10), card.right - w - 10);
  let top = Math.min(a.top, b.top) - h - 10;
  if (top < card.top + 8) top = Math.max(a.bottom, b.bottom) + 10;
  bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

bubble.addEventListener('mousedown', e => e.preventDefault()); // keep the editor's selection and focus
bubble.addEventListener('click', e => {
  const b = e.target.closest('[data-cmd]');
  if (!b) return;
  const v = editor.view;
  ({
    bold: () => toggleInline(v, '**'),
    italic: () => toggleInline(v, '*'),
    strike: () => toggleInline(v, '~~'),
    mark: () => applyMark(lastMark),
    color: () => applyColor(lastColor),
    code: () => toggleInline(v, '`'),
    link: () => insertLink(v),
    emoji: openEmoji,
  })[b.dataset.cmd]?.();
});
scroller.addEventListener('scroll', queueBubble, { passive: true });
window.addEventListener('resize', queueBubble);

// ── Inline title (rename) ───────────────────────────

titleEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); editor.view.focus(); }
  if (e.key === 'Escape') { titleEl.textContent = active.name; editor.view.focus(); }
});
titleEl.addEventListener('blur', async () => {
  const name = titleEl.textContent.replace(/\s+/g, ' ').trim();
  if (!name || name === active.name) { titleEl.textContent = active.name; return; }
  if (!active.path) {
    active.name = name;
  } else {
    try {
      Object.assign(active, await call('rename', { path: active.path, name }));
      sidebar.refresh();
    } catch (err) {
      toast(err.message);
    }
  }
  renderTabs();
  renderChrome();
  scheduleSession();
});

// ── Tabs strip interactions ─────────────────────────

const strip = $('tabs');
const tabAt = e => tabs[+e.target.closest('.tab')?.dataset.index];
strip.addEventListener('click', e => {
  const t = tabAt(e);
  if (!t) return;
  if (e.target.closest('.tab-close')) closeTab(t);
  else if (t !== active) activate(t, { focus: true });
});
strip.addEventListener('auxclick', e => { const t = tabAt(e); if (t && e.button === 1) closeTab(t); });
strip.addEventListener('dblclick', e => { if (!e.target.closest('.tab')) newTab(); });
strip.addEventListener('wheel', e => { strip.scrollLeft += e.deltaY; }, { passive: true });
strip.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const t = tabAt(e); if (t) activate(t, { focus: true }); } });
strip.addEventListener('contextmenu', e => {
  const t = tabAt(e);
  if (!t) return;
  e.preventDefault();
  const anchor = e.target.closest('.tab');
  openMenu(anchor, [
    { label: 'Fechar', kbd: 'Ctrl+W', run: () => closeTab(t) },
    { label: 'Fechar outras', run: () => closeTabs(x => x === t) },
    { label: 'Fechar à direita', run: () => closeTabs(x => tabs.indexOf(x) <= tabs.indexOf(t)) },
    '-',
    { label: 'Copiar caminho', disabled: !t.path, run: () => navigator.clipboard.writeText(t.path) },
    { label: 'Mostrar no Explorador', disabled: !t.path, run: () => call('reveal', { path: t.path }) },
  ]);
});
let dragIndex = -1;
strip.addEventListener('dragstart', e => { dragIndex = +e.target.closest('.tab')?.dataset.index; e.dataTransfer.effectAllowed = 'move'; });
strip.addEventListener('dragover', e => { if (dragIndex >= 0) e.preventDefault(); });
strip.addEventListener('drop', e => {
  if (dragIndex < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const over = e.target.closest('.tab');
  const to = over ? +over.dataset.index : tabs.length - 1;
  const [moved] = tabs.splice(dragIndex, 1);
  tabs.splice(to, 0, moved);
  dragIndex = -1;
  renderTabs();
  scheduleSession();
});
strip.addEventListener('dragend', () => { dragIndex = -1; });

// ── Commands & shortcuts ────────────────────────────

function zoom(delta) {
  update({ zoom: delta === 0 ? 100 : Math.min(300, Math.max(50, settings.zoom + delta)) });
  updateStatus();
  queueBubble();
}

const showSettings = () => openSettings($('settings'));
const editing = () => settings.mode === 'edit' && editor.view.hasFocus;
const cycleTab = step => activate(tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length], { focus: true });

// Keys: modifier prefix (C=Ctrl, S=Shift, A=Alt) + '+' + key. Returning false lets the key through.
const SHORTCUTS = {
  'C+n': newTab, 'CS+n': () => call('newWindow'), 'C+o': pickOpen,
  'C+s': () => save(), 'CS+s': () => save(active, { saveAs: true }), 'CA+s': saveAll,
  'C+w': () => closeTab(active), 'CS+w': closeWindow, 'C+p': print,
  'C+e': toggleMode, 'C+\\': toggleSidebar, 'C+,': showSettings,
  'C+=': () => zoom(10), 'C++': () => zoom(10), 'CS++': () => zoom(10), 'C+-': () => zoom(-10), 'C+0': () => zoom(0),
  'C+tab': () => cycleTab(1), 'CS+tab': () => cycleTab(-1),
  'C+h': () => withEditor(openSearchPanel), 'C+g': () => withEditor(gotoLine),
  '+f5': () => withEditor(v => insertText(v, dateTime())), 'C+r': () => {},
  'CS+c': copyAll, 'A+arrowleft': goBack, 'A+arrowright': goForward,
  '+f8': () => update({ focus: !settings.focus }), '+f9': () => update({ typewriter: !settings.typewriter }), 'CS+o': toggleOutline,
  'C+b': () => editing() ? toggleInline(editor.view, '**') : false,
  'C+i': () => editing() ? toggleInline(editor.view, '*') : false,
  'C+k': () => editing() ? insertLink(editor.view) : false,
  'CS+x': () => editing() ? toggleInline(editor.view, '~~') : false,
  'CS+h': () => editing() ? toggleInline(editor.view, '==') : false,
};
for (let i = 1; i <= 9; i++) SHORTCUTS[`C+${i}`] = () => tabs.length && activate(tabs[i === 9 ? tabs.length - 1 : Math.min(i, tabs.length) - 1], { focus: true });

document.addEventListener('keydown', e => {
  if (e.target.closest?.('dialog')) return;
  const combo = `${e.ctrlKey || e.metaKey ? 'C' : ''}${e.shiftKey ? 'S' : ''}${e.altKey ? 'A' : ''}+${e.key.toLowerCase()}`;
  const action = SHORTCUTS[combo];
  if (!action || action() === false) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

$('card').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 10 : -10);
}, { passive: false });

document.querySelector('.modes').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});
$('back').addEventListener('click', goBack);
$('forward').addEventListener('click', goForward);
$('tabs-prev').addEventListener('click', () => $('tabs').scrollBy({ left: -220, behavior: 'smooth' }));
$('tabs-next').addEventListener('click', () => $('tabs').scrollBy({ left: 220, behavior: 'smooth' }));
window.addEventListener('resize', updateTabScroll);
$('outline').addEventListener('click', e => { const b = e.target.closest('.outline-item'); if (b) jumpToHeading(+b.dataset.index, +b.dataset.pos); });
document.querySelector('.side-tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  update({ outline: b.dataset.view === 'outline' });
  showSidebarView(b.dataset.view);
});
$('new-tab').addEventListener('click', newTab);
$('new-note').addEventListener('click', () => { place(makeTab({ dir: sidebar.root ?? active?.dir })); setMode('edit'); });
$('side-toggle').addEventListener('click', toggleSidebar);
$('side-collapse').addEventListener('click', toggleSidebar);
$('workspace').addEventListener('click', () => sidebar.pickFolder());
$('settings-btn').addEventListener('click', showSettings);
$('copy').addEventListener('click', copyAll);
$('st-zoom').addEventListener('click', () => zoom(0));
window.addEventListener('focus', () => sidebar.refresh());

// ── Toast ───────────────────────────────────────────

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Settings reactions ──────────────────────────────

// The native title bar is painted in the page's exact chrome color; the page resolves it (light-dark, color-mix).
function chromeRgb() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--chrome-solid)';
  document.body.append(probe);
  const css = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',');
}
const syncChrome = () => call('theme', { dark: isDark(), glass: isGlass(), chrome: chromeRgb() });

onSettingsChange(patch => {
  if ('theme' in patch || 'accent' in patch || 'glass' in patch) syncChrome();
  if ('theme' in patch) {
    editor.refresh();
    if (settings.mode === 'read') renderRead();
  }
  if ('wrap' in patch || 'spellcheck' in patch || 'autoPairMd' in patch || 'typewriter' in patch) {
    editor.configure({ wrap: settings.wrap, spellcheck: settings.spellcheck, autoPairMd: settings.autoPairMd, typewriter: settings.typewriter });
  }
  if ('focus' in patch || 'typewriter' in patch) {
    applyWritingModes();
    toast(patch.focus !== undefined ? (settings.focus ? 'Modo foco ligado' : 'Modo foco desligado') : (settings.typewriter ? 'Máquina de escrever ligada' : 'Máquina de escrever desligada'));
  }
  if ('session' in patch) persistSession();
  if ('accent' in patch) applyIcon();
  if ('textSize' in patch || 'font' in patch || 'zoom' in patch) queueBubble();
});

function applyWritingModes() {
  document.body.classList.toggle('focus-mode', settings.focus);
  document.body.classList.toggle('typewriter', settings.typewriter);
  if (settings.typewriter && settings.mode === 'edit') {
    editor.view.dispatch({ effects: EditorView.scrollIntoView(editor.view.state.selection.main.head, { y: 'center' }) });
  }
}

/** The app icon follows the accent: window/taskbar (host) and the in-app marks. */
function applyIcon() {
  const src = `https://sustenido.app/icons/${settings.accent}.png`;
  $('app-mark').src = src;
  call('icon', { accent: settings.accent }).catch(() => {});
}

// ── Host events & startup ───────────────────────────

on('open', async ({ paths }) => {
  if (!paths.length) return newTab();
  for (const p of paths) await openPath(p);
});
on('closing', () => {
  call('closingAck');
  closeWindow();
});

(async () => {
  document.body.classList.toggle('no-sidebar', !settings.sidebar);
  applyWritingModes();
  showSidebarView(settings.outline ? 'outline' : 'tree');
  const init = await call('init');
  primary = init.primary;
  setGlassAvailable(init.glass);
  syncChrome();
  applyIcon();
  if (settings.root) sidebar.setRoot(settings.root);
  const restoredIndex = primary && settings.session && init.session ? await restore(init.session) : 0;
  if (tabs.length) activate(tabs[restoredIndex]);
  for (const f of init.files) await openPath(f);
  if (!tabs.length && !settings.welcomed) {
    // First run: a short tour instead of a blank page. Clean (not dirty), so closing it never prompts.
    place(makeTab({ name: 'Bem-vindo ao Sustenido', text: WELCOME, saved: WELCOME, dir: settings.root }));
    update({ welcomed: true });
  }
  if (!tabs.length) place(makeTab({ dir: settings.root }));
  document.body.classList.add('ready');
  call('ready', { js: Math.round(performance.now()) }); // startup timing → %LOCALAPPDATA%\Sustenido\startup.log
})();
