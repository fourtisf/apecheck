import { CHAINS, type ChainKey } from '@apecheck/core';

/** chainTag(c): coloured dot + short chain name. Renders nothing when the chain is unknown (sites, posts without a coin). */
export function ChainTag({ chain }: { chain: ChainKey | null | undefined }) {
  if (!chain || !CHAINS[chain]) return null;
  const c = CHAINS[chain];
  return (
    <span className="ch">
      <i style={{ background: c.c }} />
      {c.s}
    </span>
  );
}
