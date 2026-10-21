'use client';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { WEBHOOK_SIGNATURE_HEADER } from '@apecheck/core';

/** A highlighted run: [class, text] (k = key, s = string, nn = number, c = comment) or plain text. */
type Tok = string | ['k' | 's' | 'nn' | 'c', string];

/** Example check id: real ids are 7 characters, [a-z0-9]. */
const ID = '8f2a91c';
const SUMMARY = `"The app loads but the main flow stops at 'Coming soon'."`;

/** POST /v1/checks, then GET /v1/checks/:id (the fields apps/api documents for the /api page). */
const REST: Tok[] = [
  ['c', '# start a check'],
  '\ncurl -X POST https://api.apecheck.io/v1/checks \\\n  -H ',
  ['s', '"Authorization: Bearer $APECHECK_KEY"'],
  ' \\\n  -H ',
  ['s', '"Content-Type: application/json"'],
  ' \\\n  -d ',
  ['s', `'{"target":"orbitswap.xyz"}'`],
  '\n',
  ['c', `# → { "id": "${ID}", "status": "queued", … }`],
  '\n\n',
  ['c', `# result: GET /v1/checks/${ID}`],
  '\n{\n  ',
  ['k', '"id"'],
  ': ',
  ['s', `"${ID}"`],
  ',\n  ',
  ['k', '"status"'],
  ': ',
  ['s', '"done"'],
  ',\n  ',
  ['k', '"narrative"'],
  ': { ',
  ['k', '"verdict"'],
  ': ',
  ['s', '"PARTLY_REAL"'],
  ', ',
  ['k', '"score"'],
  ': ',
  ['nn', '48'],
  ' },\n  ',
  ['k', '"coin"'],
  ': { ',
  ['k', '"verdict"'],
  ': ',
  ['s', '"SKETCHY"'],
  ', ',
  ['k', '"score"'],
  ': ',
  ['nn', '44'],
  ' },\n  ',
  ['k', '"total"'],
  ': ',
  ['nn', '46'],
  ',\n  ',
  ['k', '"summary"'],
  ': ',
  ['s', SUMMARY],
  ',\n  ',
  ['k', '"claims"'],
  ': [ { ',
  ['k', '"text"'],
  ': ',
  ['s', '"Live on Base mainnet"'],
  ', ',
  ['k', '"result"'],
  ': ',
  ['s', '"not_seen"'],
  ' } ],\n  ',
  ['k', '"report_url"'],
  ': ',
  ['s', `"https://apecheck.io/c/${ID}"`],
  '\n}',
];

/**
 * The MCP server (apps/api /mcp behind mcp.apecheck.io) and its four tools. The prototype labelled this JSON
 * claude_desktop_config.json, but Claude Desktop can't send a header to a remote server without the mcp-remote bridge
 * (apps/api README, MCP server); `url` + `headers` under "mcpServers" is exactly Cursor's mcp.json.
 */
const MCP: Tok[] = [
  ['c', '// ~/.cursor/mcp.json'],
  '\n{\n  ',
  ['k', '"mcpServers"'],
  ': {\n    ',
  ['k', '"apecheck"'],
  ': {\n      ',
  ['k', '"url"'],
  ': ',
  ['s', '"https://mcp.apecheck.io"'],
  ',\n      ',
  ['k', '"headers"'],
  ': { ',
  ['k', '"Authorization"'],
  ': ',
  ['s', '"Bearer YOUR_KEY"'],
  ' }\n    }\n  }\n}\n\n',
  ['c', '// tools'],
  '\nrun_check(target)           ',
  ['c', '→ narrative, coin, total, verdict, report_url'],
  '\nget_check(id)               ',
  ['c', '→ full report with evidence'],
  '\nask_followup(id, question)  ',
  ['c', "→ an answer from the check's record"],
  '\ndeployer_history(wallet)    ',
  ['c', '→ coins from it that ApeCheck checked'],
];

/** A webhook delivery: the WebhookPayload body, signed in the ApeCheck-Signature header (core WEBHOOK_SIGNATURE_HEADER). */
const HOOK: Tok[] = [
  ['c', 'POST https://your-server.com/apecheck  (signed)'],
  '\n',
  ['k', WEBHOOK_SIGNATURE_HEADER],
  ': ',
  ['s', 't=1792397580,v1=5c1e…'],
  '\n\n{\n  ',
  ['k', '"id"'],
  ': ',
  ['s', '"wd_3f9c0a17be52d4e8a61c07f2"'],
  ',\n  ',
  ['k', '"event"'],
  ': ',
  ['s', '"check.completed"'],
  ',\n  ',
  ['k', '"created"'],
  ': ',
  ['s', '"2026-10-19T08:13:00.000Z"'],
  ',\n  ',
  ['k', '"check"'],
  ': {\n    ',
  ['k', '"id"'],
  ': ',
  ['s', `"${ID}"`],
  ',\n    ',
  ['k', '"target"'],
  ': ',
  ['s', '"orbitswap.xyz"'],
  ',\n    ',
  ['k', '"narrative"'],
  ': ',
  ['nn', '48'],
  ', ',
  ['k', '"coin"'],
  ': ',
  ['nn', '44'],
  ', ',
  ['k', '"total"'],
  ': ',
  ['nn', '46'],
  ',\n    ',
  ['k', '"verdict"'],
  ': ',
  ['s', '"PARTLY_REAL"'],
  ',\n    ',
  ['k', '"summary"'],
  ': ',
  ['s', SUMMARY],
  ',\n    ',
  ['k', '"report_url"'],
  ': ',
  ['s', `"https://apecheck.io/c/${ID}"`],
  '\n  }\n}\n\n',
  ['c', '// v1 = hex HMAC-SHA256(your secret, t + "." + raw body)'],
];

const TABS = [
  { k: 'rest', label: 'REST', toks: REST },
  { k: 'mcp', label: 'MCP', toks: MCP },
  { k: 'hook', label: 'Webhook', toks: HOOK },
] as const;
type TabKey = (typeof TABS)[number]['k'];

const render = (toks: Tok[]): ReactNode[] => toks.map((t, i) => (typeof t === 'string' ? t : <span key={i} className={t[0]}>{t[1]}</span>));

/** The /api page's code card: REST / MCP / Webhook examples (static docs in the prototype's layout, with the real shapes). */
export function CodeTabs() {
  const [tab, setTab] = useState<TabKey>('rest');

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex(t => t.k === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.k);
    document.getElementById(`code-tab-${next.k}`)?.focus();
  }

  return (
    <div className="code">
      <div className="code-tabs" role="tablist" aria-label="Examples" onKeyDown={onKey}>
        {TABS.map(t => (
          <button
            key={t.k}
            id={`code-tab-${t.k}`}
            type="button"
            role="tab"
            aria-selected={tab === t.k}
            aria-controls={`code-${t.k}`}
            tabIndex={tab === t.k ? 0 : -1}
            onClick={() => setTab(t.k)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {TABS.map(t => (
        <pre key={t.k} id={`code-${t.k}`} role="tabpanel" aria-labelledby={`code-tab-${t.k}`} tabIndex={0} hidden={tab !== t.k}>
          {render(t.toks)}
        </pre>
      ))}
    </div>
  );
}
