'use client';
import { useEffect, useState } from 'react';
import type { WalletChain } from '@apecheck/core';
import { walletRegistry, type WalletOption } from '@/lib/wallet';
import { useAccount } from './Account';
import { useModal } from './Modal';

const CHAIN_LABEL: Record<WalletChain, string> = { evm: 'EVM', sol: 'Solana' };
/** wallets answer the discovery events at once; after this long with none, say so */
const LOOK_MS = 400;

function WalletIconImg({ o }: { o: WalletOption }) {
  if (o.icon) {
    // only data: images (safeIcon), never a URL a wallet names
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="wopt-ic" src={o.icon} alt="" width={28} height={28} />;
  }
  return (
    <span className="wopt-ic mini-av" aria-hidden="true">
      {o.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The wallet picker (modal-box.narrow + scard): every wallet this browser offers, EVM (EIP-6963, window.ethereum)
 * and Solana (Wallet Standard, window.phantom.solana). Picking one runs the whole sign-in (useAccount().signIn).
 * While a wallet is asked ("Check your wallet"), picking it or another one starts over; closing the modal (✕, Escape,
 * the backdrop, another modal) gives up on the attempt, so a wallet that never answers can't hold the next one.
 */
export function WalletModal({ chain, linking = false }: { chain?: WalletChain; linking?: boolean }) {
  const { close } = useModal();
  const { signIn, cancel, pending } = useAccount();
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [looked, setLooked] = useState(false);

  // closed (any way): drop the attempt in progress, whatever its wallet answers later
  useEffect(() => () => cancel(), [cancel]);

  useEffect(() => {
    const reg = walletRegistry();
    if (!reg) return;
    const update = () => setOptions(reg.list(chain));
    const unsub = reg.subscribe(update);
    reg.refresh();
    update();
    const t = window.setTimeout(() => setLooked(true), LOOK_MS);
    return () => {
      unsub();
      window.clearTimeout(t);
    };
  }, [chain]);

  const title = linking && chain ? `Link a${chain === 'evm' ? 'n' : ''} ${CHAIN_LABEL[chain]} wallet` : 'Connect a wallet';
  const status = (o: WalletOption) => {
    if (pending?.key !== o.key) return null;
    return pending.step === 'verify' ? 'Signing in…' : 'Check your wallet';
  };

  return (
    <div className="scard wallet-card">
      <div className="modal-h">
        <div>
          <h2 id="modal-title">{title}</h2>
          <p>Sign a message to prove the wallet is yours. It doesn&apos;t send a transaction or cost anything.</p>
        </div>
        <button className="x-btn" type="button" aria-label="Close" onClick={close}>
          ✕
        </button>
      </div>
      {options.length ? (
        <ul className="wopts" aria-label="Wallets in this browser">
          {options.map(o => {
            const s = status(o);
            return (
              <li key={o.key}>
                <button
                  className="btn wopt"
                  type="button"
                  // only while verify is on its way (the API is signing the visitor in) is there nothing to pick
                  disabled={pending?.step === 'verify'}
                  aria-busy={s ? true : undefined}
                  onClick={e => {
                    // the second click of a double-click is not a new attempt
                    if (pending?.key === o.key && e.detail > 1) return;
                    void signIn(o);
                  }}
                >
                  <WalletIconImg o={o} />
                  <span className="wopt-n">{o.name}</span>
                  {s ? <span className="wopt-s">{s}</span> : <span className="tag">{CHAIN_LABEL[o.chain]}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : looked ? (
        <div className="empty wallet-none">
          <p>No wallet found in this browser.</p>
          <p className="muted">
            Install a{chain === 'sol' ? ' Solana' : chain === 'evm' ? 'n EVM' : ''} browser wallet, then reload this page.
          </p>
        </div>
      ) : (
        <p className="muted wallet-look">Looking for wallets…</p>
      )}
    </div>
  );
}
