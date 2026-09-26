import test from 'node:test';
import assert from 'node:assert/strict';
import { dropIndexAtY, edgeScrollSpeed } from './block-drag-reorder.js';

test('drop positions cover gaps, endpoints, own row and both move directions', () => {
  const rects = [0, 50, 100, 150].map(top => ({ top, height: 40 }));
  assert.equal(dropIndexAtY(rects, 200, 0), 3);
  assert.equal(dropIndexAtY(rects, 0, 3), 0);
  assert.equal(dropIndexAtY(rects, 45, 3), 1);
  assert.equal(dropIndexAtY(rects, 45, 0), 0);
  assert.equal(dropIndexAtY(rects, 60, 1), 1);
  assert.equal(dropIndexAtY(rects, 85, 1), 1);
  assert.equal(dropIndexAtY(rects, 145, 0), 2);
});

test('edge scrolling is bounded, symmetric and inactive outside the list or in its centre', () => {
  assert.equal(edgeScrollSpeed(0, 0, 380), -600);
  assert.equal(edgeScrollSpeed(380, 0, 380), 600);
  assert.equal(edgeScrollSpeed(190, 0, 380), 0);
  assert.equal(edgeScrollSpeed(-1, 0, 380), 0);
  assert.equal(edgeScrollSpeed(381, 0, 380), 0);
  assert.equal(edgeScrollSpeed(0, 0, 0), 0);
  assert.equal(edgeScrollSpeed(24, 0, 380), -300);
  assert.equal(edgeScrollSpeed(356, 0, 380), 300);
  assert.equal(edgeScrollSpeed(15, 0, 30), 0);
});
