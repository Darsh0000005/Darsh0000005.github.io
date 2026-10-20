// Tiny static file server for `site/`: used by `npm start` and by the browser tests.

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export const SITE_DIR = fileURLToPath(new URL('../site/', import.meta.url));

// Netlify applies the `/*` block of `_headers` to every response and never serves the file itself.
// Doing the same here means the tests run with the headers the live site will send.
async function loadGlobalHeaders(base) {
  const headers = {};
  try {
    let applies = false;
    for (const line of (await readFile(join(base, '_headers'), 'utf8')).split('\n')) {
      if (/^\S/.test(line)) applies = line.trim() === '/*';
      else if (applies && line.includes(':')) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }
  } catch {
    // No _headers file: nothing to apply.
  }
  return headers;
}

/** Starts a server for `root`; resolves to { url, close }. Port 0 picks a free port. */
export async function serve(root = SITE_DIR, port = 0) {
  const base = resolve(root);
  const globalHeaders = await loadGlobalHeaders(base);
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = normalize(join(base, pathname.endsWith('/') ? `${pathname}index.html` : pathname));
    try {
      if (!file.startsWith(base) || pathname === '/_headers') throw new Error('not served');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      res.writeHead(200, { ...globalHeaders, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { ...globalHeaders, 'content-type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((resolveStart) => {
    server.listen(port, '127.0.0.1', () => {
      resolveStart({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(SITE_DIR, Number(process.env.PORT) || 8888);
  console.log(`Serving site/ at ${url}`);
}
