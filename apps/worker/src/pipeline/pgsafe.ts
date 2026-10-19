/**
 * Postgres refuses U+0000 in text columns (22021) and in jsonb (22P05 "\u0000 cannot be converted to text"),
 * and a lone UTF-16 surrogate can't be encoded at all. Strings from the checked page (console errors, dialogs,
 * titles, button labels, visible text) and from third parties (DexScreener names, X text, GitHub) can carry
 * either, so everything the worker writes goes through pgSafe() first: one bad character must never cancel a
 * verdict.
 */
const NUL_RE = /\u0000/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One string, safe for a Postgres text/jsonb value: NUL removed, lone surrogates → U+FFFD. */
export function pgText(s: string): string {
  return s.replace(NUL_RE, '').replace(LONE_SURROGATE_RE, '�');
}

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Deep copy of `v` with every string (values and keys of plain objects, array items) made pgText-safe.
 * Dates, Buffers, Decimals and other class instances are kept as they are.
 */
export function pgSafe<T>(v: T): T {
  if (typeof v === 'string') return pgText(v) as T;
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => pgSafe(x)) as T;
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[pgText(k)] = pgSafe(x);
  return out as T;
}
