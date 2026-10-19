import { describe, expect, it } from 'vitest';
import { detect, detectChipLabel, extractRefs, normalizeDomain, parseXPost, targetKey, isNonProjectHost } from '../src/detect';

const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const EVM = '0x4200000000000000000000000000000000000006';
const TRX = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

describe('detect (same rules as the prototype)', () => {
  it('empty → null (chip shows Auto)', () => {
    expect(detect('')).toBeNull();
    expect(detect('   ')).toBeNull();
    expect(detectChipLabel('')).toEqual({ text: 'Auto', on: false });
  });
  it('X post links', () => {
    expect(detect('https://x.com/kairolabs/status/1846629381234567890')).toMatchObject({ kind: 'xpost', label: 'X post', handle: 'kairolabs', postId: '1846629381234567890' });
    expect(detect('twitter.com/Foo_Bar/status/123')).toMatchObject({ kind: 'xpost', handle: 'Foo_Bar', postId: '123' });
    expect(detect('https://mobile.twitter.com/abc/status/42?s=20')).toMatchObject({ kind: 'xpost', postId: '42' });
    expect(detect('https://x.com/i/web/status/777')).toMatchObject({ kind: 'xpost', handle: null, postId: '777' });
    expect(detect('https://fxtwitter.com/abc/status/9')).toMatchObject({ kind: 'xpost', postId: '9' });
  });
  it('X profile links are an X account (no post id)', () => {
    expect(detect('https://x.com/kairolabs')).toMatchObject({ kind: 'xpost', label: 'X account', handle: 'kairolabs', postId: null });
    expect(detect('x.com/home')).toMatchObject({ kind: 'site' });
  });
  it('contracts', () => {
    expect(detect(EVM)).toMatchObject({ kind: 'evm', label: 'EVM CA', address: EVM.toLowerCase() });
    expect(detect('0xABCDEF0123456789abcdef0123456789ABCDEF01')).toMatchObject({ kind: 'evm', address: '0xabcdef0123456789abcdef0123456789abcdef01' });
    expect(detect(TRX)).toMatchObject({ kind: 'tron', label: 'Tron CA', address: TRX });
    expect(detect(SOL)).toMatchObject({ kind: 'sol', label: 'Solana CA', address: SOL });
    expect(detect(`  ${SOL}  `)).toMatchObject({ kind: 'sol' });
  });
  it('websites', () => {
    expect(detect('orbitswap.xyz')).toMatchObject({ kind: 'site', label: 'Website', domain: 'orbitswap.xyz', url: 'https://orbitswap.xyz' });
    expect(detect('https://www.LumenPad.ai/app?x=1')).toMatchObject({ kind: 'site', domain: 'lumenpad.ai' });
    expect(detect('app.helixdex.app/swap')).toMatchObject({ kind: 'site', domain: 'app.helixdex.app' });
  });
  it('aggregator links resolve to the coin they point at', () => {
    expect(detect(`https://pump.fun/coin/${SOL}`)).toMatchObject({ kind: 'sol', address: SOL });
    expect(detect(`https://dexscreener.com/base/${EVM}`)).toMatchObject({ kind: 'evm', address: EVM.toLowerCase() });
    expect(detect('https://dexscreener.com/')).toMatchObject({ kind: 'site', domain: 'dexscreener.com' });
  });
  it('garbage is bad (chip shows Unknown)', () => {
    for (const v of ['hello', '@kairolabs', '$ORBIT', '0x123', 'localhost', '127.0.0.1', 'http://', 'not a url at all']) {
      expect(detect(v)).toEqual({ kind: 'bad' });
    }
    expect(detectChipLabel('hello')).toEqual({ text: 'Unknown', on: false });
    expect(detectChipLabel(SOL)).toEqual({ text: 'Solana CA', on: true });
  });
});

describe('keys and parsing', () => {
  it('target keys', () => {
    expect(targetKey(detect(EVM) as never)).toBe(`ca:evm:${EVM.toLowerCase()}`);
    expect(targetKey(detect(EVM) as never, 'base')).toBe(`ca:base:${EVM.toLowerCase()}`);
    expect(targetKey(detect(SOL) as never)).toBe(`ca:sol:${SOL}`);
    expect(targetKey(detect(TRX) as never)).toBe(`ca:trx:${TRX}`);
    expect(targetKey(detect('www.Orbit.xyz') as never)).toBe('site:orbit.xyz');
    expect(targetKey(detect('x.com/a/status/5') as never)).toBe('post:5');
    expect(targetKey(detect('x.com/KairoLabs') as never)).toBe('x:kairolabs');
  });
  it('normalizeDomain', () => {
    expect(normalizeDomain('HTTPS://www.Foo.xyz:8080/a?b')).toBe('foo.xyz');
    expect(normalizeDomain('foo.xyz.')).toBe('foo.xyz');
  });
  it('parseXPost', () => {
    expect(parseXPost('see https://x.com/abc/status/123 here')).toEqual({ handle: 'abc', postId: '123' });
    expect(parseXPost('nothing')).toBeNull();
  });
  it('isNonProjectHost', () => {
    expect(isNonProjectHost('t.me')).toBe(true);
    expect(isNonProjectHost('docs.github.com')).toBe(true);
    expect(isNonProjectHost('orbit.xyz')).toBe(false);
  });
});

describe('extractRefs', () => {
  it('pulls links, cashtags, handles and contract addresses out of a post', () => {
    const text = `$ORBIT is live on Base 🚀 trade at https://orbitswap.xyz/app, docs: docs.orbitswap.xyz
CA: ${EVM} also on sol ${SOL} cc @kairolabs @ApeCheckBot. Join t.me/orbit and https://x.com/orbit/status/99`;
    const r = extractRefs(text);
    expect(r.cashtags).toEqual(['ORBIT']);
    expect(r.evm).toEqual([EVM.toLowerCase()]);
    expect(r.sol).toEqual([SOL]);
    expect(r.handles).toEqual(['kairolabs', 'ApeCheckBot']);
    expect(r.domains).toContain('orbitswap.xyz');
    expect(r.domains).toContain('docs.orbitswap.xyz');
    expect(r.domains).not.toContain('t.me');
    expect(r.domains).not.toContain('x.com');
    expect(r.xPosts).toEqual([{ handle: 'orbit', postId: '99' }]);
    expect(r.urls[0]).toBe('https://orbitswap.xyz/app');
  });
  it('does not mistake English words for Solana mints', () => {
    expect(extractRefs('Thisisaverylongsentencewithoutspacesatall okay').sol).toEqual([]);
  });
  it('finds Tron addresses without double-counting them as Solana', () => {
    const r = extractRefs(`tron ca ${TRX}`);
    expect(r.tron).toEqual([TRX]);
    expect(r.sol).toEqual([]);
  });
});
