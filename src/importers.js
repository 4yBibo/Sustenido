// HTML / PDF → Markdown. Loaded on demand, only when a document is imported.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export function htmlToMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript', 'iframe', 'title', 'meta', 'link', 'template']);
  return td.turndown(html).trim() + '\n';
}

const BULLET = /^[•●▪◦‣∙·–]\s*/;

// PDFs carry positioned glyphs, not structure: rebuild lines by baseline, headings by font size,
// paragraphs by vertical gaps. Best-effort by nature; scanned PDFs (images) have no text to extract.
export async function pdfToMarkdown(bytes) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;

  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    let line = null;
    for (const it of items) {
      if (!('str' in it)) continue;
      const y = it.transform[5];
      const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10 || it.height;
      if (!line || Math.abs(line.y - y) > size * 0.6) {
        line = { y, size, text: '', page: p };
        lines.push(line);
      }
      line.text += it.str;
      line.size = Math.max(line.size, size);
      if (it.hasEOL) line = null;
    }
  }
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim();
  const text = lines.filter(l => l.text);
  if (!text.length) throw new Error('O PDF não contém texto extraível (pode ser uma imagem digitalizada).');

  // Body size = the size that covers the most characters.
  const weight = new Map();
  for (const l of text) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  const body = [...weight].sort((a, b) => b[1] - a[1])[0][0];

  const out = [];
  let para = '';
  const flush = () => { if (para) out.push(para); para = ''; };
  for (let i = 0; i < text.length; i++) {
    const l = text[i], prev = text[i - 1];
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity;
    const ratio = l.size / body;
    if (ratio >= 1.15 && l.text.length < 120) {
      flush();
      out.push(`${ratio >= 1.6 ? '#' : ratio >= 1.3 ? '##' : '###'} ${l.text}`);
    } else if (BULLET.test(l.text)) {
      flush();
      para = '- ' + l.text.replace(BULLET, '');
    } else if (para && gap < l.size * 1.8) {
      para = /\w-$/.test(para) ? para.slice(0, -1) + l.text : para + ' ' + l.text; // re-join hyphenated words
    } else {
      flush();
      para = l.text;
    }
  }
  flush();
  return out.join('\n\n') + '\n';
}
