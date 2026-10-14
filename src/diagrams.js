// Mermaid is ~3 MB: it is imported the first time a note actually contains a diagram.
let mermaid;
let seq = 0;
const cache = new Map();

async function renderMermaid(code, dark) {
  const key = (dark ? 'd:' : 'l:') + code;
  if (cache.has(key)) return cache.get(key);
  mermaid ??= (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict', // labels are sanitized; a note can't inject script through a diagram
    theme: dark ? 'dark' : 'neutral',
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
  });
  const id = `mmd-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, code);
    cache.set(key, svg);
    return svg;
  } finally {
    document.getElementById('d' + id)?.remove(); // mermaid leaves its scratch node behind on syntax errors
  }
}

export async function fillDiagram(el, code, dark) {
  try {
    el.innerHTML = await renderMermaid(code, dark);
  } catch (err) {
    el.classList.add('diagram-error');
    el.textContent = 'Diagrama Mermaid inválido: ' + (err?.message ?? err);
  }
}

/** Replaces ```mermaid blocks inside rendered HTML; resolves when every diagram is drawn. */
export function hydrateDiagrams(root, dark) {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  return Promise.all(blocks.map(code => {
    const el = document.createElement('div');
    el.className = 'diagram';
    code.parentElement.replaceWith(el);
    return fillDiagram(el, code.textContent, dark);
  }));
}
