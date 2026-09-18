import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { createServerApiClient } from './api/server-api-client.js';

// A source-level tripwire, not a replacement for browser/runtime regression tests.
async function runtimeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...await runtimeFiles(url));
    else if (/\.(js|mjs|html|css)$/.test(entry.name) && !entry.name.includes('.test.')) files.push(url);
  }
  return files;
}

for (const component of ['editor', 'viewer', 'roleplayscene', 'app', 'api']) {
  test(`${component} runtime has no direct legacy popup/widget references`, async () => {
    const files = await runtimeFiles(new URL(`../${component}/`, import.meta.url));
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /rewrite-widget|parent_prototype|worksheet_launcher\/(?:render\.(?:html|js|css)|widgets\/)/i,
        `${file.pathname} must not depend on the retiring popup; shared login and bridge routes are allowed`);
      // Case-sensitive SDK symbols: worksheetLauncher.* product storage keys stay valid.
      assert.doesNotMatch(source, /\bRewriteWidget\b|\bWorksheetLauncher\s*\.\s*create\b|\bworksheetResult\b|rw_draft_v1/,
        `${file.pathname} must not use retired SDK globals, messages or widget storage`);
    }
  });
}

// Exact paths only: the similarly named shared auth route must remain.
for (const retiredPath of [
  'parent_prototype/parent.html',
  'parent_prototype/sdk/parent-launcher.js',
  'server/worksheet_launcher/render.html',
  'server/worksheet_launcher/render.js',
  'server/worksheet_launcher/render.css',
  'server/worksheet_launcher/widgets/rewrite-widget.js',
  'server/worksheet_launcher/widgets/rewrite-widget.css',
  'server/worksheet_launcher/render-source.test.mjs',
]) {
  test(`retired file stays absent: ${retiredPath}`, async () => {
    await assert.rejects(access(new URL(`../../${retiredPath}`, import.meta.url)), { code: 'ENOENT' });
  });
}

test('retirement preserves product entry points and shared login page', async () => {
  for (const entry of ['editor/index.html', 'viewer/index.html', 'roleplayscene/index.html', 'app/login/popup.html']) {
    const source = await readFile(new URL(`../${entry}`, import.meta.url), 'utf8');
    assert.match(source, /<script\b/i, `missing application entry: ${entry}`);
  }
});

test('shared product APIs work without a widget global or popup renderer', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/t2a')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    return Response.json({ ok: true, result: 'Retained product text', data: { user: { sub: 'test' } } });
  });
  const client = createServerApiClient();
  assert.equal(client.getSessionSignInUrl(), '/worksheet_launcher/app/login/popup.html');
  assert.equal((await client.getSession()).ok, true);
  assert.equal((await client.rewriteText('Original answer')).data.text, 'Retained product text');
  assert.equal((await client.transcribeAudio(new Blob(['audio'], { type: 'audio/webm' }))).data.text, 'Retained product text');
  assert.equal((await client.generateAudioFromText('Scene dialogue')).ok, true);
  assert.deepEqual(calls.map(call => call.url), [
    '/api/worksheet-launcher/v1/session',
    '/api/rewrite-bridge/rewrite',
    '/api/rewrite-bridge/transcriptions',
    '/api/rewrite-bridge/t2a',
  ]);
  for (const { options } of calls) assert.equal(options.credentials, 'include');
  assert.deepEqual(JSON.parse(calls[1].options.body), { text: 'Original answer', stream: false });
  assert.equal(await calls[2].options.body.get('audio').text(), 'audio');
});
