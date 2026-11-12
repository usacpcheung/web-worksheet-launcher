import { worksheetTextToNodes, richTextField, copyWorksheetText, PLAIN_FORMAT, MARKDOWN_FORMAT, RICH_FORMAT } from '../app/worksheet-text.js';

const markNames = { strong: 'bold', em: 'italic', u: 'underline', red: 'redText' };
const blockNames = { p: 'paragraph', h2: 'heading', h3: 'heading', h4: 'heading', blockquote: 'blockquote', ul: 'bulletList', ol: 'orderedList', li: 'listItem' };
function toEngine(node, marks = []) {
  if (node.tag === 'text') return node.text ? [{ type: 'text', text: node.text, ...(marks.length ? { marks } : {}) }] : [];
  if (node.tag === 'br') return [{ type: 'hardBreak' }];
  if (markNames[node.tag]) return node.children.flatMap(child => toEngine(child, [...marks, { type: markNames[node.tag] }]));
  return [{ type: blockNames[node.tag],
    ...(/^h[234]$/.test(node.tag) ? { attrs: { level: Number(node.tag[1]) } } : {}),
    ...(node.tag === 'ol' ? { attrs: { start: node.start } } : {}),
    content: node.children.flatMap(child => toEngine(child)) }];
}
export function fieldToEditorDocument(field) {
  return { type: 'doc', content: worksheetTextToNodes(field).flatMap(node => toEngine(node)) };
}
function fromEngine(node) {
  if (node.type === 'text') {
    let result = { tag: 'text', text: node.text };
    // A fixed mark order produces stable application documents independent of command order.
    for (const [tag, name] of Object.entries(markNames).reverse()) {
      if (node.marks?.some(mark => mark.type === name)) result = { tag, children: [result] };
    }
    return result;
  }
  if (node.type === 'hardBreak') return { tag: 'br' };
  const tag = node.type === 'heading' ? `h${node.attrs.level}` : Object.keys(blockNames).find(tag => blockNames[tag] === node.type);
  if (!tag) throw new Error(`Unsupported editor node: ${node.type}`);
  return { tag, ...(tag === 'ol' ? { start: node.attrs?.start ?? 1 } : {}), children: (node.content || []).map(fromEngine) };
}
// Engine normalization merges adjacent text nodes and supplies default attributes.
function signature(doc) {
  const normalize = node => {
    const result = { type: node.type };
    if (node.text !== undefined) result.text = node.text;
    if (node.type === 'heading') result.level = node.attrs?.level;
    if (node.type === 'orderedList') result.start = node.attrs?.start ?? 1;
    if (node.marks?.length) result.marks = node.marks.map(mark => mark.type).sort();
    const children = (node.content || []).map(normalize);
    const merged = [];
    for (const child of children) {
      const last = merged.at(-1);
      if (child.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(child.marks)) last.text += child.text;
      else merged.push(child);
    }
    if (merged.length) result.content = merged;
    return result;
  };
  return JSON.stringify(normalize(doc));
}
const escapeMarkdown = text => text.replace(/[\\`*{}\[\]()#+\-.!_>|~]/g, '\\$&');
function markdown(node) {
  if (node.tag === 'text') return escapeMarkdown(node.text);
  if (node.tag === 'br') return '\n';
  const content = node.children.map(markdown).join('');
  if (node.tag === 'strong') return `**${content}**`;
  if (node.tag === 'em') return `*${content}*`;
  if (/^h[234]$/.test(node.tag)) return `${'#'.repeat(Number(node.tag[1]))} ${content}`;
  if (node.tag === 'blockquote') return `> ${content}`;
  if (['ul','ol'].includes(node.tag)) return node.children.map((item, i) => `${node.tag === 'ul' ? '-' : `${node.start + i}.`} ${markdown(item)}`).join('\n');
  return content;
}
export function editorDocumentToField(doc, previous) {
  const expected = signature(doc);
  if (expected === signature(fieldToEditorDocument(previous))) return copyWorksheetText(previous);
  const blocks = doc.content.map(fromEngine);
  const rich = richTextField(blocks);
  if (previous.format === RICH_FORMAT) return rich;
  const plain = { format: PLAIN_FORMAT, text: rich.text };
  if ((!previous.format || previous.format === PLAIN_FORMAT) && signature(fieldToEditorDocument(plain)) === expected) return plain;
  const candidate = { format: MARKDOWN_FORMAT, text: blocks.map(markdown).join('\n') };
  return signature(fieldToEditorDocument(candidate)) === expected ? candidate : rich;
}
