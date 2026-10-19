import type { CSSProperties } from 'react';

/** Inline CSS custom properties (--s, --h, --vc, ...) typed for React's style prop. */
export const cssVars = (vars: Record<`--${string}`, string | number>, rest: CSSProperties = {}): CSSProperties =>
  ({ ...rest, ...vars }) as CSSProperties;
