import { describe, expect, it } from 'vitest';
import { createGitHub, lastPageFromLink, parseGitHubRef } from '../src/adapters/github';
import { createHttp } from '../src/http';
import { fakeHttp, fixture, testEnv, type Handler } from './helpers';

const API = 'https://api.github.com';

function commits(n: number, startIso: string, stepHours = -1): unknown[] {
  const t0 = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(t0 + i * stepHours * 3600_000).toISOString().replace('.000Z', 'Z');
    return { sha: `sha${i}`, commit: { author: { name: 'dev', date: d }, committer: { name: 'GitHub', date: d }, message: `c${i}` } };
  });
}
const link = (path: string, last: number) => `<${API}${path}&page=2>; rel="next", <${API}${path}&page=${last}>; rel="last"`;

/** routes for one repo: 3 pages of commits (100 + 100 + 42), 7 contributors */
function repoRoutes(full: string, meta: unknown = fixture('github-repo.json')): Handler {
  return url => {
    if (url.host !== 'api.github.com') return undefined;
    const p = url.pathname;
    const q = url.searchParams;
    if (p === `/repos/${full}`) return { json: meta };
    if (p === `/repos/${full}/commits` && q.get('per_page') === '100' && !q.get('page')) {
      return { json: commits(100, '2026-10-17T19:58:41Z'), headers: { link: link(`/repositories/1/commits?per_page=100`, 3) } };
    }
    if (p === `/repos/${full}/commits` && q.get('page') === '3') return { json: commits(42, '2025-04-03T10:00:00Z') };
    if (p === `/repos/${full}/contributors`) {
      expect(q.get('anon')).toBe('1');
      expect(q.get('per_page')).toBe('1');
      return { json: [{ login: 'dev', contributions: 200 }], headers: { link: link('/repositories/1/contributors?per_page=1&anon=1', 7) } };
    }
    return undefined;
  };
}

describe('GitHub helpers', () => {
  it('parseGitHubRef', () => {
    expect(parseGitHubRef('kairolabs/kairo-core')).toEqual({ owner: 'kairolabs', repo: 'kairo-core' });
    expect(parseGitHubRef('https://github.com/kairolabs/kairo-core.git')).toEqual({ owner: 'kairolabs', repo: 'kairo-core' });
    expect(parseGitHubRef('https://github.com/kairolabs/kairo-core/tree/main/src')).toEqual({ owner: 'kairolabs', repo: 'kairo-core' });
    expect(parseGitHubRef('github.com/kairolabs')).toEqual({ owner: 'kairolabs', repo: null });
    expect(parseGitHubRef('https://www.github.com/orgs/kairolabs/repositories')).toEqual({ owner: 'kairolabs', repo: 'repositories' });
    expect(parseGitHubRef('https://kairolabs.github.io')).toEqual({ owner: 'kairolabs', repo: null });
    expect(parseGitHubRef('https://github.com/features/actions')).toBeNull();
    expect(parseGitHubRef('https://gitlab.com/a/b')).toBeNull();
    expect(parseGitHubRef('kairo.xyz/docs')).toBeNull();
    expect(parseGitHubRef('')).toBeNull();
  });

  it('lastPageFromLink', () => {
    expect(lastPageFromLink(link('/x?per_page=1', 1234))).toBe(1234);
    expect(lastPageFromLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(lastPageFromLink(undefined)).toBeNull();
  });
});

describe('GitHub adapter: fromUrl', () => {
  it('repo URL → facts with Link-header totals, first/last commit and recent dates', async () => {
    const http = fakeHttp(repoRoutes('kairolabs/kairo-core'));
    const [facts, ...rest] = await createGitHub(testEnv({ GITHUB_TOKEN: 'ghp_x' }), http).fromUrl('https://github.com/kairolabs/kairo-core');
    expect(rest).toEqual([]);
    expect(facts).toMatchObject({
      fullName: 'kairolabs/kairo-core',
      url: 'https://github.com/kairolabs/kairo-core',
      fork: false,
      stars: 214,
      createdAt: '2025-04-01T09:12:00Z',
      pushedAt: '2026-10-17T19:58:41Z',
      commits: 242,
      contributors: 7,
      lastCommit: '2026-10-17T19:58:41Z',
      firstCommit: '2025-04-01T17:00:00Z',
      description: 'Kairo protocol contracts and SDK',
    });
    expect(facts.recentCommitDates).toHaveLength(100);
    expect(http.calls[0].req.headers).toMatchObject({ authorization: 'Bearer ghp_x', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
  });

  it('small repo without a Link header; no Authorization without a token', async () => {
    const http = fakeHttp(url => {
      if (url.pathname === '/repos/a/b') return { json: { ...fixture<object>('github-repo.json'), full_name: 'a/b', html_url: 'https://github.com/a/b' } };
      if (url.pathname === '/repos/a/b/commits') return { json: commits(3, '2026-10-17T00:00:00Z') };
      if (url.pathname === '/repos/a/b/contributors') return { json: [{ login: 'solo' }] };
      return undefined;
    });
    const [facts] = await createGitHub(testEnv(), http).fromUrl('a/b');
    expect(facts).toMatchObject({ commits: 3, contributors: 1, lastCommit: '2026-10-17T00:00:00Z', firstCommit: '2026-10-16T22:00:00Z' });
    expect(http.calls[0].req.headers?.authorization).toBeUndefined();
  });

  it('empty repository (409 on commits) → 0 commits', async () => {
    const http = fakeHttp(url => {
      if (url.pathname === '/repos/a/empty') return { json: { ...fixture<object>('github-repo.json'), full_name: 'a/empty' } };
      if (url.pathname === '/repos/a/empty/commits') return { status: 409, json: { message: 'Git Repository is empty.' } };
      if (url.pathname === '/repos/a/empty/contributors') return { status: 204, text: '' };
      return undefined;
    });
    expect((await createGitHub(testEnv(), http).fromUrl('a/empty'))[0]).toMatchObject({ commits: 0, contributors: 0, firstCommit: null, lastCommit: null, recentCommitDates: [] });
  });

  it('owner URL → top 3 non-fork repos by last push', async () => {
    const generic: Handler = url => {
      const m = /^\/repos\/(kairolabs\/[^/]+)\/(commits|contributors)$/.exec(url.pathname);
      if (!m) return undefined;
      return { json: m[2] === 'commits' ? commits(1, '2026-01-01T00:00:00Z') : [{}] };
    };
    const http = fakeHttp(url => (url.pathname === '/users/kairolabs/repos' ? { json: fixture('github-user-repos.json') } : undefined), generic);
    const res = await createGitHub(testEnv(), http).fromUrl('https://github.com/kairolabs');
    expect(res.map(r => r.fullName)).toEqual(['kairolabs/kairo-core', 'kairolabs/kairo-app', 'kairolabs/docs']);
    const q = new URL(http.calls[0].url).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ sort: 'pushed', direction: 'desc', type: 'owner' });
  });

  it('rate limit (403 + x-ratelimit-remaining: 0, or 429) → [] with lastError', async () => {
    const limited = fakeHttp(() => ({ status: 403, json: { message: 'API rate limit exceeded for 1.2.3.4.' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760054400' } }));
    const gh = createGitHub(testEnv(), limited);
    expect(await gh.fromUrl('a/b')).toEqual([]);
    expect(gh.lastError).toBe('github.fromUrl: GitHub rate limit reached, resets 2025-10-10T00:00:00.000Z');
    const tooMany = createGitHub(testEnv(), fakeHttp(() => ({ status: 429, text: '' })));
    expect(await tooMany.searchByName('kairo')).toEqual([]);
    expect(tooMany.lastError).toMatch(/rate limit/);
  });

  it('404 → [] without an error', async () => {
    const gh = createGitHub(testEnv(), fakeHttp(() => ({ status: 404, json: { message: 'Not Found' } })));
    expect(await gh.fromUrl('https://github.com/nobody/nothing')).toEqual([]);
    expect(gh.lastError).toBeNull();
  });
});

describe('GitHub adapter: searchByName', () => {
  const generic: Handler = url => {
    const m = /^\/repos\/([^/]+\/[^/]+)\/(commits|contributors)$/.exec(url.pathname);
    if (!m) return undefined;
    return { json: m[2] === 'commits' ? commits(2, '2026-01-01T00:00:00Z') : [{}, {}] };
  };

  it('org/user with the same name first, then repo-name matches from search, max 3', async () => {
    const http = fakeHttp(
      url => (url.pathname === '/search/repositories' ? { json: fixture('github-search.json') } : undefined),
      url => (url.pathname === '/users/kairolabs' ? { json: { login: 'kairolabs', type: 'Organization', public_repos: 5 } } : undefined),
      url => (url.pathname === '/users/kairolabs/repos' ? { json: fixture('github-user-repos.json') } : undefined),
      generic,
    );
    const res = await createGitHub(testEnv(), http).searchByName('kairolabs');
    expect(res.map(r => r.fullName)).toEqual(['kairolabs/kairo-core', 'kairolabs/kairo-app', 'kairolabs/docs']);
    const search = http.calls.find(c => c.url.includes('/search/repositories'))!;
    expect(search.url).toBe(`${API}/search/repositories?q=kairolabs+in:name&sort=stars&per_page=5`);
  });

  it('no such org: repo-name matches only (description-only matches dropped)', async () => {
    const http = fakeHttp(
      url => (url.pathname === '/search/repositories' ? { json: fixture('github-search.json') } : undefined),
      url => (url.pathname === '/users/Kairo' ? { status: 404, json: { message: 'Not Found' } } : undefined),
      generic,
    );
    const res = await createGitHub(testEnv(), http).searchByName('$Kairo');
    expect(res.map(r => r.fullName)).toEqual(['someone/kairo-clone', 'kairolabs/kairo-core', 'unrelated/kai-ro-tools']);
    expect(res[0]).toMatchObject({ commits: 2, contributors: 2 });
  });

  it('names that are not valid logins skip the user lookup', async () => {
    const http = fakeHttp(url => (url.pathname === '/search/repositories' ? { json: { items: [] } } : undefined));
    expect(await createGitHub(testEnv(), http).searchByName('Kairo Labs')).toEqual([]);
    expect(http.calls.map(c => new URL(c.url).pathname)).toEqual(['/search/repositories']);
    expect(http.calls[0].url).toContain('q=Kairo%20Labs+in:name');
  });
});

describe.skipIf(!process.env.LIVE_TESTS)('GitHub adapter: live (LIVE_TESTS=1)', () => {
  it('fetches a real public repo through the outbound proxy', async () => {
    const http = createHttp(testEnv({ OUTBOUND_PROXY: process.env.HTTPS_PROXY ?? '' }));
    const gh = createGitHub(testEnv({ GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '' }), http);
    const repo = process.env.LIVE_GITHUB_REPO ?? 'octocat/Hello-World';
    const [facts] = await gh.fromUrl(`https://github.com/${repo}`);
    expect(gh.lastError).toBeNull();
    expect(facts.fullName.toLowerCase()).toBe(repo.toLowerCase());
    expect(facts.commits).toBeGreaterThan(0);
    expect(facts.firstCommit).toMatch(/^\d{4}-/);
  }, 30_000);
});

describe('GitHub adapter: refusals', () => {
  it('401/403 that are not rate limits are recorded with GitHub\'s message', async () => {
    const gh = createGitHub(testEnv({ GITHUB_TOKEN: 'expired' }), fakeHttp(() => ({ status: 401, json: { message: 'Bad credentials' } })));
    expect(await gh.fromUrl('a/b')).toEqual([]);
    expect(gh.lastError).toBe('github.fromUrl: HTTP 401 from api.github.com: Bad credentials');
  });

  it('a refused contributor list keeps the rest of the repo facts', async () => {
    const http = fakeHttp(url => {
      if (url.pathname === '/repos/big/repo') return { json: { ...fixture<object>('github-repo.json'), full_name: 'big/repo' } };
      if (url.pathname === '/repos/big/repo/commits') return { json: commits(5, '2026-10-17T00:00:00Z') };
      if (url.pathname === '/repos/big/repo/contributors') {
        return { status: 403, json: { message: 'The history or contributor list is too large to list contributors for this repository via the API.' } };
      }
      return undefined;
    });
    const gh = createGitHub(testEnv(), http);
    const [facts] = await gh.fromUrl('big/repo');
    expect(facts).toMatchObject({ fullName: 'big/repo', commits: 5, contributors: 0 });
    expect(gh.lastError).toMatch(/^github\.contributors: HTTP 403 from api\.github\.com: The history or contributor list is too large/);
  });
});
