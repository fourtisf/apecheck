import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttp, HttpError, USER_AGENT } from '../src/http';
import { SsrfError, startGuardProxy } from '../src/ssrf';
import { TimeoutError } from '../src/util';
import { testEnv } from './helpers';

let server: http.Server;
let port = 0;
let other: http.Server;
let otherPort = 0;
const sockets = new Set<net.Socket>();
const seen: { url: string; method: string; headers: http.IncomingHttpHeaders }[] = [];

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const u = new URL(req.url ?? '/', 'http://x');
  seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
  const chain = /^\/chain\/(\d+)$/.exec(u.pathname);
  if (chain) {
    const n = Number(chain[1]);
    if (n === 0) return res.end('end of chain');
    return res.writeHead(302, { location: `/chain/${n - 1}` }).end();
  }
  switch (u.pathname) {
    case '/ok': return res.end('hello');
    case '/json': return res.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1,"b":[true]}');
    case '/bad-json': return res.end('{nope');
    case '/500': return res.writeHead(500).end('boom');
    case '/ua': return res.end(String(req.headers['user-agent']));
    case '/big': return res.end(Buffer.alloc(3 * 1024 * 1024, 'a'));
    case '/gzip': return res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync('compressed hello'));
    case '/br': return res.writeHead(200, { 'content-encoding': 'br' }).end(zlib.brotliCompressSync('brotli hello'));
    case '/gzip-bomb': return res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 'z')));
    case '/slow': return; // never answers
    case '/to-private': return res.writeHead(302, { location: 'http://10.0.0.1/admin' }).end();
    case '/to-metadata': return res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    case '/to-file': return res.writeHead(302, { location: 'file:///etc/passwd' }).end();
    case '/to-other-port': return res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/ok` }).end();
    case '/post-303': return res.writeHead(303, { location: '/method' }).end();
    case '/post-307': return res.writeHead(307, { location: '/method' }).end();
    case '/method': {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', () => res.end(`${req.method} ${body} auth=${req.headers.authorization ?? '-'}`));
      return;
    }
    case '/bytes': {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => res.end(JSON.stringify({ hex: Buffer.concat(parts).toString('hex'), type: req.headers['content-type'] ?? null, length: req.headers['content-length'] ?? null })));
      return;
    }
    case '/to-localhost-auth': return res.writeHead(302, { location: `http://localhost:${port}/method` }).end();
    case '/head': return res.writeHead(200, { 'x-len': '5' }).end('hello');
    default: return res.writeHead(404).end('not found');
  }
}

function listen(s: http.Server): Promise<number> {
  s.on('connection', c => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
}

beforeAll(async () => {
  server = http.createServer(handler);
  port = await listen(server);
  other = http.createServer((_q, r) => r.end('other server'));
  otherPort = await listen(other);
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await Promise.all([new Promise(r => server.close(r)), new Promise(r => other.close(r))]);
});

const base = () => `http://127.0.0.1:${port}`;
const devHttp = (extra: Record<string, string> = {}, opts = {}) =>
  createHttp(testEnv({ SSRF_ALLOW_HOSTS: `127.0.0.1:${port}`, ...extra }), opts);

describe('createHttp: basics', () => {
  it('GET with the ApeCheck user agent', async () => {
    const res = await devHttp().request(`${base()}/ua`);
    expect(res).toMatchObject({ status: 200, ok: true, text: USER_AGENT, truncated: false, finalUrl: `${base()}/ua` });
    expect(res.ms).toBeGreaterThanOrEqual(0);
    expect(USER_AGENT).toBe('Mozilla/5.0 (compatible; ApeCheckBot/1.0; +https://apecheck.io/bot)');
  });

  it('json() parses, throws HttpError on non-2xx and a clear error on bad JSON', async () => {
    const h = devHttp();
    expect(await h.json(`${base()}/json`)).toEqual({ a: 1, b: [true] });
    const err = (await h.json(`${base()}/500`).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(500);
    expect(err.body).toBe('boom');
    await expect(h.json(`${base()}/bad-json`)).rejects.toThrow('bad JSON from 127.0.0.1');
    expect(seen.at(-1)?.headers.accept).toBe('application/json');
  });

  it('decodes gzip and brotli bodies', async () => {
    const h = devHttp();
    expect((await h.request(`${base()}/gzip`)).text).toBe('compressed hello');
    expect((await h.request(`${base()}/br`)).text).toBe('brotli hello');
  });

  it('stops at maxBytes (default 2 MB) and marks the body truncated', async () => {
    const h = devHttp();
    const small = await h.request(`${base()}/big`, { maxBytes: 1000 });
    expect(small.truncated).toBe(true);
    expect(small.text).toHaveLength(1000);
    const def = await h.request(`${base()}/big`);
    expect(def.truncated).toBe(true);
    expect(def.text).toHaveLength(2 * 1024 * 1024);
    // the limit applies to decompressed bytes (a small gzip can't blow up memory)
    const bomb = await h.request(`${base()}/gzip-bomb`, { maxBytes: 4096 });
    expect(bomb.truncated).toBe(true);
    expect(bomb.text).toHaveLength(4096);
    await expect(h.json(`${base()}/big`, { maxBytes: 10 })).rejects.toThrow(/larger than 10 bytes/);
  });

  it('times out (default 10 s, configurable)', async () => {
    const started = Date.now();
    const err = await devHttp().request(`${base()}/slow`, { timeoutMs: 300 }).catch(e => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/timeout after 300ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('HEAD returns headers without a body', async () => {
    const res = await devHttp().request(`${base()}/head`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['x-len']).toBe('5');
    expect(res.text).toBe('');
  });

  it('POST sends the body; 303 turns into GET, 307 keeps the method and body', async () => {
    const h = devHttp();
    expect((await h.request(`${base()}/method`, { method: 'POST', body: 'x=1' })).text).toBe('POST x=1 auth=-');
    expect((await h.request(`${base()}/post-303`, { method: 'POST', body: 'x=1' })).text).toBe('GET  auth=-');
    expect((await h.request(`${base()}/post-307`, { method: 'POST', body: 'x=1' })).text).toBe('POST x=1 auth=-');
  });

  it('POST sends a Buffer body byte for byte (multipart uploads)', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0x00]);
    const res = await devHttp().request(`${base()}/bytes`, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
    });
    expect(JSON.parse(res.text)).toEqual({ hex: bytes.toString('hex'), type: 'multipart/form-data; boundary=b', length: String(bytes.length) });
  });
});

describe('createHttp: redirects', () => {
  it('follows up to 5 redirects and reports the final URL', async () => {
    const res = await devHttp().request(`${base()}/chain/5`);
    expect(res.text).toBe('end of chain');
    expect(res.finalUrl).toBe(`${base()}/chain/0`);
    expect(res.url).toBe(`${base()}/chain/5`);
  });

  it('gives up after 5 redirects', async () => {
    await expect(devHttp().request(`${base()}/chain/6`)).rejects.toThrow(/too many redirects/);
  });

  it('redirect:false returns the 3xx as is', async () => {
    const res = await devHttp().request(`${base()}/chain/2`, { redirect: false });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/chain/1');
  });

  it('drops Authorization when a redirect changes origin', async () => {
    const h = createHttp(testEnv({ SSRF_ALLOW_HOSTS: `127.0.0.1:${port},localhost:${port}` }));
    const res = await h.request(`${base()}/to-localhost-auth`, { headers: { Authorization: 'Bearer secret' } });
    expect(res.text).toBe('GET  auth=-');
  });
});

describe('createHttp: SSRF guard', () => {
  it('guard:true refuses private targets up front', async () => {
    const h = createHttp(testEnv());
    const err = await h.request(`${base()}/ok`, { guard: true }).catch(e => e);
    expect(err).toBeInstanceOf(SsrfError);
    expect(err.reason).toBe('loopback address 127.0.0.1');
    await expect(h.request('file:///etc/passwd', { guard: true })).rejects.toThrow(/blocked scheme file:/);
    await expect(h.request('http://metadata.google.internal/', { guard: true })).rejects.toThrow(/metadata host/);
  });

  it('allow-listed dev fixtures pass with guard:true', async () => {
    const res = await devHttp().request(`${base()}/ok`, { guard: true });
    expect(res.text).toBe('hello');
  });

  it('every redirect hop is re-checked', async () => {
    const h = devHttp();
    await expect(h.request(`${base()}/to-private`, { guard: true })).rejects.toThrow('Blocked by SSRF guard: private address 10.0.0.1');
    await expect(h.request(`${base()}/to-metadata`, { guard: true })).rejects.toThrow(/link-local address 169\.254\.169\.254/);
    await expect(h.request(`${base()}/to-file`, { guard: true })).rejects.toThrow(/blocked scheme file:/);
    // a loopback port that is not on the allow-list
    await expect(h.request(`${base()}/to-other-port`, { guard: true })).rejects.toThrow(/loopback/);
    // without the guard (fixed internal APIs) the same redirect is followed
    expect((await h.request(`${base()}/to-other-port`)).text).toBe('other server');
  });

  it('pins the connection to the vetted addresses (no second DNS lookup)', async () => {
    const lookup = vi.fn(async () => ['127.0.0.1']);
    // system DNS can't resolve pinned.test, so success means the pinned answer was used for the socket
    const h = createHttp(testEnv({ SSRF_ALLOW_HOSTS: `pinned.test:${port}` }), { lookup });
    const res = await h.request(`http://pinned.test:${port}/ok`, { guard: true });
    expect(res.text).toBe('hello');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.headers.host).toBe(`pinned.test:${port}`);
  });

  it('refuses a name whose DNS answer is private', async () => {
    const h = createHttp(testEnv(), { lookup: async () => ['192.168.0.9'] });
    await expect(h.request('https://rebind.example/', { guard: true })).rejects.toThrow('rebind.example resolves to private address 192.168.0.9');
  });

  it('allowHosts is ignored in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const h = createHttp(testEnv({ NODE_ENV: 'production', SSRF_ALLOW_HOSTS: `127.0.0.1:${port}` }));
      await expect(h.request(`${base()}/ok`, { guard: true })).rejects.toBeInstanceOf(SsrfError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('createHttp: OUTBOUND_PROXY', () => {
  it('sends traffic through the proxy (CONNECT), including guarded requests for names only the proxy can resolve', async () => {
    // a guard proxy with a fake resolver stands in for the egress proxy
    const egress = await startGuardProxy({ allowHosts: [`project.test:${port}`], lookup: async () => ['127.0.0.1'] });
    try {
      const failingDns = async (): Promise<string[]> => {
        throw new Error('EAI_AGAIN');
      };
      const h = createHttp(testEnv({ OUTBOUND_PROXY: egress.url }), { lookup: failingDns });
      expect((await h.request(`http://project.test:${port}/ok`)).text).toBe('hello');
      expect((await h.request(`http://project.test:${port}/ok`, { guard: true })).text).toBe('hello');
      // literal private targets and local names are still refused before reaching the proxy
      await expect(h.request('http://10.1.1.1/', { guard: true })).rejects.toBeInstanceOf(SsrfError);
      await expect(h.request('http://localhost/', { guard: true })).rejects.toBeInstanceOf(SsrfError);
      expect(egress.blocked).toEqual([]);
    } finally {
      await egress.close();
    }
  });

  it('loopback / allow-listed targets bypass the proxy', async () => {
    const h = createHttp(testEnv({ OUTBOUND_PROXY: 'http://127.0.0.1:9', SSRF_ALLOW_HOSTS: `127.0.0.1:${port}` }));
    expect((await h.request(`${base()}/ok`)).text).toBe('hello');
    expect((await h.request(`${base()}/ok`, { guard: true })).text).toBe('hello');
  });
});
