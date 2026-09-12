import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKDOWN_FORMAT, renderWorksheetText, worksheetTextToPlain, upgradeEditableBlocks } from './worksheet-text.js';
import { createWorksheetPackageFromDraft, parseWorksheetPackage } from '../editor/worksheet-package.js';
import { createStoredZip } from '../editor/zip-utils.js';
const md = text => ({ text, format: MARKDOWN_FORMAT });

test('approved block and inline syntax renders using the restricted elements', () => {
  const html = renderWorksheetText(md('## Section\n### Detail\n- **First**\n- *Second*\n3. Third\n4. Fourth\n> Quote\n\nText\nnext line'));
  assert.match(html, /<h2>Section<\/h2><h3>Detail<\/h3>/);
  assert.match(html, /<ul><li><strong>First<\/strong><\/li><li><em>Second<\/em><\/li><\/ul>/);
  assert.match(html, /<ol start="3"><li>Third<\/li><li>Fourth<\/li><\/ol>/);
  assert.match(html, /<blockquote>Quote<\/blockquote><br><p>Text\nnext line<\/p>/);
});
test('HTML, URLs, code, unsupported headings, rules and tasks stay inert text', () => {
  const html = renderWorksheetText(md('# title\n<script>alert(1)</script>\n[click](javascript:alert)\n![x](https://example.com/x)\n`**code**`\n---\n- [x] task\n```\n## code\n```'));
  assert.doesNotMatch(html, /<(script|a|img|code|h1|hr|input)\b/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\[click\]\(javascript:alert\)/);
  assert.match(html, /`\*\*code\*\*`/);
  assert.doesNotMatch(html, /<h2>|<li>/);
});
test('escape punctuation and preserve unmatched markers', () => {
  assert.equal(renderWorksheetText(md('\\*literal\\* **unfinished')), '<p>*literal* **unfinished</p>');
  assert.equal(renderWorksheetText(md('\\# heading\n1\\. literal\n\\> quote')), '<p># heading\n1. literal\n&gt; quote</p>');
});
test('legacy conversion is non-mutating, visually literal, and idempotent', () => {
  const text = '# Heading\n**Not bold** *Not italic*\n- list\n1. one\n> quote\nC:\\text\n\n中文 <b>literal</b>  ';
  const old = [{ kind: 'content', content: { text }, instructions: '*unchanged*' }];
  const converted = upgradeEditableBlocks(old);
  assert.equal(converted.changed, true);
  assert.equal(old[0].content.text, text);
  assert.equal(worksheetTextToPlain(converted.blocks[0].content), text);
  assert.equal(converted.blocks[0].instructions, '*unchanged*');
  assert.equal(upgradeEditableBlocks(converted.blocks).changed, false);
  assert.doesNotMatch(renderWorksheetText(converted.blocks[0].content), /<(strong|em|h2|ul|ol|blockquote)>/);
  const whitespace = 'first\n  \n\t\nlast';
  assert.equal(worksheetTextToPlain(upgradeEditableBlocks([{ kind: 'content', content: { text: whitespace } }]).blocks[0].content), whitespace);
});
test('plain text never receives Markdown interpretation; unknown formats reject', () => {
  assert.equal(renderWorksheetText({ text: '**Keep** <b>raw</b>' }), '**Keep** &lt;b&gt;raw&lt;/b&gt;');
  assert.throws(() => renderWorksheetText({ text: 'x', format: 'future-format' }), /Unsupported/);
  assert.throws(() => upgradeEditableBlocks([{ kind: 'content', content: { text: 'x', format: 'future-format' } }]), /Unsupported/);
  assert.throws(() => createWorksheetPackageFromDraft({ blocks: [{ kind: 'short_text', prompt: { text: 'x', format: 'future-format' } }] }), /Unsupported/);
  assert.equal(renderWorksheetText(md('')), '<br>');
});
test('Markdown ZIP version prevents old readers from treating it as plain text', () => {
  const source = '## Source\r\n**保留** \\*';
  const draft = { localId: 'd', blocks: [{ blockId: 'c', kind: 'content', position: 0, content: md(source) }] };
  const output = createWorksheetPackageFromDraft(draft);
  assert.equal(output.manifest.packageVersion, 3);
  assert.equal(output.manifest.schemaVersion, 3);
  assert.deepEqual(parseWorksheetPackage(output.bytes).worksheet.blocks[0].content, md(source));
  const bad = createStoredZip([
    { path: 'manifest.json', data: JSON.stringify({ ...output.manifest, packageVersion: 2, schemaVersion: 2 }) },
    { path: 'content/worksheet.json', data: JSON.stringify(output.worksheet) },
  ]);
  assert.throws(() => parseWorksheetPackage(bad), /version 3/);
  assert.equal(createWorksheetPackageFromDraft({ ...draft, blocks: [{ kind: 'content', content: { text: '**plain**' } }] }).manifest.packageVersion, 2);
});
test('large unmatched punctuation has bounded processing cost', { timeout: 3000 }, () => {
  const text = '['.repeat(50000) + '* '.repeat(20000);
  assert.ok(renderWorksheetText(md(text)).length >= text.length);
});
