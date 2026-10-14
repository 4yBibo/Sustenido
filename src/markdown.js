// Shared Markdown dialect: GFM + Obsidian wikilinks/embeds + image sizing + KaTeX math.
import { marked } from 'marked';
import katex from 'katex';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export const wikiHref = target => encodeURI(/\.md$/i.test(target.split('#')[0]) ? target : target.replace(/(#|$)/, '.md$1'));

// Obsidian sizing: "alt|300" or "alt|300x200".
export function parseImageAlt(alt) {
  const m = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(alt);
  return m ? { alt: m[1], width: +m[2], height: m[3] ? +m[3] : undefined } : { alt };
}

export const renderMath = (tex, display) =>
  katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });

// Pandoc rules: "$" opens only before a non-space and closes only after one, never before a digit —
// so prices like "R$ 10 e R$ 20" stay plain text.
export const INLINE_MATH = /(?<![\\$])\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![\d$])/g;
export const BLOCK_MATH = /\$\$([\s\S]+?)\$\$/g;

// Colored highlight: <mark style="background: #hex">texto</mark>. Plain ==texto== takes the theme/default color.
export const MARK_SPAN = /<mark style="background(?:-color)?:\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+);?">([^<\n]*)<\/mark>/g;
export const MARK_COLORS = [
  { id: '#facc15', name: 'Amarelo' }, { id: '#4ade80', name: 'Verde' }, { id: '#60a5fa', name: 'Azul' },
  { id: '#f472b6', name: 'Rosa' }, { id: '#fb923c', name: 'Laranja' }, { id: '#a78bfa', name: 'Lilás' }, { id: '#f87171', name: 'Vermelho' },
];

// Colored text, Obsidian-compatible: <span style="color: #e5484d">texto</span>. Only plain color values are accepted.
export const COLOR_SPAN = /<span style="color:\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+);?">([^<\n]*)<\/span>/g;
export const TEXT_COLORS = [
  { id: '#e5484d', name: 'Vermelho' }, { id: '#f2711c', name: 'Laranja' }, { id: '#d9a404', name: 'Amarelo' },
  { id: '#1fa463', name: 'Verde' }, { id: '#0ea5a4', name: 'Turquesa' }, { id: '#2f80ed', name: 'Azul' },
  { id: '#7c5cff', name: 'Roxo' }, { id: '#e5488f', name: 'Rosa' }, { id: '#8e8e93', name: 'Cinza' },
];

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const imgTag = (src, { alt, width, height }) =>
  `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt ?? '')}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`;

// Footnotes: "[^id]" in the text, "[^id]: texto" definitions; numbered in order of first reference,
// listed at the end of the document, and shown as a tooltip on hover.
let footnotes = new Map();
export const FN_REF = /\[\^([^\]\s]+)\](?!:)/g;
export const FN_DEF = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;

marked.use({
  gfm: true,
  hooks: {
    preprocess(md) { footnotes = new Map(); return md; },
    postprocess(html) {
      if (!footnotes.size) return html.replace(/<sup class="fn-ref" data-fn="[^"]*"><\/sup>/g, '');
      const order = [];
      html = html.replace(/<sup class="fn-ref" data-fn="([^"]*)"><\/sup>/g, (_, id) => {
        const def = footnotes.get(id);
        if (!def) return `[^${id}]`;
        if (!order.includes(id)) order.push(id);
        const n = order.indexOf(id) + 1;
        return `<sup class="fn-ref" id="fnref-${escapeHtml(id)}"><a href="#fn-${escapeHtml(id)}" data-tip="${escapeHtml(def.text)}">${n}</a></sup>`;
      });
      if (!order.length) return html;
      // U+FE0E keeps the arrow as text; without it the emoji font takes over.
      const items = order.map(id => `<li id="fn-${escapeHtml(id)}">${footnotes.get(id).html} <a href="#fnref-${escapeHtml(id)}" class="fn-back" aria-label="Voltar ao texto">&#8617;&#xFE0E;</a></li>`);
      return `${html}<section class="footnotes" role="doc-endnotes"><ol>${items.join('')}</ol></section>`;
    },
  },
  renderer: {
    image({ href, text }) { return imgTag(href, parseImageAlt(text)); },
  },
  extensions: [
    {
      name: 'footnoteDef',
      level: 'block',
      start: src => src.search(/^\[\^[^\]\s]+\]:/m),
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n[ \t]+[^\n]+)*)/.exec(src);
        if (!m) return;
        const text = m[2].replace(/\n[ \t]+/g, ' ').trim();
        return { type: 'footnoteDef', raw: m[0], id: m[1], text, tokens: this.lexer.inlineTokens(text) };
      },
      renderer(t) {
        footnotes.set(t.id, { text: t.text.replace(/[*_`~=]/g, ''), html: this.parser.parseInline(t.tokens) });
        return '';
      },
    },
    {
      name: 'footnoteRef',
      level: 'inline',
      start: src => src.indexOf('[^'),
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
        if (m) return { type: 'footnoteRef', raw: m[0], id: m[1] };
      },
      renderer: t => `<sup class="fn-ref" data-fn="${escapeHtml(t.id)}"></sup>`,
    },
    {
      name: 'mathBlock',
      level: 'block',
      start: src => src.indexOf('$$'),
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer: t => `<div class="math">${renderMath(t.text, true)}</div>`,
    },
    {
      name: 'math',
      level: 'inline',
      start: src => src.indexOf('$'),
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$/.exec(src) ?? /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![\d$])/.exec(src);
        if (m) return { type: 'math', raw: m[0], text: m[1], display: m[0].startsWith('$$') };
      },
      renderer: t => renderMath(t.text, t.display),
    },
    {
      name: 'highlight', // ==marca-texto==
      level: 'inline',
      start: src => src.indexOf('=='),
      tokenizer(src) {
        const m = /^==(?![\s=])([\s\S]*?[^\s=])==(?!=)/.exec(src);
        if (m) return { type: 'highlight', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
    },
    {
      name: 'wikilink',
      level: 'inline',
      start: src => src.search(/!?\[\[/),
      tokenizer(src) {
        const m = /^(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
        if (m) return { type: 'wikilink', raw: m[0], embed: !!m[1], target: m[2].trim(), label: (m[3] ?? m[2]).trim() };
      },
      renderer(t) {
        if (t.embed && IMAGE_EXT.test(t.target)) {
          const size = /^(\d+)(?:x(\d+))?$/.exec(t.label);
          return imgTag(encodeURI(t.target), { alt: t.target, width: size?.[1], height: size?.[2] });
        }
        return `<a class="wikilink" href="${escapeHtml(wikiHref(t.target))}">${escapeHtml(t.label)}</a>`;
      },
    },
  ],
});

export { marked };
