import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { Highlight, buildDecorations } from './livepreview.js';
import { marked } from './markdown.js';
import { renderProperties, splitFrontmatter } from './properties.js';
import { toDocx } from './docx.js';

function decorate(doc, { focused = false, cursor = 0, opts = {} } = {}) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage, extensions: [Highlight] })],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const hidden = [], widgets = [], marks = [];
  buildDecorations(state, focused, { ...opts, tree }).between(0, doc.length, (from, to, deco) => {
    const slice = doc.slice(from, to);
    if (deco.spec.widget) widgets.push(slice);
    else if (deco.spec.class) marks.push([deco.spec.class, slice]);
    else if (from !== to && !deco.spec.attributes) hidden.push(slice);
  });
  return { hidden, widgets, marks };
}

const DOC = [
  '# Título',
  '**negrito** e [[Outra nota|apelido]] e [site](https://x.dev) e [sic]',
  '- [ ] tarefa',
  '> citação',
].join('\n');

test('unfocused: markup is hidden, plain brackets are kept', () => {
  // "[sic]" has no URL, so its brackets must survive.
  assert.deepEqual(decorate(DOC).hidden, ['# ', '**', '**', '[[Outra nota|', ']]', '[', '](https://x.dev)', '- ', '> ']);
});

test('cursor on the heading reveals only that line', () => {
  const { hidden } = decorate(DOC, { focused: true, cursor: 2 });
  assert.ok(!hidden.includes('# '));
  assert.ok(hidden.includes('**'));
});

test('cursor inside a wikilink reveals its brackets', () => {
  const { hidden } = decorate(DOC, { focused: true, cursor: DOC.indexOf('Outra') });
  assert.ok(!hidden.includes('[[Outra nota|'));
});

test('a list item containing a wikilink still renders its bullet', () => {
  const { widgets } = decorate('- veja [[Nota]]\n');
  assert.deepEqual(widgets, ['-']);
});

test('==marca-texto== hides its marks and is styled', () => {
  const { hidden, marks } = decorate('um ==destaque== aqui');
  assert.deepEqual(hidden, ['==', '==']);
  assert.ok(marks.some(([cls, s]) => cls === 'cm-lp-highlight' && s === '==destaque=='));
});

test('math renders as widgets, prices stay text', () => {
  const doc = 'Energia $E=mc^2$ custa R$ 10 e R$ 20.\n\n$$\n\\int_0^1 x\\,dx\n$$\n';
  const { widgets } = decorate(doc);
  assert.deepEqual(widgets, ['$E=mc^2$', '$$\n\\int_0^1 x\\,dx\n$$']);
  assert.match(marked.parse('R$ 10 e R$ 20'), /R\$ 10 e R\$ 20/);
  assert.match(marked.parse('$x^2$'), /class="katex"/);
});

test('sized images keep their size spec in the alt text', () => {
  assert.match(marked.parse('![logo|240](a.png)'), /<img src="a.png" alt="logo" width="240">/);
  assert.match(marked.parse('![[foto.png|300]]'), /<img src="foto.png" alt="foto.png" width="300">/);
});

test('frontmatter becomes a properties widget and stays out of the body', () => {
  const doc = '---\ntags: [projeto, q4]\ncriado: 2020-09-30\n---\n# Corpo\n';
  const { widgets } = decorate(doc, { opts: { renderProperties: () => '<div class="props"></div>' } });
  assert.equal(widgets[0], '---\ntags: [projeto, q4]\ncriado: 2020-09-30\n---');
  assert.equal(splitFrontmatter(doc).body, '# Corpo\n');
  const html = renderProperties('tags: [projeto, "<b>x</b>"]\nautor: Nico\nsite: https://www.dribbble.com/x');
  assert.match(html, /chip tag t\d">projeto</);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, 'values are escaped');
  assert.match(html, /dribbble\.com/);
});

test('docx export produces a zip package', async () => {
  const b64 = await toDocx('---\na: 1\n---\n# T\n\n1. um\n2. dois\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`x` **y** ==z== $x^2$ [l](https://a.b)', 'T');
  const bytes = Buffer.from(b64, 'base64');
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.ok(bytes.length > 2000);
});
