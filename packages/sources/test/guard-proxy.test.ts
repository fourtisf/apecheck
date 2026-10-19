import http from 'node:http';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProxyAgent, request as undiciRequest } from 'undici';
import { startGuardProxy } from '../src/ssrf';
import type { GuardProxy } from '../src/types';

let target: http.Server;
let targetPort = 0;
const seenHosts: string[] = [];
const seenHeaders: http.IncomingHttpHeaders[] = [];

const openSockets = new Set<net.Socket>();
function listen(server: http.Server): Promise<number> {
  server.on('connection', s => {
    openSockets.add(s);
    s.on('close', () => openSockets.delete(s));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}
function stop(server: http.Server): Promise<void> {
  for (const s of openSockets) s.destroy();
  return new Promise(r => server.close(() => r()));
}

beforeAll(async () => {
  target = http.createServer((req, res) => {
    seenHosts.push(String(req.headers.host));
    seenHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain', 'keep-alive': 'timeout=5', 'x-hop': 'kept' });
    res.end(`hello from fixture ${req.url}`);
  });
  target.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', d => socket.write(d));
  });
  targetPort = await listen(target);
});
afterAll(() => stop(target));

const proxies: GuardProxy[] = [];
async function guard(opts: Parameters<typeof startGuardProxy>[0]): Promise<GuardProxy> {
  const p = await startGuardProxy(opts);
  proxies.push(p);
  return p;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  while (proxies.length) await proxies.pop()!.close();
});

const portOf = (p: GuardProxy) => Number(new URL(p.url).port);

/** raw CONNECT; resolves with the status and the open socket */
function connectVia(p: GuardProxy, authority: string): Promise<{ status: number; socket: net.Socket; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: portOf(p), method: 'CONNECT', path: authority });
    req.on('connect', (res, socket, head) => {
      let body = head.toString();
      if (res.statusCode !== 200) {
        socket.on('data', d => (body += d));
        socket.on('end', () => resolve({ status: res.statusCode ?? 0, socket, body }));
        socket.on('close', () => resolve({ status: res.statusCode ?? 0, socket, body }));
        return;
      }
      resolve({ status: 200, socket, body });
    });
    req.on('error', reject);
    req.end();
  });
}

/** absolute-URI plain HTTP request through the proxy */
function getVia(p: GuardProxy, url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      host: '127.0.0.1', port: portOf(p), method: 'GET', path: url,
      headers: { host: u.host, 'proxy-connection': 'keep-alive', 'proxy-authorization': 'Basic c2VjcmV0', te: 'trailers' },
    });
    req.on('response', res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpOverTunnel(socket: net.Socket, host: string): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    socket.on('data', d => (data += d));
    socket.on('end', () => resolve(data));
    socket.write(`GET /tunnel HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

describe('guard proxy: refusals', () => {
  it('refuses CONNECT to a loopback target and records it', async () => {
    const p = await guard({});
    const r = await connectVia(p, `127.0.0.1:${targetPort}`);
    expect(r.status).toBe(403);
    expect(r.body).toContain('Blocked by ApeCheck SSRF guard: loopback address 127.0.0.1');
    expect(p.blocked).toEqual([{ host: '127.0.0.1', reason: 'loopback address 127.0.0.1' }]);
  });

  it('refuses absolute-URI requests to a loopback target and records it', async () => {
    const p = await guard({});
    const r = await getVia(p, `http://127.0.0.1:${targetPort}/secret`);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/loopback/);
    expect(p.blocked).toHaveLength(1);
    expect(seenHosts).not.toContain(`127.0.0.1:${targetPort}`);
  });

  it('refuses alternative IP spellings, IPv6 loopback, metadata and local names', async () => {
    const p = await guard({ lookup: async () => { throw new Error('lookup must not be needed'); } });
    for (const authority of [`2130706433:${targetPort}`, `0x7f000001:${targetPort}`, `[::1]:${targetPort}`, `[::ffff:127.0.0.1]:${targetPort}`, '169.254.169.254:80', 'metadata.google.internal:80', 'localhost:80', 'svc.internal:443']) {
      const r = await connectVia(p, authority);
      expect(r.status, authority).toBe(403);
    }
    expect(p.blocked.map(b => b.reason)).toEqual([
      'loopback address 127.0.0.1',
      'loopback address 127.0.0.1',
      'loopback address ::1',
      expect.stringMatching(/loopback .*IPv4-mapped/),
      'link-local address 169.254.169.254',
      'metadata host metadata.google.internal',
      'local host name localhost',
      'local host name svc.internal',
    ]);
  });

  it('refuses a name that resolves to a private address (resolver-level check)', async () => {
    const p = await guard({ lookup: async () => ['10.0.0.7'] });
    const r = await connectVia(p, 'evil.example:443');
    expect(r.status).toBe(403);
    expect(p.blocked).toEqual([{ host: 'evil.example', reason: 'evil.example resolves to private address 10.0.0.7' }]);
  });

  it('refuses websocket upgrades to blocked targets', async () => {
    const p = await guard({});
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: portOf(p), path: `http://127.0.0.1:${targetPort}/ws`,
        headers: { host: `127.0.0.1:${targetPort}`, connection: 'Upgrade', upgrade: 'websocket' },
      });
      req.on('response', res => resolve(res.statusCode ?? 0));
      req.on('upgrade', res => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(p.blocked[0].reason).toMatch(/loopback/);
  });

  it('allowHosts is ignored with NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const p = await guard({ allowHosts: [`127.0.0.1:${targetPort}`] });
    expect((await connectVia(p, `127.0.0.1:${targetPort}`)).status).toBe(403);
    expect((await getVia(p, `http://127.0.0.1:${targetPort}/`)).status).toBe(403);
  });
});

describe('guard proxy: allowed traffic', () => {
  it('allowHosts lets a dev fixture through (CONNECT)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const p = await guard({ allowHosts: [`127.0.0.1:${targetPort}`] });
    const r = await connectVia(p, `127.0.0.1:${targetPort}`);
    expect(r.status).toBe(200);
    expect(await httpOverTunnel(r.socket, `127.0.0.1:${targetPort}`)).toContain('hello from fixture /tunnel');
    expect(p.blocked).toEqual([]);
  });

  it('allowHosts lets a dev fixture through (absolute URI), keeps the Host header, strips hop-by-hop headers', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const p = await guard({ allowHosts: [`127.0.0.1:${targetPort}`] });
    const r = await getVia(p, `http://127.0.0.1:${targetPort}/page?x=1`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello from fixture /page?x=1');
    expect(r.headers['x-hop']).toBe('kept');
    const sent = seenHeaders.at(-1)!;
    expect(sent['proxy-authorization']).toBeUndefined();
    expect(sent['proxy-connection']).toBeUndefined();
    expect(sent.te).toBeUndefined();
    expect(seenHosts.at(-1)).toBe(`127.0.0.1:${targetPort}`);
  });

  it('works as an undici ProxyAgent upstream (the way Chromium/undici tunnel)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const p = await guard({ allowHosts: [`127.0.0.1:${targetPort}`] });
    const agent = new ProxyAgent(p.url);
    const res = await undiciRequest(`http://127.0.0.1:${targetPort}/via-undici`, { dispatcher: agent });
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('hello from fixture /via-undici');
    await agent.close();
  });

  it('connects to the vetted address, not a fresh DNS answer (pinning)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    // system DNS cannot resolve this name; only the guard's resolver can, so a success proves it connected to that answer
    const lookup = vi.fn(async () => ['127.0.0.1']);
    const p = await guard({ allowHosts: [`fixture.test:${targetPort}`], lookup });
    const r = await connectVia(p, `fixture.test:${targetPort}`);
    expect(r.status).toBe(200);
    expect(await httpOverTunnel(r.socket, `fixture.test:${targetPort}`)).toContain('hello from fixture');
    expect(lookup).toHaveBeenCalledWith('fixture.test');
  });

  it('forwards websocket upgrades to allowed targets', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const p = await guard({ allowHosts: [`127.0.0.1:${targetPort}`] });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: portOf(p), path: `http://127.0.0.1:${targetPort}/ws`,
        headers: { host: `127.0.0.1:${targetPort}`, connection: 'Upgrade', upgrade: 'websocket' },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('response', res => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(101);
  });

  it('close() tears down open tunnels', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const p = await guard({ allowHosts: [`127.0.0.1:${targetPort}`] });
    const r = await connectVia(p, `127.0.0.1:${targetPort}`);
    const closed = new Promise<void>(resolve => r.socket.on('close', () => resolve()));
    await p.close();
    proxies.splice(proxies.indexOf(p), 1);
    await closed;
    expect(r.socket.destroyed).toBe(true);
  });
});

describe('guard proxy with an upstream egress proxy', () => {
  let upstream: http.Server;
  let upstreamPort = 0;
  const upstreamSaw: string[] = [];
  beforeAll(async () => {
    upstream = http.createServer((_req, res) => res.writeHead(405).end());
    // stands in for an egress proxy that resolves names itself: every tunnel lands on the fixture server
    upstream.on('connect', (req, client, head) => {
      upstreamSaw.push(String(req.url));
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('user:pa ss').toString('base64')}`) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const up = net.connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
    });
    upstreamPort = await listen(upstream);
  });
  afterAll(() => stop(upstream));

  const unresolvable = async (): Promise<string[]> => {
    throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
  };

  it('lets names that cannot be resolved locally through the upstream, by name', async () => {
    const p = await guard({ upstreamProxy: `http://user:pa%20ss@127.0.0.1:${upstreamPort}`, lookup: unresolvable });
    const r = await connectVia(p, 'project.example:443');
    expect(r.status).toBe(200);
    expect(upstreamSaw.at(-1)).toBe('project.example:443');
    expect(await httpOverTunnel(r.socket, 'project.example')).toContain('hello from fixture /tunnel');
  });

  it('tunnels plain-HTTP absolute-URI requests through the upstream with CONNECT', async () => {
    const p = await guard({ upstreamProxy: `http://user:pa%20ss@127.0.0.1:${upstreamPort}`, lookup: unresolvable });
    const r = await getVia(p, 'http://project.example/plain');
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello from fixture /plain');
    expect(upstreamSaw.at(-1)).toBe('project.example:80');
    expect(seenHosts.at(-1)).toBe('project.example');
  });

  it('still refuses private literals and local/metadata names even with an upstream', async () => {
    const p = await guard({ upstreamProxy: `http://user:pa%20ss@127.0.0.1:${upstreamPort}`, lookup: unresolvable });
    const before = upstreamSaw.length;
    for (const a of ['10.0.0.1:443', '[fd00::1]:443', 'localhost:80', 'metadata.google.internal:80', '169.254.169.254:80']) {
      expect((await connectVia(p, a)).status, a).toBe(403);
    }
    expect(upstreamSaw.length).toBe(before);
    expect(p.blocked).toHaveLength(5);
  });

  it('still refuses names that DO resolve locally to private addresses', async () => {
    const p = await guard({ upstreamProxy: `http://user:pa%20ss@127.0.0.1:${upstreamPort}`, lookup: async () => ['192.168.1.20'] });
    expect((await connectVia(p, 'rebind.example:443')).status).toBe(403);
  });

  it('reports a refused upstream as 502 without recording a guard block', async () => {
    const p = await guard({ upstreamProxy: `http://127.0.0.1:${upstreamPort}`, lookup: unresolvable });
    const r = await connectVia(p, 'project.example:443');
    expect(r.status).toBe(502);
    expect(p.blocked).toEqual([]);
  });
});
