// Obsidian-style Live Preview for CodeMirror 6.
// The document text is never rewritten by rendering: formatting is purely visual (decorations),
// and markup reappears on whichever element the cursor touches. The only edits come from
// explicit user gestures (ticking a checkbox, dragging an image's resize handle).
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { BLOCK_MATH, COLOR_SPAN, FN_DEF, FN_REF, IMAGE_EXT, MARK_SPAN, INLINE_MATH, parseImageAlt, renderMath, wikiHref } from './markdown.js';
import { FRONTMATTER } from './properties.js';

const WIKILINK = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

// ==marca-texto== as a real lezer inline node (nests and escapes like ~~strikethrough~~).
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
export const Highlight = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': tags.special(tags.content) } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before));
    },
    after: 'Emphasis',
  }],
};

class TextWidget extends WidgetType {
  constructor(className, text) { super(); this.className = className; this.text = text; }
  eq(other) { return other.className === this.className && other.text === this.text; }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.className;
    el.textContent = this.text;
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(other) { return other.checked === this.checked && other.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-task';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Tarefa concluída' : 'Tarefa pendente');
    box.addEventListener('mousedown', e => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class ImageWidget extends WidgetType {
  // resize: { from, to, format(width) } — the text span that stores the size, or null.
  constructor(src, alt, width, height, resize) {
    super();
    // The base is part of the identity: when the note's folder changes (first save), the widget is rebuilt.
    Object.assign(this, { src, alt, width, height, resize, base: globalThis.document?.baseURI ?? '' });
  }
  eq(o) {
    return o.src === this.src && o.base === this.base && o.alt === this.alt && o.width === this.width
      && o.height === this.height && o.resize?.from === this.resize?.from;
  }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-lp-imgwrap';
    const img = document.createElement('img');
    img.className = 'cm-lp-img';
    img.alt = this.alt;
    img.src = new URL(this.src, this.base).href;
    if (this.width) img.style.width = `${this.width}px`;
    if (this.height) img.style.height = `${this.height}px`;
    wrap.append(img);
    if (this.resize) {
      const handle = document.createElement('span');
      handle.className = 'cm-lp-resize';
      handle.title = 'Arraste para redimensionar';
      handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const startX = e.clientX, startW = img.getBoundingClientRect().width;
        const max = view.contentDOM.clientWidth;
        const move = ev => {
          img.style.width = `${Math.round(Math.min(max, Math.max(48, startW + ev.clientX - startX)))}px`;
          img.style.height = 'auto';
        };
        const end = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', end);
          handle.removeEventListener('pointercancel', end);
          const w = parseInt(img.style.width, 10);
          if (w && w !== Math.round(startW)) {
            view.dispatch({ changes: { from: this.resize.from, to: this.resize.to, insert: this.resize.format(w) } });
          }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
      });
      wrap.append(handle);
    }
    return wrap;
  }
  ignoreEvent(e) { return !!e.target?.classList?.contains('cm-lp-resize'); }
}

class MathWidget extends WidgetType {
  constructor(tex, display) { super(); this.tex = tex; this.display = display; }
  eq(o) { return o.tex === this.tex && o.display === this.display; }
  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-lp-math cm-lp-math-block' : 'cm-lp-math';
    el.innerHTML = renderMath(this.tex, this.display); // KaTeX output, built from text — no raw HTML passthrough
    return el;
  }
  ignoreEvent() { return false; }
}

class HtmlWidget extends WidgetType {
  constructor(html) { super(); this.html = html; }
  eq(other) { return other.html === this.html; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-lp-block prose';
    el.innerHTML = this.html; // already sanitized by the caller
    return el;
  }
  ignoreEvent() { return false; } // a click lands the cursor inside, revealing the source
}

class DiagramWidget extends WidgetType {
  constructor(code, dark, render) { super(); this.code = code; this.dark = dark; this.render = render; }
  eq(o) { return o.code === this.code && o.dark === this.dark; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-lp-diagram diagram';
    this.render(el, this.code, this.dark);
    return el;
  }
  get estimatedHeight() { return 240; }
  ignoreEvent() { return false; }
}

const hidden = Decoration.replace({});

/**
 * Pure function of (state, focused, opts) → DecorationSet, testable without a DOM.
 * opts.renderBlock(markdown) → sanitized HTML (tables); opts.renderDiagram(el, code, dark); opts.dark.
 */
export function buildDecorations(state, focused, opts = {}) {
  const { doc } = state;
  const ranges = state.selection.ranges;
  const touches = (from, to) => focused && ranges.some(r => r.from <= to && r.to >= from);
  const touchesLine = (from, to) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const atLineEdges = (from, to) => doc.lineAt(from).from === from && doc.lineAt(to).to === to;
  const out = [];
  const hide = (from, to) => { if (from < to) out.push(hidden.range(from, to)); };
  const mark = (from, to, spec) => { if (from < to) out.push(Decoration.mark(spec).range(from, to)); };
  const replace = (from, to, widget, block = false) => out.push(Decoration.replace({ widget, block }).range(from, to));
  const lines = (from, to, cls) => {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      out.push(Decoration.line({ class: typeof cls === 'function' ? cls(line) : cls }).range(line.from));
      pos = line.to + 1;
    }
  };
  const withSpace = to => (doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);
  const tree = opts.tree ?? syntaxTree(state); // tests pass a fully parsed tree
  const text = doc.toString();
  const inCode = pos => /Code|HTML|Comment/.test(tree.resolveInner(pos, 1).name);

  // Spans lezer doesn't know (wikilinks, math). Tree nodes fully inside them are skipped.
  const claimed = [];
  const isClaimed = (from, to) => claimed.some(([a, b]) => from < b && to > a);

  const fm = FRONTMATTER.exec(text);
  if (fm) {
    const end = fm[0].endsWith('\n') ? fm[0].length - 1 : fm[0].length;
    claimed.push([0, end]);
    if (opts.renderProperties && !touches(0, end)) replace(0, end, new HtmlWidget(opts.renderProperties(fm[1])), true);
    else lines(0, end, 'cm-lp-yaml');
  }

  for (const m of text.matchAll(BLOCK_MATH)) {
    const from = m.index, to = from + m[0].length;
    if (inCode(from)) continue;
    claimed.push([from, to]);
    if (touches(from, to)) mark(from, to, { class: 'cm-lp-mathsrc' });
    else replace(from, to, new MathWidget(m[1].trim(), true));
  }
  for (const m of text.matchAll(INLINE_MATH)) {
    const from = m.index, to = from + m[0].length;
    if (isClaimed(from, to) || inCode(from)) continue;
    claimed.push([from, to]);
    if (touches(from, to)) mark(from, to, { class: 'cm-lp-mathsrc' });
    else replace(from, to, new MathWidget(m[1], false));
  }

  for (const m of text.matchAll(WIKILINK)) {
    const from = m.index, to = from + m[0].length;
    if (isClaimed(from, to) || inCode(from)) continue;
    claimed.push([from, to]);
    const [, bang, rawTarget, label] = m;
    const target = rawTarget.trim();
    if (bang && IMAGE_EXT.test(target)) {
      if (touches(from, to)) { mark(from, to, { class: 'cm-lp-mathsrc' }); continue; }
      const size = /^(\d+)(?:x(\d+))?$/.exec(label?.trim() ?? '');
      replace(from, to, new ImageWidget(encodeURI(target), target, size ? +size[1] : 0, size?.[2] ? +size[2] : 0,
        { from: from + 3, to: to - 2, format: w => `${rawTarget}|${w}` }));
      continue;
    }
    const spec = { class: 'cm-lp-link cm-lp-wikilink' };
    if (touches(from, to)) { mark(from, to, spec); continue; }
    spec.attributes = { 'data-href': wikiHref(target) };
    const labelFrom = label ? from + bang.length + 2 + rawTarget.length + 1 : from + bang.length + 2;
    hide(from, labelFrom);
    mark(labelFrom, to - 2, spec);
    hide(to - 2, to);
  }
  // Colored text: hide the <span> tags, paint the content. The content keeps its own Markdown.
  for (const m of text.matchAll(COLOR_SPAN)) {
    const from = m.index, to = from + m[0].length;
    if (isClaimed(from, to) || /Code/.test(tree.resolveInner(from, 1).name)) continue;
    const open = m[0].indexOf('>') + 1, close = '</span>'.length;
    if (touches(from, to)) { mark(from, from + open, { class: 'cm-lp-markup' }); mark(to - close, to, { class: 'cm-lp-markup' }); }
    else { hide(from, from + open); hide(to - close, to); }
    mark(from + open, to - close, { attributes: { style: `color: ${m[1]}` } });
  }

  for (const m of text.matchAll(MARK_SPAN)) {
    const from = m.index, to = from + m[0].length;
    if (isClaimed(from, to) || /Code/.test(tree.resolveInner(from, 1).name)) continue;
    const open = m[0].indexOf('>') + 1, close = '</mark>'.length;
    if (touches(from, to)) { mark(from, from + open, { class: 'cm-lp-markup' }); mark(to - close, to, { class: 'cm-lp-markup' }); }
    else { hide(from, from + open); hide(to - close, to); }
    mark(from + open, to - close, { class: 'cm-lp-highlight', attributes: { style: `--mark: ${m[1]}` } });
  }

  // Footnotes: references become small superscripts; definition lines are set smaller and muted.
  for (const m of text.matchAll(FN_REF)) {
    if (isClaimed(m.index, m.index + m[0].length) || inCode(m.index)) continue;
    mark(m.index, m.index + m[0].length, { class: 'cm-lp-fnref' });
  }
  for (let pos = 0; pos < doc.length;) {
    const line = doc.lineAt(pos);
    if (FN_DEF.test(line.text) && !inCode(line.from)) lines(line.from, line.from, 'cm-lp-fndef');
    pos = line.to + 1;
  }

  const skip = (from, to) => claimed.some(([a, b]) => from >= a && to <= b);

  tree.iterate({
    enter(n) {
      const { name, from, to } = n;
      if (skip(from, to)) return false;

      if (/^ATXHeading[1-6]$/.test(name)) {
        lines(from, from, `cm-lp-h cm-lp-h${name.slice(-1)}`);
        return;
      }
      switch (name) {
        case 'HeaderMark':
          if (n.node.parent?.name.startsWith('ATXHeading') && !touchesLine(from, to)) hide(from, withSpace(to));
          return;
        case 'Emphasis': mark(from, to, { class: 'cm-lp-em' }); return;
        case 'StrongEmphasis': mark(from, to, { class: 'cm-lp-strong' }); return;
        case 'Strikethrough': mark(from, to, { class: 'cm-lp-strike' }); return;
        case 'Highlight': mark(from, to, { class: 'cm-lp-highlight' }); return;
        case 'InlineCode': mark(from, to, { class: 'cm-lp-code' }); return;
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'HighlightMark': {
          const p = n.node.parent;
          if (!touches(p.from, p.to)) hide(from, to);
          return;
        }
        case 'CodeMark': {
          const p = n.node.parent;
          if (p.name === 'InlineCode' && !touches(p.from, p.to)) hide(from, to);
          return;
        }
        case 'Link': {
          const url = n.node.getChild('URL');
          if (!url) return; // "[texto]" without a URL is plain text, not a link
          if (touches(from, to)) { mark(from, to, { class: 'cm-lp-link' }); return; }
          const marks = n.node.getChildren('LinkMark');
          mark(from, to, { class: 'cm-lp-link', attributes: { 'data-href': doc.sliceString(url.from, url.to) } });
          hide(marks[0].from, marks[0].to);
          if (marks[1]) hide(marks[1].from, to);
          return;
        }
        case 'URL':
          if (n.node.parent?.name !== 'Link' && n.node.parent?.name !== 'Image') {
            mark(from, to, { class: 'cm-lp-link', attributes: touches(from, to) ? {} : { 'data-href': doc.sliceString(from, to) } });
          }
          return;
        case 'Image': {
          const url = n.node.getChild('URL');
          const marks = n.node.getChildren('LinkMark');
          if (!url || marks.length < 2 || touches(from, to)) return false;
          const altFrom = marks[0].to, altTo = marks[1].from;
          const info = parseImageAlt(doc.sliceString(altFrom, altTo));
          replace(from, to, new ImageWidget(doc.sliceString(url.from, url.to), info.alt, info.width ?? 0, info.height ?? 0,
            { from: altFrom, to: altTo, format: w => (info.alt ? `${info.alt}|${w}` : `|${w}`) }));
          return false;
        }
        case 'ListMark': {
          const item = n.node.parent;
          const task = item?.getChild('Task');
          if (task) {
            const marker = task.getChild('TaskMarker');
            if (marker && !touches(from, marker.to)) hide(from, withSpace(to));
          } else if (item?.parent?.name === 'BulletList' && !touches(from, to)) {
            replace(from, to, new TextWidget('cm-lp-bullet', '•'));
          } else {
            mark(from, to, { class: 'cm-lp-listmark' });
          }
          return;
        }
        case 'TaskMarker': {
          const checked = /x/i.test(doc.sliceString(from, to));
          if (checked) lines(from, from, 'cm-lp-done');
          if (!touches(from, to)) replace(from, to, new CheckboxWidget(checked, from));
          return;
        }
        case 'Blockquote':
          lines(from, to, 'cm-lp-quote');
          return;
        case 'QuoteMark':
          if (!touchesLine(from, to)) hide(from, withSpace(to));
          return;
        case 'FencedCode': {
          const info = n.node.getChild('CodeInfo');
          const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : '';
          if (lang === 'mermaid' && opts.renderDiagram && !touches(from, to) && atLineEdges(from, to)) {
            const code = n.node.getChild('CodeText');
            replace(from, to, new DiagramWidget(code ? doc.sliceString(code.from, code.to) : '', !!opts.dark, opts.renderDiagram), true);
            return false;
          }
          const first = doc.lineAt(from).number, last = doc.lineAt(to).number;
          lines(from, to, line => 'cm-lp-codeblock'
            + (line.number === first ? ' cm-lp-codeblock-first' : '')
            + (line.number === last ? ' cm-lp-codeblock-last' : ''));
          if (!touches(from, to)) {
            for (const c of [...n.node.getChildren('CodeMark'), ...n.node.getChildren('CodeInfo')]) hide(c.from, c.to);
          }
          return false;
        }
        case 'HorizontalRule':
          if (!touchesLine(from, to)) replace(from, to, new TextWidget('cm-lp-hr', ''));
          return;
        case 'Table':
          if (opts.renderBlock && !touches(from, to) && atLineEdges(from, to)) {
            replace(from, to, new HtmlWidget(opts.renderBlock(doc.sliceString(from, to))), true);
          } else {
            lines(from, to, 'cm-lp-tablesrc');
          }
          return false;
      }
    },
  });

  return Decoration.set(out, true);
}

/** Whether the editor has focus; a fresh state (new tab) must be told, since no focus event fires. */
export const setFocus = StateEffect.define();
/** Dispatch to re-render widgets whose look depends on outside state (e.g. the theme). */
export const refreshPreview = StateEffect.define();

const focusField = StateField.define({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setFocus) ? e.value : v), value),
});

export function livePreview(opts) {
  const build = state => buildDecorations(state, state.field(focusField), { ...opts, dark: opts.isDark?.() });
  const decorations = StateField.define({
    create: build,
    update(deco, tr) {
      const changed = tr.docChanged || tr.selection
        || tr.effects.some(e => e.is(setFocus) || e.is(refreshPreview))
        || syntaxTree(tr.state) !== syntaxTree(tr.startState);
      return changed ? build(tr.state) : deco;
    },
    provide: f => EditorView.decorations.from(f),
  });

  return [
    focusField,
    decorations,
    EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing)),
    EditorView.domEventHandlers({
      mousedown(e) {
        const link = e.button === 0 && e.target.closest?.('[data-href]');
        if (!link) return false;
        e.preventDefault();
        opts.openLink(link.dataset.href);
        return true;
      },
    }),
  ];
}
