// Static host for the console + a same-origin proxy to the Stage 2 API.
// Proxying rather than enabling CORS on the backend keeps Stage 2 untouched and
// means the browser never needs credentials for a second origin.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3200);
// API_ORIGIN is a full origin and wins. API_HOST is a bare hostname (Render's
// fromService can only inject one) and is assumed https.
const API = process.env.API_ORIGIN
  ?? (process.env.API_HOST ? `https://${process.env.API_HOST}` : 'http://127.0.0.1:3100');
// Logged at boot and named in every proxy failure. An "unreachable" error that
// does not say what it tried to reach cannot distinguish a misconfigured origin
// from a genuinely down upstream - which cost an entire deploy cycle to learn.
console.log(`console proxying /api -> ${API}`
  + `  (API_ORIGIN=${process.env.API_ORIGIN ?? 'unset'}, API_HOST=${process.env.API_HOST ?? 'unset'})`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/api/')) {
    // Pass the Authorization header straight through: the browser holds a token,
    // the proxy adds no authority of its own.
    // Bounded like the backend's own limit: an unbounded read here would be a
    // memory DoS the API's cap cannot protect against.
    let body;
    if (req.method !== 'GET') {
      const c = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) { res.writeHead(413).end('{"error":"BODY_TOO_LARGE"}'); return; }
        c.push(chunk);
      }
      body = Buffer.concat(c);
    }
    try {
      const up = await fetch(API + url.pathname.slice(4) + url.search, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body,
      });
      const text = await up.text();
      res.writeHead(up.status, { 'content-type': 'application/json' });
      return res.end(text);
    } catch (e) {
      // The API being down is a state the UI must render, not a blank page.
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'API_UNREACHABLE', detail: String(e.message), upstream: API }));
    }
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');   // no path traversal
  try {
    const buf = await readFile(join(process.cwd(), 'web', safe));
    res.writeHead(200, { 'content-type': TYPES[extname(safe)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
});

export { server };
if (process.argv[1]?.endsWith('server.mjs')) {
  server.listen(PORT, () => console.log(`console on http://localhost:${PORT}`));
}
