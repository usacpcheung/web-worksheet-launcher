import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const host = process.env.STATIC_HOST || '127.0.0.1';
const port = Number(process.env.STATIC_PORT || 8765);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.zip', 'application/zip'],
]);

function resolveRequestPath(url) {
  const parsed = new URL(url || '/', `http://${host}:${port}`);
  const decoded = decodeURIComponent(parsed.pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return absolute;
}

const server = http.createServer(async (req, res) => {
  let absolute;
  try {
    absolute = resolveRequestPath(req.url);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (!absolute) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    let info = await stat(absolute);
    if (info.isDirectory()) {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (!url.pathname.endsWith('/')) {
        // Keep relative scripts/styles relative to the directory, not its parent.
        res.writeHead(301, { location: `${url.pathname}/${url.search}` });
        res.end();
        return;
      }
      absolute = path.join(absolute, 'index.html');
      info = await stat(absolute);
    }
    if (!info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-length': info.size,
      'content-type': contentTypes.get(path.extname(absolute).toLowerCase()) || 'application/octet-stream',
    });
    createReadStream(absolute).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`Static server listening at http://${host}:${server.address().port}/`);
});
