/**
 * The doctor's plain-text output: header lines, one aligned row per probe (a "fix:" line under WARN / FAIL / SKIP
 * rows), and a summary. Everything passes through the Redactor first.
 */
import { exitCode, tally, type ProbeResult } from './result';

const STATUS_WIDTH = 6;
const TIME_WIDTH = 7;

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The result rows as aligned lines (no header lines, no summary). */
export function formatTable(results: ProbeResult[], redact: (s: string) => string = s => s): string[] {
  const nameWidth = Math.max('DEPENDENCY'.length, ...results.map(r => r.name.length));
  const lead = (status: string, name: string, time: string) =>
    `${status.padEnd(STATUS_WIDTH)}  ${name.padEnd(nameWidth)}  ${time.padStart(TIME_WIDTH)}  `;
  const indent = ' '.repeat(lead('', '', '').length);
  const lines = [lead('STATUS', 'DEPENDENCY', 'TIME') + 'DETAIL'];
  for (const r of results) {
    lines.push(lead(r.status, r.name, formatMs(r.ms)) + redact(r.detail));
    if (r.remedy && r.status !== 'PASS') lines.push(`${indent}fix: ${redact(r.remedy)}`);
  }
  return lines;
}

export function summaryLine(results: ProbeResult[]): string {
  const t = tally(results);
  const counts = `${t.PASS} PASS, ${t.WARN} WARN, ${t.FAIL} FAIL, ${t.SKIP} SKIP`;
  return exitCode(results)
    ? `Summary: ${counts}. Exit code 1: fix the FAIL rows first, then the WARN rows.`
    : `Summary: ${counts}. Exit code 0${t.WARN ? ': it works, but read the WARN rows' : ''}.`;
}

export function formatReport(header: string[], results: ProbeResult[], redact: (s: string) => string = s => s): string {
  return [...header.map(redact), '', ...formatTable(results, redact), '', summaryLine(results)].join('\n');
}
