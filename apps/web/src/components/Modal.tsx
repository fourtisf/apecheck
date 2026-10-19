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

/**
 * State for the prototype's single #modal. The dialog itself is drawn by <ModalRoot/>, which sits
 * inside every other provider so modal content can use any hook (useMe, useToast, ...).
 */
export function ModalProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<ModalState | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const pathname = usePathname();

  const open = useCallback((content: ReactNode, opts: ModalOpts = {}) => {
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    setModal(m => ({ content, narrow: !!opts.narrow, label: opts.label, n: (m?.n ?? 0) + 1 }));
  }, []);

  const close = useCallback(() => {
    setModal(null);
    const el = opener.current;
    opener.current = null;
    if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
  }, []);

  // route() in the prototype closes the modal on every navigation
  useEffect(() => {
    setModal(null);
    opener.current = null;
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
