// Syntax highlighting for rendered code blocks (read view, PDF, HTML export).
// Uses the same lezer parsers and tok-* classes as the editor, so both modes color code identically.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightCode } from '@lezer/highlight';

export async function highlightBlocks(root) {
  const blocks = [...root.querySelectorAll('pre > code[class*="language-"]')];
  await Promise.all(blocks.map(async code => {
    const name = /language-([\w#+.-]+)/.exec(code.className)?.[1];
    const desc = name && LanguageDescription.matchLanguageName(languages, name, true);
    if (!desc) return;
    const support = await desc.load(); // each language is its own lazy chunk
    const text = code.textContent;
    const out = document.createDocumentFragment();
    highlightCode(text, support.language.parser.parse(text), classHighlighter,
      (t, cls) => out.append(cls ? Object.assign(document.createElement('span'), { className: cls, textContent: t }) : t),
      () => out.append('\n'));
    code.replaceChildren(out);
  }));
}
