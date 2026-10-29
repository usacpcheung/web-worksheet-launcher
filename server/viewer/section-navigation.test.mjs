import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionAtReadingLine } from './section-navigation.js';

const bounds = [{ top: 0, bottom: 100 }, { top: 120, bottom: 160 }, { top: 180, bottom: 600 }];
test('reading line selects sections and keeps identity through gaps in both directions', () => {
  assert.equal(sectionAtReadingLine(bounds, 0, 110), 0);
  assert.equal(sectionAtReadingLine(bounds, 1, 110), 1);
  assert.equal(sectionAtReadingLine(bounds, 0, 125), 1);
  assert.equal(sectionAtReadingLine(bounds, 2, 90), 0);
  assert.equal(sectionAtReadingLine(bounds, 1, 450), 2);
  assert.equal(sectionAtReadingLine(bounds, 0, 170), 1, 'fast downward scroll stops after the last crossed section');
  assert.equal(sectionAtReadingLine(bounds, 2, 110), 1, 'fast upward scroll retains the section below the gap');
});
test('small tolerance prevents oscillation at an adjacent boundary', () => {
  const adjacent = [{ top: 0, bottom: 100 }, { top: 100, bottom: 300 }];
  assert.equal(sectionAtReadingLine(adjacent, 0, 102), 0);
  assert.equal(sectionAtReadingLine(adjacent, 0, 104), 1);
  assert.equal(sectionAtReadingLine(adjacent, 1, 98), 1);
  assert.equal(sectionAtReadingLine(adjacent, 1, 96), 0);
});
test('start/end overrides cover short final sections and empty worksheets', () => {
  assert.equal(sectionAtReadingLine(bounds, 1, 300, { atStart: true }), 0);
  assert.equal(sectionAtReadingLine(bounds, 0, 40, { atEnd: true }), 2);
  assert.equal(sectionAtReadingLine([], 0, 40), -1);
});
