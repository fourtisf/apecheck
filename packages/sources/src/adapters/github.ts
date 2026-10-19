/**
 * GitHub REST v3. Works without GITHUB_TOKEN at 60 requests/hour; with it, 5 000/hour.
 * Commit and contributor totals use the Link rel="last" page number instead of listing everything.
 */
import { z } from 'zod';
import type { Env } from '@apecheck/core';
import { warnOnce } from '@apecheck/core/node';
import type { GitHubSource, Http, HttpResponse, RepoFacts } from '../types';
import { HttpError } from '../http';
import { ErrorState } from '../util';

export const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
const PAGE = 100;
const MAX_REPOS = 3;

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** github.com/<segment> paths that are not users or orgs */
const RESERVED = new Set([
  'about', 'apps', 'collections', 'codespaces', 'contact', 'customer-stories', 'enterprise', 'events', 'explore',
  'features', 'issues', 'join', 'login', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls',
  'readme', 'search', 'security', 'settings', 'site', 'sponsors', 'topics', 'trending', 'users',
]);

const RepoMetaZ = z.object({
  full_name: z.string(),
  html_url: z.string(),
  fork: z.boolean().optional().default(false),
  stargazers_count: z.number().optional().default(0),
  created_at: z.string().nullish(),
  pushed_at: z.string().nullish(),
  description: z.string().nullish(),
});
type RepoMeta = z.infer<typeof RepoMetaZ>;
const CommitZ = z.object({
  commit: z.object({
    author: z.object({ date: z.string().nullish() }).nullish(),
    committer: z.object({ date: z.string().nullish() }).nullish(),
  }),
});
const UserZ = z.object({ login: z.string(), public_repos: z.number().optional() });
const SearchZ = z.object({ items: z.array(z.unknown()) });

export class GitHubRateLimitError extends Error {
  constructor(public readonly resetAt: string | null) {
    super(`GitHub rate limit reached${resetAt ? `, resets ${resetAt}` : ''}`);
    this.name = 'GitHubRateLimitError';
  }
}

/** owner/repo, https://github.com/owner[/repo][/…], github.com/owner, owner.github.io */
export function parseGitHubRef(input: string): { owner: string; repo: string | null } | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const short = /^([^/\s:]+)\/([^/\s]+)$/.exec(s);
  if (short && !short[1].includes('.') && LOGIN_RE.test(short[1])) {
    const repo = short[2].replace(/\.git$/i, '');
    return REPO_RE.test(repo) ? { owner: short[1], repo } : null;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length);
    return LOGIN_RE.test(owner) ? { owner, repo: null } : null;
  }
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[0]?.toLowerCase() === 'orgs' && seg[1]) seg.shift();
  const owner = seg[0];
  if (!owner || RESERVED.has(owner.toLowerCase()) || !LOGIN_RE.test(owner)) return null;
  const repo = seg[1]?.replace(/\.git$/i, '') ?? null;
  return { owner, repo: repo && REPO_RE.test(repo) ? repo : null };
}

/** page number of rel="last" in a Link header */
export function lastPageFromLink(link: string | undefined): number | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    if (!/rel="last"/.test(part)) continue;
    const m = /[?&]page=(\d+)/.exec(part);
    if (m) return Number(m[1]);
  }
  return null;
}

function commitDate(c: unknown): string | null {
  const r = CommitZ.safeParse(c);
  if (!r.success) return null;
  return r.data.commit.committer?.date ?? r.data.commit.author?.date ?? null;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export class GitHubAdapter implements GitHubSource {
  readonly configured = true;
  private readonly errors = new ErrorState('github');
  private readonly headers: Record<string, string>;

  constructor(env: Pick<Env, 'GITHUB_TOKEN'>, private readonly http: Http) {
    this.headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    if (env.GITHUB_TOKEN) this.headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
    else warnOnce('github-anon', 'GitHub token not configured (GITHUB_TOKEN empty): using the unauthenticated API (60 requests/hour)');
  }

  get lastError() {
    return this.errors.lastError;
  }

  /** null body for 404/409/451 and other "not available" answers; throws on rate limits, auth refusals and server errors */
  private async get(path: string): Promise<{ res: HttpResponse; body: unknown }> {
    const res = await this.http.request(`${GITHUB_API}${path}`, { headers: this.headers, timeoutMs: TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 });
    if (res.status === 429 || (res.status === 403 && (res.headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(res.text)))) {
      const reset = Number(res.headers['x-ratelimit-reset']);
      throw new GitHubRateLimitError(Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null);
    }
    if (res.status === 401 || res.status === 403 || res.status >= 500) {
      let detail = '';
      try {
        detail = String((JSON.parse(res.text) as { message?: unknown }).message ?? '');
      } catch {
        detail = '';
      }
      const err = new HttpError(res.status, res.finalUrl, res.text.slice(0, 300), res.headers);
      if (detail) err.message += `: ${detail.slice(0, 160)}`;
      throw err;
    }
    if (!res.ok || !res.text.trim()) return { res, body: null };
    try {
      return { res, body: JSON.parse(res.text) };
    } catch {
      throw new Error('bad JSON from api.github.com');
    }
  }

  private async repoFacts(meta: RepoMeta): Promise<RepoFacts> {
    const full = meta.full_name;
    const [first, contributors] = await Promise.all([
      this.get(`/repos/${full}/commits?per_page=${PAGE}`),
      // GitHub refuses the contributor list of very large repos; that must not discard the commit facts
      this.get(`/repos/${full}/contributors?per_page=1&anon=1`)
        .then(c => lastPageFromLink(c.res.headers.link) ?? (Array.isArray(c.body) ? c.body.length : 0))
        .catch((e: unknown) => {
          if (e instanceof GitHubRateLimitError) throw e;
          this.errors.fail('contributors', e);
          return 0;
        }),
    ]);
    const firstPage = Array.isArray(first.body) ? first.body : [];
    const recentCommitDates = firstPage.map(commitDate).filter((d): d is string => !!d);
    let commits = firstPage.length;
    let firstCommit = firstPage.length ? commitDate(firstPage[firstPage.length - 1]) : null;
    const last = lastPageFromLink(first.res.headers.link);
    if (last && last > 1) {
      const tail = await this.get(`/repos/${full}/commits?per_page=${PAGE}&page=${last}`);
      const tailPage = Array.isArray(tail.body) ? tail.body : [];
      commits = (last - 1) * PAGE + tailPage.length;
      if (tailPage.length) firstCommit = commitDate(tailPage[tailPage.length - 1]);
    }
    return {
      fullName: full,
      url: meta.html_url,
      fork: meta.fork,
      stars: meta.stargazers_count,
      createdAt: meta.created_at ?? null,
      pushedAt: meta.pushed_at ?? null,
      commits,
      contributors,
      firstCommit,
      lastCommit: recentCommitDates[0] ?? null,
      recentCommitDates,
      description: meta.description ?? null,
    };
  }

  private parseMetas(list: unknown): RepoMeta[] {
    if (!Array.isArray(list)) return [];
    return list.map(r => RepoMetaZ.safeParse(r)).filter(r => r.success).map(r => r.data);
  }

  /** Top non-fork repos by last push (forks only when the owner has nothing else). */
  private async ownerRepos(owner: string): Promise<RepoMeta[]> {
    const { body } = await this.get(`/users/${owner}/repos?type=owner&sort=pushed&direction=desc&per_page=30`);
    const repos = this.parseMetas(body).sort((a, b) => Date.parse(b.pushed_at ?? '') - Date.parse(a.pushed_at ?? '') || 0);
    const originals = repos.filter(r => !r.fork);
    return (originals.length ? originals : repos).slice(0, MAX_REPOS);
  }

  async fromUrl(url: string): Promise<RepoFacts[]> {
    const ref = parseGitHubRef(url);
    if (!ref) return [];
    try {
      let metas: RepoMeta[];
      if (ref.repo) {
        const { body } = await this.get(`/repos/${ref.owner}/${ref.repo}`);
        const meta = RepoMetaZ.safeParse(body);
        metas = meta.success ? [meta.data] : [];
      } else {
        metas = await this.ownerRepos(ref.owner);
      }
      return await Promise.all(metas.map(m => this.repoFacts(m)));
    } catch (e) {
      this.errors.fail('fromUrl', e);
      return [];
    }
  }

  async searchByName(name: string): Promise<RepoFacts[]> {
    const q = name.trim().replace(/^\$/, '');
    if (!q) return [];
    try {
      const [search, user] = await Promise.all([
        this.get(`/search/repositories?q=${encodeURIComponent(q)}+in:name&sort=stars&per_page=5`),
        LOGIN_RE.test(q) ? this.get(`/users/${q}`) : Promise.resolve(null),
      ]);
      const candidates: RepoMeta[] = [];
      const u = user ? UserZ.safeParse(user.body) : null;
      if (u?.success && (u.data.public_repos ?? 1) > 0) candidates.push(...(await this.ownerRepos(u.data.login)));
      const s = SearchZ.safeParse(search.body);
      const want = squash(q);
      if (s.success && want) {
        candidates.push(...this.parseMetas(s.data.items).filter(m => squash(m.full_name.split('/')[1] ?? '').includes(want)));
      }
      const picked = new Map<string, RepoMeta>();
      for (const m of candidates) {
        if (picked.size >= MAX_REPOS) break;
        if (!picked.has(m.full_name.toLowerCase())) picked.set(m.full_name.toLowerCase(), m);
      }
      return await Promise.all([...picked.values()].map(m => this.repoFacts(m)));
    } catch (e) {
      this.errors.fail('searchByName', e);
      return [];
    }
  }
}

export function createGitHub(env: Pick<Env, 'GITHUB_TOKEN'>, http: Http): GitHubAdapter {
  return new GitHubAdapter(env, http);
}
