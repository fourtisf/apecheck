/**
 * ApeCheck is independent: no source file names the third-party coin services it was once wired to. The one exception
 * is the retired-names block in labels.ts that maps data stored back then (step source tags, their "unavailable"
 * lines, old free text and stub lists) to ApeCheck's own wording when it is shown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RETIRED = /fourtis|devradar|bundlescan|whaleflow/i;
const LABELS = path.join(ROOT, 'packages/core/src/labels.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.next')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|css|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** labels.ts without its retired-names block (between the "// retired-names:begin" and "// retired-names:end" lines) */
function labelsOutsideTable(src: string): string {
  const start = src.indexOf('// retired-names:begin');
  const end = src.indexOf('// retired-names:end');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // one block only
  expect(src.indexOf('// retired-names:begin', start + 1)).toBe(-1);
  return src.slice(0, start) + src.slice(end);
}

describe('no third-party coin service in the source', () => {
  it('apps/*/src and packages/*/src never name them, except the display mapping for old steps', () => {
    const roots = ['apps', 'packages'].flatMap(top =>
      fs
        .readdirSync(path.join(ROOT, top), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(ROOT, top, d.name, 'src'))
        .filter(p => fs.existsSync(p)),
    );
    expect(roots.length).toBeGreaterThanOrEqual(6);
    const hits: string[] = [];
    for (const file of roots.flatMap(r => walk(r))) {
      let text = fs.readFileSync(file, 'utf8');
      if (file === LABELS) text = labelsOutsideTable(text);
      text.split('\n').forEach((line, i) => {
        if (RETIRED.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
