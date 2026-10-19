# apps/web components

Shared shell and building blocks for every page. They port the prototype (`design/apecheck.html`) one to one:
same class names, same markup, same copy. All styles live in `src/app/globals.css` (the prototype's `<style>`
block verbatim, plus a few marked React additions at the end). No UI kit, no CSS-in-JS: use the prototype's
classes.

Data only comes from the API (`src/lib/api.ts`, shapes in `packages/core/src/dto.ts`). Nothing here holds mock data.

## Conventions for pages

- Pages render inside `<main id="app">` from the root layout (header, footer, modal, toast and tooltip are already there).
  Wrap content like the prototype: `<section className="wrap page">…</section>`.
- Title: `export const metadata = { title: 'Coins' }` gives "Coins · ApeCheck".
- Server render first paint, then hydrate client parts:
  ```tsx
  import { coins } from '@/lib/api';
  import { orNull, serverCall } from '@/lib/server-api';
  export const dynamic = 'force-dynamic';
  const data = await orNull(coins({ tab: 'all' }, serverCall())); // null when the API is down: render a "couldn't load" state
  ```
  `serverCall()` forwards the visitor's `X-Forwarded-For` so API rate limits count the visitor, not the web server.
  Never import `@/lib/server-api` from a `'use client'` file.
- Client fetches: call the same functions from `@/lib/api` (they use `NEXT_PUBLIC_API_URL` with `credentials: 'include'`;
  the anonymous credits session is a cookie on the API origin, so the server can't know credits or "mine" flags).
  Errors throw `ApiRequestError` (`.status`, `.code`, `.message` = the API's plain-English `error`). `isAbortError(e)`
  tells a cancelled fetch apart.
- Long lists of links: pass `prefetch={false}` to `next/link` (rows already do).
- Every page must render an empty database cleanly: show the prototype's empty copy or a short muted line.
- Import from `@apecheck/core` freely in client code: `optimizePackageImports` keeps zod (env/schemas) out of the bundle.
- Dev server of your own: `NEXT_DIST_DIR=.next-<you> npx next dev -p <port>` in `apps/web`. Next adds
  `.next-<you>/types/**/*.ts` to `tsconfig.json` `include`; remove that line before handing off.

## lib

| File | What |
|---|---|
| `lib/api.ts` | Typed client: `me`, `createCheck`, `report`, `eventsUrl(id)` (SSE, `new EventSource(url, { withCredentials: true })`, close it on `done`), `feed`, `live`, `insights`, `coins`, `deployers`, `botStats`, `asks`, `notes`, `helpful`, `watch`, `shotUrl(path)`. Also `ApiRequestError`, `isApiError(e, code?)`, `isAbortError(e)`, `NETWORK_ERROR`, param types `FeedParams`, `CoinsParams`, `DeployersParams`, `FeedTab`, `FeedType`. `HelpfulResponse` / `WatchResponse` are the expected M3 bodies (not in dto.ts yet). |
| `lib/server-api.ts` | Server only: `serverCall()`, `forwardedHeaders()`, `orNull(promise)`. |
| `lib/env.ts` | `PUBLIC_API_URL`, `APP_URL`, `APP_HOST` ("apecheck.io"), `reportPath(id)` → `/c/<id>`. Server renders reach the API at `API_INTERNAL_URL` (default `http://127.0.0.1:4000`, handled inside `api.ts`). |
| `lib/theme.ts` | `THEME_KEY` ('apecheck-theme'), `THEME_SCRIPT` (inline head script), `setTheme(t)`, `currentTheme()`, `savedTheme()`, `applySavedTheme()` (puts the saved theme on `<html>` without writing it back). |

## Shell (mounted once by `app/layout.tsx`)

| Component | Props | Notes |
|---|---|---|
| `Header` | — | Brand, `NavLinks` (`.nav` and `.nav-m`), `HeaderSearch`, `TokenPrice`, `ThemeToggle`, `CreditsButton`, `WalletButton`. |
| `NavLinks` | `className: 'nav' \| 'nav-m'`, `id?` | `aria-current="page"` like `route()`: Feed is current on `/` and on `/c/*`. Exports `NAV`, `isCurrent(href, pathname)`. |
| `HeaderSearch` | — | `.hsearch` + the "/" shortcut. Submit: exact ticker/handle/domain/CA match among checked projects → that report; else something checkable → `startCheck`; else filters the feed (`/?q=` from other pages). |
| `ThemeToggle` | — | Both icons rendered, CSS shows one (`.theme-ic-sun/moon`), so no flash. Saves `apecheck-theme`, updates `meta[name=theme-color]`. On mount it re-applies the saved theme (`applySavedTheme()`, before paint): Next serves `notFound()` under `/c/[id]` as a client-rendered error shell where the head script never runs, and the root layout would keep that "light" for the whole visit. |
| `CreditsButton` | — | Ring + "4/5" (`renderCredits()`); "–/–" until `/v1/me` answers. Opens the access modal. |
| `WalletButton` | — | "Connect wallet" → `useActions().connectWallet()` (M1: access modal; M3 replaces it with sign-in). |
| `TokenPrice` | `quote?: { usd, ch24 }` | The `.tok` "$APECHECK $0.00412 +6.1%". Renders nothing unless `MeDTO.tokenLive` and a real quote is given. Exports `fmtTokenPrice`. |
| `Footer` | — | Disclaimer + footer links. |
| `AppProvider` | `children` | Composes all stores below; draws `ModalRoot` last so modal content can use every hook. |

## Stores and hooks (client components only)

| Hook | Returns | Notes |
|---|---|---|
| `useToast()` (`Toast.tsx`) | `toast(text, checkId?)` | With a check id it shows an "Open" link to `/c/<id>` and stays 6 s, else 2.8 s. |
| `useModal()` (`Modal.tsx`) | `{ open(node, { narrow?, label? }), close(), isOpen }` | Escape, backdrop click and navigation close it; first button gets focus; focus returns to the opener. |
| `useTooltip()` (`Tooltip.tsx`) | `{ show(node, x, y), hide() }` | Any element with `data-tip="text"` gets the `#tip` on hover automatically (plain text, never HTML). Use `show` for rich tips (e.g. the since-check chart): `x, y` are viewport px, the tip sits centred above the point. |
| `useMe()` (`Me.tsx`) | `{ me: MeDTO \| null, refresh(), setCredits(n) }` | Loads on mount, refreshes when the tab returns after 60 s and right after 00:00 UTC. |
| `useFeedState()` (`FeedState.tsx`) | `{ get(), save(s), search(q) }` | The feed list's tab, layout, filters and rows for the visit (the prototype's `S.tab/S.view/S.f/S.limit`), so a report and Back (or the Feed pill) show the same list. In memory only. `search(q)` is what a header search on another page leaves before going to `/?q=`. Pure rules: `restoreFeed`, `startRows`, `feedParams`/`feedKey`, `serverFeedKey`. |
| `useWatchlist()` (`Watchlist.tsx`) | `{ ids, has(id), toggle(id) → boolean, ready }` | M1: check ids in `localStorage['apecheck-watch']`, newest first, synced across tabs. `toggle` shows no toast; the Watch button picks its copy. `WATCH_KEY`, `WATCH_MAX_IDS` (100, the API's cap). |
| `useLive()` (`Live.tsx`) | `{ items, receivedAt, error, subscribe(seed?), trackMine(id), onFinished(cb) }` | Shared `/v1/live` poller (3 s), only while a view subscribes or one of my checks runs; pauses in hidden tabs. Also the global notifier: when my check leaves `/v1/live` it fetches the report and toasts "Your check on {name} is done: {LABEL} {nar}" with Open, **except when the viewer is on `/c/<that id>`** (the report page shows the verdict landing itself). `startCheck` calls `trackMine` for you. |
| `useActions()` (`Actions.tsx`) | `{ openAccess(out?), openShare(item, opts?), startCheck(raw, { recheck? }), connectWallet(), requestFeedSearch(q) }` | `startCheck` = the hero form: bad input → toast "Paste a contract address, an X post link or a website"; no credits → access modal (out); else POST `/v1/checks`, refresh credits, `router.push('/c/<id>')`. Resolves to the id or null. Use it for the report's **Re-check** (`{ recheck: true }`). |
| `useFeedSearchRequest()` (`Actions.tsx`) | `{ q, n } \| null` | The feed listens to it; other pages don't need it. |
| `useNow()` (`Now.tsx`) | `number` (ms) | Shared clock refreshed every 30 s. |

## Modals

| Component | Props | Notes |
|---|---|---|
| `AccessModal` | `out?`, `onWallet?` | `openAccess(out)`. While `tokenLive` is false: holding requirements hidden, Pro/Max read "Opens at token launch", buttons disabled, note "Pro and Max open at token launch." (no USDC line). Open it with `useActions().openAccess()`. |
| `Tiers` | `me`, `onFree?`, `onWallet?`, `proPerDay?` (30), `maxPerDay?` (200) | `tiersHTML()`. Free tier uses `me.max` for "N checks a day". |
| `TiersNote` | `me` | USDC line only once the token is live; otherwise "Pro and Max open at token launch." |
| `AccessTiers` | — | `Tiers` + `TiersNote` for the current viewer: the /api page's Access section. |
| `ShareModal` | `item: VCardItem`, `onDownload?`, `onPost?` | `openShare(it)`: the card + Close / Download image / Post to X. Defaults: download `/card/<id>.png` from this site; open an X post with `shareText(item)` and the report link. Override either from the report page. Exports `shareText`, `downloadCard`, `postToX`. |

## Render helpers (no hooks, usable from server and client components)

| Component | Props | Prototype |
|---|---|---|
| `Avatar` | `item: { kind, hue, ticker?, name? }`, `size = 30` | `avatar(it, size)`: coin = hued letter tile, post = X, site = globe. |
| `ChainTag` | `chain: ChainKey \| null` | `chainTag(c)`; renders nothing for null. |
| `NarBadge` | `score: number \| null` | `narB(n)`; '—' for null. |
| `CoinBadge` | `score: number \| null` | `coinB(n)`; '—' for null. |
| `Pct` | `value: number \| null` | `pct(p)`: green/red `fmtPct`, '—' for null. |
| `ScoreChip` | `score: number \| null`, `title = 'Total score'` | `.schip` in the narrative-band colour of the score. |
| `MiniMeter` | `score`, `kind: 'nar' \| 'coin' = 'nar'`, `label?` | `mm(n, band, p, label)`; the label shows on phones (`.mm-k`). |
| `Ring` | `value`, `size`, `color?`, `id?` | `ringSVG(n, size, col, id)`: arc colour defaults to the parent's `--vc`. Wrap in `.rv-ring` (+ `n-<band>`) with a `.rv-ring-in` label. Changing `value` animates via the prototype's `.arc` transition. |
| `Spark` | `data: number[] \| null`, `w = 46`, `h = 16` | `spark(a)`; nothing for fewer than 2 points. |
| `VCard` | `item: VCardItem` (any `CheckSummaryDTO`) | `cardHTML(it)`: footer shows the chain name, or the kind ("Site", "Post") when there is no chain. Exports `cardSource(it)`. |
| `VerdictRow` | `item: CheckSummaryDTO`, `fresh?` | `rowHTML(it)`: one `a.tr` row, ages refresh themselves. Exports `CoinCell`. |
| `VerdictCard` | `item: CheckSummaryDTO`, `fresh?` | `gridHTML(it)`: one `.gc` card for `.gview`. |
| `FeedHead` | — | `FEED_HEAD`. |
| `VerdictTable` | `items`, `fresh?: Set<string>` | `<div class="tbl">FEED_HEAD + rows</div>` (feed list view, "Recent bot replies" on /bot). |
| `Age` (`Now.tsx`) | `ts`, `long?`, `className?` | "5m" / "5m ago", refreshed every 30 s (client component, fine inside server components). |
| `icons.tsx` | SVG props | `BrandLogo`, `Logo`, `XIcon`, `GlobeIcon`, `CopyIcon`, `SearchIcon`, `SunIcon`, `MoonIcon`, `WalletIcon`, `ListIcon`, `GridIcon`. |
| `cssVars` (`css.ts`) | `{ '--s': '30px', ... }` | Typed inline custom properties for `style`. |

## Feed page (`components/feed/`, used only by `app/page.tsx`)

`FeedView` (hero, live row, insights, verdicts), `ProbeForm`, `CreditLine`, `HeroStats`, `LiveChecks`, `Insights`
(links builders to `/deployers?focus=<address>`), `Verdicts` (tabs, list/grid, filters, cursor paging, `.fresh`
highlight when a live check lands, watchlist via `GET /v1/feed?tab=watch&ids=…`). `Verdicts` starts from `useFeedState()`:
the saved rows show at once and refresh quietly; restored filters that differ from the server render's (Latest, `?q=`
only) load their own rows. `?q=` is read from the address bar (`useSearchParams`), never from props that may belong to
an older URL after Back.

## Report page notes (for `/c/[id]`)

- Screenshots: `<img className="cam-shot" src={shotUrl(step.screenshot) ?? ''} alt="" />` inside `.cam-view` (the `.cam-shot` rule is in globals.css).
- Live log: `new EventSource(eventsUrl(id), { withCredentials: true })`; call `.close()` on the `done` event.
- Share card button: `useActions().openShare(report)`; side panel card: `<VCard item={report} />`.
- Watch button: `useWatchlist().toggle(report.id)` and `useToast()` for the prototype's toast copy.
- The global notifier stays quiet while the viewer is on that report's page.
- Deployer: `coin.deployer` (known record) → the record card and badge; only `coin.deployerAddress` (history unknown) → the
  short address with "Launch history unavailable" (Coin tab, side card, coins table), never a made-up record.
- A pasted contract whose chain couldn't be read (`kind === 'coin' && !hasCoin`) says so; it is never "No coin linked".
- A check that stopped without a verdict (`noVerdict(r)` in `report/util.tsx`: failed, or finished with no narrative
  score) opens on the Agent run tab (`initialTab`), and Claims, Coin and the price card say the run stopped before
  that point instead of "no claims found" / "no coin linked". Claims or coin facts saved before it stopped still show.

## /coins and /deployers

The filters live in the address bar (`useSyncUrl`, `window.history.replaceState`). That keeps the router's cached
render for the URL the page was loaded with, so after Back the server props can describe older filters than the URL.
The views therefore start from `useUrlSearchParams()` (the URL the browser is on) and only use the server's rows when
they were rendered for those same filters; otherwise they load the right rows first.

## /bot

The example thread (`pickBotExample` in `pages/botExample.ts`) never shows a reply the bot didn't post or words someone
didn't write:
- a real X thread only for a bot check whose reply was posted (`CheckReportDTO.botReply`, from `BotMention`: the
  mention's author and text as written, `repliedAt` for the reply's time, X's "Automated account" label), with the
  project's post when the check read it (`CheckReportDTO.post`);
- otherwise (always in M1: the bot is M2) a post check run on the site or through the API whose post text was read,
  shown as a captioned illustration ("Example: how the bot would answer this post. The check ran on the site; nothing
  was posted on X."): the project's real post without a time, "You" tagging the bot, and the answer without a time or
  the X label. A bot check whose reply isn't on X is never used;
- with neither, no thread.

## Tests

```bash
pnpm --filter @apecheck/web test        # unit: pure rules + server-rendered markup (vitest, no services)
pnpm --filter @apecheck/web test:e2e    # browser: Chromium against `next build` + `next start` and the real API
pnpm --filter @apecheck/web typecheck   # src and test/
```

- Unit tests (`test/*.test.ts(x)`, `vitest.config.ts`): feed state rules, theme, `/bot` thread selection and markup,
  a report that stopped before a verdict. Components render with `react-dom/server`.
- Browser suite (`test/e2e`, `vitest.e2e.config.ts`): its own database `apecheck_test_web` (created and migrated, then
  seeded by `test/e2e/seed.ts`), Redis db 3, the API on 127.0.0.1:4611 and the web on 127.0.0.1:3611 (built into
  `.next-e2e`; `tsconfig.json` is put back after the build). Needs local Postgres + Redis; Playwright and its Chromium
  come from `@apecheck/worker` (no install). Override with `E2E_DATABASE_URL`, `E2E_REDIS_URL`, `E2E_API_PORT`,
  `E2E_WEB_PORT`; `E2E_SKIP_BUILD=1` reuses the last build. Covers: feed state after a report and Back, `/coins` and
  `/deployers` filters on Back, the dark theme on an unknown `/c/<id>`, a failed check's tabs, the `/bot` thread, the
  header from 1001 to 1240px and the segmented controls at phone width.
