import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function selectScripts(discovered, args) {
  let shard = 1, total = 1;
  const requested = [];
  for (const arg of args) {
    if (arg.startsWith('--shard=')) {
      const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(arg);
      if (!match) throw new Error('Use --shard=N/TOTAL, for example --shard=1/3');
      [, shard, total] = match.map(Number);
      if (shard > total) throw new Error('Shard number exceeds total shards');
    } else {
      if (!discovered.includes(arg)) throw new Error(`Unknown smoke script: ${arg}`);
      requested.push(arg);
    }
  }
  const scripts = [...new Set(requested.length ? requested : discovered)].sort();
  const selected = scripts.filter((_, index) => index % total === shard - 1);
  if (!selected.length) throw new Error('No smoke scripts selected');
  return selected;
}

// Each fixture gets its own process group, including Chromium descendants.
// Killing only the Node parent can leave a hung browser holding the job open.
export function launch(command, args, { log, env = process.env, timeoutMs, onOutput } = {}) {
  const fd = openSync(log, 'w');
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, {
    cwd: root, env, detached: grouped,
    stdio: ['ignore', onOutput ? 'pipe' : fd, fd],
  });
  let timedOut = false;
  let spawnError;
  const stop = () => {
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  if (onOutput) child.stdout.on('data', chunk => {
    writeSync(fd, chunk);
    onOutput(chunk.toString());
  });
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;
  const completion = new Promise(resolve => {
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      stop();
      closeSync(fd);
      resolve({ code, signal, timedOut, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
  return { stop, completion };
}

async function main() {
  const discovered = (await readdir(path.join(root, 'scripts'))).filter(name => name.endsWith('-smoke.mjs'));
  const scripts = selectScripts(discovered, process.argv.slice(2));
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('SMOKE_TIMEOUT_MS must be a positive integer of at most 2147483647');
  }
  const artifactRoot = path.resolve(process.env.SMOKE_ARTIFACT_DIR || path.join(root, 'artifacts/browser'));
  await mkdir(artifactRoot, { recursive: true });
  const output = await mkdtemp(path.join(artifactRoot, 'run-'));
  console.log(`Running ${scripts.length} smoke scripts; diagnostics: ${output}`);
  let active;
  let interrupted = false;
  let server;
  const interrupt = () => { interrupted = true; active?.stop(); server?.stop(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const results = [];
  const saveSummary = () => writeFile(path.join(output, 'summary.json'), JSON.stringify({
    selected: scripts, results, interrupted,
  }, null, 2) + '\n');
  try {
    let ready;
    let startupOutput = '';
    const address = new Promise(resolve => { ready = resolve; });
    server = launch(process.execPath, ['scripts/static-server.mjs'], {
      log: path.join(output, 'static-server.log'),
      env: { ...process.env, STATIC_HOST: '127.0.0.1', STATIC_PORT: '0' },
      onOutput(chunk) {
        startupOutput += chunk;
        const match = /Static server listening at (http:\/\/127\.0\.0\.1:\d+)\//.exec(startupOutput);
        if (match) ready(match[1]);
      },
    });
    let startupTimer;
    let base;
    try {
      base = await Promise.race([
        address,
        server.completion.then(result => { throw new Error(`Static server exited: ${JSON.stringify(result)}`); }),
        new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('Static server startup timed out')), 15_000); }),
      ]);
    } finally {
      clearTimeout(startupTimer);
    }
    const response = await fetch(`${base}/server/editor/`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Static server health check returned ${response.status}`);
    await response.arrayBuffer();
    await saveSummary();
    for (const script of scripts) {
      if (interrupted) break;
      const name = script.replace(/\.mjs$/, '');
      const screenshots = path.join(output, name);
      await mkdir(screenshots);
      if (interrupted) break;
      console.log(`START ${script}`);
      const started = Date.now();
      active = launch(process.execPath, [path.join('scripts', script)], {
        log: path.join(output, `${name}.log`), timeoutMs,
        env: {
          ...process.env,
          VIEWER_SMOKE_URL: base,
          ROLEPLAYSCENE_URL: `${base}/server/roleplayscene/`,
          VIEWER_SMOKE_SCREENSHOTS: screenshots,
          DEBUG: 'pw:api',
        },
      });
      const result = await active.completion;
      active = null;
      results.push({ script, ...result, seconds: (Date.now() - started) / 1000 });
      console.log(`${result.code === 0 && !result.timedOut ? 'PASS' : 'FAIL'} ${script}${result.timedOut ? ' (timeout)' : ''}`);
      await saveSummary();
    }
  } finally {
    active?.stop();
    server?.stop();
    await server?.completion;
    await saveSummary();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  const failed = results.filter(result => result.code !== 0 || result.timedOut);
  console.log(`${results.length - failed.length}/${scripts.length} passed; diagnostics: ${output}`);
  if (interrupted || failed.length || results.length !== scripts.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
