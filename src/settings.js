// User preferences: defaults, persistence, application to the document, and the Settings sheet.

import ACCENT_LIST from './accents.json';

// Each accent has a light-theme value (≥4.5:1 on white, safe for links) and a dark-theme value.
// Shared with tools/make-icons.ps1, which tints the app icon to match each accent.
export const ACCENTS = ACCENT_LIST;

const FONTS = [
  { id: 'inter', name: 'Inter' },
  { id: 'serif', name: 'Serifada' },
  { id: 'system', name: 'Sistema' },
  { id: 'mono', name: 'Mono' },
];

const DEFAULTS = {
  theme: 'system', accent: 'roxo', textSize: 16, zoom: 100, font: 'inter',
  glass: true, readable: true, inlineTitle: true, wrap: true, spellcheck: true, statusBar: true,
  session: true, sidebar: true, mode: 'edit', root: null, expanded: [],
  markColor: 'theme', welcomed: false,
};

const MARK_COLORS = [
  { id: '#facc15', name: 'Amarelo' }, { id: '#4ade80', name: 'Verde' }, { id: '#60a5fa', name: 'Azul' },
  { id: '#f472b6', name: 'Rosa' }, { id: '#fb923c', name: 'Laranja' }, { id: '#a78bfa', name: 'Lilás' }, { id: '#f87171', name: 'Vermelho' },
];

const SHORTCUTS = [
  ['Ler / editar', 'Ctrl+E'], ['Nova aba', 'Ctrl+N'], ['Abrir', 'Ctrl+O'], ['Salvar', 'Ctrl+S'],
  ['Localizar / substituir', 'Ctrl+F / Ctrl+H'], ['Ir para a linha', 'Ctrl+G'], ['Negrito / itálico', 'Ctrl+B / Ctrl+I'],
  ['Marca-texto', 'Ctrl+Shift+H'], ['Link', 'Ctrl+K'], ['Emoji', 'Win+.'], ['Barra lateral', 'Ctrl+\\'],
  ['Próxima aba', 'Ctrl+Tab'], ['Zoom', 'Ctrl+ + / Ctrl+ −'], ['Hora/data', 'F5'], ['Configurações', 'Ctrl+,'],
];

const KEY = 'sustenido.settings';
export const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
})();

const listeners = [];
export const onSettingsChange = fn => listeners.push(fn);

export function update(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* preferences are a convenience */ }
  applySettings();
  for (const fn of listeners) fn(patch);
}

let glassAvailable = false;
export const setGlassAvailable = value => { glassAvailable = value; applySettings(); };

const systemDark = matchMedia('(prefers-color-scheme: dark)');
export const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && systemDark.matches);
systemDark.addEventListener('change', () => { applySettings(); for (const fn of listeners) fn({ theme: settings.theme }); });

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const onAccent = hex => (luminance(hex) > 0.4 ? '#141416' : '#ffffff');

export function applySettings() {
  const root = document.documentElement;
  const accent = ACCENTS.find(a => a.id === settings.accent) ?? ACCENTS[0];
  root.style.setProperty('--accent-l', accent.light);
  root.style.setProperty('--accent-d', accent.dark);
  root.style.setProperty('--on-accent-l', onAccent(accent.light));
  root.style.setProperty('--on-accent-d', onAccent(accent.dark));
  root.style.setProperty('--text-size', `${(settings.textSize * settings.zoom) / 100}px`);
  root.dataset.theme = settings.theme;
  root.dataset.font = settings.font;
  root.dataset.readable = String(settings.readable);
  root.dataset.statusbar = String(settings.statusBar);
  root.dataset.inlineTitle = String(settings.inlineTitle);
  root.dataset.glass = String(glassAvailable && settings.glass);
  if (settings.markColor === 'theme') root.style.removeProperty('--mark-custom');
  else root.style.setProperty('--mark-custom', settings.markColor);
}

// ── Settings sheet ──────────────────────────────────

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.flat().filter(c => c != null));
  return el;
};

function row(label, hint, control) {
  return h('div', { className: 'set-row' },
    h('div', { className: 'set-label' }, h('span', { textContent: label }), hint && h('small', { textContent: hint })),
    control);
}

function segmented(name, options, value, onPick) {
  const group = h('div', { className: 'segmented', role: 'radiogroup', ariaLabel: name });
  for (const o of options) {
    const b = h('button', { type: 'button', role: 'radio', textContent: o.name });
    b.setAttribute('aria-checked', String(o.id === value));
    b.addEventListener('click', () => {
      for (const x of group.children) x.setAttribute('aria-checked', String(x === b));
      onPick(o.id);
    });
    group.append(b);
  }
  return group;
}

function toggle(label, key) {
  const input = h('input', { type: 'checkbox', className: 'switch', checked: !!settings[key] });
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => update({ [key]: input.checked }));
  return input;
}

export function openSettings(dialog) {
  const swatches = h('div', { className: 'swatches', role: 'radiogroup', ariaLabel: 'Cor de destaque' });
  const accentName = h('span', { className: 'set-value' });
  const paintAccent = () => { accentName.textContent = ACCENTS.find(a => a.id === settings.accent)?.name ?? ''; };
  for (const a of ACCENTS) {
    const s = h('button', { type: 'button', className: 'swatch', title: a.name, ariaLabel: a.name });
    s.setAttribute('role', 'radio');
    s.setAttribute('aria-checked', String(a.id === settings.accent));
    s.style.setProperty('--sw-l', a.light);
    s.style.setProperty('--sw-d', a.dark);
    s.addEventListener('click', () => {
      for (const x of swatches.children) x.setAttribute('aria-checked', String(x === s));
      update({ accent: a.id });
      paintAccent();
    });
    swatches.append(s);
  }
  paintAccent();

  // Marca-texto: "theme" follows the accent; any other choice sticks regardless of the accent.
  const marks = h('div', { className: 'swatches mark-swatches', role: 'radiogroup', ariaLabel: 'Cor do marca-texto' });
  const markName = h('span', { className: 'set-value' });
  const paintMark = () => { markName.textContent = settings.markColor === 'theme' ? 'Cor do tema' : MARK_COLORS.find(c => c.id === settings.markColor)?.name ?? ''; };
  for (const c of [{ id: 'theme', name: 'Cor do tema' }, ...MARK_COLORS]) {
    const s = h('button', { type: 'button', className: 'swatch', title: c.name, ariaLabel: c.name });
    s.setAttribute('role', 'radio');
    s.setAttribute('aria-checked', String(c.id === settings.markColor));
    const tone = c.id === 'theme' ? null : c.id;
    s.style.setProperty('--sw-l', tone ?? 'var(--accent-l)');
    s.style.setProperty('--sw-d', tone ?? 'var(--accent-d)');
    if (!tone) s.classList.add('swatch-theme');
    s.addEventListener('click', () => {
      for (const x of marks.children) x.setAttribute('aria-checked', String(x === s));
      update({ markColor: c.id });
      paintMark();
    });
    marks.append(s);
  }
  paintMark();

  const sizeValue = h('output', { className: 'set-value', textContent: `${settings.textSize} px` });
  const size = h('input', { type: 'range', min: 12, max: 28, step: 1, value: settings.textSize, className: 'range', ariaLabel: 'Tamanho do texto' });
  size.addEventListener('input', () => { sizeValue.textContent = `${size.value} px`; update({ textSize: +size.value }); });

  const sessionGroup = segmented('Ao iniciar', [
    { id: true, name: 'Continuar sessão anterior' },
    { id: false, name: 'Começar nova sessão' },
  ], settings.session, v => update({ session: v }));

  dialog.replaceChildren(
    h('form', { method: 'dialog', className: 'sheet' },
      h('header', { className: 'sheet-head' },
        h('h2', { textContent: 'Configurações' }),
        h('button', { className: 'icon close', value: 'close', ariaLabel: 'Fechar', innerHTML: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>' })),
      h('div', { className: 'sheet-body' },
        h('section', {},
          h('h3', { textContent: 'Aparência' }),
          row('Tema', null, segmented('Tema', [
            { id: 'system', name: 'Sistema' }, { id: 'light', name: 'Claro' }, { id: 'dark', name: 'Escuro' },
          ], settings.theme, v => update({ theme: v }))),
          h('div', { className: 'set-row set-col' },
            h('div', { className: 'set-label' }, h('span', { textContent: 'Cor de destaque' }), accentName),
            swatches),
          h('div', { className: 'set-row set-col' },
            h('div', { className: 'set-label' }, h('span', { textContent: 'Cor do marca-texto' }), markName),
            marks),
          row('Tamanho do texto', 'Também ajustável com Ctrl + e Ctrl −', h('div', { className: 'range-wrap' }, h('span', { className: 'aa small', textContent: 'A' }), size, h('span', { className: 'aa', textContent: 'A' }), sizeValue)),
          row('Fonte', null, segmented('Fonte', FONTS, settings.font, v => update({ font: v }))),
          row('Efeito vidro', 'Transparência com desfoque ao redor do documento', toggle('Efeito vidro', 'glass')),
          row('Largura de leitura confortável', 'Limita o comprimento das linhas', toggle('Largura de leitura', 'readable')),
          row('Mostrar título da nota', 'Editável — renomeia o arquivo', toggle('Mostrar título', 'inlineTitle'))),
        h('section', {},
          h('h3', { textContent: 'Editor' }),
          row('Quebra automática de linha', null, toggle('Quebra automática de linha', 'wrap')),
          row('Verificação ortográfica', null, toggle('Verificação ortográfica', 'spellcheck')),
          row('Barra de status', null, toggle('Barra de status', 'statusBar'))),
        h('section', {},
          h('h3', { textContent: 'Ao iniciar o Sustenido' }),
          h('div', { className: 'set-row set-col' }, sessionGroup)),
        h('section', {},
          h('h3', { textContent: 'Atalhos de teclado' }),
          h('dl', { className: 'shortcuts' }, SHORTCUTS.flatMap(([what, keys]) => [
            h('dt', { textContent: what }),
            h('dd', {}, h('kbd', { textContent: keys })),
          ]))),
        h('section', { className: 'about' },
          h('h3', { textContent: 'Sobre' }),
          h('p', {}, h('span', { className: 'wordmark about-word', textContent: 'Sustenido' }), h('span', { textContent: ' — Edição Markdown Visual · versão 1.0' }))))));
  dialog.showModal();
}
