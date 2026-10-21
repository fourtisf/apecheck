/**
 * Project links from token metadata: normalising X handles and project websites, and merging what DexScreener,
 * the token's own metadata JSON and GeckoTerminal say, field by field (priority DexScreener > token metadata >
 * GeckoTerminal).
 *
 * Not a "project website" (rejected): launchpads (pump.fun, letsbonk.fun / bonk.fun, moonshot, believe.app…),
 * explorers (solscan, etherscan & co), trading aggregators and terminals (dexscreener, gmgn, birdeye, geckoterminal,
 * coingecko, photon…), socials and chat (x.com, t.me, discord, youtube…), and link-in-bio hubs (linktr.ee and
 * similar): a link hub is the project's own page but has no copy to pull claims from, and browsing it would only
 * lead back to the socials; the real site, if any, is usually listed in the metadata too. IPFS / Arweave
 * gateways are rejected as well (that is where the logo and the metadata JSON live, not a site).
 */
import { NON_PROJECT_HOSTS, X_RESERVED, normalizeDomain } from '@apecheck/core';
import type { LinkSource, MergedTokenLinks, TokenLinks } from './types';

/** Hosts that are never a project's own website, beyond core's NON_PROJECT_HOSTS. */
export const NOT_PROJECT_SITES: readonly string[] = [
  ...NON_PROJECT_HOSTS,
  // launchpads
  'pump.fun', 'letsbonk.fun', 'bonk.fun', 'moonshot.money', 'moonshot.com', 'believe.app', 'boop.fun', 'four.meme', 'sunpump.meme',
  'clanker.world', 'zora.co', 'virtuals.io', 'daos.fun', 'heaven.xyz', 'launchlab.raydium.io', 'meteora.ag', 'bags.fm',
  // explorers
  'solscan.io', 'solana.fm', 'explorer.solana.com', 'etherscan.io', 'bscscan.com', 'basescan.org', 'arbiscan.io', 'tronscan.org',
  'blockscout.com', 'debank.com',
  // aggregators / terminals
  'dexscreener.com', 'dextools.io', 'gmgn.ai', 'birdeye.so', 'geckoterminal.com', 'coingecko.com', 'coinmarketcap.com', 'photon-sol.tinyastro.io',
  'bullx.io', 'axiom.trade', 'defined.fi', 'jup.ag', 'rugcheck.xyz', 'solsniffer.com', 'dexview.com', 'ave.ai', 'poocoin.app',
  // socials / chat / link hubs
  'x.com', 'twitter.com', 't.me', 'telegram.me', 'telegram.org', 'discord.gg', 'discord.com', 'warpcast.com', 'farcaster.xyz',
  'youtube.com', 'tiktok.com', 'instagram.com', 'facebook.com', 'reddit.com', 'medium.com', 'linktr.ee', 'link3.to', 'bio.link',
  'solo.to', 'beacons.ai', 'lnk.bio',
  // storage gateways
  'ipfs.io', 'cf-ipfs.com', 'gateway.pinata.cloud', 'nftstorage.link', 'dweb.link', 'arweave.net', 'irys.xyz',
];

function notProjectHost(host: string): boolean {
  const h = normalizeDomain(host);
  return NOT_PROJECT_SITES.some(s => h === s || h.endsWith('.' + s));
}

/** X paths that are not a profile (core X_RESERVED plus share/intent/community paths). */
const NOT_HANDLES = new Set([...X_RESERVED, 'intent', 'share', 'hashtag', 'search', 'home', 'i', 'communities', 'status', 'statuses', 'web']);
const RE_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOST = /^(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com$/i;

/**
 * The X handle in a profile link or "@handle" (a bare handle is accepted too). A post link (/status/) is a
 * post, not a profile: null. So are intent/share/search/home links and anything that is not on x.com/twitter.com.
 */
export function xHandleOf(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const bare = s.replace(/^@/, '');
  if (!/[/.:]/.test(bare)) return RE_HANDLE.test(bare) && !NOT_HANDLES.has(bare.toLowerCase()) ? bare : null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !X_HOST.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  const h = parts[0].replace(/^@/, '');
  return RE_HANDLE.test(h) && !NOT_HANDLES.has(h.toLowerCase()) ? h : null;
}

/** ipfs:// and ar:// through a public gateway; http(s) as is; anything else null. */
export function gatewayUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2000) return null;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(s);
  if (ipfs) return `https://ipfs.io/ipfs/${ipfs[1]}`;
  const ar = /^ar:\/\/(.+)$/i.exec(s);
  if (ar) return `https://arweave.net/${ar[1]}`;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A project website as an absolute http(s) URL; null for launchpads, explorers, aggregators, socials and link hubs. */
export function projectWebsiteOf(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2000 || /\s/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = normalizeDomain(u.hostname);
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
  if (notProjectHost(host)) return null;
  return u.href;
}

/** t.me / telegram.me link (or a bare handle) → https://t.me/<name> */
export function telegramUrlOf(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^@/, '');
  if (/^[A-Za-z0-9_]{4,64}$/.test(s)) return `https://t.me/${s}`;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = normalizeDomain(u.hostname);
    if (host !== 't.me' && host !== 'telegram.me') return null;
    const name = u.pathname.split('/').filter(Boolean)[0];
    return name && /^[A-Za-z0-9_+-]{2,64}$/.test(name) ? `https://t.me/${name}` : null;
  } catch {
    return null;
  }
}

/** discord.gg / discord.com invite link */
export function discordUrlOf(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    const host = normalizeDomain(u.hostname);
    if (host !== 'discord.gg' && host !== 'discord.com') return null;
    return u.pathname.length > 1 ? `https://${host}${u.pathname}` : null;
  } catch {
    return null;
  }
}

/** An image URL worth downloading: http(s) (ipfs:// / ar:// through a gateway), not a data: URL or a placeholder. */
export function imageUrlOf(raw: string | null | undefined): string | null {
  const u = gatewayUrl(raw);
  if (!u) return null;
  if (/\/missing(?:_\w+)?\.png(?:$|\?)/i.test(u)) return null;
  return u;
}

/** The links one source gave for a token, empty. */
export function emptyLinks(): TokenLinks {
  return { websites: [], twitter: [], telegram: [], discord: [], image: null, description: null, name: null, symbol: null };
}

/**
 * DexScreener's token info as TokenLinks (websites, socials by type, image), for mergeTokenLinks.
 * A pair without "Enhanced Token Info" gives empty lists.
 */
export function linksFromDex(info: { websites?: string[] | null; socials?: { type: string; url: string }[] | null; imageUrl?: string | null } | null | undefined): TokenLinks | null {
  if (!info) return null;
  const out = emptyLinks();
  out.websites = [...(info.websites ?? [])];
  for (const s of info.socials ?? []) {
    const t = s.type.toLowerCase();
    if (t === 'twitter' || t === 'x') out.twitter.push(s.url);
    else if (t === 'telegram') out.telegram.push(s.url);
    else if (t === 'discord') out.discord.push(s.url);
  }
  out.image = info.imageUrl ?? null;
  return out;
}

/**
 * Per field, the first valid value in priority order (the sources as given: DexScreener, token metadata,
 * GeckoTerminal). Every value is normalised; rejected ones are skipped, so a launchpad page from DexScreener
 * never hides a real site from the metadata.
 */
export function mergeTokenLinks(sources: { source: LinkSource; links: TokenLinks | null | undefined }[]): MergedTokenLinks {
  const out: MergedTokenLinks = { website: null, x: null, telegram: null, discord: null, image: null };
  for (const { source, links } of sources) {
    if (!links) continue;
    if (!out.website) {
      for (const w of links.websites) {
        const url = projectWebsiteOf(w);
        if (url) {
          out.website = { url, source };
          break;
        }
      }
    }
    if (!out.x) {
      for (const t of links.twitter) {
        const handle = xHandleOf(t);
        if (handle) {
          out.x = { handle, source };
          break;
        }
      }
    }
    if (!out.telegram) {
      const url = links.telegram.map(telegramUrlOf).find(Boolean);
      if (url) out.telegram = { url, source };
    }
    if (!out.discord) {
      const url = links.discord.map(discordUrlOf).find(Boolean);
      if (url) out.discord = { url, source };
    }
    if (!out.image) {
      const url = imageUrlOf(links.image);
      if (url) out.image = { url, source };
    }
  }
  return out;
}
