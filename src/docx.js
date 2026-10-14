// Markdown → native .docx (real Word document, not HTML renamed to .doc).
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat,
  Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { marked } from './markdown.js';
import { splitFrontmatter } from './properties.js';

const MONO = 'Consolas';
const ACCENT = '5E5CE6';
const shade = fill => ({ type: ShadingType.CLEAR, color: 'auto', fill });

// marked keeps HTML entities in some token texts; Word needs the literal characters.
const decode = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

function inline(tokens = [], style = {}) {
  return tokens.flatMap(t => {
    switch (t.type) {
      case 'strong': return inline(t.tokens, { ...style, bold: true });
      case 'em': return inline(t.tokens, { ...style, italics: true });
      case 'del': return inline(t.tokens, { ...style, strike: true });
      case 'codespan': return [new TextRun({ ...style, text: decode(t.text), font: MONO, shading: shade('F2F2F4') })];
      case 'br': return [new TextRun({ break: 1 })];
      case 'link':
        return /^(https?:|mailto:)/i.test(t.href)
          ? [new ExternalHyperlink({ link: t.href, children: inline(t.tokens, { ...style, style: 'Hyperlink' }) })]
          : inline(t.tokens, style);
      case 'image': return t.text ? [new TextRun({ ...style, text: `[${t.text}]`, italics: true })] : [];
      case 'wikilink': return [new TextRun({ ...style, text: t.label })];
      case 'highlight': return inline(t.tokens, { ...style, highlight: 'yellow' });
      case 'math': return [new TextRun({ ...style, text: t.text, font: 'Cambria Math', italics: true })];
      case 'html': return [];
      default: return t.tokens ? inline(t.tokens, style) : [new TextRun({ ...style, text: decode(t.text ?? '') })];
    }
  });
}

function blocks(tokens, ctx) {
  const out = [];
  const para = (children, extra = {}) => new Paragraph({
    children,
    ...(ctx.level ? { indent: { left: 720 * ctx.level } } : {}),
    ...(ctx.quote ? { indent: { left: 360 + 720 * ctx.level }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 12 } } } : {}),
    ...extra,
  });

  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out.push(new Paragraph({ heading: HeadingLevel[`HEADING_${t.depth}`], children: inline(t.tokens) }));
        break;
      case 'paragraph':
      case 'text':
        out.push(para(t.tokens ? inline(t.tokens) : [new TextRun(decode(t.text))]));
        break;
      case 'list': {
        const instance = ++ctx.lists.count; // each ordered list restarts at 1
        for (const item of t.items) {
          const listing = t.ordered
            ? { numbering: { reference: 'numbers', level: Math.min(ctx.level, 5), instance } }
            : { bullet: { level: Math.min(ctx.level, 5) } };
          const box = item.task ? [new TextRun(item.checked ? '☑ ' : '☐ ')] : [];
          const [first, ...rest] = item.tokens;
          const lead = first && (first.type === 'text' || first.type === 'paragraph');
          out.push(new Paragraph({ ...listing, children: [...box, ...(lead ? inline(first.tokens ?? [first]) : [])] }));
          out.push(...blocks(lead ? rest : item.tokens, { ...ctx, level: ctx.level + 1 }));
        }
        break;
      }
      case 'blockquote':
        out.push(...blocks(t.tokens, { ...ctx, quote: true }));
        break;
      case 'code':
        for (const line of t.text.split('\n')) {
          out.push(new Paragraph({ style: 'Code', children: [new TextRun({ text: line, font: MONO })] }));
        }
        out.push(new Paragraph({ children: [] }));
        break;
      case 'mathBlock':
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t.text, font: 'Cambria Math', italics: true })] }));
        break;
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D0D5', space: 1 } } }));
        break;
      case 'table': {
        const cell = (c, head) => new TableCell({
          children: [new Paragraph({ children: inline(c.tokens, head ? { bold: true } : {}) })],
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          ...(head ? { shading: shade('F2F2F4') } : {}),
        });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: t.header.map(c => cell(c, true)) }),
            ...t.rows.map(r => new TableRow({ children: r.map(c => cell(c, false)) })),
          ],
        }));
        out.push(new Paragraph({ children: [] }));
        break;
      }
    }
  }
  return out;
}

export async function toDocx(markdown, title) {
  const doc = new Document({
    title,
    creator: 'Sustenido',
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 160, line: 300 } } } },
      paragraphStyles: [{
        id: 'Code', name: 'Code', basedOn: 'Normal',
        run: { font: MONO, size: 19 },
        paragraph: { spacing: { before: 0, after: 0, line: 260 }, shading: shade('F5F5F7') },
      }],
    },
    numbering: {
      config: [{
        reference: 'numbers',
        levels: Array.from({ length: 6 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{ children: blocks(marked.lexer(splitFrontmatter(markdown).body), { level: 0, quote: false, lists: { count: 0 } }) }],
  });
  return Packer.toBase64String(doc);
}
