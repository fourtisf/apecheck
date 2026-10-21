/**
 * GeckoTerminal probe: the token info read every coin check makes for its website / X / logo (no key). Optional:
 * DexScreener and the token's own metadata still give links, so a failure is a WARN, never a FAIL.
 */
import { captureErrors, GECKOTERMINAL_BASE, type TokenLinksSource } from '@apecheck/sources';
import { hostOf } from './redact';
import { networkRemedy, pass, warn, type ProbeOutcome } from './result';

/** PEPE on Ethereum: GeckoTerminal has had its token info for years */
export const GECKO_PROBE_TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';

export const GECKOTERMINAL_REMEDY =
  'optional, no key needed: allow outbound HTTPS from user apecheck to api.geckoterminal.com:443 (free tier: about 30 requests a minute)';

export async function probeGeckoTerminal(deps: { tokenLinks?: Pick<TokenLinksSource, 'gecko'> }): Promise<ProbeOutcome> {
  const host = hostOf(GECKOTERMINAL_BASE);
  if (!deps.tokenLinks) return warn(`${host}: token links source not wired`, GECKOTERMINAL_REMEDY);
  const r = await captureErrors(() => deps.tokenLinks!.gecko('eth', GECKO_PROBE_TOKEN));
  const t = r.value;
  if (!t) {
    const msg = r.errors[0] ?? 'answered without token info for PEPE';
    const remedy = /HTTP 429/.test(msg) ? 'GeckoTerminal rate-limits this IP (about 30 requests a minute): it clears by itself' : networkRemedy(msg, host) ?? GECKOTERMINAL_REMEDY;
    return warn(`${host}: ${msg} (coins fall back to DexScreener and their own metadata for links and logos)`, remedy);
  }
  const bits = [t.symbol ? `symbol ${t.symbol}` : null, t.websites.length ? `${t.websites.length} website(s)` : null, t.twitter.length ? 'X handle' : null, t.image ? 'image' : null].filter(Boolean);
  return pass(`${host}: PEPE token info${bits.length ? `, ${bits.join(', ')}` : ''}`);
}
