// CodeMirror setup (Live Preview, search, Notepad keys) and Markdown formatting commands.
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { classHighlighter, tags } from '@lezer/highlight';
import { Highlight, livePreview, refreshPreview, setFocus } from './livepreview.js';

const PHRASES = {
  Find: 'Localizar', Replace: 'Substituir', next: 'próximo', previous: 'anterior', all: 'todos',
  'match case': 'Aa', regexp: '.*', 'by word': 'palavra inteira', replace: 'substituir',
  'replace all': 'substituir tudo', close: 'fechar', 'current match': 'resultado atual',
  'replaced $ matches': '$ substituições', 'replaced match on line $': 'substituído na linha $',
  'on line': 'na linha', 'Go to line': 'Ir para a linha', go: 'ir',
};

const BRACKETS = ['(', '[', '{', "'", '"'];
const MD_PAIRS = ['*', '_', '`', '~', '='];

// Tables, Typora-style: Enter on "| a | b |" creates the header rule and a first row; Enter at the end of a body
// row adds a row; Tab / Shift+Tab move between cells.
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]*\|\s*$/;
const columns = text => text.trim().slice(1, -1).split('|').length;

function tableEnter(view) {
  const { state } = view;
  const { head, empty } = state.selection.main;
  if (!empty) return false;
  const line = state.doc.lineAt(head);
  if (head !== line.to || !TABLE_ROW.test(line.text) || TABLE_RULE.test(line.text)) return false;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : '';
  const prev = line.number > 1 ? state.doc.line(line.number - 1).text : '';
  const row = '|' + '  |'.repeat(columns(line.text));
  const insert = TABLE_RULE.test(next) || TABLE_RULE.test(prev) || TABLE_ROW.test(prev)
    ? `\n${row}` // inside a table: new body row
    : `\n|${' --- |'.repeat(columns(line.text))}\n${row}`; // lone header line: make it a table
  view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length - row.length + 2 }, userEvent: 'input' });
  return true;
}

function tableTab(forward) {
  return view => {
    const { state } = view;
    const { head } = state.selection.main;
    const line = state.doc.lineAt(head);
    if (!TABLE_ROW.test(line.text)) return false;
    const col = head - line.from;
    const bars = [...line.text.matchAll(/\|/g)].map(m => m.index);
    const target = forward ? bars.find(b => b > col) : [...bars].reverse().find(b => b < col - 1);
    if (target == null || (forward && target === bars[bars.length - 1])) return false;
    const cell = forward ? target + 1 : (bars[bars.indexOf(target) - 1] ?? -1) + 1;
    const content = line.text.slice(cell, forward ? (bars.find(b => b > target) ?? line.length) : target);
    const start = cell + (content.match(/^\s*/)[0].length);
    const end = cell + content.replace(/\s+$/, '').length;
    view.dispatch({ selection: { anchor: line.from + start, head: line.from + Math.max(start, end) } });
    return true;
  };
}

export function createEditor({ parent, preview, onDocChange, onSelection, onFiles, onImages }) {
  const wrap = new Compartment();
  const spell = new Compartment();
  const pairs = new Compartment();
  const config = { wrap: true, spellcheck: true, autoPairMd: true, typewriter: false };
  const pairConfig = () => markdownLanguage.data.of({ closeBrackets: { brackets: config.autoPairMd ? [...BRACKETS, ...MD_PAIRS] : BRACKETS } });

  let centering = 0;
  const typewriter = EditorView.updateListener.of(u => {
    if (!config.typewriter || !(u.selectionSet || u.docChanged) || !u.transactions.some(t => t.isUserEvent('input') || t.isUserEvent('select') || t.isUserEvent('delete'))) return;
    cancelAnimationFrame(centering);
    centering = requestAnimationFrame(() => u.view.dispatch({ effects: EditorView.scrollIntoView(u.view.state.selection.main.head, { y: 'center' }) }));
  });

  const base = [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    highlightActiveLine(),
    closeBrackets(),
    typewriter,
    EditorState.allowMultipleSelections.of(true),
    EditorState.phrases.of(PHRASES),
    search({ top: true }),
    highlightSelectionMatches(),
    // Notepad bindings win over CodeMirror's defaults (Ctrl+G is "go to line", not "find next").
    Prec.high(keymap.of([
      { key: 'Mod-h', run: openSearchPanel },
      { key: 'Mod-g', run: gotoLine },
      { key: 'Enter', run: tableEnter },
      { key: 'Tab', run: tableTab(true), shift: tableTab(false) },
    ])),
    keymap.of([...closeBracketsKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Highlight] }),
    syntaxHighlighting(classHighlighter),
    syntaxHighlighting(HighlightStyle.define([{ tag: tags.processingInstruction, class: 'cm-lp-markup' }])),
    livePreview(preview),
    placeholder('Comece a escrever…'),
    EditorView.updateListener.of(u => {
      if (u.docChanged) onDocChange(u);
      if (u.docChanged || u.selectionSet || u.focusChanged || u.viewportChanged) onSelection(u);
    }),
    EditorView.domEventHandlers({
      paste(e) {
        const images = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
        if (!images.length) return false;
        e.preventDefault();
        onImages(images);
        return true;
      },
      drop(e, view) {
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos != null) view.dispatch({ selection: { anchor: pos } });
        onFiles(files);
        return true;
      },
    }),
    EditorView.theme({
      '&': { color: 'var(--fg)', backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--font-body)', lineHeight: '1.75', overflow: 'visible' },
      '.cm-content': { padding: '0 0 40vh', caretColor: 'var(--accent)' },
      '.cm-line': { padding: '0' },
      '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'var(--accent-soft)' },
      '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' },
      '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, #ffcc00 40%, transparent)', borderRadius: '3px' },
      '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, #ff9500 55%, transparent)' },
      '.cm-placeholder': { color: 'var(--muted)' },
    }),
  ];

  const dynamic = () => [
    wrap.of(config.wrap ? EditorView.lineWrapping : []),
    spell.of(EditorView.contentAttributes.of({ spellcheck: String(config.spellcheck), 'aria-label': 'Editor de Markdown' })),
    pairs.of(pairConfig()),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ extensions: [base, dynamic()] }) });

  return {
    view,
    createState: doc => EditorState.create({ doc, extensions: [base, dynamic()] }),
    /** Swaps in a tab's state and tells it whether the editor is focused (no focus event fires for a swap). */
    setState(state) {
      view.setState(state);
      view.dispatch({ effects: setFocus.of(view.hasFocus) });
    },
    /** Re-applies wrap/spellcheck — also needed after swapping in another tab's state. */
    configure(next = {}) {
      Object.assign(config, next);
      view.dispatch({
        effects: [
          wrap.reconfigure(config.wrap ? EditorView.lineWrapping : []),
          spell.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(config.spellcheck), 'aria-label': 'Editor de Markdown' })),
          pairs.reconfigure(pairConfig()),
        ],
      });
    },
    refresh: () => view.dispatch({ effects: refreshPreview.of(null) }),
  };
}

// ── Formatting commands ─────────────────────────────

/** Wraps or unwraps each selection with an inline marker (**, *, ~~, ==, `). */
export function toggleInline(view, mark) {
  const { state } = view;
  const n = mark.length;
  view.dispatch(state.changeByRange(range => {
    const before = state.sliceDoc(range.from - n, range.from);
    const after = state.sliceDoc(range.to, range.to + n);
    if (before === mark && after === mark) {
      return {
        changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }],
        range: EditorSelection.range(range.from - n, range.to - n),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
      return {
        changes: { from: range.from, to: range.to, insert: text.slice(n, -n) },
        range: EditorSelection.range(range.from, range.to - 2 * n),
      };
    }
    return {
      changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + n, range.to + n),
    };
  }), { userEvent: 'input.format' });
  view.focus();
}

const PREFIX = /^(\s*)(#{1,6} |> ?|[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/;
const KINDS = {
  p: { test: p => !p, make: () => '' },
  h1: { test: p => p === '# ', make: () => '# ' },
  h2: { test: p => p === '## ', make: () => '## ' },
  h3: { test: p => p === '### ', make: () => '### ' },
  quote: { test: p => /^> ?$/.test(p), make: () => '> ' },
  bullet: { test: p => /^[-*+] $/.test(p), make: () => '- ' },
  number: { test: p => /^\d+[.)] $/.test(p), make: i => `${i}. ` },
  task: { test: p => /^[-*+] \[[ xX]\] $/.test(p), make: () => '- [ ] ' },
};

/** The block kind at the cursor, for the "Parágrafo ▾" label. */
export function currentBlock(state) {
  const prefix = PREFIX.exec(state.doc.lineAt(state.selection.main.head).text)[2] ?? '';
  return Object.keys(KINDS).find(k => k !== 'p' && KINDS[k].test(prefix)) ?? 'p';
}

/** Turns every selected line into `kind`; applying the same kind again reverts to a paragraph. */
export function setBlock(view, kind) {
  const { state } = view;
  const numbers = new Set();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) numbers.add(l);
  }
  const lines = [...numbers].sort((a, b) => a - b).map(n => state.doc.line(n));
  const parsed = lines.map(line => PREFIX.exec(line.text));
  const off = kind !== 'p' && parsed.every(m => KINDS[kind].test(m[2] ?? ''));
  view.dispatch({
    changes: lines.map((line, i) => {
      const [, indent, prefix = ''] = parsed[i];
      return { from: line.from + indent.length, to: line.from + indent.length + prefix.length, insert: off ? '' : KINDS[kind].make(i + 1) };
    }),
    userEvent: 'input.format',
  });
  view.focus();
}

const SPAN_OPEN = /<span style="color:\s*(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+);?">$/;

/** Colors each selection (null removes the color). Re-coloring replaces the existing span instead of nesting. */
export function setTextColor(view, color) {
  const { state } = view;
  view.dispatch(state.changeByRange(range => {
    const line = state.doc.lineAt(range.from);
    const before = state.sliceDoc(line.from, range.from);
    const open = SPAN_OPEN.exec(before);
    const closed = state.sliceDoc(range.to, range.to + 7) === '</span>';
    const text = state.sliceDoc(range.from, range.to);
    if (open && closed) {
      const start = range.from - open[0].length;
      const tag = color ? `<span style="color: ${color}">` : '';
      return {
        changes: [{ from: start, to: range.from, insert: tag }, { from: range.to, to: range.to + 7, insert: color ? '</span>' : '' }],
        range: EditorSelection.range(start + tag.length, start + tag.length + text.length),
      };
    }
    if (!color || range.empty) return { range };
    const tag = `<span style="color: ${color}">`;
    return {
      changes: [{ from: range.from, insert: tag }, { from: range.to, insert: '</span>' }],
      range: EditorSelection.range(range.from + tag.length, range.to + tag.length),
    };
  }), { userEvent: 'input.format' });
  view.focus();
}

const MARK_OPEN = /<mark style="background(?:-color)?:\s*(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+);?">$/;

/** Highlights each selection: null = ==default color==, otherwise <mark style="background: color">. */
export function setHighlight(view, color) {
  if (!color) return toggleInline(view, '==');
  const { state } = view;
  view.dispatch(state.changeByRange(range => {
    const before = state.sliceDoc(state.doc.lineAt(range.from).from, range.from);
    const open = MARK_OPEN.exec(before);
    const closed = state.sliceDoc(range.to, range.to + 7) === '</mark>';
    const tag = `<mark style="background: ${color}">`;
    if (open && closed) { // recolor in place
      const start = range.from - open[0].length;
      return { changes: { from: start, to: range.from, insert: tag }, range: EditorSelection.range(start + tag.length, start + tag.length + (range.to - range.from)) };
    }
    if (range.empty) return { range };
    return {
      changes: [{ from: range.from, insert: tag }, { from: range.to, insert: '</mark>' }],
      range: EditorSelection.range(range.from + tag.length, range.to + tag.length),
    };
  }), { userEvent: 'input.format' });
  view.focus();
}

/** Headings of the document, for the outline panel. */
export function outline(state) {
  const items = [];
  syntaxTree(state).iterate({
    enter(n) {
      const m = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
      if (!m) return;
      const line = state.doc.lineAt(n.from);
      items.push({ level: +m[1], text: line.text.replace(/^#+\s*|\s*#+$/g, '').replace(/[*_`=~]/g, '').trim() || '(sem título)', pos: line.from });
      return false;
    },
  });
  return items;
}

/** Counts shown in the status bar popover. */
export function stats(state) {
  const text = state.doc.toString();
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return {
    words,
    chars: text.length,
    charsNoSpace: text.replace(/\s/g, '').length,
    lines: state.doc.lines,
    paragraphs: text.split(/\n\s*\n/).filter(p => p.trim()).length,
    minutes: Math.max(1, Math.round(words / 200)),
  };
}

export function insertLink(view) {
  const { state } = view;
  view.dispatch(state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^https?:\/\/\S+$/.test(text)) {
      return { changes: { from: range.from, to: range.to, insert: `[](${text})` }, range: EditorSelection.cursor(range.from + 1) };
    }
    const insert = `[${text}](url)`;
    const urlFrom = range.from + text.length + 3;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlFrom, urlFrom + 3) };
  }), { userEvent: 'input.format' });
  view.focus();
}

/** Inserts text at the cursor; block snippets get their own lines. `cursor` = offset inside `text`. */
export function insertText(view, text, { block = false, cursor = text.length } = {}) {
  const { state } = view;
  let { from, to } = state.selection.main;
  let lead = '';
  if (block) {
    const line = state.doc.lineAt(to);
    if (line.text.trim()) { from = to = line.to; lead = '\n\n'; }
  }
  view.dispatch({ changes: { from, to, insert: lead + text }, selection: { anchor: from + lead.length + cursor }, userEvent: 'input' });
  view.focus();
}

export function dateTime() {
  const now = new Date();
  return `${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ${now.toLocaleDateString('pt-BR')}`;
}
