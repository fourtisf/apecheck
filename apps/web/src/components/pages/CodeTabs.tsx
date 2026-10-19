'use client';
import { useState, type KeyboardEvent, type ReactNode } from 'react';

/** A highlighted run: [class, text] (k = key, s = string, nn = number, c = comment) or plain text. */
type Tok = string | ['k' | 's' | 'nn' | 'c', string];

const REST: Tok[] = [
  ['c', '# start a check'],
  '\ncurl -X POST https://api.apecheck.io/v1/checks \\\n  -H ',
  ['s', '"Authorization: Bearer $APECHECK_KEY"'],
  ' \\\n  -d ',
  ['s', `'{"target":"orbitswap.xyz"}'`],
  '\n\n',
  ['c', '# result'],
  '\n{\n  ',
  ['k', '"id"'],
  ': ',
  ['s', '"chk_8f2a91"'],
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
  ['s', `"The app loads but the main flow stops at 'Coming soon'."`],
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
  ['s', '"https://apecheck.io/c/chk_8f2a91"'],
  '\n}',
];

const MCP: Tok[] = [
  ['c', '// claude_desktop_config.json'],
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
  ['c', '→ narrative, coin, total, report'],
  '\nget_check(id)               ',
  ['c', '→ full report with evidence'],
  '\nask_followup(id, question)\ndeployer_history(wallet)',
];

const HOOK: Tok[] = [
  ['c', 'POST https://your-server.com/apecheck  (signed)'],
  '\n{\n  ',
  ['k', '"event"'],
  ': ',
  ['s', '"check.completed"'],
  ',\n  ',
  ['k', '"check"'],
  ': {\n    ',
  ['k', '"id"'],
  ': ',
  ['s', '"chk_8f2a91"'],
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
  '\n  },\n  ',
  ['k', '"signature"'],
  ': ',
  ['s', '"t=1729325580,v1=5c1e…"'],
  '\n}',
];

const TABS = [
  { k: 'rest', label: 'REST', toks: REST },
  { k: 'mcp', label: 'MCP', toks: MCP },
  { k: 'hook', label: 'Webhook', toks: HOOK },
] as const;
type TabKey = (typeof TABS)[number]['k'];

const render = (toks: Tok[]): ReactNode[] => toks.map((t, i) => (typeof t === 'string' ? t : <span key={i} className={t[0]}>{t[1]}</span>));

/** The /api page's code card: REST / MCP / Webhook examples (static docs, same as the prototype). */
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
