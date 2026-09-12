// Versioned worksheet text only. Never use this for learner answers or HTML input.
export const MARKDOWN_FORMAT = 'limited-markdown-v1';
export const PLAIN_FORMAT = 'plain_text';
// Match the package normalizer's legacy question detection before normalization.
const fieldKey = block => block?.kind === 'question' || (block?.prompt && typeof block.prompt === 'object') ? 'prompt' : 'content';
export function assertTextFormat(field) {
  const format = field?.format || PLAIN_FORMAT;
  if (![PLAIN_FORMAT, MARKDOWN_FORMAT].includes(format)) throw new Error(`Unsupported worksheet text format: ${format}`);
  return format;
}
export function assertWorksheetTextFormats(blocks = []) {
  for (const block of blocks) assertTextFormat(block?.[fieldKey(block)]);
}
export function hasMarkdown(blocks = []) {
  return blocks.some(block => block?.[fieldKey(block)]?.format === MARKDOWN_FORMAT);
}
export function upgradeEditableBlocks(blocks = []) {
  assertWorksheetTextFormats(blocks);
  let changed = false;
  const upgraded = blocks.map(block => {
    const key = fieldKey(block);
    const field = block[key] || {};
    if (field.format === MARKDOWN_FORMAT) return block;
    changed = true;
    return { ...block, [key]: { ...field, format: MARKDOWN_FORMAT,
      text: String(field.text ?? '').replace(/[\\`*{}\[\]()#+\-.!_>|~]/g, '\\$&') } };
  });
  return { blocks: upgraded, changed };
}

const textNode = text => ({ tag: 'text', text });
// Tokenize once; delimiter stacks are bounded to avoid recursive/backtracking parsers.
function inline(source) {
  const root = []; const stack = [{ children: root, marker: null }];
  const tokens = /\\[\\`*{}\[\]()#+\-.!_>|~]|!?\[[^\[\]\n]*\]\([^\)\n]*\)|`+[^`\n]*`+|\*{3,}|\*\*|\*/g;
  let end = 0;
  const append = value => stack.at(-1).children.push(textNode(value));
  for (const match of source.matchAll(tokens)) {
    append(source.slice(end, match.index)); end = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith('\\')) { append(token.slice(1)); continue; }
    if (token !== '*' && token !== '**') { append(token); continue; }
    if (stack.at(-1).marker === token && !/\s/.test(source[match.index - 1] || ' ')) {
      const frame = stack.pop();
      stack.at(-1).children.push({ tag: token === '**' ? 'strong' : 'em', children: frame.children });
    } else if (stack.length < 3 && !/\s/.test(source[end] || ' ')) {
      stack.push({ marker: token, children: [] });
    } else append(token);
  }
  append(source.slice(end));
  while (stack.length > 1) {
    const frame = stack.pop(); stack.at(-1).children.push(textNode(frame.marker), ...frame.children);
  }
  return root;
}

function parse(source) {
  const nodes = []; let paragraph = []; let list = null; let fence = null;
  const flush = () => { if (paragraph.length) nodes.push({ tag: 'p', children: inline(paragraph.join('\n')) }); paragraph = []; list = null; };
  for (const line of source.split(/\r\n|\r|\n/)) {
    if (fence) {
      nodes.push({ tag: 'p', children: [textNode(line)] });
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const fenceStart = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceStart) { flush(); fence = fenceStart[1]; nodes.push({ tag: 'p', children: [textNode(line)] }); continue; }
    if (!line.trim()) { flush(); nodes.push(line ? { tag: 'p', children: [textNode(line)] } : { tag: 'br' }); continue; }
    if (/^(?:[-*_][ \t]*){3,}$/.test(line)) { flush(); nodes.push({ tag: 'p', children: [textNode(line)] }); continue; }
    const heading = line.match(/^(#{2,6})[ \t]+(.+)$/);
    const quote = line.match(/^>[ \t]+(.*)$/);
    const bullet = line.match(/^- +(?!\[[ xX]\] )(.*)$/);
    const numbered = line.match(/^(\d{1,9})\. +(.*)$/);
    if (heading || quote) {
      flush(); nodes.push({ tag: heading ? `h${heading[1].length}` : 'blockquote', children: inline(heading ? heading[2] : quote[1]) });
    } else if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flush(); list = { tag, start: numbered ? Number(numbered[1]) : undefined, children: [] }; nodes.push(list);
      }
      list.children.push({ tag: 'li', children: inline(bullet ? bullet[1] : numbered[2]) });
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush(); return nodes;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TAGS = new Set(['p', 'br', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em']);
// Strict output allowlist: only generated nodes reach serialization; input HTML is always text.
function safeHtml(node) {
  if (node.tag === 'text') return escapeHtml(node.text);
  if (!TAGS.has(node.tag)) return '';
  if (node.tag === 'br') return '<br>';
  const start = node.tag === 'ol' && Number.isSafeInteger(node.start) && node.start >= 0 ? ` start="${node.start}"` : '';
  return `<${node.tag}${start}>${(node.children || []).map(safeHtml).join('')}</${node.tag}>`;
}
export function renderWorksheetText(field) {
  const format = assertTextFormat(field); const source = String(field?.text ?? '');
  return format === PLAIN_FORMAT ? escapeHtml(source) : parse(source).map(safeHtml).join('');
}
export function worksheetTextToPlain(field) {
  if (assertTextFormat(field) === PLAIN_FORMAT) return String(field?.text ?? '');
  const plain = node => node.tag === 'text' ? node.text : (node.children || []).map(plain).join(node.tag === 'ul' || node.tag === 'ol' ? '\n' : '');
  return parse(String(field?.text ?? '')).map(plain).join('\n');
}
export function setWorksheetText(element, field) {
  element.classList.add('worksheet-text');
  element.classList.toggle('worksheet-text--markdown', assertTextFormat(field) === MARKDOWN_FORMAT);
  if (assertTextFormat(field) === PLAIN_FORMAT) element.textContent = String(field?.text ?? '');
  else element.innerHTML = renderWorksheetText(field);
}
export const WORKSHEET_TEXT_CSS = `
.worksheet-text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.question-card__prompt-label.worksheet-text--markdown { font-weight: 400; }
.worksheet-text p { margin: 0; }
.worksheet-text h2,.worksheet-text h3,.worksheet-text h4,.worksheet-text h5,.worksheet-text h6 { margin: .5em 0 .25em; line-height: 1.3; text-transform: none; letter-spacing: normal; color: inherit; }
.worksheet-text h2 { font-size: 1.35em; } .worksheet-text h3 { font-size: 1.2em; }
.worksheet-text h4,.worksheet-text h5,.worksheet-text h6 { font-size: 1em; }
.worksheet-text ul,.worksheet-text ol { margin: .35em 0; padding-inline-start: 1.6em; white-space: normal; }
.worksheet-text li { white-space: pre-wrap; }
.worksheet-text blockquote { margin: .35em 0; padding-inline-start: .8em; border-inline-start: 3px solid #cbd5e1; }
@media print { .worksheet-text { overflow: visible; height: auto; } .worksheet-text h2,.worksheet-text h3 { break-after: avoid; } }
`;
export function installWorksheetTextStyles(doc) {
  if (!doc?.head || doc.getElementById('worksheet-text-styles')) return;
  const style = doc.createElement('style'); style.id = 'worksheet-text-styles'; style.textContent = WORKSHEET_TEXT_CSS;
  doc.head.appendChild(style);
}
