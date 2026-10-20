'use client';
import { useMe } from './Me';
import { useToast } from './Toast';
import { CopyIcon } from './icons';

/** What a click on the pill does: copy the address, or say it isn't out yet. */
export function caClick(address: string | null): { copy: string | null; toast: string } {
  return address
    ? { copy: address, toast: 'Contract address copied' }
    : { copy: null, toast: 'The contract address is coming soon. Follow @ApeCheckBot on X for the launch.' };
}

/**
 * "CA <address>" pill (hero and footer): $APECHECK's contract address from MeDTO.tokenAddress (TOKEN_ADDRESS in .env),
 * copied on click; "Coming soon" until the token launches.
 */
export function TokenCA({ className }: { className?: string }) {
  const { me } = useMe();
  const toast = useToast();
  const address = me?.tokenLive ? me.tokenAddress ?? null : null;
  const onClick = () => {
    const r = caClick(address);
    if (r.copy) navigator.clipboard?.writeText(r.copy).catch(() => {});
    toast(r.toast);
  };
  return (
    <button
      type="button"
      className={`ca-pill${className ? ` ${className}` : ''}`}
      onClick={onClick}
      title={address ?? 'Coming soon'}
      aria-label={address ? `Copy the $APECHECK contract address ${address}` : '$APECHECK contract address: coming soon'}
    >
      <span className="ca-k">CA</span>
      <span className={address ? 'ca-v' : 'ca-v soon'}>{address ?? 'Coming soon'}</span>
      <CopyIcon className="ca-ic" />
    </button>
  );
}
