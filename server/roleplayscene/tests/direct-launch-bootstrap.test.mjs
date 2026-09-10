import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/direct-launch-bootstrap.js', import.meta.url), 'utf8');

function run(search) {
  const classes = [];
  vm.runInNewContext(source, {
    URLSearchParams,
    globalThis: { location: { search } },
    document: { documentElement: { classList: { add: value => classes.push(value) } } },
  });
  return classes;
}

test('direct launch class is added before the module for a non-empty published scene id', () => {
  assert.deepEqual(run('?publishedSceneId=scene-1'), ['direct-launch-pending']);
});

test('normal and empty direct-link values leave the regular shell unchanged', () => {
  assert.deepEqual(run(''), []);
  assert.deepEqual(run('?publishedSceneId='), []);
  assert.deepEqual(run('?publishedSceneId=%20%20'), []);
});

test('a malformed encoded value still blocks the shell while validation reports the error', () => {
  assert.deepEqual(run('?publishedSceneId=%E0%A4%A'), ['direct-launch-pending']);
});
