import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('renderer scopes rewrite widget host ids to the launch rid', async () => {
  const source = await readFile(path.resolve('server/worksheet_launcher/render.js'), 'utf8');
  assert.equal(source.includes('function hashHostIdPart(value)'), true);
  assert.equal(source.includes('function buildHostId(index, launchRid)'), true);
  assert.equal(source.includes('const ridHash = hashHostIdPart(launchRid);'), true);
  assert.equal(source.includes('const hostId = `rw_host_${index}_${ridHash}`;'), true);
  assert.equal(source.includes('const hostId = buildHostId(idx, rid);'), true);
  assert.equal(source.includes('containerSelector: `#${hostId}`,'), true);
});

test('renderer leaves the frozen shared rewrite widget file untouched by design', async () => {
  const source = await readFile(path.resolve('server/worksheet_launcher/render.js'), 'utf8');
  assert.equal(source.includes('rewrite-widget.v2.js'), false);
  assert.equal(source.includes('DRAFT_KEY'), false);
});
