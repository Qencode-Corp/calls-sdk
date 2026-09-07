// Minimal backend for the vanilla example: holds the Qencode API key, creates one call, mints a
// credential per identity, and serves the page. Plain Node, no dependencies.
//
//   QENCODE_API_KEY=... node server.js            # API_BASE defaults to https://api.qencode.com
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API_BASE = (process.env.API_BASE || 'https://api.qencode.com').replace(/\/+$/, '');
const API_KEY = process.env.QENCODE_API_KEY;
const PORT = Number(process.env.PORT || 8787);
if (!API_KEY) { console.error('QENCODE_API_KEY is required'); process.exit(1); }

const here = path.dirname(fileURLToPath(import.meta.url));
const vanilla = path.resolve(here, '../vanilla');
const dist = path.resolve(here, '../../dist');

let jwt = null, jwtAt = 0, call = null;

async function api(method, p, body, token) {
  const res = await fetch(`${API_BASE}${p}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function projectJwt() {
  if (jwt && Date.now() - jwtAt < 20 * 3600_000) return jwt;
  jwt = (await api('POST', `/v1/access_token/${API_KEY}`)).access_token; jwtAt = Date.now();
  return jwt;
}

async function ensureCall() {
  if (call && call.status !== 'ended') return call;
  call = (await api('POST', '/v1/calls', {}, await projectJwt())).call;
  console.log('created call', call.id, 'on', call.backend);
  return call;
}

async function credentialFor(identity) {
  const c = await ensureCall();
  const tok = await api('POST', `/v1/calls/${c.id}/tokens`, { identity, name: identity, role: identity === 'alice' ? 'A' : 'B', ttl: 3600 }, await projectJwt());
  return { ...tok, call_id: c.id, api_base: API_BASE };
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
async function serveFile(res, file) {
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/calls/join') {
      const identity = url.searchParams.get('as') || 'alice';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await credentialFor(identity)));
    } else if (url.pathname === '/api/calls/reset') {
      call = null; res.writeHead(204); res.end();
    } else if (url.pathname.startsWith('/dist/')) {
      await serveFile(res, path.join(dist, url.pathname.slice('/dist/'.length)));
    } else {
      await serveFile(res, path.join(vanilla, url.pathname === '/' ? 'index.html' : url.pathname));
    }
  } catch (e) {
    console.error(e); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => console.log(`example on http://localhost:${PORT}/ (API ${API_BASE})`));
