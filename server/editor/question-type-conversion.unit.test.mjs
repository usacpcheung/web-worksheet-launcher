import test from 'node:test';
import assert from 'node:assert/strict';
import { questionTextConversion, passageToPrompt } from './question-type-conversion.js';
import { emptyBlankConfig } from '../app/fill-in-blanks.js';
import { richTextField, worksheetTextToPlain, MARKDOWN_FORMAT } from '../app/worksheet-text.js';

const metadata = { mediaRefs: [{ usage: 'question_image', assetId: 'image' }], audioTracks: [{ language: 'english', assetId: 'audio', sourceTextHash: 'unchanged' }] };
for (const prompt of [
  { text: 'Keep **literal**\nNew line\n\nNew paragraph' },
  { format: MARKDOWN_FORMAT, text: '## Heading\n\nA **bold** word\n- item' },
  richTextField([{ tag: 'p', children: [{ tag: 'u', children: [{ tag: 'red', children: [{ tag: 'text', text: 'Formatted' }] }] }] }]),
]) {
  test(`prompt to passage round trip preserves visible text, formatting and media: ${prompt.format || 'plain'}`, () => {
    const block = { prompt: { ...prompt, ...metadata }, responseConfig: { inputType: 'text' } };
    const original = structuredClone(block);
    const moved = questionTextConversion(block, 'fill_in_blanks', 'passage');
    assert.equal(moved.prompt.text, '');
    assert.deepEqual(moved.prompt.audioTracks, metadata.audioTracks);
    const restored = passageToPrompt(moved);
    assert.equal(worksheetTextToPlain(restored), worksheetTextToPlain(block.prompt));
    assert.deepEqual(restored.mediaRefs, metadata.mediaRefs);
    assert.deepEqual(restored.audioTracks, metadata.audioTracks);
    if (prompt.document) assert.deepEqual(restored.document, prompt.document);
    assert.deepEqual(block, original);
  });
}
test('keeping instructions preserves the exact original field and creates an empty passage', () => {
  const prompt = { text: '**instructions**', format: MARKDOWN_FORMAT, ...metadata };
  const converted = questionTextConversion({ prompt, responseConfig: { inputType: 'multiple_choice' } }, 'fill_in_blanks', 'instructions');
  assert.deepEqual(converted.prompt, prompt);
  assert.deepEqual(converted.responseConfig, emptyBlankConfig());
});
test('leaving blanks restores unchanged formatted words, uses edited text, and prepends instructions', () => {
  const block = { prompt: { text: 'Instructions', ...metadata }, responseConfig: emptyBlankConfig() };
  block.responseConfig.passage.blocks = [{ tag: 'p', children: [
    { tag: 'blank', text: 'water', initialText: 'water', original: [{ tag: 'strong', children: [{ tag: 'text', text: 'water' }] }] },
    { tag: 'text', text: ' and ' },
    { tag: 'blank', text: 'sun', initialText: 'light', original: [{ tag: 'text', text: 'light' }] },
    { tag: 'blank', text: '!', checking: 'free' },
  ] }];
  const converted = questionTextConversion(block, 'text').prompt;
  assert.equal(converted.text, 'Instructions\nwater and sun!');
  assert.deepEqual(converted.document.blocks[1].children[0], { tag: 'strong', children: [{ tag: 'text', text: 'water' }] });
  assert.deepEqual(converted.audioTracks, metadata.audioTracks);
});
test('long passages are preserved without truncation and malformed conversion does not mutate source', () => {
  const block = { prompt: { text: '' }, responseConfig: emptyBlankConfig() };
  block.responseConfig.passage.blocks[0].children = [{ tag: 'text', text: '字'.repeat(900) }];
  assert.equal(passageToPrompt(block).text.length, 900);
  block.responseConfig.passage.blocks[0].children = [{ tag: 'invalid', children: [] }];
  const snapshot = structuredClone(block);
  assert.throws(() => passageToPrompt(block));
  assert.deepEqual(block, snapshot);
});
test('ordinary type switches keep prompt fields exactly as authored', () => {
  const prompt = { text: '**literal**', ...metadata };
  assert.deepEqual(questionTextConversion({ prompt, responseConfig: { inputType: 'number' } }, 'text'), { prompt });
});
