import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBlankConfig,
  assertBlankConfig,
  normalizeBlankAnswer,
  checkBlanks,
  blankAnswered,
  renderBlankPassage,
  blankWordPool,
  blankVoiceId,
  resolveBlankVoiceTarget,
  withBlankVoiceTargets,
} from './fill-in-blanks.js';
const blank = (id, text = 'Water', checking = 'auto') => ({
  tag: 'blank',
  id,
  text,
  checking,
  alternatives: [],
});
const config = (...blanks) => ({
  ...emptyBlankConfig(),
  passage: { version: 1, blocks: [{ tag: 'p', children: blanks }] },
});
test('typed matching ignores only outer whitespace and English letter case; free responses do not score', () => {
  const c = config(
    { ...blank('a'), alternatives: ['rain water'] },
    blank('b', '', 'free'),
    blank('c', 'ice cream'),
  );
  assertBlankConfig(c);
  assert.deepEqual(
    checkBlanks(c, { a: ' WATER ', b: 'anything', c: 'icecream' }),
    {
      statuses: { a: 'correct', b: 'teacher_review', c: 'incorrect' },
      total: 2,
      correct: 1,
    },
  );
  assert.equal(checkBlanks(c, { a: 'Rain water', c: 'ice cream' }).correct, 2);
  assert.equal(
    checkBlanks(c, { a: 'rain  water', c: 'ice cream!' }).correct,
    0,
  );
  assert.equal(blankAnswered(c, { a: 'Water', b: '', c: 'ice cream' }), false);
  assert.equal(
    blankAnswered(c, { a: 'Water', b: 'why', c: 'ice cream' }),
    true,
  );
});
test('answer map rejects unknown keys, oversize Unicode and malformed values', () => {
  const c = config(blank('a'));
  assert.deepEqual(normalizeBlankAnswer(c, { a: '中'.repeat(50) }), {
    a: '中'.repeat(50),
  });
  assert.deepEqual(normalizeBlankAnswer(c, { a: '😀'.repeat(50) }), {
    a: '😀'.repeat(50),
  });
  for (const value of [
    { a: 'a'.repeat(51) },
    { b: 'water' },
    { a: 5 },
    { a: 'a\nb' },
    ['Water'],
    JSON.parse('{"__proto__":"x"}'),
  ])
    assert.throws(() => normalizeBlankAnswer(c, value));
});
test('word bank enforces common pool, duplicate inventory and reuse', () => {
  const c = {
    ...config(blank('a', 'water'), blank('b', 'water'), blank('c', 'sun')),
    mode: 'word_bank',
    distractors: ['sand', 'water'],
  };
  assert.equal(blankWordPool(c).get('water'), 2);
  assert.doesNotThrow(() =>
    normalizeBlankAnswer(c, { a: 'water', b: 'water', c: 'sand' }),
  );
  assert.throws(() =>
    normalizeBlankAnswer(c, { a: 'water', b: 'water', c: 'water' }),
  );
  assert.throws(() => normalizeBlankAnswer(c, { a: 'unknown' }));
  assert.doesNotThrow(() =>
    normalizeBlankAnswer(
      { ...c, reuseWords: true },
      { a: 'water', b: 'water', c: 'water' },
    ),
  );
});
test('strict passage boundary rejects HTML, duplicate IDs, wrong node positions and limits', () => {
  assert.doesNotThrow(() => assertBlankConfig(config(blank('a'))));
  assert.throws(() => assertBlankConfig(config(blank('a'), blank('a'))));
  assert.throws(() =>
    assertBlankConfig(
      config(...Array.from({ length: 21 }, (_, i) => blank('b' + i))),
    ),
  );
  assert.throws(() =>
    assertBlankConfig(config({ ...blank('a'), text: 'a'.repeat(51) })),
  );
  assert.throws(() =>
    assertBlankConfig(config({ tag: 'script', children: [] })),
  );
  assert.throws(() =>
    assertBlankConfig({
      ...config(blank('a')),
      passage: { version: 1, blocks: [blank('a')] },
    }),
  );
  assert.throws(() =>
    assertBlankConfig(
      config({ ...blank('a'), original: [blank('x')], initialText: 'x' }),
    ),
  );
  assert.throws(() => assertBlankConfig(config(blank('__proto__'))));
  assert.doesNotThrow(() =>
    assertBlankConfig(emptyBlankConfig(), { complete: false }),
  );
  assert.throws(() => assertBlankConfig(emptyBlankConfig()));
});
test('render preserves literal tokens, escapes author text and delegates blank slots only', () => {
  const c = config(
    { tag: 'text', text: '[[12222]] blank-slot-0-end <script>x</script> ' },
    blank('a'),
  );
  const html = renderBlankPassage(c, () => '<input aria-label="Blank">');
  assert.match(html, /\[\[12222\]\] blank-slot-0-end &lt;script&gt;/);
  assert.equal((html.match(/<input/g) || []).length, 1);
  assert.doesNotMatch(html, /Water/);
});
test('voice targets identify parent and blank without adding synthetic attempt answers', () => {
  const parent = {
    blockId: 'q1',
    kind: 'question',
    responseConfig: config(blank('a')),
  };
  const id = blankVoiceId('q1', 'a'),
    target = resolveBlankVoiceTarget([parent], id);
  assert.equal(target.parent, parent);
  assert.equal(target.blank.id, 'a');
  assert.equal(target.block.responseConfig.maxLength, 50);
  assert.equal(withBlankVoiceTargets([parent]).length, 2);
  assert.equal(
    resolveBlankVoiceTarget(
      [
        {
          ...parent,
          responseConfig: { ...parent.responseConfig, mode: 'word_bank' },
        },
      ],
      id,
    ),
    null,
  );
});

test('answer markup that resembles a slot is never substituted again', () => {
  const c = config(blank('a'), blank('b'));
  const html = renderBlankPassage(c, (b) =>
    b.id === 'a' ? '<span>blank-slot-1-end</span>' : '<span>second</span>',
  );
  assert.match(html, /<span>blank-slot-1-end<\/span><span>second<\/span>/);
});

test('maximum blank answer capacity is included in the image-attempt budget', async () => {
  const { imageBudget } = await import('./image-response.js');
  const blocks = [{ responseConfig: config(blank('a'), blank('b')) }];
  assert.equal(imageBudget(blocks, 0).total - imageBudget([], 0).total, 628);
});
