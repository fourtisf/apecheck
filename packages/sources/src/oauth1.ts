/**
 * OAuth 1.0a request signing, HMAC-SHA1 (RFC 5849 §3), for X API user-context calls (the bot).
 *
 * The signature base string is METHOD & base URL & the sorted parameters, where the parameters are the
 * URL query, the oauth_* protocol parameters and — only for application/x-www-form-urlencoded bodies — the
 * form fields. JSON and multipart bodies are never part of the signature (RFC 5849 §3.4.1.3.1).
 */
import { createHmac, randomBytes } from 'node:crypto';

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export type ParamList = [string, string][];

export interface OAuth1Request {
  method: string;
  /** full URL; its query string is signed */
  url: string;
  /** fields of an application/x-www-form-urlencoded body (signed); leave out for JSON / multipart bodies */
  form?: Record<string, string> | ParamList;
  /** fixed values for tests; random / now by default */
  nonce?: string;
  timestamp?: number | string;
}

/** RFC 3986 percent-encoding (unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"), UTF-8, upper-case hex. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** application/x-www-form-urlencoded parsing ('+' is a space), as RFC 5849 §3.4.1.3.1 asks for the query. */
function decodeForm(s: string): ParamList {
  const out: ParamList = [];
  for (const [k, v] of new URLSearchParams(s)) out.push([k, v]);
  return out;
}

/** Scheme and host lower-cased, default port dropped, no query or fragment (RFC 5849 §3.4.1.2). */
export function baseUrl(url: string | URL): string {
  const u = new URL(String(url));
  const scheme = u.protocol.toLowerCase();
  const defaultPort = (scheme === 'http:' && u.port === '80') || (scheme === 'https:' && u.port === '443');
  const host = u.hostname.toLowerCase() + (u.port && !defaultPort ? `:${u.port}` : '');
  return `${scheme}//${host}${u.pathname || '/'}`;
}

/** Normalised parameter string (RFC 5849 §3.4.1.3.2): encode, sort by name then value, join. */
export function normaliseParams(params: ParamList): string {
  return params
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function signatureBaseString(method: string, url: string, params: ParamList): string {
  return [method.toUpperCase(), percentEncode(baseUrl(url)), percentEncode(normaliseParams(params))].join('&');
}

export function hmacSha1(baseString: string, consumerSecret: string, tokenSecret: string): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac('sha1', key).update(baseString).digest('base64');
}

/** 32 random alphanumeric characters. */
export function makeNonce(): string {
  return randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, '0');
}

/** The oauth_* protocol parameters (without the signature) for one request. */
export function protocolParams(creds: OAuth1Credentials, nonce?: string, timestamp?: number | string): Record<string, string> {
  return {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce ?? makeNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
}

export interface SignedRequest {
  /** the value for the Authorization header: OAuth oauth_consumer_key="…", … */
  authorization: string;
  oauth: Record<string, string>;
  baseString: string;
  signature: string;
}

export function signRequest(creds: OAuth1Credentials, req: OAuth1Request): SignedRequest {
  const oauth = protocolParams(creds, req.nonce, req.timestamp);
  const u = new URL(req.url);
  const form: ParamList = !req.form ? [] : Array.isArray(req.form) ? req.form : Object.entries(req.form);
  const params: ParamList = [...decodeForm(u.search.slice(1)), ...Object.entries(oauth), ...form];
  const baseString = signatureBaseString(req.method, req.url, params);
  const signature = hmacSha1(baseString, creds.consumerSecret, creds.tokenSecret);
  const signed = { ...oauth, oauth_signature: signature };
  const authorization =
    'OAuth ' +
    Object.keys(signed)
      .sort()
      .map(k => `${percentEncode(k)}="${percentEncode(signed[k as keyof typeof signed])}"`)
      .join(', ');
  return { authorization, oauth: signed, baseString, signature };
}

/** Authorization header value for one request. */
export function oauth1Header(creds: OAuth1Credentials, req: OAuth1Request): string {
  return signRequest(creds, req).authorization;
}

/** Parse an `OAuth k="v", …` header back into its (decoded) parameters (tests, logs). */
export function parseOAuthHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^OAuth\s+/i, '').matchAll(/([^\s=,]+)="([^"]*)"/g)) out[decodeURIComponent(m[1])] = decodeURIComponent(m[2]);
  return out;
}

/** application/x-www-form-urlencoded body with RFC 3986 encoding (the form that signRequest signs). */
export function formBody(form: Record<string, string> | ParamList): string {
  const list = Array.isArray(form) ? form : Object.entries(form);
  return list.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join('&');
}
