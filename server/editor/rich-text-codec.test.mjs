import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldToEditorDocument, editorDocumentToField } from './rich-text-codec.js';
import { richTextField, assertTextFormat, renderWorksheetText, worksheetTextToPlain, promptTextState } from '../app/worksheet-text.js';
import { createWorksheetPackageFromDraft, parseWorksheetPackage } from './worksheet-package.js';
import { createStoredZip } from './zip-utils.js';
const p = (...children) => ({ tag: 'p', children });
const text = text => ({ tag: 'text', text });
const rich = richTextField([p({ tag: 'u', children: [{ tag: 'red', children: [text('中文 <script>')] }] }), p(text('下一段'))]);

test('legacy fields round trip without migration, including unsupported and partial Markdown', () => {
  for (const format of ['plain_text', 'limited-markdown-v1']) for (const source of [
    '**literal**\n\n## Heading\n3. First\n4. Second', '中文  \n next\n\n', '\\* escaped *unfinished',
    '[x](javascript:alert)\n```\n**code**\n```', '##### unsupported\n- [x] task\n<svg onload=x>',
  ]) {
    const field = { text: source, format };
    assert.deepEqual(editorDocumentToField(fieldToEditorDocument(field), field), field);
  }
});
test('ordinary edits keep legacy formats when representable; underline and red use restricted rich text', () => {
  const old = { format: 'plain_text', text: 'First' };
  const doc = fieldToEditorDocument(old); doc.content[0].content[0].text = 'Second **literal**';
  assert.deepEqual(editorDocumentToField(doc, old), { format: 'plain_text', text: 'Second **literal**' });
  doc.content[0].content[0].marks = [{ type: 'bold' }];
  assert.equal(editorDocumentToField(doc, old).format, 'limited-markdown-v1');
  doc.content[0].content[0].marks.push({ type: 'underline' }, { type: 'redText' });
  const saved = editorDocumentToField(doc, old);
  assert.equal(saved.format, 'rich-text-v1');
  assert.match(renderWorksheetText(saved), /<strong><u><span class="worksheet-text-red">/);
  assert.deepEqual(editorDocumentToField(fieldToEditorDocument(saved), saved), saved);
});
test('rich paragraphs and hard breaks survive render, speech and Unicode counting', () => {
  assert.equal(worksheetTextToPlain(rich), '中文 <script>\n下一段');
  assert.match(renderWorksheetText(rich), /<u><span class="worksheet-text-red">中文 &lt;script&gt;<\/span><\/u>/);
  const field = richTextField([p(text('𠮷'.repeat(500))), p({ tag: 'br' }, text('末'))]);
  assert.equal(promptTextState(field).count, 503);
  assert.equal(promptTextState(field).exceedsLimit, true);
  assert.match(renderWorksheetText(field), /<p><br>末<\/p>/);
});
test('untrusted rich documents reject invalid nesting, attributes, depth, cache and versions', () => {
  for (const change of [
    f => { f.document.version = 2; }, f => { f.text = 'wrong cache'; },
    f => { f.document.blocks[0].onclick = 'alert(1)'; },
    f => { f.document.blocks[0].children[0].tag = 'script'; },
    f => { f.document.blocks[0].children[0] = p(text('nested paragraph')); },
    f => { f.document.blocks[0].children[0].color = 'url(x)'; },
    f => { let n = text('x'); for (let i=0;i<35;i++) n = { tag: 'u', children: [n] }; f.document.blocks = [p(n)]; },
  ]) {
    const bad = structuredClone(rich); change(bad);
    assert.throws(() => assertTextFormat(bad), /Invalid rich/);
  }
});
test('worksheet ZIP preserves rich documents and requires version 7, unchanged legacy stays version 2', () => {
  const draft = { localId: 'd', title: 'Rich', blocks: [{ blockId: 'c', position: 0, kind: 'content', content: rich }] };
  const output = createWorksheetPackageFromDraft(draft);
  assert.equal(output.manifest.packageVersion, 7); assert.equal(output.manifest.schemaVersion, 7);
  assert.deepEqual(parseWorksheetPackage(output.bytes).worksheet.blocks[0].content, rich);
  const bad = createStoredZip([{ path: 'manifest.json', data: JSON.stringify({ ...output.manifest, packageVersion: 6, schemaVersion: 6 }) },
    { path: 'content/worksheet.json', data: JSON.stringify(output.worksheet) }]);
  assert.throws(() => parseWorksheetPackage(bad), /version 7/);
});
