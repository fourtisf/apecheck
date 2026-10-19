'use client';
import { useActions } from './Actions';
import { WalletIcon } from './icons';

/** Header "Connect wallet". Wallet sign-in is M3; in M1 it opens the access modal. */
export function WalletButton() {
  const { connectWallet } = useActions();
  return (
    <button className="btn btn-primary" type="button" onClick={connectWallet}>
      <WalletIcon />
      <span className="wallet-t">Connect wallet</span>
    </button>
  );
}
