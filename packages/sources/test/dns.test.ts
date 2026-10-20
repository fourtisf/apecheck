/**
 * The SSRF guard's resolver (SEC-M4-3): names that users and pages supply (webhook URLs, pasted links, every hop of
 * a guarded fetch) are resolved with c-ares (dns.Resolver), never with dns.lookup (getaddrinfo on libuv's threadpool,
 * where a name server that never answers holds a thread past any timeout we race it against).
 *
 * The c-ares path runs for real against a fake DNS server on 127.0.0.1 (UDP); the default wiring is checked with spies.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttp } from '../src/http';
import { SsrfError, checkUrl, createDnsLookup, startGuardProxy, vetHost } from '../src/ssrf';
import { testEnv } from './helpers';

/* ---------------- a fake DNS server ---------------- */

type Zone = Record<string, { A?: string[]; AAAA?: string[] }>;

interface FakeDns {
  server: string;
  /** questions received ("A hooks.example.com") */
  queries: string[];
  close(): Promise<void>;
}

const TYPE_A = 1;
const TYPE_AAAA = 28;

/** Answers A / AAAA from `zone` (NXDOMAIN for unknown names, NODATA for a missing family); `silent`: never answers. */
async function fakeDns(zone: Zone, silent = false): Promise<FakeDns> {
  const sock = dgram.createSocket('udp4');
  const queries: string[] = [];
  sock.on('message', (msg, rinfo) => {
    // header (12 bytes), then one question: labels, QTYPE, QCLASS
    let i = 12;
    const labels: string[] = [];
    while (msg[i] !== 0) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString('latin1'));
      i += msg[i] + 1;
    }
    const qEnd = i + 5;
    const qtype = msg.readUInt16BE(i + 1);
    const name = labels.join('.').toLowerCase();
    queries.push(`${qtype === TYPE_A ? 'A' : qtype === TYPE_AAAA ? 'AAAA' : qtype} ${name}`);
    if (silent) return;

    const entry = zone[name];
    const ips = !entry ? [] : qtype === TYPE_A ? entry.A ?? [] : qtype === TYPE_AAAA ? entry.AAAA ?? [] : [];
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // id
    header.writeUInt16BE(entry ? 0x8180 : 0x8183, 2); // response, RD, RA; NOERROR or NXDOMAIN
    header.writeUInt16BE(1, 4); // QDCOUNT
    header.writeUInt16BE(ips.length, 6); // ANCOUNT
    const answers = ips.map(ip => {
      const rdata = Buffer.from(ipaddr.parse(ip).toByteArray());
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0); // name: pointer to the question
      rr.writeUInt16BE(qtype, 2);
      rr.writeUInt16BE(1, 4); // IN
      rr.writeUInt32BE(60, 6); // TTL
      rr.writeUInt16BE(rdata.length, 10);
      return Buffer.concat([rr, rdata]);
    });
    sock.send(Buffer.concat([header, msg.subarray(12, qEnd), ...answers]), rinfo.port, rinfo.address);
  });
  await new Promise<void>(resolve => sock.bind(0, '127.0.0.1', resolve));
  return {
    server: `127.0.0.1:${sock.address().port}`,
    queries,
    close: () => new Promise<void>(resolve => sock.close(() => resolve())),
  };
}

const ZONE: Zone = {
  'hooks.example.com': { A: ['93.184.215.14', '93.184.215.15'], AAAA: ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'] },
  'v4only.example.com': { A: ['93.184.215.20'] },
  'v6only.example.com': { AAAA: ['2606:4700::6810:84e5'] },
  'sneaky.example.com': { A: ['93.184.215.30'], AAAA: ['::1'] },
  'internal.example.com': { A: ['10.0.0.7'] },
};

let ns: FakeDns;
let blackhole: FakeDns;

beforeAll(async () => {
  ns = await fakeDns(ZONE);
  blackhole = await fakeDns({}, true);
});
afterAll(async () => {
  await ns.close();
  await blackhole.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------- createDnsLookup ---------------- */

describe('createDnsLookup — c-ares A + AAAA', () => {
  it('asks both families and merges the answers', async () => {
    const lookup = createDnsLookup({ servers: [ns.server] });
    expect((await lookup('hooks.example.com')).sort()).toEqual(['2606:2800:21f:cb07:6820:80da:af6b:8b2c', '93.184.215.14', '93.184.215.15']);
    expect(ns.queries).toEqual(expect.arrayContaining(['A hooks.example.com', 'AAAA hooks.example.com']));
  });

  it('one family missing is fine (NODATA)', async () => {
    const lookup = createDnsLookup({ servers: [ns.server] });
    expect(await lookup('v4only.example.com')).toEqual(['93.184.215.20']);
    expect(await lookup('v6only.example.com')).toEqual(['2606:4700::6810:84e5']);
  });

  it('a name that does not exist rejects', async () => {
    const lookup = createDnsLookup({ servers: [ns.server] });
    await expect(lookup('nope.example.com')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('through vetHost / checkUrl: every address of both families is vetted', async () => {
    const lookup = createDnsLookup({ servers: [ns.server] });
    expect(await checkUrl('https://hooks.example.com/apecheck', { lookup })).toMatchObject({ ok: true });
    // the AAAA record alone makes it a loopback name
    expect(await vetHost('sneaky.example.com', 443, { lookup })).toMatchObject({ ok: false, reason: 'sneaky.example.com resolves to loopback address ::1' });
    expect(await vetHost('internal.example.com', 443, { lookup })).toMatchObject({ ok: false, reason: 'internal.example.com resolves to private address 10.0.0.7' });
    expect(await vetHost('nope.example.com', 443, { lookup })).toMatchObject({ ok: false, reason: 'could not resolve nope.example.com' });
  });

  it('a name server that never answers: the lookup gives up at its deadline and leaves the threadpool alone', async () => {
    // per-query timeout far beyond the deadline: only the deadline (resolver.cancel()) can end these lookups
    const lookup = createDnsLookup({ servers: [blackhole.server], timeoutMs: 400, queryTimeoutMs: 10_000, tries: 3 });
    const started = Date.now();
    // more hanging lookups than libuv has threads (4 by default, 2 of them for DNS)
    const pending = Array.from({ length: 8 }, (_, i) => lookup(`slow${i}.example.com`).then(() => null, (e: unknown) => e));

    // meanwhile the process's other threadpool work (getaddrinfo from /etc/hosts, fs) goes through at once
    const t0 = Date.now();
    await dns.promises.lookup('localhost');
    await readFile(new URL(import.meta.url));
    expect(Date.now() - t0).toBeLessThan(300);

    const errors = await Promise.all(pending);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2_000);
    for (const e of errors) expect(e).toMatchObject({ code: 'ETIMEOUT' });
    expect(blackhole.queries.filter(q => q.endsWith('slow0.example.com')).sort()).toEqual(['A slow0.example.com', 'AAAA slow0.example.com']);
    // and vetHost reports it as an unresolved name, not a crash
    expect(await vetHost('slow.example.com', 443, { lookup })).toMatchObject({ ok: false, reason: 'could not resolve slow.example.com' });
  });
});

/* ---------------- the default wiring ---------------- */

const enodata = () => Object.assign(new Error('queryAaaa ENODATA'), { code: 'ENODATA' });

/** Stub c-ares (Resolver.prototype) and getaddrinfo (dns.promises.lookup), recording which one the guard used. */
function stubResolvers(a: string[] | Error, aaaa: string[] | Error = enodata()) {
  const proto = dns.promises.Resolver.prototype;
  const answer = (v: string[] | Error) => async () => {
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    resolve4: vi.spyOn(proto, 'resolve4').mockImplementation(answer(a) as never),
    resolve6: vi.spyOn(proto, 'resolve6').mockImplementation(answer(aaaa) as never),
    getaddrinfo: vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: '127.0.0.1', family: 4 }]) as never),
  };
}

describe('the guard resolves user-supplied names with c-ares, never getaddrinfo (SEC-M4-3)', () => {
  it('vetHost / checkUrl without a lookup override (the API webhook URL check)', async () => {
    const s = stubResolvers(['93.184.215.14'], ['2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
    expect(await vetHost('hooks.example.com', 443)).toMatchObject({ ok: true, addresses: ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'] });
    expect(await checkUrl('https://hooks.example.com/apecheck')).toMatchObject({ ok: true });
    expect(s.resolve4).toHaveBeenCalledWith('hooks.example.com');
    expect(s.resolve6).toHaveBeenCalledWith('hooks.example.com');
    expect(s.getaddrinfo).not.toHaveBeenCalled();
  });

  it('a c-ares answer with a blocked address refuses the name', async () => {
    const s = stubResolvers(['93.184.215.14'], ['fd00::5']);
    expect(await vetHost('hooks.example.com', 443)).toMatchObject({ ok: false, reason: 'hooks.example.com resolves to private address fd00::5' });
    expect(s.getaddrinfo).not.toHaveBeenCalled();
  });

  it('createHttp guard:true (webhook deliveries, site fetches) vets every hop with c-ares', async () => {
    const s = stubResolvers(['10.0.0.9']);
    const http = createHttp(testEnv());
    await expect(http.request('https://hooks.example.com/apecheck', { method: 'POST', guard: true, redirect: false, body: '{}' })).rejects.toBeInstanceOf(SsrfError);
    expect(s.resolve4).toHaveBeenCalledWith('hooks.example.com');
    expect(s.getaddrinfo).not.toHaveBeenCalled();
  });

  it('the guard proxy for Chromium resolves CONNECT targets with c-ares', async () => {
    const s = stubResolvers(['192.168.1.20']);
    const proxy = await startGuardProxy({});
    try {
      const { hostname: host, port } = new URL(proxy.url);
      const res = await new Promise<string>((resolve, reject) => {
        const sock = net.connect({ host, port: Number(port) });
        let buf = '';
        sock.on('data', d => (buf += d.toString('latin1')));
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
        sock.write('CONNECT site.example.com:443 HTTP/1.1\r\nHost: site.example.com:443\r\n\r\n');
      });
      expect(res).toMatch(/^HTTP\/1\.1 403/);
      expect(proxy.blocked).toEqual([{ host: 'site.example.com', reason: 'site.example.com resolves to private address 192.168.1.20' }]);
    } finally {
      await proxy.close();
    }
    expect(s.resolve4).toHaveBeenCalledWith('site.example.com');
    expect(s.getaddrinfo).not.toHaveBeenCalled();
  });

  it('only the dev allow-list (operator-chosen names, maybe in /etc/hosts) keeps the system resolver', async () => {
    const s = stubResolvers(enodata(), enodata());
    expect(await vetHost('fixture.test', 8080, { allowHosts: ['fixture.test:8080'] })).toMatchObject({ ok: true, allowListed: true, addresses: ['127.0.0.1'] });
    expect(s.getaddrinfo).toHaveBeenCalledTimes(1);
    expect(s.resolve4).not.toHaveBeenCalled();
    // the same name off the allow-list is a user's name: c-ares
    expect(await vetHost('fixture.test', 443, { allowHosts: ['fixture.test:8080'] })).toMatchObject({ ok: false, reason: 'could not resolve fixture.test' });
    expect(s.resolve4).toHaveBeenCalledWith('fixture.test');
    expect(s.getaddrinfo).toHaveBeenCalledTimes(1);
  });
});
