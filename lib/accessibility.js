// On-demand accessibility audit. Rules run as a page script over the rendered DOM; the result is evidence,
// not a native accessibility-tree dump, and it never injects a permanent library into the page.
const a11yFail = (code, message) => Object.assign(new Error(message), { code })
export const A11Y_RULES = Object.freeze(['image-alt', 'label', 'button-name', 'link-name', 'heading-order', 'duplicate-id', 'lang', 'tabindex-positive', 'aria-hidden-focus', 'color-contrast', 'touch-target'])
export const A11Y_LIMITS = Object.freeze({ maxFindings: 200, maxElements: 5000, vendorLibrary: false })
export function auditScript({ rules = A11Y_RULES, selector } = {}) {
  const selected = Array.isArray(rules) ? rules.filter(rule => A11Y_RULES.includes(rule)) : A11Y_RULES
  if (selected.length === 0) throw a11yFail('INVALID_ARGUMENT', `rules must include at least one of ${A11Y_RULES.join(', ')}.`)
  return `(() => {
  const rules = ${JSON.stringify(selected)};
  const scope = ${selector ? `document.querySelector(${JSON.stringify(String(selector))})` : 'document.body'};
  if (!scope) throw new Error('LOCATOR_NOT_FOUND');
  const all = Array.from(scope.querySelectorAll('*')).slice(0, ${A11Y_LIMITS.maxElements});
  const findings = [];
  const add = (rule, el, detail) => { if (findings.length < ${A11Y_LIMITS.maxFindings}) findings.push({ rule, tag: el.tagName.toLowerCase(), detail, selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/)[0] : '') }); };
  const name = el => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
  const parse = color => { const m = /rgba?\\(([^)]+)\\)/.exec(color || ''); if (!m) return null; const parts = m[1].split(',').map(Number); return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }; };
  const luminance = c => { const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const background = el => { let node = el; while (node && node !== document.documentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a > 0) return c; node = node.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
  let lastHeading = 0;
  const ids = new Map();
  for (const el of all) {
    if (rules.includes('image-alt') && el.tagName === 'IMG' && !el.hasAttribute('alt')) add('image-alt', el, 'img without alt');
    if (rules.includes('label') && ['INPUT','SELECT','TEXTAREA'].includes(el.tagName) && !['hidden','submit','button','image','reset'].includes(el.type) && !name(el) && !(el.labels && el.labels.length) && !el.getAttribute('aria-labelledby')) add('label', el, 'form control without accessible name');
    if (rules.includes('button-name') && el.tagName === 'BUTTON' && !name(el) && !el.getAttribute('title')) add('button-name', el, 'button without accessible name');
    if (rules.includes('link-name') && el.tagName === 'A' && el.hasAttribute('href') && !name(el)) add('link-name', el, 'link without accessible name');
    if (rules.includes('heading-order') && /^H[1-6]$/.test(el.tagName)) { const level = Number(el.tagName[1]); if (lastHeading && level > lastHeading + 1) add('heading-order', el, 'heading level jumps from ' + lastHeading + ' to ' + level); lastHeading = level; }
    if (rules.includes('duplicate-id') && el.id) { if (ids.has(el.id)) add('duplicate-id', el, 'duplicate id ' + el.id); else ids.set(el.id, true); }
    if (rules.includes('tabindex-positive') && Number(el.getAttribute('tabindex')) > 0) add('tabindex-positive', el, 'positive tabindex');
    if (rules.includes('aria-hidden-focus') && el.getAttribute('aria-hidden') === 'true' && el.querySelector('a[href],button,input,select,textarea,[tabindex]')) add('aria-hidden-focus', el, 'focusable content inside aria-hidden');
    if (rules.includes('color-contrast') && el.children.length === 0 && name(el)) {
      const style = getComputedStyle(el); const fg = parse(style.color); const bg = background(el);
      if (fg && bg) { const l1 = luminance(fg), l2 = luminance(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); const size = parseFloat(style.fontSize); const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700); if (ratio < (large ? 3 : 4.5)) add('color-contrast', el, 'contrast ' + ratio.toFixed(2) + ':1'); }
    }
    if (rules.includes('touch-target')) { const r = el.getBoundingClientRect(); if ((el.tagName === 'BUTTON' || (el.tagName === 'A' && el.hasAttribute('href'))) && r.width > 0 && (r.width < 24 || r.height < 24)) add('touch-target', el, 'target ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  }
  if (rules.includes('lang') && !document.documentElement.getAttribute('lang')) add('lang', document.documentElement, 'html element has no lang');
  return { url: location.href, rules, findings, scanned: all.length, truncated: all.length >= ${A11Y_LIMITS.maxElements}, coverage: 'Rendered DOM rules only; not a native accessibility tree, and no external library was loaded.' };
})()`
}
/** Summarize findings by rule so repeated problems do not flood the result. */
export function summarizeAudit(audit) {
  if (!audit || !Array.isArray(audit.findings)) throw a11yFail('INVALID_ARGUMENT', 'An audit result is required.')
  const groups = new Map()
  for (const finding of audit.findings) {
    const group = groups.get(finding.rule) ?? { rule: finding.rule, count: 0, samples: [] }
    group.count++
    if (group.samples.length < 3) group.samples.push(finding)
    groups.set(finding.rule, group)
  }
  return { url: audit.url, scanned: audit.scanned, truncated: audit.truncated === true, total: audit.findings.length, groups: [...groups.values()].sort((a, b) => b.count - a.count), coverage: audit.coverage }
}
export const A11Y_POLICY = Object.freeze({ onDemandOnly: true, noPermanentInjection: true, noExternalNetwork: true, vendorLibraryBundled: false })
