/**
 * Code that runs inside the checked page. Kept as plain JS strings: functions passed to page.evaluate
 * are serialised from their source, and transpiler helpers would not exist in the page.
 * These scripts only read the DOM (plus a data attribute used to target clicks); they never send anything.
 *
 * SUMMARY / PROBE / TEXT run in an isolated world (page.ts readPage): the page shares the DOM with them but
 * can't redefine the builtins or DOM getters they see, so the length caps below hold. Every field is capped
 * here and clamped again on the Node side.
 */

/**
 * Counts meaningful DOM changes (added/removed elements, text edits) for dead-button detection. Installed
 * lazily by the first probe of each document, in the same isolated world that reads it.
 */
const OBSERVE = `
  const mutState = (() => {
    if (window.__apecheckMut) return window.__apecheckMut;
    const state = { added: 0, removed: 0, text: 0 };
    window.__apecheckMut = state;
    try {
      new MutationObserver(list => {
        for (const m of list) {
          if (m.type === 'childList') {
            for (const n of m.addedNodes) if (n.nodeType === 1 || (n.nodeType === 3 && n.textContent && n.textContent.trim())) state.added++;
            for (const n of m.removedNodes) if (n.nodeType === 1) state.removed++;
          } else if (m.type === 'characterData') state.text++;
        }
      }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
    return state;
  })();
`;

const HELPERS = `
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05;
  };
  const clean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const cut = (s, n) => String(s == null ? '' : s).slice(0, n);
  const textOf = (el) => clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || (el.querySelector && el.querySelector('img[alt]') ? el.querySelector('img[alt]').alt : ''), 80);
  const findModal = () => {
    const explicit = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]')];
    // class names alone ("modal-trigger" buttons) are not dialogs: also require an overlay-like box
    const byClass = [...document.querySelectorAll('[class*=modal i],[class*=popup i],[class*=dialog i]')].filter(m => {
      const cs = getComputedStyle(m), r = m.getBoundingClientRect();
      return (cs.position === 'fixed' || cs.position === 'absolute') && r.width * r.height > 40000;
    });
    const all = [...explicit, ...byClass].filter(m => vis(m) && clean(m.innerText, 20).length > 0);
    // the innermost visible one (later in DOM order usually sits on top)
    return all.filter(m => !all.some(o => o !== m && m.contains(o))).pop() || null;
  };
`;

/** Numbered visible buttons/links/inputs (also tags them with data-apecheck-id for clicking). */
export const SUMMARY_SCRIPT = `((opts) => {
  ${HELPERS}
  const maxEls = opts.maxEls || 80;
  document.querySelectorAll('[data-apecheck-id]').forEach(e => e.removeAttribute('data-apecheck-id'));
  const modal = findModal();
  const sel = 'a[href],button,[role=button],[role=link],[role=menuitem],[role=tab],input[type=submit],input[type=button],summary,[onclick]';
  const raw = [];
  let id = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (raw.length >= 400) break;
    if (!vis(el)) continue;
    const text = textOf(el);
    if (!text) continue;
    const parent = el.parentElement && el.parentElement.closest('[data-apecheck-id]');
    if (parent && textOf(parent) === text) continue;
    id++;
    el.setAttribute('data-apecheck-id', String(id));
    const r = el.getBoundingClientRect();
    const isLink = el.tagName === 'A' || el.getAttribute('role') === 'link';
    raw.push({
      id, kind: isLink ? 'link' : 'button', text,
      href: el.tagName === 'A' && el.href ? cut(el.href, 500) : null,
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      inViewport: r.top < innerHeight && r.bottom > 0,
      inModal: !!(modal && modal.contains(el)),
    });
  }
  const els = raw
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Number(b.e.inModal) - Number(a.e.inModal) || Number(b.e.inViewport) - Number(a.e.inViewport) || a.i - b.i)
    .slice(0, maxEls).map(x => x.e);
  const inputs = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select')) {
    if (inputs.length >= 20) break;
    if (!vis(el)) continue;
    id++;
    el.setAttribute('data-apecheck-id', String(id));
    const lab = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    inputs.push({ id, type: (el.getAttribute('type') || el.tagName).toLowerCase(), label: clean(el.getAttribute('placeholder') || el.getAttribute('aria-label') || lab || el.name, 60) });
  }
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(h => clean(h.innerText, 120)).filter(Boolean).slice(0, 10);
  return {
    url: cut(location.href, 2000),
    title: clean(document.title, 160),
    headings,
    elements: els,
    inputs,
    modalText: modal ? clean(modal.innerText, 1500) : null,
    textSample: clean(document.body ? document.body.innerText : '', 2000),
  };
})`;

/** Light probe for before/after comparisons around an action. */
export const PROBE_SCRIPT = `(() => {
  ${HELPERS}
  ${OBSERVE}
  const modal = findModal();
  const m = mutState;
  const text = document.body ? String(document.body.innerText || '') : '';
  return {
    url: cut(location.href, 2000),
    title: clean(document.title, 160),
    text: text.slice(0, 30000),
    textLen: text.length,
    modalText: modal ? clean(modal.innerText, 1500) : null,
    added: m.added, removed: m.removed, textEdits: m.text,
    emailInput: [...document.querySelectorAll('input[type=email],input[name*=mail i],input[placeholder*=mail i]')].some(vis),
    amountInput: [...document.querySelectorAll('input[inputmode=decimal],input[type=number],input[placeholder*="0.0"],input[placeholder="0"],input[name*=amount i],input[placeholder*=amount i]')].some(vis),
    connectButton: [...document.querySelectorAll('button,[role=button],a')].some(b => vis(b) && /connect( a| your)? wallet|^connect$/i.test(clean(b.innerText, 40))),
    h1: clean((document.querySelector('h1') || {}).innerText, 120),
  };
})()`;

/** Hero (above the fold), footer and full visible text, grouped by block so sentences stay whole. */
export const TEXT_SCRIPT = `(() => {
  ${HELPERS}
  const H = innerHeight;
  const footerEl = document.querySelector('footer,[role=contentinfo]');
  const docH = document.documentElement.scrollHeight;
  const disp = new WeakMap();
  const isInline = (el) => { if (!disp.has(el)) disp.set(el, getComputedStyle(el).display); const d = disp.get(el); return d === 'inline' || d === 'contents' || d === 'inline-block' && !el.children.length; };
  const blockOf = (el) => { let e = el; while (e && e !== document.body && isInline(e)) e = e.parentElement; return e || document.body; };
  const skip = (el) => !!el.closest('a,button,nav,[role=button],[role=navigation],[role=menu],select,label,script,style,noscript,svg,[aria-hidden=true],header nav');
  const blocks = new Map();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n, count = 0;
  while ((n = walker.nextNode()) && count < 6000) {
    count++;
    const t = n.textContent.replace(/\\s+/g, ' ');
    if (!t.trim()) continue;
    const el = n.parentElement;
    if (!el || skip(el) || !vis(el)) continue;
    const b = blockOf(el);
    const cur = blocks.get(b);
    if (cur) cur.parts.push(t); else blocks.set(b, { parts: [t], top: b.getBoundingClientRect().top + scrollY, el: b });
  }
  const hero = [], footer = [];
  for (const { parts, top, el } of blocks.values()) {
    const text = parts.join('').replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    if (footerEl && footerEl.contains(el)) footer.push(text);
    else if (top < H) hero.push(text);
    else if (!footerEl && top > docH - H * 0.35) footer.push(text);
  }
  const links = [...document.querySelectorAll('a[href]')].slice(0, 500).map(a => ({ href: cut(a.href, 500), text: textOf(a) }));
  const metaMod = document.querySelector('meta[property="article:modified_time"],meta[property="og:updated_time"],meta[name="last-modified"],meta[itemprop="dateModified"]');
  const times = [...document.querySelectorAll('time[datetime]')].slice(0, 20).map(t => { const v = t.getAttribute('datetime'); return v == null ? null : cut(v, 100); });
  return {
    title: clean(document.title, 160),
    hero: hero.join('\\n').slice(0, 6000),
    footer: footer.join('\\n').slice(0, 3000),
    text: (document.body ? String(document.body.innerText || '') : '').slice(0, 20000),
    links,
    modified: metaMod && metaMod.getAttribute('content') != null ? cut(metaMod.getAttribute('content'), 100) : null,
    times,
    codeBlocks: document.querySelectorAll('pre, code').length,
  };
})()`;

/** Navigation timing of the current document (ms), 0 when unknown. */
export const LOAD_MS_SCRIPT = `(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? Math.round(n.loadEventEnd || n.domContentLoadedEventEnd || 0) : 0; })()`;

/**
 * Put an amount into the first empty amount field so a main-action button can be tried. Runs in the page's
 * main world (the page's own listeners must see the input) and only ever returns true / false.
 */
export const FILL_AMOUNT_SCRIPT = `(() => {
  ${HELPERS}
  const el = [...document.querySelectorAll('input[inputmode=decimal],input[type=number],input[placeholder*="0.0"],input[placeholder="0"],input[name*=amount i],input[placeholder*=amount i]')]
    .find(i => vis(i) && !i.disabled && !i.readOnly && !i.value);
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, '0.001');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
