import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launch, selectScripts } from './run-browser-smokes.mjs';

test('shards partition every discovered smoke exactly once, including newly added scripts', () => {
  const scripts = ['z-smoke.mjs', 'a-smoke.mjs', 'new-smoke.mjs', 'b-smoke.mjs'];
  const shards = [1, 2, 3].flatMap(n => selectScripts(scripts, [`--shard=${n}/3`]));
  assert.deepEqual(shards.sort(), [...scripts].sort());
  assert.deepEqual(selectScripts(scripts, ['z-smoke.mjs']), ['z-smoke.mjs']);
  for (const args of [['--shard=0/3'], ['--shard=4/3'], ['--shard=5/5'], ['missing.mjs']]) {
    assert.throws(() => selectScripts(scripts, args));
  }
});

test('child failures and spawn errors remain failures and preserve diagnostic output', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'smoke-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'failure.log');
  const result = await launch(process.execPath, ['-e', 'console.error("fixture failure"); process.exit(7)'], { log }).completion;
  assert.equal(result.code, 7);
  assert.match(await readFile(log, 'utf8'), /fixture failure/);
  const missing = await launch(path.join(dir, 'missing-executable'), [], { log }).completion;
  assert.notEqual(missing.code, 0);
  assert.match(missing.error, /ENOENT/);
});

test('hung child and descendants are terminated at the deadline', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'smoke-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'timeout.log');
  const program = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
  const result = await launch(process.execPath, ['-e', program], { log, timeoutMs: 1_000 }).completion;
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  const pid = Number((await readFile(log, 'utf8')).trim());
  assert.ok(pid > 0);
  // A terminated orphan can briefly remain a zombie awaiting the OS reaper.
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(status, /State:\s+Z/);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
});

test('CLI continues after failures, records timeouts and returns nonzero with diagnostics', { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'smoke-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'scripts/ci'), { recursive: true });
  await copyFile(new URL('./run-browser-smokes.mjs', import.meta.url), path.join(dir, 'scripts/ci/run-browser-smokes.mjs'));
  await writeFile(path.join(dir, 'scripts/static-server.mjs'), `
    import http from 'node:http';
    const server = http.createServer((req, res) => res.end('fixture'));
    server.listen(0, '127.0.0.1', () => console.log('Static server listening at http://127.0.0.1:' + server.address().port + '/'));
  `);
  await writeFile(path.join(dir, 'scripts/a-smoke.mjs'), 'console.error("fixture assertion failed"); process.exit(7)');
  await writeFile(path.join(dir, 'scripts/b-smoke.mjs'), `
    import assert from 'node:assert/strict';
    const url = new URL(process.env.VIEWER_SMOKE_URL);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.protocol, 'http:');
    assert.ok(Number(url.port) > 0);
    assert.equal(process.env.ROLEPLAYSCENE_URL, process.env.VIEWER_SMOKE_URL + '/server/roleplayscene/');
    console.log('ran after failed fixture');
  `);
  await writeFile(path.join(dir, 'scripts/c-smoke.mjs'), 'setInterval(() => {}, 1000)');
  const artifacts = path.join(dir, 'diagnostics');
  const result = await launch(process.execPath, [path.join(dir, 'scripts/ci/run-browser-smokes.mjs')], {
    log: path.join(dir, 'runner.log'), timeoutMs: 10_000,
    env: { ...process.env, SMOKE_ARTIFACT_DIR: artifacts, SMOKE_TIMEOUT_MS: '2000', VIEWER_SMOKE_URL: 'https://unused.invalid' },
  }).completion;
  assert.equal(result.code, 1);
  assert.equal(result.timedOut, false);
  const output = path.join(artifacts, (await readdir(artifacts))[0]);
  const summary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.results.length, 3);
  assert.equal(summary.results[0].code, 7);
  assert.equal(summary.results[1].code, 0, await readFile(path.join(output, 'b-smoke.log'), 'utf8'));
  assert.equal(summary.results[2].timedOut, true);
  assert.match(await readFile(path.join(output, 'a-smoke.log'), 'utf8'), /fixture assertion failed/);
  assert.match(await readFile(path.join(output, 'b-smoke.log'), 'utf8'), /ran after failed fixture/);
  assert.match(await readFile(path.join(dir, 'runner.log'), 'utf8'), /fixture assertion failed/);
});
