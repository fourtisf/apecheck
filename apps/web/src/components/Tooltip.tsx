'use client';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface TooltipApi {
  /** Show `content` centred above the point (x, y) in viewport pixels, like the prototype's showTip(). */
  show(content: ReactNode, x: number, y: number): void;
  hide(): void;
}

const TipCtx = createContext<TooltipApi>({ show() {}, hide() {} });

/**
 * The prototype's #tip. Any element with a data-tip="text" attribute gets it on hover (rendered as
 * plain text, never HTML, since names come from scanned projects). Rich tips such as the
 * since-check chart call useTooltip().show(<>...</>, x, y).
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<{ content: ReactNode; x: number; y: number; on: boolean }>({ content: null, x: 0, y: 0, on: false });
  const pathname = usePathname();

  const show = useCallback((content: ReactNode, x: number, y: number) => setTip({ content, x, y, on: true }), []);
  const hide = useCallback(() => setTip(t => (t.on ? { ...t, on: false } : t)), []);

  useEffect(() => {
    const over = (e: MouseEvent) => {
      const t = (e.target as Element | null)?.closest?.('[data-tip]');
      if (!t) return;
      const r = t.getBoundingClientRect();
      show(t.getAttribute('data-tip') ?? '', r.left + r.width / 2, r.top);
    };
    const out = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-tip]')) hide();
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mouseout', out);
    };
  }, [show, hide]);

  useEffect(() => hide(), [pathname, hide]);

  const api = useMemo(() => ({ show, hide }), [show, hide]);
  return (
    <TipCtx.Provider value={api}>
      {children}
      <div id="tip" role="tooltip" className={tip.on ? 'on' : undefined} style={{ left: tip.x, top: tip.y }}>
        {tip.content}
      </div>
    </TipCtx.Provider>
  );
}

export const useTooltip = () => useContext(TipCtx);
