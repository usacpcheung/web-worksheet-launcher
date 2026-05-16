import assert from 'node:assert/strict';
import { computeSceneGraphLayout } from '../scripts/editor/graph.js';
import { SceneType } from '../scripts/model.js';

const sampleProject = {
  scenes: [
    { id: 'start', type: SceneType.START, choices: [
      { id: 'choice-1', label: 'Go left', nextSceneId: 'left' },
      { id: 'choice-2', label: 'Go right', nextSceneId: 'right' },
      { id: 'choice-5', label: 'Walk forward', nextSceneId: 'linear' },
    ] },
    { id: 'left', type: SceneType.INTERMEDIATE, choices: [
      { id: 'choice-3', label: 'Finish', nextSceneId: 'end-a' },
    ], autoNextSceneId: null },
    { id: 'right', type: SceneType.INTERMEDIATE, choices: [
      { id: 'choice-4', label: 'Finish', nextSceneId: 'end-b' },
    ] },
    { id: 'linear', type: SceneType.INTERMEDIATE, choices: [], autoNextSceneId: 'end-a' },
    { id: 'end-a', type: SceneType.END, choices: [] },
    { id: 'end-b', type: SceneType.END, choices: [] },
    { id: 'orphan', type: SceneType.INTERMEDIATE, choices: [] },
  ],
};

const layout = computeSceneGraphLayout(sampleProject);

assert.strictEqual(layout.rowCount, 4, 'expected four rows including orphan row and ending row');
assert.strictEqual(layout.columnCount, 3, 'expected three columns for branching level with linear path');

const startPos = layout.positions.get('start');
assert.deepStrictEqual(startPos, { row: 0, column: 0 }, 'start scene should anchor row 0 column 0');

const leftPos = layout.positions.get('left');
const rightPos = layout.positions.get('right');
const linearPos = layout.positions.get('linear');
assert.strictEqual(leftPos.row, 1, 'left branch should be depth row 1');
assert.strictEqual(rightPos.row, 1, 'right branch should be depth row 1');
assert.strictEqual(linearPos.row, 1, 'linear branch should share depth row 1');
assert.notStrictEqual(leftPos.column, rightPos.column, 'siblings should occupy different columns');
assert.notStrictEqual(linearPos.column, leftPos.column, 'linear path should have its own column');

const endARow = layout.positions.get('end-a').row;
const endBRow = layout.positions.get('end-b').row;
assert.strictEqual(endARow, layout.rowCount - 1, 'end scenes should occupy final row');
assert.strictEqual(endBRow, layout.rowCount - 1, 'end scenes should occupy final row');

const orphanRow = layout.positions.get('orphan').row;
assert.strictEqual(orphanRow, layout.rowCount - 2, 'unreachable nodes should appear before final ending row');

console.log('graph layout helper tests passed');
