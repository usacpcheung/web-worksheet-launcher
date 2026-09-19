import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

test('static smoke server serves directory indexes without changing relative URL resolution', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, ['scripts/static-server.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, STATIC_HOST: '127.0.0.1', STATIC_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Static server exited (${code}): ${errors}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) resolve(match[0]);
    });
  });
  for (const product of ['editor', 'viewer', 'roleplayscene']) {
    const route = `server/${product}/`;
    const expected = await readFile(new URL(`../${product}/index.html`, import.meta.url), 'utf8');
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(await response.text(), expected);
    const direct = await fetch(base + route + 'index.html');
    assert.equal(await direct.text(), expected);
    const redirect = await fetch(base + route.slice(0, -1) + '?fixture=1', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), `/${route}?fixture=1`);
    await redirect.text();
  }
  for (const route of ['server/scripts/', 'does-not-exist.html']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  }
  const malformed = await fetch(base + '%ZZ');
  assert.equal(malformed.status, 400);
  await malformed.text();
  const traversal = await fetch(base + '..%2fpackage.json');
  assert.equal(traversal.status, 403);
  await traversal.text();
  const healthy = await fetch(base + 'server/viewer/index.html');
  assert.equal(healthy.status, 200, 'bad requests must not stop the fixture server');
  await healthy.text();
});
