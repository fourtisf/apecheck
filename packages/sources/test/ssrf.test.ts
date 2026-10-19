import { afterEach, describe, expect, it, vi } from 'vitest';
import { SsrfError, assertPublicUrl, checkUrl, ipBlockReason, isBlockedIp, vetHost } from '../src/ssrf';

const noDns = vi.fn(async (_host: string): Promise<string[]> => {
  throw new Error('lookup must not be called for this input');
});
const resolvesTo = (...ips: string[]) => vi.fn(async (_host: string) => ips);

afterEach(() => {
  vi.unstubAllEnvs();
  noDns.mockClear();
});

describe('isBlockedIp — IPv4 ranges', () => {
  const blocked: [string, RegExp][] = [
    ['0.0.0.0', /reserved/],
    ['0.255.1.2', /reserved/],
    ['10.0.0.5', /^private address 10\.0\.0\.5$/],
    ['10.255.255.255', /private/],
    ['100.64.0.1', /CGNAT/],
    ['100.127.255.254', /CGNAT/],
    ['100.100.100.200', /CGNAT/], // Alibaba metadata
    ['127.0.0.1', /loopback/],
    ['127.255.255.254', /loopback/],
    ['169.254.169.254', /link-local/],
    ['172.16.0.1', /private/],
    ['172.31.255.255', /private/],
    ['192.0.0.8', /reserved/],
    ['192.0.2.1', /documentation/],
    ['192.168.1.1', /private/],
    ['198.18.0.1', /benchmarking/],
    ['198.19.255.255', /benchmarking/],
    ['198.51.100.7', /documentation/],
    ['203.0.113.9', /documentation/],
    ['224.0.0.1', /multicast/],
    ['239.255.255.250', /multicast/],
    ['240.0.0.1', /reserved/],
    ['255.255.255.254', /reserved/],
    ['255.255.255.255', /reserved|broadcast/],
  ];
  it.each(blocked)('%s is blocked', (ip, reason) => {
    expect(isBlockedIp(ip)).toBe(true);
    expect(ipBlockReason(ip)).toMatch(reason);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '198.17.255.255', '198.20.0.0', '192.0.1.1', '192.169.0.1', '11.0.0.1', '223.255.255.255'])(
    '%s is public',
    ip => {
      expect(isBlockedIp(ip)).toBe(false);
      expect(ipBlockReason(ip)).toBeNull();
    },
  );

  it('alternative IPv4 spellings are normalised before checking', () => {
    for (const s of ['2130706433', '0177.0.0.1', '0x7f000001', '127.1', '0x7f.1', '017700000001']) {
      expect(isBlockedIp(s), s).toBe(true);
    }
    expect(ipBlockReason('2130706433')).toBe('loopback address 127.0.0.1');
    expect(ipBlockReason('0xa9fea9fe')).toBe('link-local address 169.254.169.254');
  });

  it('non-IP input fails closed', () => {
    expect(isBlockedIp('example.com')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });
});

describe('isBlockedIp — IPv6 ranges', () => {
  it.each([
    ['::', /unspecified/],
    ['::1', /loopback/],
    ['[::1]', /loopback/],
    ['fc00::1', /private/],
    ['fd00:ec2::254', /private/], // AWS IMDS over IPv6
    ['fdff:ffff::1', /private/],
    ['fe80::1', /link-local/],
    ['fe80::1%eth0', /link-local/],
    ['febf::1', /link-local/],
    ['ff02::1', /multicast/],
    ['2001:db8::1', /documentation/],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', /Teredo/],
    ['64:ff9b:1::a00:1', /NAT64/],
  ])('%s is blocked', (ip, reason) => {
    expect(isBlockedIp(ip)).toBe(true);
    expect(ipBlockReason(ip)).toMatch(reason);
  });

  it('IPv4-mapped and other embedded IPv4 forms get the IPv4 rules', () => {
    expect(ipBlockReason('::ffff:127.0.0.1')).toMatch(/loopback .*IPv4-mapped 127\.0\.0\.1/);
    expect(ipBlockReason('::ffff:7f00:1')).toMatch(/loopback/);
    expect(ipBlockReason('::ffff:10.0.0.1')).toMatch(/private/);
    expect(ipBlockReason('::ffff:169.254.169.254')).toMatch(/link-local/);
    expect(ipBlockReason('::ffff:a9fe:a9fe')).toMatch(/link-local/);
    expect(ipBlockReason('64:ff9b::a00:1')).toMatch(/private .*NAT64 10\.0\.0\.1/);
    expect(ipBlockReason('64:ff9b::7f00:1')).toMatch(/loopback/);
    expect(ipBlockReason('2002:c0a8:0101::1')).toMatch(/private .*6to4 192\.168\.1\.1/);
    expect(ipBlockReason('::127.0.0.1')).toMatch(/loopback .*IPv4-compatible/);
    expect(ipBlockReason('::ffff:0:a00:1')).toMatch(/private/);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1'])('%s is public', ip => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('checkUrl', () => {
  it('refuses non-http(s) schemes', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'data:text/html,hi', 'javascript:alert(1)', 'ws://example.com/', 'chrome://settings']) {
      const c = await checkUrl(u, { lookup: noDns });
      expect(c.ok, u).toBe(false);
      expect(c.reason, u).toMatch(/^blocked scheme /);
    }
    expect(noDns).not.toHaveBeenCalled();
  });

  it('refuses invalid URLs', async () => {
    expect(await checkUrl('not a url')).toEqual({ ok: false, reason: 'invalid URL' });
  });

  it('refuses private IP literals in every spelling without resolving', async () => {
    for (const u of [
      'http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.1:8080/',
      'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'https://10.1.2.3/x', 'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200/', 'http://[fd00:ec2::254]/', 'http://0.0.0.0:3000/', 'http://[64:ff9b::a9fe:a9fe]/',
    ]) {
      const c = await checkUrl(u, { lookup: noDns });
      expect(c.ok, u).toBe(false);
      expect(c.reason, u).toMatch(/address/);
    }
    expect(noDns).not.toHaveBeenCalled();
  });

  it('refuses metadata and local host names without resolving', async () => {
    const cases: [string, RegExp][] = [
      ['http://metadata.google.internal/computeMetadata/v1/', /metadata host/],
      ['http://metadata.google.internal./', /metadata host/],
      ['http://METADATA/', /metadata host/],
      ['http://metadata.azure.com/', /metadata host/],
      ['http://instance-data/', /metadata host/],
      ['http://instance-data.ec2.internal/', /metadata host/],
      ['http://localhost:3000/', /local host name localhost/],
      ['http://LOCALHOST./', /local host name/],
      ['http://api.localhost/', /local host name/],
      ['http://db.internal/', /local host name/],
      ['http://printer.local/', /local host name/],
      ['http://intranet/', /single-label/],
    ];
    for (const [u, reason] of cases) {
      const c = await checkUrl(u, { lookup: noDns });
      expect(c.ok, u).toBe(false);
      expect(c.reason, u).toMatch(reason);
    }
    expect(noDns).not.toHaveBeenCalled();
  });

  it('host strings with userinfo/path characters are refused (CONNECT authority confusion)', async () => {
    for (const h of ['evil.example@127.0.0.1', 'evil.example/x', 'a b', 'x?y', 'x#y', 'evil\\127.0.0.1']) {
      expect(await vetHost(h, 443, { lookup: noDns }), h).toMatchObject({ ok: false, reason: 'invalid host' });
    }
    expect(noDns).not.toHaveBeenCalled();
  });

  it('blocks a public-looking name that resolves to a private address', async () => {
    const c = await checkUrl('https://evil.example/', { lookup: resolvesTo('10.0.0.7') });
    expect(c).toMatchObject({ ok: false, reason: 'evil.example resolves to private address 10.0.0.7' });
  });

  it('blocks when ANY resolved address is private (A + AAAA)', async () => {
    const c = await checkUrl('https://mixed.example/', { lookup: resolvesTo('93.184.215.14', '::1') });
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/loopback address ::1/);
  });

  it('blocks a name resolving to an IPv4-mapped private address', async () => {
    const c = await checkUrl('https://mapped.example/', { lookup: resolvesTo('::ffff:192.168.0.10') });
    expect(c.ok).toBe(false);
  });

  it('passes a public name and returns the vetted addresses for pinning', async () => {
    const lookup = resolvesTo('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c');
    const c = await checkUrl('https://Example.COM/path?q=1', { lookup });
    expect(c.ok).toBe(true);
    expect(c.addresses).toEqual(['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
    expect(c.url?.href).toBe('https://example.com/path?q=1');
    expect(lookup).toHaveBeenCalledWith('example.com');
  });

  it('DNS failure is blocked ("could not resolve") unless allowUnresolved is set', async () => {
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    expect(await checkUrl('https://nope.example/', { lookup: failing })).toMatchObject({ ok: false, reason: 'could not resolve nope.example' });
    expect(await checkUrl('https://empty.example/', { lookup: resolvesTo() })).toMatchObject({ ok: false, reason: 'could not resolve empty.example' });
    const v = await vetHost('nope.example', 443, { lookup: failing, allowUnresolved: true });
    expect(v).toMatchObject({ ok: true, unresolved: true, addresses: [] });
    // allowUnresolved never lets a blocked literal or local name through
    expect((await vetHost('10.0.0.1', 443, { allowUnresolved: true })).ok).toBe(false);
    expect((await vetHost('localhost', 80, { allowUnresolved: true })).ok).toBe(false);
  });

  describe('allowHosts (dev/test only)', () => {
    it('lets a listed host:port through in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const opts = { allowHosts: ['localhost:4555', '127.0.0.1'], lookup: resolvesTo('127.0.0.1') };
      expect(await checkUrl('http://localhost:4555/fixture', opts)).toMatchObject({ ok: true, addresses: ['127.0.0.1'] });
      expect((await checkUrl('http://localhost:4556/', opts)).ok).toBe(false); // other port
      expect((await checkUrl('http://127.0.0.1:9999/', opts)).ok).toBe(true); // host-only entry: any port
      expect((await checkUrl('http://0x7f000001:9999/', opts)).ok).toBe(true); // same host, other spelling
    });

    it('is ignored when NODE_ENV=production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const c = await checkUrl('http://localhost:4555/', { allowHosts: ['localhost:4555'], lookup: resolvesTo('127.0.0.1') });
      expect(c).toMatchObject({ ok: false, reason: 'local host name localhost' });
      expect((await checkUrl('http://127.0.0.1/', { allowHosts: ['127.0.0.1'] })).ok).toBe(false);
    });

    it('is ignored when the caller says production', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const c = await checkUrl('http://127.0.0.1:4555/', { allowHosts: ['127.0.0.1:4555'], production: true });
      expect(c.ok).toBe(false);
    });
  });
});

describe('assertPublicUrl', () => {
  it('returns the parsed URL or throws SsrfError with the reason', async () => {
    await expect(assertPublicUrl('https://kairo.xyz/', { lookup: resolvesTo('104.21.3.4') })).resolves.toBeInstanceOf(URL);
    const err = await assertPublicUrl('http://169.254.169.254/latest/meta-data/').catch(e => e);
    expect(err).toBeInstanceOf(SsrfError);
    expect(err.reason).toBe('link-local address 169.254.169.254');
    expect(err.message).toBe('Blocked by SSRF guard: link-local address 169.254.169.254');
  });
});
