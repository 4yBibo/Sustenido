// YAML frontmatter → Obsidian-style Properties panel (icon + key, values as tinted chips).
import { parse } from 'yaml';
import DOMPurify from 'dompurify';
import { marked, wikiHref } from './markdown.js';

export const FRONTMATTER = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/;

export function splitFrontmatter(md) {
  const m = FRONTMATTER.exec(md);
  return m ? { yaml: m[1], body: md.slice(m[0].length), length: m[0].length } : { yaml: null, body: md, length: 0 };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const svg = d => `<svg viewBox="0 0 20 20" aria-hidden="true">${d}</svg>`;
const ICONS = {
  tag: svg('<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h5.38a1.5 1.5 0 0 1 1.06.44l5.62 5.62a1.5 1.5 0 0 1 0 2.12l-5.38 5.38a1.5 1.5 0 0 1-2.12 0L3.44 10.94A1.5 1.5 0 0 1 3 9.88zM7 8.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5z" class="fill"/>'),
  date: svg('<path d="M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zm.75 3.75v3.44l2.28 2.28-1.06 1.06-2.72-2.72V6.25z" class="fill"/>'),
  person: svg('<path d="M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-6 6.25C4 13.9 6.7 12 10 12s6 1.9 6 4.25V17H4z" class="fill"/>'),
  link: svg('<path d="M5.5 2.5h6L16 7v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 16V4a1.5 1.5 0 0 1 1.5-1.5z" class="fill"/>'),
  check: svg('<path d="M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zm3.53 5.28-4.5 4.5L6.47 9.72l1.06-1.06 1.5 1.5 3.44-3.44z" class="fill"/>'),
  text: svg('<path d="M4 5h12v1.5H4zm0 4.25h12v1.5H4zm0 4.25h8v1.5H4z" class="fill"/>'),
};

function iconFor(key) {
  if (/tag|label|etiqueta|categor|tipo|type/i.test(key)) return ICONS.tag;
  if (/date|data|cria|created|update|modific|prazo|due|quando|when/i.test(key)) return ICONS.date;
  if (/autor|author|by$|^por$|owner|respons|pessoa|people|assignee/i.test(key)) return ICONS.person;
  if (/link|url|relat|source|fonte|^ref/i.test(key)) return ICONS.link;
  if (/status|done|feito|conclu/i.test(key)) return ICONS.check;
  return ICONS.text;
}

const tint = s => [...String(s)].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 7) % 8;

const isDate = v => /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}.*)?$/.test(v);
function formatDate(v) {
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  return v.length > 10 ? `${day}, ${v.slice(11, 16)}` : day;
}

function single(v, asTag) {
  const s = String(v).trim();
  const wiki = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(s);
  if (wiki) return `<a class="chip chip-link" data-href="${esc(wikiHref(wiki[1].trim()))}">${esc((wiki[2] ?? wiki[1]).trim())}</a>`;
  if (/^https?:\/\//i.test(s)) {
    let host = s;
    try { host = new URL(s).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    return `<a class="chip chip-link" data-href="${esc(s)}"><span class="chip-dot t${tint(host)}"></span>${esc(host)}</a>`;
  }
  if (asTag) return `<span class="chip tag t${tint(s.replace(/^#/, ''))}">${esc(s.replace(/^#/, ''))}</span>`;
  if (isDate(s)) return `<span class="prop-text">${esc(formatDate(s))}</span>`;
  return `<span class="prop-text">${esc(s)}</span>`;
}

function value(key, v) {
  const asTag = /tag|label|etiqueta|categor|alias/i.test(key);
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '<span class="prop-empty">Vazio</span>';
  if (Array.isArray(v)) return v.map(x => single(x, asTag)).join('');
  if (typeof v === 'boolean') return `<input type="checkbox" disabled${v ? ' checked' : ''} aria-label="${esc(key)}">`;
  if (typeof v === 'object') return `<span class="prop-text">${esc(JSON.stringify(v))}</span>`;
  return single(v, asTag);
}

/** HTML for a frontmatter block. Every value is escaped; links carry data-href only. */
export function renderProperties(yamlText) {
  let data;
  try { data = parse(yamlText); } catch { return '<div class="props props-error">Propriedades com YAML inválido — clique para editar.</div>'; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const rows = Object.entries(data).map(([k, v]) =>
    `<div class="prop"><span class="prop-key">${iconFor(k)}${esc(k)}</span><span class="prop-val">${value(k, v)}</span></div>`);
  return `<div class="props">${rows.join('')}</div>`;
}

/** Full note → sanitized HTML (properties panel + body). Notes are untrusted input. */
export function renderHtml(md) {
  const { yaml, body } = splitFrontmatter(md);
  return DOMPurify.sanitize((yaml != null ? renderProperties(yaml) : '') + marked.parse(body));
}
