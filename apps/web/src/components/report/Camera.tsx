'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

const FADE_MS = 350;

interface Layer {
  src: string;
  key: number;
  shown: boolean;
}

/**
 * The newest screenshot fades in over the previous one, which is dropped once the fade is done.
 * A screenshot that fails to load is skipped, so the camera keeps the last good frame.
 */
function Shots({ src, alt }: { src: string | null; alt: string }) {
  const seq = useRef(0);
  // the first frame (server render or tab switch) shows at once; later ones wait for their load
  const [layers, setLayers] = useState<Layer[]>(() => (src ? [{ src, key: 0, shown: true }] : []));

  useEffect(() => {
    setLayers(ls => {
      if (!src) return [];
      const top = ls[ls.length - 1];
      if (top && top.src === src) return ls;
      seq.current += 1;
      return [...ls.filter(l => l.shown).slice(-1), { src, key: seq.current, shown: false }];
    });
  }, [src]);

  const top = layers[layers.length - 1];
  useEffect(() => {
    if (!top?.shown || layers.length < 2) return;
    const t = window.setTimeout(() => setLayers(ls => ls.slice(-1)), FADE_MS + 50);
    return () => window.clearTimeout(t);
  }, [top, layers.length]);

  const reveal = useCallback(
    (key: number) => setLayers(ls => (ls.some(l => l.key === key && !l.shown) ? ls.map(l => (l.key === key ? { ...l, shown: true } : l)) : ls)),
    [],
  );
  const drop = useCallback((key: number) => setLayers(ls => ls.filter(l => l.key !== key)), []);

  return (
    <>
      {layers.map(l => (
        <img
          key={l.key}
          className="cam-shot"
          src={l.src}
          alt={l === top ? alt : ''}
          decoding="async"
          // cached images can finish before React attaches onLoad
          ref={el => {
            if (el && !l.shown && el.complete && el.naturalWidth > 0) reveal(l.key);
          }}
          onLoad={() => reveal(l.key)}
          onError={() => drop(l.key)}
          style={{ opacity: l.shown ? 1 : 0, transition: `opacity ${FADE_MS}ms ease` }}
        />
      ))}
    </>
  );
}

export interface CameraProps {
  /** address bar: the URL of the latest step that has one */
  url: string | null;
  /** public URL of the screenshot to show */
  shot: string | null;
  /** caption pill */
  caption: string;
  /** text in the dark view until the first screenshot */
  idle: string;
  alt: string;
}

/** The prototype's .cam, showing the agent's real screenshots instead of a drawn site (HANDOFF §3). */
export function Camera({ url, shot, caption, idle, alt }: CameraProps) {
  return (
    <div className="cam">
      <div className="cam-bar">
        <span className="cam-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="cam-url" id="camUrl" title={url ?? undefined}>
          {url ?? 'about:blank'}
        </span>
      </div>
      <div className="cam-view" id="camView">
        {shot ? null : (
          <div className="cam-idle" id="camIdle">
            {idle}
          </div>
        )}
        <Shots src={shot} alt={alt} />
        <div className="cam-cap" id="camCap">
          {caption}
        </div>
      </div>
    </div>
  );
}
