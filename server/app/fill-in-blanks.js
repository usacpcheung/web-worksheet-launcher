import { richTextField, renderWorksheetText } from './worksheet-text.js';

export const BLANK_LIMIT = 50;
export const MAX_BLANKS = 20;
export const isFillInBlanks = (config) =>
  config?.inputType === 'fill_in_blanks';
export const hasFillInBlanks = (blocks) =>
  (blocks || []).some((b) => isFillInBlanks(b.responseConfig));
export const blankLength = (text) => Array.from(String(text ?? '')).length;
export const trimBlankText = (text, count = BLANK_LIMIT) =>
  Array.from(String(text ?? ''))
    .slice(0, Math.max(0, count))
    .join('');
export const matchBlankText = (text) =>
  String(text ?? '')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
export const emptyBlankConfig = () => ({
  inputType: 'fill_in_blanks',
  mode: 'typed',
  reuseWords: false,
  distractors: [],
  passage: { version: 1, blocks: [{ tag: 'p', children: [] }] },
});
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key);
export function blankDefinitions(config) {
  const found = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.tag === 'blank') found.push(node);
      else if (node.children) walk(node.children);
    }
  };
  walk(config?.passage?.blocks);
  return found;
}
export function mapBlankPassage(config, replace) {
  const map = (nodes) =>
    nodes.map((node) =>
      node.tag === 'blank'
        ? replace(node)
        : {
            ...node,
            ...(node.children ? { children: map(node.children) } : {}),
          },
    );
  return map(config.passage.blocks);
}
export function assertBlankConfig(config, { complete = true } = {}) {
  if (!isFillInBlanks(config)) return;
  const fail = (message) => {
    throw new Error(`Fill in the blanks: ${message}`);
  };
  if (
    !['typed', 'word_bank'].includes(config.mode) ||
    typeof config.reuseWords !== 'boolean'
  )
    fail('invalid answering mode.');
  if (
    !record(config.passage) ||
    config.passage.version !== 1 ||
    !Array.isArray(config.passage.blocks)
  )
    fail('invalid passage.');
  if (
    Object.keys(config.passage).some((k) => !['version', 'blocks'].includes(k))
  )
    fail('unsupported passage field.');
  const ids = new Set();
  let count = 0;
  const word = (text) =>
    typeof text === 'string' &&
    blankLength(text) <= BLANK_LIMIT &&
    !/[\r\n]/.test(text);
  const map = (nodes, depth = 0) => {
    if (!Array.isArray(nodes) || depth > 32)
      fail('passage is too deeply nested.');
    return nodes.map((node) => {
      if (!record(node) || ++count > 100000)
        fail('invalid or oversized passage.');
      if (node.tag !== 'blank')
        return {
          ...node,
          ...(node.children ? { children: map(node.children, depth + 1) } : {}),
        };
      if (
        Object.keys(node).some(
          (k) =>
            ![
              'tag',
              'id',
              'text',
              'alternatives',
              'checking',
              'original',
              'initialText',
            ].includes(k),
        )
      )
        fail('unsupported blank field.');
      if (
        typeof node.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(node.id) ||
        ['__proto__', 'constructor', 'prototype'].includes(node.id) ||
        ids.has(node.id)
      )
        fail('blank IDs must be unique.');
      ids.add(node.id);
      if (ids.size > MAX_BLANKS)
        fail(`maximum ${MAX_BLANKS} blanks per question.`);
      if (!word(node.text) || !['auto', 'free'].includes(node.checking))
        fail('invalid blank answer.');
      if (
        complete &&
        (config.mode === 'word_bank' || node.checking === 'auto') &&
        !node.text.trim()
      )
        fail('a main answer is required for checked blanks.');
      if (
        !Array.isArray(node.alternatives) ||
        node.alternatives.length > 50 ||
        node.alternatives.some((s) => !word(s) || !s.trim())
      )
        fail('invalid accepted alternatives.');
      if (node.original !== undefined) {
        if (!Array.isArray(node.original) || !word(node.initialText))
          fail('invalid original marked text.');
        // Original text has formatting only: never another blank or a block.
        const field = richTextField([{ tag: 'p', children: node.original }]);
        if (
          field.text !== node.initialText ||
          blankLength(field.text) > BLANK_LIMIT ||
          field.text.includes('\n')
        )
          fail('invalid original marked text.');
      } else if (node.initialText !== undefined)
        fail('original marked text is missing.');
      return { tag: 'text', text: node.text };
    });
  };
  richTextField(map(config.passage.blocks));
  if (complete && !ids.size) fail('add at least one blank.');
  if (
    !Array.isArray(config.distractors) ||
    config.distractors.length > 100 ||
    config.distractors.some((s) => !word(s) || !s.trim())
  )
    fail('invalid distractors.');
}
export function assertBlankQuestions(blocks, options) {
  for (const b of blocks || []) assertBlankConfig(b?.responseConfig, options);
  const ids = new Set((blocks || []).map((b) => b?.blockId));
  for (const b of blocks || [])
    if (isFillInBlanks(b?.responseConfig))
      for (const blank of blankDefinitions(b.responseConfig)) {
        if (ids.has(blankVoiceId(b.blockId, blank.id)))
          throw new Error('A block ID conflicts with a blank voice target.');
      }
}
export function blankWordPool(config) {
  const pool = new Map();
  for (const b of blankDefinitions(config))
    if (b.text.trim()) pool.set(b.text, (pool.get(b.text) || 0) + 1);
  for (const word of config.distractors || [])
    if (!pool.has(word)) pool.set(word, 1);
  // Sorting is independent of the order of blanks; the pool must not reveal answer order.
  return new Map([...pool].sort(([a], [b]) => a.localeCompare(b)));
}
export function normalizeBlankAnswer(config, value) {
  if (value == null || value === '') return {};
  if (!record(value)) throw new Error('Invalid blank answer map.');
  const defs = blankDefinitions(config),
    ids = new Set(defs.map((b) => b.id));
  const pool = blankWordPool(config),
    used = new Map();
  for (const [id, text] of Object.entries(value)) {
    if (
      !ids.has(id) ||
      typeof text !== 'string' ||
      blankLength(text) > BLANK_LIMIT ||
      /[\r\n]/.test(text)
    )
      throw new Error('Invalid blank answer or character limit.');
    if (config.mode === 'word_bank' && text) {
      const count = (used.get(text) || 0) + 1;
      used.set(text, count);
      if (!pool.has(text) || (!config.reuseWords && count > pool.get(text)))
        throw new Error('Word-bank answer exceeds available words.');
    }
  }
  return Object.fromEntries(
    defs.filter((b) => own(value, b.id)).map((b) => [b.id, value[b.id]]),
  );
}
export function assertBlankAnswers(blocks, answers) {
  for (const b of blocks || [])
    if (isFillInBlanks(b.responseConfig))
      normalizeBlankAnswer(b.responseConfig, answers?.[b.blockId]?.value);
}
export const blankAnswered = (config, value) => {
  const defs = blankDefinitions(config);
  return (
    defs.length > 0 && defs.every((b) => own(value, b.id) && value[b.id].trim())
  );
};
export function checkBlanks(config, value) {
  const statuses = {};
  let total = 0,
    correct = 0;
  for (const blank of blankDefinitions(config)) {
    if (config.mode === 'typed' && blank.checking === 'free') {
      statuses[blank.id] = 'teacher_review';
      continue;
    }
    total++;
    const answer = own(value, blank.id) ? value[blank.id] : '';
    const accepted =
      config.mode === 'word_bank'
        ? [blank.text]
        : [blank.text, ...blank.alternatives];
    const matches =
      answer.trim() &&
      accepted.some((s) => matchBlankText(s) === matchBlankText(answer));
    statuses[blank.id] = matches ? 'correct' : 'incorrect';
    if (matches) correct++;
  }
  return { statuses, total, correct };
}
// Render supported application formatting first; substitute only generated, escaped slots.
export function renderBlankPassage(config, renderBlank) {
  const placeholders = [];
  let nonce = 'blank-slot-';
  const source = JSON.stringify(config.passage);
  while (source.includes(nonce)) nonce += 'x';
  const translated = mapBlankPassage(config, (blank) => {
    const token = `${nonce}${placeholders.length}-end`;
    placeholders.push([token, renderBlank(blank)]);
    return { tag: 'text', text: token };
  });
  const html = renderWorksheetText(richTextField(translated));
  // A single pass prevents answer text resembling another slot from being substituted.
  return html.replace(
    new RegExp(`${nonce}(\\d+)-end`, 'g'),
    (_, index) => placeholders[Number(index)][1],
  );
}
// Virtual targets stay local to the existing voice state machine, never attempt answer keys.
export const blankVoiceId = (blockId, blankId) =>
  `blank:${JSON.stringify([blockId, blankId])}`;
export function resolveBlankVoiceTarget(blocks, id) {
  for (const block of blocks || [])
    if (
      isFillInBlanks(block.responseConfig) &&
      block.responseConfig.mode === 'typed'
    ) {
      for (const blank of blankDefinitions(block.responseConfig))
        if (blankVoiceId(block.blockId, blank.id) === id) {
          return {
            parent: block,
            blank,
            block: {
              blockId: id,
              kind: 'question',
              responseConfig: {
                inputType: 'text',
                maxLength: BLANK_LIMIT,
                blankTarget: true,
              },
            },
          };
        }
    }
  return null;
}
export function withBlankVoiceTargets(blocks = []) {
  return [
    ...blocks,
    ...blocks
      .filter(
        (b) =>
          isFillInBlanks(b.responseConfig) && b.responseConfig.mode === 'typed',
      )
      .flatMap((b) =>
        blankDefinitions(b.responseConfig).map(
          (blank) =>
            resolveBlankVoiceTarget([b], blankVoiceId(b.blockId, blank.id))
              .block,
        ),
      ),
  ];
}
