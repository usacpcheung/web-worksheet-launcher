import test from 'node:test';
import assert from 'node:assert/strict';
import { getCheckRevealMessage } from './check-feedback.js';
import { setLocale } from '../app/i18n/index.js';

test('reveal formatter supplies an explicit unanswered clause for empty and whitespace answers', () => {
  const calls = [];
  const t = (key, params) => { calls.push({ key, params }); return key; };
  for (const learnerAnswerText of ['', '   ', undefined]) {
    calls.length = 0;
    assert.equal(getCheckRevealMessage({ status: 'incorrect', learnerAnswerText, correctAnswerText: 'A, B' }, t),
      'viewer.check.reveal.incorrectWithCorrectAnswer');
    assert.deepEqual(calls.at(-1).params, { learnerClause: 'viewer.check.reveal.noAnswer', answer: 'A, B' });
  }
});

for (const locale of ['en', 'zh-Hant']) {
  test(`reveal messages preserve correct, incorrect and ungraded wording: ${locale}`, () => {
    setLocale(locale, { persist: false });
    try {
      const zh = locale === 'zh-Hant';
      assert.equal(getCheckRevealMessage({ status: 'correct', learnerAnswerText: '', correctAnswerText: '0' }),
        zh ? '正確答案：0' : 'Correct answer: 0');
      assert.equal(getCheckRevealMessage({ status: 'incorrect', learnerAnswerText: zh ? '是' : 'True', correctAnswerText: zh ? '否' : 'False' }),
        zh ? '不正確。正確答案：否' : 'Incorrect. Correct answer: False');
      for (const status of ['ungraded_missing_key', 'ungraded_missing_or_invalid_key']) {
        assert.equal(getCheckRevealMessage({ status, learnerAnswerText: zh ? '  否  ' : '  False  ', correctAnswerText: 'do not reveal' }),
          zh ? '你的答案：否' : 'Your answer: False');
        assert.equal(getCheckRevealMessage({ status, learnerAnswerText: '  ', correctAnswerText: 'do not reveal' }),
          zh ? '未作答' : 'No answer');
      }
    } finally { setLocale('en', { persist: false }); }
  });
}
