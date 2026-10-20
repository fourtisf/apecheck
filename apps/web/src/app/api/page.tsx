import type { Metadata } from 'next';
import { CodeTabs } from '@/components/pages/CodeTabs';
import { DevNote, DevTools } from '@/components/pages/Developers';
import { AccessTiers } from '@/components/Tiers';

export const metadata: Metadata = {
  title: 'API',
  description: 'Run ApeCheck from your own app or AI: REST API, MCP server and webhooks, with the same agent and the same report as JSON.',
};

/**
 * viewApi(): developer docs (REST / MCP / webhook) and the access tiers. M4: a signed-in Max viewer manages API keys and
 * webhooks under the docs; everyone else reads that they come with Max under the code.
 */
export default function ApiPage() {
  return (
    <section className="wrap page">
      <div className="dev-g">
        <div>
          <h1 className="h-pg">Run checks from your own app or AI.</h1>
          <p style={{ color: 'var(--mute)', fontSize: '17px', margin: 0, maxWidth: '52ch' }}>
            Same agent, same report, as JSON. Plug it into a trading bot, a Telegram group or your AI assistant.
          </p>
          <ul className="dev-list">
            <li>
              <b>REST API</b>Start a check, poll it or wait for the result.
            </li>
            <li>
              <b>MCP server</b>Add it to Claude, ChatGPT or Cursor and ask &quot;is this real?&quot; in chat.
            </li>
            <li>
              <b>Webhooks</b>Get the verdict pushed to your server when a check finishes, or when a watched coin changes.
            </li>
          </ul>
        </div>
        <div className="dev-code">
          <CodeTabs />
          <DevNote />
        </div>
      </div>
      <DevTools />
      <div className="sec2">
        <h2>Access</h2>
        <AccessTiers />
      </div>
    </section>
  );
}
