import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSections, isAnsweredValue } from './worksheet-navigation.js';
test('reading sections never consume question numbers or lose their ordered identity', () => {
  const blocks = ['content', 'question', 'content', 'question', 'content'].map((kind, i) => ({ kind, blockId: 'id'+i, content: {text:'Read'}, prompt:{text:'Answer'} }));
  const sections = describeSections(blocks, (key, {number}) => key+number);
  assert.deepEqual(sections.map(s=>[s.id,s.isQuestion,s.number]), [['id0',false,1],['id1',true,1],['id2',false,2],['id3',true,2],['id4',false,3]]);
});
test('completion keeps false and zero answers; excludes empty strings and selections', () => {
  for (const value of [false, 0, '0', ['a'], 'Answer']) assert.equal(isAnsweredValue(value), true);
  for (const value of [undefined, null, '', ' \n ', []]) assert.equal(isAnsweredValue(value), false);
});
test('chooser names use a plain-text first-line title without injecting worksheet markup', () => {
  const sections = describeSections([{blockId:'q',kind:'question',prompt:{format:'limited-markdown-v1',text:'**Useful** title\nLater detail'}},{blockId:'r',kind:'content',content:{text:'Reading title\nBody'}}], (_, {number})=>String(number));
  assert.deepEqual(sections.map(s=>s.title), ['Useful title','Reading title']);
});
