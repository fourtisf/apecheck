/** Small console logger with a scope prefix ("[checks]", "[check abc1234]"). */
export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

const fmtExtra = (extra: unknown) => {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` ${extra.stack ?? extra.message}`;
  try {
    return ' ' + JSON.stringify(extra);
  } catch {
    return ' ' + String(extra);
  }
};

export function createLogger(scope: string, quiet = false): Logger {
  const line = (msg: string, extra?: unknown) => `${new Date().toISOString()} [${scope}] ${msg}${fmtExtra(extra)}`;
  return {
    info: (m, e) => { if (!quiet) console.log(line(m, e)); },
    warn: (m, e) => console.warn(line(m, e)),
    error: (m, e) => console.error(line(m, e)),
    child: (s: string) => createLogger(`${scope}:${s}`, quiet),
  };
}

/** Logger that only keeps lines in memory (tests). */
export function memoryLogger(lines: string[] = []): Logger & { lines: string[] } {
  const push = (lvl: string) => (m: string, e?: unknown) => { lines.push(`${lvl} ${m}${fmtExtra(e)}`); };
  const self = { lines, info: push('info'), warn: push('warn'), error: push('error'), child: () => self };
  return self;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}
