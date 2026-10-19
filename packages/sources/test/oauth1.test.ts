import { describe, expect, it } from 'vitest';
import {
  baseUrl, formBody, hmacSha1, makeNonce, normaliseParams, oauth1Header, parseOAuthHeader, percentEncode, signatureBaseString,
  signRequest, type OAuth1Credentials, type ParamList,
} from '../src/oauth1';

/** X developer docs, "Creating a signature" / "Authorizing a request" */
const DOCS: OAuth1Credentials = {
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
};
const DOCS_NONCE = 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg';
const DOCS_TS = 1318622958;
const STATUS = 'Hello Ladies + Gentlemen, a signed OAuth request!';

describe('oauth1: percent-encoding (RFC 3986)', () => {
  it('matches the X docs examples', () => {
    expect(percentEncode('Ladies + Gentlemen')).toBe('Ladies%20%2B%20Gentlemen');
    expect(percentEncode('An encoded string!')).toBe('An%20encoded%20string%21');
    expect(percentEncode('Dogs, Cats & Mice')).toBe('Dogs%2C%20Cats%20%26%20Mice');
    expect(percentEncode('☃')).toBe('%E2%98%83');
  });

  it('leaves only unreserved characters alone', () => {
    expect(percentEncode('AZaz09-._~')).toBe('AZaz09-._~');
    expect(percentEncode("!*'()")).toBe('%21%2A%27%28%29');
    expect(percentEncode('a/b?c=d&e')).toBe('a%2Fb%3Fc%3Dd%26e');
    expect(percentEncode('🚀')).toBe('%F0%9F%9A%80');
  });
});

describe('oauth1: base string', () => {
  it('base URL: lower-case scheme/host, no default port, no query or fragment', () => {
    expect(baseUrl('HTTPS://API.X.com:443/2/tweets?x=1#frag')).toBe('https://api.x.com/2/tweets');
    expect(baseUrl('http://Example.com:80/r%20v/X?id=123')).toBe('http://example.com/r%20v/X');
    expect(baseUrl('https://www.example.net:8080/?q=1')).toBe('https://www.example.net:8080/');
  });

  it('RFC 5849 §3.4.1 example: duplicate names sorted by value, empty values kept', () => {
    // POST /request?b5=%3D%253D&a3=a&c%40=&a2=r%20b  body: c2&a3=2+q
    const params: ParamList = [
      ['b5', '=%3D'], ['a3', 'a'], ['c@', ''], ['a2', 'r b'], ['c2', ''], ['a3', '2 q'],
      ['oauth_consumer_key', '9djdj82h48djs9d2'], ['oauth_token', 'kkk9d7dh3k39sjv7'], ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '137131201'], ['oauth_nonce', '7d8f3e4a'],
    ];
    expect(normaliseParams(params)).toBe(
      'a2=r%20b&a3=2%20q&a3=a&b5=%3D%253D&c%40=&c2=&oauth_consumer_key=9djdj82h48djs9d2&oauth_nonce=7d8f3e4a' +
        '&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201&oauth_token=kkk9d7dh3k39sjv7',
    );
    expect(signatureBaseString('post', 'http://example.com/request', params)).toBe(
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D' +
        '%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1' +
        '%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7',
    );
  });
});

describe('oauth1: X documented signature vectors', () => {
  it('"Creating a signature": base string, signing key and signature (1.1 URL)', () => {
    const r = signRequest(DOCS, {
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
      form: { status: STATUS },
      nonce: DOCS_NONCE,
      timestamp: DOCS_TS,
    });
    expect(r.baseString).toBe(
      'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog' +
        '%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958' +
        '%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0' +
        '%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
    );
    expect(r.signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
    // signing key = consumerSecret&tokenSecret
    expect(hmacSha1(r.baseString, DOCS.consumerSecret, DOCS.tokenSecret)).toBe(r.signature);
  });

  it('"Authorizing a request": oauth_signature tnnArxj06cWHq44gCs1OSKk/jLY= and the exact header', () => {
    // That page's example was signed against the v1 path; the same inputs reproduce its signature exactly.
    const header = oauth1Header(DOCS, {
      method: 'POST',
      url: 'https://api.twitter.com/1/statuses/update.json?include_entities=true',
      form: [['status', STATUS]],
      nonce: DOCS_NONCE,
      timestamp: String(DOCS_TS),
    });
    expect(parseOAuthHeader(header).oauth_signature).toBe('tnnArxj06cWHq44gCs1OSKk/jLY=');
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
        'oauth_signature="tnnArxj06cWHq44gCs1OSKk%2FjLY%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", ' +
        'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });

  it('the form body that is signed is the RFC 3986 encoding of the same fields', () => {
    expect(formBody({ status: STATUS })).toBe('status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21');
  });
});

describe('oauth1: X API v2 calls (vectors from an independent implementation, Python oauthlib 3.2.2)', () => {
  const creds: OAuth1Credentials = { consumerKey: 'ck', consumerSecret: 'cs', token: 'tok', tokenSecret: 'ts' };
  const sig = (method: string, url: string) => signRequest(creds, { method, url, nonce: 'abc123', timestamp: 1700000000 }).signature;

  it('GET with a query: every query param is signed, however the URL spells it', () => {
    const encoded =
      'https://api.x.com/2/users/42/mentions?since_id=10&max_results=100&expansions=author_id%2Creferenced_tweets.id' +
      '&tweet.fields=created_at%2Centities&pagination_token=7140dibdnow9c7btw4b0u';
    expect(sig('GET', encoded)).toBe('fmJNBhyxxggv6xWnfmipWegE+Yo=');
    expect(sig('GET', encoded.replace(/%2C/g, ','))).toBe('fmJNBhyxxggv6xWnfmipWegE+Yo=');
  });

  it('GET media STATUS and users/me', () => {
    expect(sig('GET', 'https://api.x.com/2/media/upload?command=STATUS&media_id=1880028106020515840')).toBe('C5Cb9TjSS97vS2lI/dn/aJnDdLA=');
    expect(sig('GET', 'https://api.x.com/2/users/me')).toBe('uimXy9Qdii6K2EvapXn7enquSWc=');
  });

  it('POST with a JSON or multipart body signs only the oauth_* params', () => {
    expect(sig('POST', 'https://api.x.com/2/tweets')).toBe('sUCc3MnMPvRprFXmbN6ccABSFJc=');
    expect(sig('POST', 'https://api.x.com/2/media/upload/initialize')).toBe('MH7xgtMLP8YjzHwxUQirhLKZCMc=');
    expect(sig('POST', 'https://api.x.com/2/media/upload/1880028106020515840/append')).toBe('7iZ0eLAaXwvV9dH1PJiiRK8Rn/U=');
  });

  it('defaults: random 32-char alphanumeric nonce, current timestamp, header round-trips', () => {
    const a = makeNonce();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(makeNonce()).not.toBe(a);
    const r = signRequest(creds, { method: 'GET', url: 'https://api.x.com/2/users/me' });
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(Number(r.oauth.oauth_timestamp) - now)).toBeLessThanOrEqual(2);
    expect(parseOAuthHeader(r.authorization)).toEqual(r.oauth);
    expect(Object.keys(parseOAuthHeader(r.authorization)).sort()).toEqual([
      'oauth_consumer_key', 'oauth_nonce', 'oauth_signature', 'oauth_signature_method', 'oauth_timestamp', 'oauth_token', 'oauth_version',
    ]);
  });
});
