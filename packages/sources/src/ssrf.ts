/**
 * SSRF guard (HANDOFF §11).
 *
 * - checkUrl / assertPublicUrl: vet a URL before a server-side fetch. Only http(s); IP literals in any
 *   spelling are normalised by the WHATWG URL parser (2130706433, 0177.0.0.1, 0x7f000001 → 127.0.0.1)
 *   and checked against the blocked ranges; names are refused if they are local/metadata names or if ANY
 *   resolved A/AAAA address is blocked. The vetted addresses are returned so the caller can pin them.
 * - startGuardProxy: a local forward proxy for Chromium (--proxy-server) applying the same rules to every
 *   CONNECT, absolute-URI and upgrade request, connecting to the vetted IP itself (no DNS rebinding window).
 */
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import type { GuardProxy, SsrfCheck } from './types';

export class SsrfError extends Error {
  constructor(public readonly reason: string) {
    super(`Blocked by SSRF guard: ${reason}`);
    this.name = 'SsrfError';
  }
}

export interface SsrfOptions {
  /** DEV/TEST ONLY host[:port] allow-list (env SSRF_ALLOW_HOSTS); ignored when NODE_ENV=production */
  allowHosts?: string[];
  /** custom resolver for tests */
  lookup?: (host: string) => Promise<string[]>;
  /** force production rules (allowHosts ignored). process.env.NODE_ENV=production always forces them. */
  production?: boolean;
  /**
   * Treat a name that does not resolve locally as public instead of refusing it. Only for traffic that
   * leaves through an upstream proxy which resolves names itself (see startGuardProxy / createHttp).
   */
  allowUnresolved?: boolean;
}

/* ---------------- address rules ---------------- */

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];
const cidr = (s: string): Cidr => ipaddr.parseCIDR(s);

const V4_BLOCKED: [Cidr, string][] = [
  [cidr('0.0.0.0/8'), 'reserved'],
  [cidr('10.0.0.0/8'), 'private'],
  [cidr('100.64.0.0/10'), 'shared (CGNAT)'],
  [cidr('127.0.0.0/8'), 'loopback'],
  [cidr('169.254.0.0/16'), 'link-local'],
  [cidr('172.16.0.0/12'), 'private'],
  [cidr('192.0.0.0/24'), 'reserved'],
  [cidr('192.0.2.0/24'), 'documentation'],
  [cidr('192.168.0.0/16'), 'private'],
  [cidr('198.18.0.0/15'), 'benchmarking'],
  [cidr('198.51.100.0/24'), 'documentation'],
  [cidr('203.0.113.0/24'), 'documentation'],
  [cidr('224.0.0.0/4'), 'multicast'],
  [cidr('240.0.0.0/4'), 'reserved'],
  [cidr('255.255.255.255/32'), 'broadcast'],
];

const V6_BLOCKED: [Cidr, string][] = [
  [cidr('::/128'), 'unspecified'],
  [cidr('::1/128'), 'loopback'],
  [cidr('fc00::/7'), 'private'],
  [cidr('fe80::/10'), 'link-local'],
  [cidr('fec0::/10'), 'site-local'],
  [cidr('ff00::/8'), 'multicast'],
  [cidr('2001:db8::/32'), 'documentation'],
  [cidr('100::/64'), 'discard'],
  // Teredo hides an arbitrary IPv4 client address inside the IPv6 address; nothing legitimate needs it here.
  [cidr('2001::/32'), 'Teredo'],
  [cidr('64:ff9b:1::/48'), 'local NAT64'],
];

/** IPv6 ranges that embed an IPv4 address: the embedded address gets the IPv4 rules. */
const V6_EMBEDS_V4: { range: Cidr; label: string; v4: (p: number[]) => number[] }[] = [
  { range: cidr('::ffff:0:0/96'), label: 'IPv4-mapped', v4: p => [p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255] },
  { range: cidr('64:ff9b::/96'), label: 'NAT64', v4: p => [p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255] },
  { range: cidr('::ffff:0:0:0/96'), label: 'IPv4-translated', v4: p => [p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255] },
  { range: cidr('::/96'), label: 'IPv4-compatible', v4: p => [p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255] },
  { range: cidr('2002::/16'), label: '6to4', v4: p => [p[1] >> 8, p[1] & 255, p[2] >> 8, p[2] & 255] },
];

function v4Reason(a: ipaddr.IPv4): string | null {
  for (const [range, label] of V4_BLOCKED) if (a.match(range)) return label;
  return null;
}

/** Why an IP address is refused ("private address 10.0.0.5"), or null when it is public. Non-IP input is refused. */
export function ipBlockReason(ip: string): string | null {
  let raw = stripBrackets(String(ip ?? '').trim()).split('%')[0];
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    // WHATWG serialisation first: ipaddr.js reads "::a.b.c.d" as IPv4-mapped instead of IPv4-compatible
    if (raw.includes(':')) raw = stripBrackets(new URL(`http://[${raw}]/`).hostname);
    addr = ipaddr.parse(raw);
  } catch {
    return `invalid address ${ip}`;
  }
  if (addr.kind() === 'ipv4') {
    const label = v4Reason(addr as ipaddr.IPv4);
    return label ? `${label} address ${addr.toString()}` : null;
  }
  const v6 = addr as ipaddr.IPv6;
  for (const [range, label] of V6_BLOCKED) if (v6.match(range)) return `${label} address ${v6.toString()}`;
  for (const e of V6_EMBEDS_V4) {
    if (!v6.match(e.range)) continue;
    const v4 = new ipaddr.IPv4(e.v4(v6.parts));
    const label = v4Reason(v4);
    return label ? `${label} address ${v6.toString()} (${e.label} ${v4.toString()})` : null;
  }
  return null;
}

export function isBlockedIp(ip: string): boolean {
  return ipBlockReason(ip) !== null;
}

/* ---------------- host-name rules ---------------- */

const METADATA_HOSTS = new Set([
  'metadata.google.internal', 'metadata.goog', 'metadata', 'metadata.azure.com',
  'instance-data', 'instance-data.ec2.internal',
]);
const LOCAL_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain'];

function stripBrackets(h: string): string {
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** lowercase, no brackets, no trailing dots */
export function normaliseHost(host: string): string {
  return stripBrackets(String(host ?? '').trim().toLowerCase()).replace(/\.+$/, '');
}

function hostNameReason(host: string): string | null {
  if (METADATA_HOSTS.has(host)) return `metadata host ${host}`;
  if (host === 'localhost' || LOCAL_SUFFIXES.some(s => host.endsWith(s))) return `local host name ${host}`;
  // single-label names resolve through the resolver's search domains, i.e. to internal hosts
  if (!host.includes('.')) return `single-label host name ${host}`;
  return null;
}

/* ---------------- resolution ---------------- */

const LOOKUP_TIMEOUT_MS = 5_000;

async function systemLookup(host: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      dns.promises.lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('DNS timeout')), LOOKUP_TIMEOUT_MS); }),
    ]);
    return res.map(r => r.address);
  } finally {
    clearTimeout(timer);
  }
}

export function isProduction(opts: SsrfOptions = {}): boolean {
  return opts.production === true || process.env.NODE_ENV === 'production';
}

function allowListed(host: string, port: number, opts: SsrfOptions): boolean {
  if (!opts.allowHosts?.length || isProduction(opts)) return false;
  const keys = new Set([host, `${host}:${port}`, `[${host}]`, `[${host}]:${port}`]);
  return opts.allowHosts.some(h => keys.has(h.trim().toLowerCase()));
}

export interface HostVetting {
  ok: boolean;
  host: string;
  reason?: string;
  /** vetted addresses to connect to (empty when the name could not be resolved and allowUnresolved was set) */
  addresses: string[];
  /** let through by the dev/test allow-list: connect directly, never through an upstream proxy */
  allowListed?: boolean;
  /** name did not resolve locally; only the upstream proxy can reach it */
  unresolved?: boolean;
}

/** Vet a host name or IP (any spelling) for a connection to `port`. */
export async function vetHost(hostname: string, port: number, opts: SsrfOptions = {}): Promise<HostVetting> {
  const host = canonicalHost(hostname);
  if (!host) return { ok: false, host: String(hostname), reason: 'invalid host', addresses: [] };
  const lookup = opts.lookup ?? systemLookup;

  if (allowListed(host, port, opts)) {
    let addresses: string[] = [];
    if (net.isIP(host)) addresses = [host];
    else addresses = await lookup(host).catch(() => []);
    return { ok: true, host, addresses, allowListed: true };
  }
  if (net.isIP(host)) {
    const reason = ipBlockReason(host);
    return reason ? { ok: false, host, reason, addresses: [] } : { ok: true, host, addresses: [host] };
  }
  const nameReason = hostNameReason(host);
  if (nameReason) return { ok: false, host, reason: nameReason, addresses: [] };

  let addresses: string[] = [];
  try {
    addresses = await lookup(host);
  } catch {
    addresses = [];
  }
  if (!addresses.length) {
    return opts.allowUnresolved
      ? { ok: true, host, addresses: [], unresolved: true }
      : { ok: false, host, reason: `could not resolve ${host}`, addresses: [] };
  }
  for (const a of addresses) {
    const reason = ipBlockReason(a);
    if (reason) return { ok: false, host, reason: `${host} resolves to ${reason}`, addresses: [] };
  }
  return { ok: true, host, addresses };
}

/** Canonical host via the WHATWG parser (catches decimal/octal/hex IPv4 and IPv6 forms), '' when invalid. */
function canonicalHost(hostname: string): string {
  const h = String(hostname ?? '').trim();
  // userinfo, paths or whitespace in a host position are a parser-confusion attempt, not a host
  if (!h || /[\s@/\\?#]/.test(h)) return '';
  const bare = stripBrackets(h);
  const forUrl = net.isIPv6(bare.split('%')[0]) ? `[${bare}]` : h;
  try {
    return normaliseHost(new URL(`http://${forUrl}/`).hostname);
  } catch {
    return '';
  }
}

/* ---------------- URL checks ---------------- */

export interface UrlVetting extends SsrfCheck {
  allowListed?: boolean;
  unresolved?: boolean;
}

export async function vetUrl(raw: string, opts: SsrfOptions = {}): Promise<UrlVetting> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, url, reason: `blocked scheme ${url.protocol}` };
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const v = await vetHost(url.hostname, port, opts);
  if (!v.ok) return { ok: false, url, reason: v.reason };
  return { ok: true, url, addresses: v.addresses, allowListed: v.allowListed, unresolved: v.unresolved };
}

export async function checkUrl(url: string, opts: SsrfOptions = {}): Promise<SsrfCheck> {
  const { ok, url: u, addresses, reason } = await vetUrl(url, opts);
  return ok ? { ok, url: u, addresses } : { ok, url: u, reason };
}

export async function assertPublicUrl(url: string, opts: SsrfOptions = {}): Promise<URL> {
  const c = await checkUrl(url, opts);
  if (!c.ok || !c.url) throw new SsrfError(c.reason ?? 'invalid URL');
  return c.url;
}

/* ---------------- guard proxy ---------------- */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const MAX_BLOCKED_RECORDS = 1000;
const CONNECT_TIMEOUT_MS = 10_000;

function stripHopByHop(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || listed.has(k)) continue;
    out[k] = v;
  }
  return out;
}

interface Upstream { host: string; port: number; auth: string | null }

function parseUpstream(u: string): Upstream {
  const url = new URL(u);
  if (url.protocol !== 'http:') throw new Error(`upstream proxy must be http:// (got ${url.protocol})`);
  const auth = url.username ? Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64') : null;
  return { host: stripBrackets(url.hostname), port: Number(url.port || 80), auth };
}

/** "host:port" / "[v6]:port" from a CONNECT line */
function parseAuthority(target: string | undefined): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(String(target ?? '').trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return null;
  return { host: m[1], port };
}

const hostForLine = (host: string) => (net.isIPv6(host) ? `[${host}]` : host);

function connectDirect(addresses: string[], port: number): Promise<net.Socket> {
  // IPv4 first: hosts without IPv6 routing would otherwise wait out the connect timeout on every AAAA answer
  const ordered = [...addresses].sort((a, b) => (net.isIPv6(a) ? 1 : 0) - (net.isIPv6(b) ? 1 : 0));
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = (lastErr?: Error) => {
      if (i >= ordered.length) return reject(lastErr ?? new Error('no address to connect to'));
      const sock = net.connect({ host: ordered[i++], port });
      const timer = setTimeout(() => sock.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
      sock.once('connect', () => { clearTimeout(timer); sock.removeAllListeners('error'); resolve(sock); });
      sock.once('error', err => { clearTimeout(timer); sock.destroy(); next(err); });
    };
    next();
  });
}

/** Open a CONNECT tunnel to host:port through an HTTP proxy. */
export function tunnelThrough(up: Upstream, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: up.host, port: up.port });
    const timer = setTimeout(() => sock.destroy(new Error('upstream proxy timeout')), CONNECT_TIMEOUT_MS);
    let buf = Buffer.alloc(0);
    const fail = (err: Error) => { clearTimeout(timer); sock.destroy(); reject(err); };
    sock.once('error', fail);
    sock.once('connect', () => {
      const authority = `${hostForLine(host)}:${port}`;
      sock.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
          (up.auth ? `Proxy-Authorization: Basic ${up.auth}\r\n` : '') +
          '\r\n',
      );
    });
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 16_384) fail(new Error('upstream proxy sent an oversized response'));
        return;
      }
      sock.off('data', onData);
      clearTimeout(timer);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1] ?? 0);
      if (status !== 200) return fail(new Error(`upstream proxy answered ${status || 'garbage'}`));
      sock.removeListener('error', fail);
      const rest = buf.subarray(end + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.on('data', onData);
  });
}

/**
 * Local forward proxy for Chromium. Every CONNECT, absolute-URI request and upgrade is vetted with the
 * rules above, then connected to the vetted IP (pinned), so a name can't be re-resolved to a private
 * address between check and connect.
 *
 * Limitation with `upstreamProxy` (an egress proxy that must carry all traffic, e.g. a sandbox): the
 * upstream resolves names itself, so the tunnel is opened to the NAME and pinning is the upstream's job.
 * When local DNS works we still refuse names resolving to blocked addresses; when it doesn't, we still
 * refuse IP literals in blocked ranges and local/metadata names, and let other names through to the
 * upstream. Allow-listed dev hosts always connect directly.
 */
export async function startGuardProxy(opts: SsrfOptions & { upstreamProxy?: string | null }): Promise<GuardProxy> {
  const upstream = opts.upstreamProxy ? parseUpstream(opts.upstreamProxy) : null;
  const vetOpts: SsrfOptions = { ...opts, allowUnresolved: !!upstream };
  const blocked: { host: string; reason: string }[] = [];
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
    return s;
  };
  const record = (host: string, reason: string) => {
    if (blocked.length < MAX_BLOCKED_RECORDS) blocked.push({ host, reason });
  };

  const open = async (v: HostVetting, port: number): Promise<net.Socket> => {
    if (v.allowListed || !upstream) {
      return track(await connectDirect(v.addresses.length ? v.addresses : [v.host], port));
    }
    return track(await tunnelThrough(upstream, v.host, port));
  };

  const refuseSocket = (sock: net.Socket, status: number, text: string, reason?: string) => {
    if (sock.destroyed) return;
    const body = reason ? `Blocked by ApeCheck SSRF guard: ${reason}\n` : `${text}\n`;
    sock.end(
      `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  };

  const splice = (a: net.Socket, b: net.Socket) => {
    a.pipe(b);
    b.pipe(a);
    a.on('error', () => b.destroy());
    b.on('error', () => a.destroy());
    a.on('close', () => b.destroy());
    b.on('close', () => a.destroy());
  };

  const server = http.createServer();
  server.on('connection', track);
  server.on('clientError', (_err, sock) => sock.destroy());

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const target = parseAuthority(req.url);
    if (!target) return refuseSocket(client, 400, 'Bad Request');
    const v = await vetHost(target.host, target.port, vetOpts);
    if (!v.ok) {
      record(v.host, v.reason ?? 'blocked');
      return refuseSocket(client, 403, 'Forbidden', v.reason);
    }
    let up: net.Socket;
    try {
      up = await open(v, target.port);
    } catch {
      return refuseSocket(client, 502, 'Bad Gateway');
    }
    if (client.destroyed) return void up.destroy();
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) up.write(head);
    splice(client, up);
  });

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let url: URL | null = null;
    try {
      url = new URL(req.url ?? '');
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('absolute http:// URL required\n');
      return;
    }
    const port = Number(url.port || 80);
    const v = await vetHost(url.hostname, port, vetOpts);
    if (!v.ok) {
      record(v.host, v.reason ?? 'blocked');
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by ApeCheck SSRF guard: ${v.reason}\n`);
      return;
    }
    let sock: net.Socket;
    try {
      sock = await open(v, port);
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad Gateway\n');
      return;
    }
    const headers = stripHopByHop(req.headers);
    headers.host = req.headers.host ?? url.host;
    headers.connection = 'close';
    const preq = http.request({
      method: req.method,
      path: url.pathname + url.search,
      headers,
      createConnection: () => sock,
    });
    preq.on('response', pres => {
      res.writeHead(pres.statusCode ?? 502, stripHopByHop(pres.headers));
      pres.pipe(res);
      pres.on('error', () => res.destroy());
    });
    preq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad Gateway\n');
      else res.destroy();
    });
    req.on('error', () => preq.destroy());
    req.pipe(preq);
  });

  server.on('upgrade', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    let url: URL | null = null;
    try {
      url = new URL(req.url ?? '');
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'ws:')) return refuseSocket(client, 400, 'Bad Request');
    const port = Number(url.port || 80);
    const v = await vetHost(url.hostname, port, vetOpts);
    if (!v.ok) {
      record(v.host, v.reason ?? 'blocked');
      return refuseSocket(client, 403, 'Forbidden', v.reason);
    }
    let up: net.Socket;
    try {
      up = await open(v, port);
    } catch {
      return refuseSocket(client, 502, 'Bad Gateway');
    }
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (/^proxy-/i.test(req.rawHeaders[i])) continue;
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    splice(client, up);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise<void>(resolve => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
