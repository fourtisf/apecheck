'use client';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ModalOpts {
  /** the share-card modal: no box, just the card and actions (.modal-box.narrow) */
  narrow?: boolean;
  /** accessible name for the dialog */
  label?: string;
}

export interface ModalApi {
  open(content: ReactNode, opts?: ModalOpts): void;
  close(): void;
  isOpen: boolean;
}

interface ModalState {
  content: ReactNode;
  narrow: boolean;
  label?: string;
  /** bumps on every open(), so the first button gets focus again when content is swapped */
  n: number;
}

const ModalApiCtx = createContext<ModalApi>({ open() {}, close() {}, isOpen: false });
const ModalStateCtx = createContext<ModalState | null>(null);

/** The header's account control: "Connect wallet", or the account button once signed in. */
export const ACCOUNT_CONTROL = '.top-r .acct-btn, .top-r > button.btn-primary';

/** Focus fell to <body> (its element was removed or disabled): someone should take it back. */
export const focusLost = () => !document.activeElement || document.activeElement === document.body;

/** After the next paint, give focus to `el` if it fell to <body> meanwhile (a submit button that was disabled). */
export function refocusIfLost(el: { current: HTMLElement | null }) {
  requestAnimationFrame(() => {
    if (focusLost()) el.current?.focus({ preventScroll: true });
  });
}

/**
 * State for the prototype's single #modal. The dialog itself is drawn by <ModalRoot/>, which sits
 * inside every other provider so modal content can use any hook (useMe, useToast, ...).
 */
export function ModalProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** set by close(): where focus goes once the dialog is gone (undefined: nothing to restore) */
  const restore = useRef<HTMLElement | null | undefined>(undefined);
  const pathname = usePathname();

  const open = useCallback((content: ReactNode, opts: ModalOpts = {}) => {
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    restore.current = undefined;
    setModal(m => ({ content, narrow: !!opts.narrow, label: opts.label, n: (m?.n ?? 0) + 1 }));
  }, []);

  const close = useCallback(() => {
    setModal(null);
    restore.current = opener.current;
    opener.current = null;
  }, []);

  // Focus goes back to the opener after React has committed the close: what closed the modal may have replaced the
  // opener in the same render (signing in swaps "Connect wallet" for the account button), so a gone opener hands
  // focus to the header's account control instead of leaving it on <body>.
  useEffect(() => {
    if (modal || restore.current === undefined) return;
    const el = restore.current;
    restore.current = undefined;
    const inDialog = document.activeElement instanceof HTMLElement && !!document.activeElement.closest('#modal');
    if (!focusLost() && !inDialog) return;
    const target = el && el.isConnected && el !== document.body ? el : document.querySelector<HTMLElement>(ACCOUNT_CONTROL);
    target?.focus();
  }, [modal]);

  // route() in the prototype closes the modal on every navigation
  useEffect(() => {
    setModal(null);
    opener.current = null;
    restore.current = undefined;
  }, [pathname]);

  const isOpen = !!modal;
  const api = useMemo<ModalApi>(() => ({ open, close, isOpen }), [open, close, isOpen]);
  return (
    <ModalApiCtx.Provider value={api}>
      <ModalStateCtx.Provider value={modal}>{children}</ModalStateCtx.Provider>
    </ModalApiCtx.Provider>
  );
}

/** The dialog element: Escape and a backdrop click close it; the first button gets focus (openModal() in the prototype). */
export function ModalRoot() {
  const modal = useContext(ModalStateCtx);
  const { close } = useContext(ModalApiCtx);
  const boxRef = useRef<HTMLDivElement>(null);

  const openCount = modal?.n;
  useEffect(() => {
    if (!openCount) return;
    boxRef.current?.querySelector<HTMLElement>('button:not([disabled]), a[href], input')?.focus();
  }, [openCount]);

  const isOpen = !!modal;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  return (
    <div
      className={`modal${modal ? ' open' : ''}`}
      id="modal"
      role="dialog"
      aria-modal="true"
      aria-label={modal?.label}
      onClick={e => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className={`modal-box${modal?.narrow ? ' narrow' : ''}`} id="modalBox" ref={boxRef}>
        {modal?.content}
      </div>
    </div>
  );
}

export const useModal = () => useContext(ModalApiCtx);
