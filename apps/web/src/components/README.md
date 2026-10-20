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
  `serverCall()` forwards the visitor's `X-Forwarded-For` (API rate limits count the visitor, not the web server) and
  the API's own cookies `ac_sid` / `ac_session` (only those), so the first paint shows the visitor's own view: "mine",
  `watching`, their private reports, their tier. In production the API sets both cookies for `COOKIE_DOMAIN=.apecheck.io`,
  so the browser sends them to the site too; locally cookies ignore the port, so `localhost:3000` sees `localhost:4000`'s.
  Never import `@/lib/server-api` from a `'use client'` file.
- Client fetches: call the same functions from `@/lib/api` (they use `NEXT_PUBLIC_API_URL` with `credentials: 'include'`).
  Client parts still re-ask what depends on the viewer when it can change in the page (sign-in, sign-out); a private
  report whose owner signs out on it turns into the not-found state (the API answers 404 to a signed-out browser).
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
| `lib/api.ts` | Typed client: `me`, `createCheck` (`private` for Max), `report`, `eventsUrl(id)` (SSE, `new EventSource(url, { withCredentials: true })`, close it on `done`), `feed`, `live`, `insights`, `coins`, `deployers`, `botStats`, `asks`, `notes`, `helpful`, `shotUrl(path)`; M3: `watch` / `unwatch` (POST / DELETE `/v1/watch/:targetId`), `watchlist`, `notifications(limit?)`, `readNotifications(ids?)`, `authNonce(chain, address, chainId?)`, `authVerify(body)`, `logout`, `xLinkUrl()` (the browser goes there for "Link your X"), `xUnlink`; M4 (Max, wallet session only; the API refuses API keys on these): `apiKeys`, `createApiKey(name?)` (the key is in that response only), `revokeApiKey(id)`, `webhooks`, `createWebhook({ url, events })` (the signing secret is in that response only), `deleteWebhook(id)`, `enableWebhook(id)`, `testWebhook(id)` (queues a ping, returns the pending `WebhookDeliveryDTO`), `webhookDeliveries(id)` (last 50). Also `ApiRequestError`, `isApiError(e, code?)`, `isAbortError(e)`, `NETWORK_ERROR`, param types `FeedParams`, `CoinsParams`, `DeployersParams`, `FeedTab`, `FeedType`. |
| `lib/server-api.ts` | Server only: `serverCall({ timeoutMs? })`, `forwardedHeaders()` (X-Forwarded-For, User-Agent, the API cookies), `apiCookieHeader(cookie)`, `orNull(promise)`. |
| `lib/wallet/` | Wallet sign-in without wallet libraries. `walletRegistry()` (the page's one `createWalletRegistry(window)`): `list(chain?)`, `refresh()`, `subscribe(fn)`. EVM: EIP-6963 (`eip6963:requestProvider` / `announceProvider`; name, rdns, icon only when it is a `data:image/…` URL), `window.ethereum` while nothing announced (named by its `isX` flags). Solana: the Wallet Standard handshake (`wallet-standard:app-ready` with `{ register }`, `wallet-standard:register-wallet`), wallets with `standard:connect` + `solana:signMessage`; `window.phantom.solana` / `window.solana` while none registered. `walletSignIn(option, { nonce, verify }, onStep?)`: connect (`eth_requestAccounts` + `eth_chainId` / `standard:connect`) → `GET /v1/auth/nonce` → sign the exact message (`personal_sign [hexUtf8(message), address]` / `signMessage(utf8 bytes)` → base64) → `POST /v1/auth/verify`. Wallet failures are `WalletFlowError` (`declined_connect`, `declined_sign`, `pending`, `no_account`, `bad_signature`, `wallet_error`); `signInErrorText(e)` is the toast ("Signature request was declined", or the API's message). |
| `lib/env.ts` | `PUBLIC_API_URL`, `APP_URL`, `APP_HOST` ("apecheck.io"), `reportPath(id)` → `/c/<id>`. Server renders reach the API at `API_INTERNAL_URL` (default `http://127.0.0.1:4000`, handled inside `api.ts`). |
| `lib/theme.ts` | `THEME_KEY` ('apecheck-theme'), `THEME_SCRIPT` (inline head script), `setTheme(t)`, `currentTheme()`, `savedTheme()`, `applySavedTheme()` (puts the saved theme on `<html>` without writing it back). |

## Shell (mounted once by `app/layout.tsx`)

| Component | Props | Notes |
|---|---|---|
| `Header` | — | Brand, `NavLinks` (`.nav` and `.nav-m`), `HeaderSearch`, `TokenPrice`, `ThemeToggle`, `CreditsButton`, `WalletButton`. The root layout renders `GET /v1/me` on the server (2.5 s budget, the visitor's cookies) and passes it to `AppProvider initialMe`, so the header shows the viewer's tier, address and credits on first paint. |
| `NavLinks` | `className: 'nav' \| 'nav-m'`, `id?` | `aria-current="page"` like `route()`: Feed is current on `/` and on `/c/*`. Exports `NAV`, `isCurrent(href, pathname)`. |
| `HeaderSearch` | — | `.hsearch` + the "/" shortcut. Submit: exact ticker/handle/domain/CA match among checked projects → that report; else something checkable → `startCheck`; else filters the feed (`/?q=` from other pages). |
| `ThemeToggle` | — | Both icons rendered, CSS shows one (`.theme-ic-sun/moon`), so no flash. Saves `apecheck-theme`, updates `meta[name=theme-color]`. On mount it re-applies the saved theme (`applySavedTheme()`, before paint): Next serves `notFound()` under `/c/[id]` as a client-rendered error shell where the head script never runs, and the root layout would keep that "light" for the whole visit. |
| `CreditsButton` | — | Ring + "4/5" (`renderCredits()`) of the viewer's daily limit (`MeDTO.max`: Free, or the signed-in tier's 30 / 200); "–/–" until `/v1/me` answers (and right after sign-out until it says what this browser has: `creditsKnown`). Opens the access modal. |
| `WalletButton` | — | Signed out: "Connect wallet" → the wallet modal. Signed in: the short address (`.wallet-t`, hidden on phones and between 1001 and 1100px where the bar is full), a small tier pill for Pro/Max and an unread dot for re-check alerts; it opens the account menu (`.acct-menu`, a `role="dialog"` popover announced by `aria-haspopup="dialog"`; focus moves into it on open; full width under the bar on phones; capped at the window and scrolling on its own, with Sign out kept in view): tier, "Holds 3.1M $APECHECK" (token live only; before launch a Free viewer reads "Pro and Max open at token launch"), linked wallets, "Link a Solana wallet" / "Link an EVM wallet", "Link your X" (when `xLinkAvailable`; linked: @handle + Unlink), the re-check alerts (`GET /v1/notifications?limit=10` when opened; clicking one marks it read and opens `/c/<checkId>`; "Mark all read"), "Sign out". Escape, outside clicks and navigation close it. After sign-in, sign-out or a wallet link, keyboard focus lands on the new account control ("Connect wallet" or the account button), never on `<body>`. Exports `fmtHolding`, `holdingLine`. |
| `TokenPrice` | `quote?: { usd, ch24 }` | The `.tok` "$APECHECK $0.00412 +6.1%" (the prototype's markup) from `MeDTO.token` (or `quote`). Renders nothing unless `MeDTO.tokenLive` and a real quote. Hidden up to 1340px (the search keeps its room). Exports `fmtTokenPrice`. |
| `Footer` | — | Disclaimer + footer links. |
| `AppProvider` | `children`, `initialMe?` | Composes all stores below; draws `ModalRoot` last so modal content can use every hook. |

## Stores and hooks (client components only)

| Hook | Returns | Notes |
|---|---|---|
| `useToast()` (`Toast.tsx`) | `toast(text, checkId?)` | With a check id it shows an "Open" link to `/c/<id>` and stays 6 s, else 2.8 s. |
| `useModal()` (`Modal.tsx`) | `{ open(node, { narrow?, label? }), close(), isOpen }` | Escape, backdrop click and navigation close it; first button gets focus; focus returns to the opener once the close is rendered, or to the header's account control when the opener is gone (signing in replaces "Connect wallet"). Also exports `ACCOUNT_CONTROL`, `focusLost()`, `refocusIfLost(ref)`. |
| `useTooltip()` (`Tooltip.tsx`) | `{ show(node, x, y), hide() }` | Any element with `data-tip="text"` gets the `#tip` on hover automatically (plain text, never HTML). Use `show` for rich tips (e.g. the since-check chart): `x, y` are viewport px, the tip sits centred above the point. |
| `useMe()` (`Me.tsx`) | `{ me: MeDTO \| null, loaded, creditsKnown, refresh(), setCredits(n), apply(me, { creditsKnown? }), setUnread(n) }` | Starts from the layout's server render, asks again on mount, every minute while the tab is visible and the token is live or someone is signed in (the price, the alert dot), when the tab returns after 60 s and right after 00:00 UTC. `apply(me)` takes a MeDTO another call returned (sign-in, X unlink); a refresh started before it can't undo it. `creditsKnown` is false while the credits are a placeholder (right after sign-out): show no count then. `me.user` is the signed-in viewer (`UserDTO`: wallets, X handle, `tier`, `holding`, `holder`). Also exports `tierName(t)`. |
| `useAccount()` (`Account.tsx`) | `{ openWallets({ chain? }), signIn(option), cancel(), pending, signOut(), linkX(), unlinkX() }` | `openWallets()` opens the wallet modal (with `chain` while signed in: link that chain's wallet). `signIn` runs `walletSignIn`, applies the MeDTO, closes the modal, toasts "Signed in as 0x19e…ff2a" / "Solana wallet linked" (or the decline / API message) and `router.refresh()`es the server render. Picking a wallet again while one is asked starts over. `cancel()` (the wallet modal calls it when it closes, any way) drops the attempt: a wallet that answers later gets no nonce, signature request or verify, and nothing it answers closes another modal (once verify was sent, its answer is still applied, since the API signed the browser in). `signOut` → `POST /v1/auth/logout`, then the signed-out header at once with the credits unknown ("–/–") until `/v1/me` answers. `linkX` sends the browser to the API (`/v1/auth/x/start` → X → `/?x=linked\|error`); the provider toasts `?x=` once and removes it from the address bar (`xLinkToast`). |
| `useFeedState()` (`FeedState.tsx`) | `{ get(), save(s), search(q) }` | The feed list's tab, layout, filters and rows for the visit (the prototype's `S.tab/S.view/S.f/S.limit`), so a report and Back (or the Feed pill) show the same list. In memory only. `search(q)` is what a header search on another page leaves before going to `/?q=`. Pure rules: `restoreFeed`, `startRows`, `feedParams`/`feedKey`, `serverFeedKey`. |
| `useWatchlist()` (`Watchlist.tsx`) | `{ mode, ready, ids, list, count, isWatching({ id, targetId }), setWatching(item, on), reload(), version }` | Signed out (`mode: 'local'`): check ids in `localStorage['apecheck-watch']`, newest first, synced across tabs. Signed in (`'account'`): the account's watched targets (`GET /v1/watchlist`; `setWatching` → POST / DELETE `/v1/watch/:targetId`, throws `ApiRequestError`, e.g. 409 `watchlist_full`). On sign-in the browser's ids move to the account (`migrateLocalWatchlist`: targets resolved through `/v1/feed?ids=`, the ones the account already watches skipped, the rest watched; toast "Moved N watched projects…"). A long list moves in passes of at most `MIGRATE_PER_PASS` (40) watches, `MIGRATE_RETRY_MS` apart, stopping at a 429; each pass drops only the ids it settled from the browser, so the next visit carries on instead of starting over. A full account watchlist ends the move. `setWatching` shows no toast; the Watch button picks its copy. `WATCH_KEY`, `WATCH_MAX_IDS` (100). |
| `useLive()` (`Live.tsx`) | `{ items, receivedAt, error, subscribe(seed?), trackMine(id), onFinished(cb) }` | Shared `/v1/live` poller (3 s), only while a view subscribes or one of my checks runs; pauses in hidden tabs. Also the global notifier: when my check leaves `/v1/live` it fetches the report and toasts "Your check on {name} is done: {LABEL} {nar}" with Open, **except when the viewer is on `/c/<that id>`** (the report page shows the verdict landing itself). `startCheck` calls `trackMine` for you. |
| `useActions()` (`Actions.tsx`) | `{ openAccess(out?), openShare(item, opts?), startCheck(raw, { recheck?, private? }), connectWallet(), requestFeedSearch(q) }` | `startCheck` = the hero form: bad input → toast "Paste a contract address, an X post link or a website"; no credits → access modal (out); else POST `/v1/checks`, refresh credits, `router.push('/c/<id>')`. Resolves to the id or null. Use it for the report's **Re-check** (`{ recheck: true }`; a private report re-checks privately). `connectWallet()` = `useAccount().openWallets()`. |
| `useFeedSearchRequest()` (`Actions.tsx`) | `{ q, n } \| null` | The feed listens to it; other pages don't need it. |
| `useNow()` (`Now.tsx`) | `number` (ms) | Shared clock refreshed every 30 s. |

## Modals

| Component | Props | Notes |
|---|---|---|
| `AccessModal` | `out?` | `openAccess(out)`. Subtitle by tier ("4 of 5 free checks left today" / "28 of 30 checks left today"). While `tokenLive` is false: holding requirements hidden, Pro/Max read "Opens at token launch", note "Pro and Max open at token launch." (no USDC line). Its Connect wallet buttons open the wallet modal. Exports `creditsLeftText(me)`. |
| `Tiers` | `me`, `onFree?`, `onWallet?` | `tiersHTML()`. Daily limits from `MeDTO.proChecksPerDay` / `maxChecksPerDay` (Free: `me.max` for a Free viewer). Buttons: signed out "Keep using free" / "Connect wallet"; signed in the viewer's tier reads "Your tier" (`aria-pressed`), lower tiers "Included", higher ones "Check my holding" (token live: signing in again re-reads the balance) or "At token launch". |
| `WalletModal` | `chain?`, `linking?` | `useAccount().openWallets()`: `.modal-box.narrow` with a `.scard` — "Connect a wallet" (or "Link a Solana wallet"), one `.btn.wopt` row per wallet the browser offers (icon, name, chain tag; "Check your wallet" / "Signing in…" while it runs; any row can be picked again until verify is on its way), "No wallet found in this browser." after 400 ms with none. Closing it cancels the attempt (`useAccount().cancel()`). |
| `TiersNote` | `me` | USDC line only once the token is live; otherwise "Pro and Max open at token launch." |
| `AccessTiers` | — | `Tiers` + `TiersNote` for the current viewer: the /api page's Access section. |
| `ShareModal` | `item: VCardItem`, `onDownload?`, `onPost?`, `postable?` | `openShare(it)`: the card + Close / Download image / Post to X (`postable: false` for a private report, whose link opens only for its owner). Defaults: download `/card/<id>.png` from this site; open an X post with `shareText(item)` and the report link. Override either from the report page. Exports `shareText`, `downloadCard`, `postToX`. |

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
highlight when a live check lands; the Watchlist tab is `GET /v1/feed?tab=watch&ids=…` signed out and `GET /v1/watchlist`
signed in, with the filters applied in the browser by `filterRows`). `Verdicts` starts from `useFeedState()`:
the saved rows show at once and refresh quietly; restored filters that differ from the server render's (Latest, `?q=`
only) load their own rows. `?q=` is read from the address bar (`useSearchParams`), never from props that may belong to
an older URL after Back.

## Report page notes (for `/c/[id]`)

- Screenshots: `<img className="cam-shot" src={shotUrl(step.screenshot) ?? ''} alt="" />` inside `.cam-view` (the `.cam-shot` rule is in globals.css).
- Live log: `new EventSource(eventsUrl(id), { withCredentials: true })`; call `.close()` on the `done` event.
- Share card button: `useActions().openShare(report)`; side panel card: `<VCard item={report} />`.
- Watch button: `useWatchlist().setWatching({ id, targetId }, on)`. Signed in it is the account's list (first paint from
  `CheckReportDTO.watching`, then the store); signed out this browser's list with the toast "Watching in this browser.
  Connect a wallet to keep it on your account; re-check alerts come with Pro." (`watchToast` promises only what the tier
  gets: Max "You'll get a re-check when the site or contract changes", Pro "an alert when …", Free "Re-check alerts come
  with Pro"). The feed's empty Watchlist tab follows the same rule (`watchEmptyText` in Watchlist.tsx).
- A private report (`isPrivate`) shows a `.lock` "Private" pill in the meta line, and its Share card has no Post to X.
- Asks tab: the form posts the question (3–280 characters), shows it at once with a plain pending "Thinking…" (the API
  waits up to 45 s for the worker), then the answer (`AskDTO`, deduped when the API returns the same ask). A failure
  shows the API's own words under the box (403 `pro_required`, 429, 504 `ask_timeout`, …) and puts the question back.
  The box is read-only (not disabled) while it waits, so keyboard focus stays there for the next question. Askers
  without a handle show their short wallet in mono with the wallet icon as avatar, on the pending row too.
- Asks and Notes stay mounted once opened (hidden while another tab shows): a pending question, its error and a note
  draft survive a look at another tab.
- Notes tab: holders (`me.user.holder`) get the note form (textarea, "57/500" counter read with the field and not
  announced per keystroke, Post note enabled at 10–500 characters, the API's message under it on failure); everyone else
  keeps the prototype's "Add a note" toast (`notesClosedText`). Helpful toggles show `NoteDTO.mine` and the API's answer
  (403 `own_note` etc. as a toast). `onChange` takes an updater (`prev => next`), so votes and a new note in flight
  together don't undo each other. Wallet authors are set in mono (`byLabel`; the body font draws "0x" as "0×").
- Signing in or out on a report re-asks `GET /v1/checks/:id`, so "mine", Helpful marks and Watch follow the viewer.
- Max viewers get a "Private" toggle in the hero form (`.probe-priv`, beside the input like the type chip; sends `private: true`).
- The global notifier stays quiet while the viewer is on that report's page.
- Deployer: `coin.deployer` (known record) → the record card and badge; only `coin.deployerAddress` (history unknown) → the
  short address with "Launch history unavailable" (Coin tab, side card, coins table), never a made-up record.
- A pasted contract whose chain couldn't be read (`kind === 'coin' && !hasCoin`) says so; it is never "No coin linked".
- Coin tab, M4: **Wallet clusters** (`Clusters` in `CoinTab.tsx`) under the coin facts when `coin.clusters` has items (the
  API sends them to Pro/Max viewers only): heading with the `.lock` "Pro" marker, one `.facts` row per cluster: label,
  "12.4% of supply", "14 wallets, funded from …" (a wallet address in mono, shortened; a name as written), source
  WhaleFlow. Nothing otherwise.
- A check that stopped without a verdict (`noVerdict(r)` in `report/util.tsx`: failed, or finished with no narrative
  score) opens on the Agent run tab (`initialTab`), and Claims, Coin and the price card say the run stopped before
  that point instead of "no claims found" / "no coin linked". Claims or coin facts saved before it stopped still show.

## /api (M4: API keys, webhooks, MCP)

`app/api/page.tsx` keeps the prototype's `viewApi()` layout: the `.dev-g` intro and the code card, then Access.

- `CodeTabs` (`pages/CodeTabs.tsx`): the prototype's three tabs and markup, with the real shapes. REST: `POST /v1/checks`
  with the Bearer key and `Content-Type: application/json` (the API parses JSON only), then the `GET /v1/checks/:id`
  fields apps/api documents for this page (`id`, `status`, `narrative`, `coin`, `total`, `summary`, `claims[].result`,
  `report_url`; ids are 7 characters). MCP: server `"apecheck"` at `https://mcp.apecheck.io` and the four tools, labelled `~/.cursor/mcp.json` (the prototype
  said `claude_desktop_config.json`, but Claude Desktop needs the mcp-remote bridge to send the key; apps/api README).
  Webhook: the `ApeCheck-Signature: t=…,v1=…` header (`WEBHOOK_SIGNATURE_HEADER`) above the `WebhookPayload` body
  (`id`, `event`, `created`, `check`), and how `v1` is computed. Static docs: no viewer data.
- `DevNote` (`pages/Developers.tsx`), under the code card (`.dev-code` keeps the card's long lines scrolling inside it):
  "API keys, webhooks and MCP are part of Max." for everyone but a signed-in Max viewer, with Connect wallet when signed
  out (`devViewer(me)`: `signed-out` / `signed-in` / `max`).
- `DevTools`, between the docs and Access, only for a signed-in Max viewer (`MeDTO.tier`; keyed by the user, so signing
  out or switching wallets drops everything, a shown-once secret included). A 401/403 from any of its calls re-reads
  `/v1/me` (the tier is re-read by the API per the M3 rules), so a lapsed Max viewer falls back to the Max line.
  - **Your API keys**: a pill field "Key name (optional)" (40 characters) + Create key; the new key appears once in
    `OnceSecret` (read-only mono field, focused, Copy → toast "Copied" with a select-and-copy fallback, "Copy it now and
    keep it somewhere safe. It won't be shown again.", Done). The list (`.tbl.dev-tbl.ktbl`) shows name, `prefix…`
    (`keyShown`), created, last used ("Never") and Revoke → "Yes, revoke" / "Cancel" (`ConfirmButton`, focus follows).
    The API's words under the field on failure (409 `too_many_keys`, …). Revoking the key still on show hides it.
  - **Webhooks**: URL field + event checkboxes (`.dev-ev`; check.completed ticked by default, watch.changed) → the
    signing secret once in `OnceSecret`. The page only checks the URL's shape (`webhookUrlProblem`); https in
    production and "public" are the API's (400 `bad_url` with its message). Rows (`.htbl`): URL, events, status pill
    (`hookStatus`: Active / Failing / Disabled with "Turned off after N failed deliveries in a row"), last delivery
    ("HTTP 200 · 5m ago", `responseText`), Send test (Enable when disabled, the same button node so focus stays),
    Deliveries (expands `.dep-more` with the last 50: `deliveryStatus` pill Delivered / Pending / Retrying / Failed,
    event, HTTP code, attempts, Report link, error) and Delete → "Yes, delete". Send test opens the deliveries and
    looks again until that ping settles, then re-reads the row's own status; only the newest deliveries answer is
    shown. The looks back off (`testPollDelay`: 1.5 s twice, 3 s twice, 6 s twice, then 10 s; `TEST_POLL_MAX` 10, about
    a minute), so every webhook tested at once stays under the API's 60 deliveries reads a minute, and stop at a 429,
    401/403 or 404 (`pollStops`). Delete of a webhook already deleted in another tab (404) takes the row away like a
    delete; deleting the webhook whose secret is on show hides the secret. A 401/403 from Revoke or Delete re-reads
    `/v1/me` like the lists do, so a page signed out meanwhile falls back to the Max line.
  - Buttons waiting for a request are `aria-disabled` (not `disabled`), so keyboard focus never drops to `<body>`.
  - Columns have fixed widths (each `.tr` is its own grid); up to 1000px rows stack (name and status, then the dates in
    `.c-mob`, then the actions).

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
  a report that stopped before a verdict; M3: wallet discovery and sign-in with fake providers (`wallet.test.ts`:
  EIP-6963, `window.ethereum`, Wallet Standard, `window.phantom.solana`, declines, API errors) and the account rules
  and markup (`account.test.tsx`: tier cards, `$APECHECK` quote, holding line, watch toasts, watchlist filters and
  migration, forwarded cookies, `?x=`); M4 (`m4-ui.test.tsx`): who gets keys and webhooks or the Max line, status
  pills, the webhook URL check, the code tabs' shapes, the Coin tab's clusters. Components render with `react-dom/server`.
- Browser suite (`test/e2e`, `vitest.e2e.config.ts`): its own database `apecheck_test_web` (created and migrated, then
  seeded by `test/e2e/seed.ts`), Redis db 3, the API on 127.0.0.1:4611 and the web on 127.0.0.1:3611 (built into
  `.next-e2e`; `tsconfig.json` is put back after the build). Needs local Postgres + Redis; Playwright and its Chromium
  come from `@apecheck/worker` (no install). Override with `E2E_DATABASE_URL`, `E2E_REDIS_URL`, `E2E_API_PORT`,
  `E2E_WEB_PORT`, `E2E_HOOK_PORT`, `E2E_DIST_DIR` (a second build folder, e.g. for a parallel run); `E2E_SKIP_BUILD=1` reuses the last build. Covers: feed state after a report and Back, `/coins` and
  `/deployers` filters on Back, the dark theme on an unknown `/c/<id>`, a failed check's tabs, the `/bot` thread, the
  header from 1001 to 1240px and the segmented controls at phone width.
- M3 (`test/e2e/account.e2e.test.ts`): global setup also starts worker-bot (`apps/worker src/bot.ts`: the asks consumer;
  the bot idles without X keys, answers come from the heuristic AI), gives the test wallets Pro / Max through
  `TIER_OVERRIDES` and sets a dummy `X_OAUTH2_CLIENT_ID`. `test/e2e/wallets.ts` injects fake wallets before the page
  loads: an EIP-6963 EVM wallet whose `personal_sign` runs in Node with `@noble/curves` secp256k1 (apps/api's copy) via
  `page.exposeFunction`, and a Wallet Standard Solana wallet signing with `node:crypto` ed25519
  (`window.__acWallets.rejectNext = true` declines the next request; `hangNext = true` leaves the next EVM connect
  unanswered until `release()`). Covers: EVM sign-in, the account menu, linking a
  Solana wallet, sign-out, Solana sign-in, a declined signature, no wallet, the access modal per viewer, `?x=linked`,
  the browser watchlist moving to the account and server watch/unwatch (also in the server-rendered HTML) and the
  feed's Watchlist tab, a Pro follow-up answered by the worker, a holder's note and Helpful votes, re-check alerts with
  the unread dot, the Max "Private" toggle's request body, and the signed-in header at 1001–1280px and on phones.
  Review fixes: an 80-id browser list moving in passes under the 60-a-minute watch limit, a wallet that never answers
  (the modal stays usable, a late answer signs nobody in and closes nothing), picking the waiting wallet again, no paid
  credits on the signed-out header, two Helpful votes in flight, a pending ask and a note draft across tab switches,
  keyboard focus after sign-in / linking / asking / posting / sign-out, the private report's marker and share card,
  the account menu on short windows, the header with the token live (as Max, 1241–1440px), and alerts arriving on an
  open page (`page.clock`).
- M4 (`test/e2e/developers.e2e.test.ts`): global setup also starts worker-prices (`apps/worker src/prices.ts`: the
  webhook deliveries on queue "webhooks") and sets `SSRF_ALLOW_HOSTS=127.0.0.1:<E2E_HOOK_PORT>` (default 4612) for the
  API and the worker, where the test runs its own receiver. Covers: the Max line signed out (with Connect wallet) and for
  Pro, the code tabs' shapes, a Max wallet creating a key (shown once and copied, then only its prefix; the key calls
  the API and shows "last used"; revoked, it gets 401 `invalid_key`), adding a webhook (a malformed and a private URL
  refused, the secret shown once), Send test delivered by the worker with a valid `ApeCheck-Signature`, a disabled
  webhook enabled again, focus kept on Send test, Send test backing off from a stuck ping and stopping at a 429, Delete
  of a webhook another tab deleted first (row and secret gone), Revoke after the session ended (back to the Max line),
  the Coin tab's clusters for Pro and not for a signed-out reader, and
  /api as Max and signed out at 1440, 900 and 390px, light and dark (no sideways scroll, header columns aligned;
  screenshots in the log folder's `m4-shots/`).
