/** Serves test/fixtures/sites/<name>/ on 127.0.0.1 (one server per site, root-relative links work). */
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sites');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

export interface FixtureSite {
  name: string;
  /** "<name>.test:<port>" — the host name the tests resolve to 127.0.0.1 */
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function serveFixture(name: string): Promise<FixtureSite> {
  const dir = path.join(ROOT, name);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(dir, p);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>404 Not Found</title><h1>404 Not Found</h1>');
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const host = `${name}.test:${port}`;
  return {
    name,
    host,
    port,
    url: `http://${host}/`,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A fixture host answered by `handler` (status codes and headers the static sites can't produce). */
export async function serveHandler(name: string, handler: http.RequestListener): Promise<FixtureSite> {
  const server = http.createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const host = `${name}.test:${port}`;
  return {
    name,
    host,
    port,
    url: `http://${host}/`,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Cloudflare's "Just a moment..." bot challenge (403 + cf-mitigated), or a plain 403 from an origin behind Cloudflare. */
export function challengeHandler(kind: 'challenge' | 'plain403'): http.RequestListener {
  return (_req, res) => {
    if (kind === 'challenge') {
      res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', server: 'cloudflare', 'cache-control': 'no-store' });
      res.end('<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><noscript>Enable JavaScript and cookies to continue</noscript><p>Checking your browser before accessing the site.</p></body></html>');
    } else {
      res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare' });
      res.end('<!doctype html><html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>');
    }
  };
}

/** A hostile page: megabytes of text, and the builtins the page scripts use redefined to defeat their caps. */
export function hostileHandler(): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Hostile</title></head><body><h1>Hi</h1><a href="/x" id="l">Launch app</a><script>
      const big = 'word '.repeat(1000000);
      document.body.appendChild(document.createTextNode(big));
      document.getElementById('l').href = '/' + 'a'.repeat(200000);
      document.title = 'T'.repeat(200000) + '\u0000';
      String.prototype.slice = function () { return String(this); };
      String.prototype.trim = function () { return String(this); };
      String.prototype.replace = function () { return String(this); };
      Array.prototype.slice = function () { return this; };
      Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return 'EVIL'.repeat(1000000); } });
    </script></body></html>`);
  };
}

/** A port nothing listens on (the "never loads" site). */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

/** Test resolver: every *.test name is this machine. */
export async function testLookup(host: string): Promise<string[]> {
  if (/\.test$/i.test(host)) return ['127.0.0.1'];
  throw new Error(`ENOTFOUND ${host}`);
}
