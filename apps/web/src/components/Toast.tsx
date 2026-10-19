'use client';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { reportPath } from '@/lib/env';

/** toast(text) shows a short message; toast(text, checkId) adds an "Open" link to that report and stays longer. */
export type ToastFn = (text: string, checkId?: string) => void;

const ToastCtx = createContext<ToastFn>(() => {});

const SHORT_MS = 2800;
const WITH_LINK_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ text: string; id?: string; on: boolean }>({ text: '', on: false });
  const timer = useRef<number | undefined>(undefined);

  const toast = useCallback<ToastFn>((text, checkId) => {
    window.clearTimeout(timer.current);
    setState({ text, id: checkId, on: true });
    timer.current = window.setTimeout(() => setState(s => ({ ...s, on: false })), checkId ? WITH_LINK_MS : SHORT_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hide = () => {
    window.clearTimeout(timer.current);
    setState(s => ({ ...s, on: false }));
  };

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className={`toast${state.on ? ' on' : ''}`} id="toast" role="status">
        {state.text ? <span>{state.text}</span> : null}
        {state.id ? (
          <Link href={reportPath(state.id)} onClick={hide}>
            Open
          </Link>
        ) : null}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
