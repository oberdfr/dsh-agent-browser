// Pure page-operation helpers. They return page scripts / validate arguments; they never touch Host state.
const engineFail = (code, message) => Object.assign(new Error(message), { code })
const engineRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const DEFAULT_TIMEOUT_MS = 8000
export const MAX_TIMEOUT_MS = 15000
export function boundedTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMEOUT_MS) throw engineFail('INVALID_ARGUMENT', `timeoutMs must be 0–${MAX_TIMEOUT_MS}.`)
  return Math.floor(value)
}
/** Locator: exactly one strategy per call; ambiguity is an error, never "first match". */
export function normalizeLocator(locator) {
  if (!engineRecord(locator)) throw engineFail('INVALID_ARGUMENT', 'locator must be an object with one of ref, css, text, role/name or testId.')
  const keys = Object.keys(locator)
  const strategies = ['ref', 'css', 'text', 'role', 'testId'].filter(key => locator[key] !== undefined)
  if (strategies.length !== 1) throw engineFail('INVALID_ARGUMENT', 'locator needs exactly one strategy: ref, css, text, role or testId.')
  const strategy = strategies[0]
  if (strategy === 'role') { if (typeof locator.role !== 'string' || !locator.role.trim()) throw engineFail('INVALID_ARGUMENT', 'role must be a nonempty string.'); if (locator.name !== undefined && typeof locator.name !== 'string') throw engineFail('INVALID_ARGUMENT', 'name must be a string.') }
  else if (typeof locator[strategy] !== 'string' || !locator[strategy].trim()) throw engineFail('INVALID_ARGUMENT', `${strategy} must be a nonempty string.`)
  for (const key of keys) if (!['ref', 'css', 'text', 'role', 'name', 'testId', 'exact', 'nth'].includes(key)) throw engineFail('INVALID_ARGUMENT', `Unknown locator field "${key}".`)
  if (locator.nth !== undefined && (!Number.isSafeInteger(locator.nth) || locator.nth < 0)) throw engineFail('INVALID_ARGUMENT', 'nth must be a non-negative integer.')
  return Object.freeze({ ...locator })
}
const PAGE_HELPERS = `
  var root = (typeof ShadowRoot === 'undefined') ? null : document;
  var deepAll = function (selector, scope, out) {
    out = out || []; scope = scope || document;
    try { for (var el of scope.querySelectorAll(selector)) out.push(el); } catch (e) { throw new Error('Invalid CSS selector'); }
    var hosts = scope.querySelectorAll('*');
    for (var host of hosts) if (host.shadowRoot) deepAll(selector, host.shadowRoot, out);
    return out;
  };
  var visible = function (el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0; };
  var accessibleName = function (el) {
    var aria = el.getAttribute('aria-label'); if (aria) return aria.trim();
    var labelled = el.getAttribute('aria-labelledby'); if (labelled) { var t = labelled.split(/\\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ').trim(); if (t) return t; }
    if (el.labels && el.labels.length) return Array.from(el.labels).map(function (l) { return l.textContent; }).join(' ').trim();
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  var resolve = function (locator) {
    var matches;
    if (locator.css) matches = deepAll(locator.css);
    else if (locator.text) matches = deepAll('*').filter(function (el) { return el.children.length === 0 && (el.innerText || el.textContent || '').trim() === locator.text.trim(); });
    else if (locator.role) matches = deepAll('[role="' + locator.role + '"],' + locator.role).filter(function (el) { return !locator.name || accessibleName(el) === locator.name; });
    else if (locator.testId) matches = deepAll('[data-testid="' + locator.testId + '"], [data-test-id="' + locator.testId + '"]');
    else throw new Error('LOCATOR_NOT_FOUND');
    matches = matches.filter(function (el) { return document.contains(el) || (el.getRootNode && el.getRootNode().host); });
    if (locator.nth !== undefined) { if (!matches[locator.nth]) throw new Error('AMBIGUOUS_RESOLVED: nth match missing'); return matches[locator.nth]; }
    if (matches.length === 0) throw new Error('LOCATOR_NOT_FOUND');
    if (matches.length > 1) throw new Error('AMBIGUOUS_LOCATOR:' + matches.length);
    return matches[0];
  };
  var rect = function (el) { var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  var hit = function (el) { var r = el.getBoundingClientRect(); var x = r.x + r.width / 2, y = r.y + r.height / 2; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { reachable: false, reason: 'outside-viewport', x: x, y: y }; var top = document.elementFromPoint(x, y); return { reachable: !!top && (top === el || el.contains(top)), x: x, y: y, top: top ? top.tagName : null }; };
`
export function locatorScript(locator, body) {
  const safe = JSON.stringify(normalizeLocator(locator))
  return `(() => { ${PAGE_HELPERS} const locator = ${safe}; const el = resolve(locator); ${body} })()`
}
/** Wait for visibility/enabled/stable geometry/clickable hit point, total bounded timeout. */
export function waitScript(locator, state = 'clickable', timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = boundedTimeout(timeoutMs)
  return `new Promise((resolve, reject) => { ${PAGE_HELPERS} const locator = ${JSON.stringify(normalizeLocator(locator))}; const end = Date.now() + ${timeout}; let lastRect = null, stable = 0;
    const check = () => { try {
      let el; try { el = resolve(locator); } catch (e) { const message = String(e?.message ?? ''); if (message.startsWith('AMBIGUOUS')) return reject(new Error('AMBIGUOUS_LOCATOR')); if ('${state}' === 'detached' && message === 'LOCATOR_NOT_FOUND') return resolve({ ok: true, detached: true }); return again(); }
      const r = rect(el); const vis = visible(el); const en = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      if (lastRect && r.x === lastRect.x && r.y === lastRect.y && r.width === lastRect.width && r.height === lastRect.height) stable++; else stable = 0; lastRect = r;
      const ok = '${state}' === 'visible' ? vis : '${state}' === 'hidden' ? !vis : '${state}' === 'enabled' ? en : '${state}' === 'stable' ? vis && stable >= 2 : vis && en && stable >= 1 && hit(el).reachable;
      if (ok) return resolve({ ok: true, rect: r, hit: hit(el) }); return again();
    } catch (e) { return reject(new Error(String(e?.message ?? 'WAIT_FAILED'))); } };
    const fail = message => reject(new Error(message));
    const again = () => { if (Date.now() >= end) return reject(new Error('WAIT_TIMEOUT')); setTimeout(check, 50); };
    check(); })`
}
export function snapshotScript({ selector, query, maxElements = 120, maxText = 6000 } = {}) {
  const limit = Math.min(400, Math.max(1, Number.isSafeInteger(maxElements) ? maxElements : 120))
  const textLimit = Math.min(20000, Math.max(200, Number.isSafeInteger(maxText) ? maxText : 6000))
  return `(() => { ${PAGE_HELPERS} const scope = ${selector ? `deepAll(${JSON.stringify(String(selector))})[0]` : 'document.body'}; if (!scope) throw new Error('LOCATOR_NOT_FOUND');
    const q = ${query ? JSON.stringify(String(query)) : 'null'};
    const nodes = deepAll('a,button,input,select,textarea,[role],[tabindex],[data-testid],[aria-label]', scope).slice(0, ${limit});
    const elements = nodes.map((el, i) => ({ i, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, name: accessibleName(el).slice(0, 80), testId: el.getAttribute('data-testid'), visible: visible(el), disabled: !!el.disabled, rect: rect(el), hit: hit(el).reachable }));
    let text = (scope.innerText || scope.textContent || '').replace(/\\s+/g, ' ').trim();
    if (q) { const at = text.toLowerCase().indexOf(q.toLowerCase()); text = at < 0 ? '' : text.slice(Math.max(0, at - 200), at + 800); }
    const truncated = text.length > ${textLimit};
    return { url: location.href, title: document.title, text: text.slice(0, ${textLimit}), textTruncated: truncated, elements, elementCount: elements.length, elementLimit: ${limit}, shadowOpenTraversed: true, closedShadowOrCrossOriginFrames: 'not inspected' };
  })()`
}
export function inspectScript(locator, properties = []) {
  const props = Array.isArray(properties) ? properties.filter(value => typeof value === 'string').slice(0, 40) : []
  return `(() => { ${PAGE_HELPERS} const el = resolve(${JSON.stringify(normalizeLocator(locator))}); const s = getComputedStyle(el); const wanted = ${JSON.stringify(props)};
    const styles = {}; for (const p of wanted.length ? wanted : ['display','position','overflow','visibility','opacity','font-family','font-size','color','z-index']) styles[p] = s.getPropertyValue(p);
    const box = { rect: rect(el), client: { w: el.clientWidth, h: el.clientHeight }, scroll: { w: el.scrollWidth, h: el.scrollHeight }, overflow: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight };
    const before = getComputedStyle(el, '::before'), after = getComputedStyle(el, '::after');
    return { tag: el.tagName.toLowerCase(), styles, box, hit: hit(el), font: { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight }, pseudo: { before: { content: before.content, display: before.display }, after: { content: after.content, display: after.display } }, note: 'Computed-style evidence, not a native accessibility tree.' };
  })()`
}
export function evalScript(code, args = {}) {
  if (typeof code !== 'string' || !code.trim() || code.length > 20000) throw engineFail('INVALID_ARGUMENT', 'code must be a nonempty string under 20000 characters.')
  if (!engineRecord(args)) throw engineFail('INVALID_ARGUMENT', 'args must be a JSON object.')
  const stack = [args]
  while (stack.length) {
    const item = stack.pop()
    if (!item || typeof item !== 'object') continue
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw engineFail('INVALID_ARGUMENT', 'args contains an unsafe key.')
      stack.push(child)
    }
  }
  return `(async () => { const __args = ${JSON.stringify(args)}; const __fn = (${code}); return typeof __fn === 'function' ? await __fn(__args) : await __fn; })()`
}
export function boundedSerialize(value, { maxDepth = 6, maxBytes = 65536 } = {}) {
  const seen = new WeakSet()
  const walk = (item, depth) => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') return typeof item === 'string' && item.length > 4096 ? `${item.slice(0, 4096)}[TRUNCATED]` : item
    if (typeof item !== 'object') return `[${typeof item}]`
    if (depth >= maxDepth) return '[DEPTH_LIMIT]'
    if (seen.has(item)) return '[CIRCULAR]'
    seen.add(item)
    try {
      if (Array.isArray(item)) return item.slice(0, 200).map(value => walk(value, depth + 1))
      if (typeof Element !== 'undefined' && item instanceof Element) return { element: item.tagName.toLowerCase(), id: item.id || undefined, text: (item.innerText || '').slice(0, 200) }
      return Object.fromEntries(Object.entries(item).slice(0, 200).map(([key, value]) => [key, walk(value, depth + 1)]))
    } finally { seen.delete(item) }
  }
  const result = walk(value, 0)
  const text = JSON.stringify(result)
  if (text === undefined) return { value: null }
  // Web API only: this module is also inlined into the browser client, where Node's Buffer does not exist.
  return new TextEncoder().encode(text).byteLength > maxBytes ? { truncated: true, preview: text.slice(0, maxBytes / 2) } : { value: result }
}
export function extractScript(kind, selector, maxSteps = 1) {
  if (!['table', 'links', 'forms', 'list'].includes(kind)) throw engineFail('INVALID_ARGUMENT', 'kind must be table, links, forms or list.')
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 20) throw engineFail('INVALID_ARGUMENT', 'maxSteps must be 1–20.')
  const sel = JSON.stringify(String(selector || ''))
  return `(() => { ${PAGE_HELPERS} const nodes = deepAll(${sel}); if (!nodes.length) throw new Error('LOCATOR_NOT_FOUND');
    const kind = ${JSON.stringify(kind)};
    if (kind === 'table') return nodes.slice(0, 10).map(t => ({ rows: Array.from(t.rows).slice(0, 500).map(r => Array.from(r.cells).map(c => (c.innerText || '').trim().slice(0, 500))) }));
    if (kind === 'links') { const seen = new Set(); const out = []; for (const a of nodes.flatMap(n => deepAll('a[href]', n))) { const href = a.href; if (seen.has(href)) continue; seen.add(href); out.push({ text: (a.innerText || '').trim().slice(0, 200), href }); if (out.length >= 1000) break; } return out; }
    if (kind === 'forms') return nodes.map(f => ({ action: f.getAttribute('action'), method: (f.getAttribute('method') || 'get').toUpperCase(), fields: Array.from(f.elements).slice(0, 200).map(e => ({ name: e.name, type: e.type, required: !!e.required })) }));
    return nodes.map(l => Array.from(l.children).slice(0, 500).map(c => (c.innerText || '').trim().slice(0, 300)));
  })()`
}
/** DOM/synthetic input is explicitly not trusted: the result always says so. */
export function inputScript(kind, locator, options = {}) {
  const safe = JSON.stringify(normalizeLocator(locator))
  const text = typeof options.text === 'string' ? options.text.slice(0, 10000) : ''
  const submit = options.submit === true
  const common = `const el = resolve(${safe}); el.scrollIntoView({ block: 'center', inline: 'center' }); const h = hit(el); if (!h.reachable) throw new Error('NOT_REACHABLE');`
  const bodies = {
    click: `${common} el.focus({ preventScroll: true }); el.click(); return { clicked: true, trusted: false, mode: 'dom' };`,
    type: `${common} if (!('value' in el) && !el.isContentEditable) throw new Error('NOT_EDITABLE'); el.focus({ preventScroll: true }); if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); } else { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } ${submit ? "if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();" : ''} return { typed: true, trusted: false, mode: 'dom', submitted: ${submit} };`,
    select: `${common} if (!el.options) throw new Error('NOT_SELECT'); const wanted = ${JSON.stringify(String(options.value ?? ''))}; const option = Array.from(el.options).find(o => o.value === wanted || o.label === wanted); if (!option) throw new Error('OPTION_NOT_FOUND'); el.value = option.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { selected: option.value, trusted: false, mode: 'dom' };`,
    hover: `${common} el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); return { hovered: true, trusted: false, mode: 'dom' };`,
    drag: `${common} const dt = new DataTransfer(); const dragstart = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(dragstart); const target = ${options.target ? `resolve(${JSON.stringify(normalizeLocator(options.target))})` : 'null'}; if (target) { target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt })); target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); } el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt })); return { dragged: true, dropped: !!target, trusted: false, mode: 'dom' };`,
    upload: `${common} if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('NOT_FILE_INPUT'); return { ready: true, trusted: false, mode: 'dom', note: 'Files are assigned by the Host from authorized workspace paths.' };`
  }
  if (!bodies[kind]) throw engineFail('INVALID_ARGUMENT', 'kind must be click, type, select, hover, drag or upload.')
  return `(() => { ${PAGE_HELPERS} ${bodies[kind]} })()`
}
export function touchScript(kind, { x = 0, y = 0, dx = 0, dy = 0, scale = 1 } = {}) {
  if (!['tap', 'swipe', 'pinch'].includes(kind)) throw engineFail('INVALID_ARGUMENT', 'touch kind must be tap, swipe or pinch.')
  for (const value of [x, y, dx, dy, scale]) if (!Number.isFinite(value)) throw engineFail('INVALID_ARGUMENT', 'touch coordinates must be finite.')
  const point = (cx, cy) => ({ identifier: 1, clientX: cx, clientY: cy, pageX: cx, pageY: cy })
  return `(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) throw new Error('NOT_REACHABLE'); const fire = (type, target, points) => target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: points, targetTouches: points, changedTouches: points })); const p = ${JSON.stringify(point(x, y))};
    if ('${kind}' === 'tap') { fire('touchstart', el, [p]); fire('touchend', el, []); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return { tapped: true, experimental: true, realDevice: false }; }
    if ('${kind}' === 'swipe') { fire('touchstart', el, [p]); fire('touchmove', el, [${JSON.stringify(point(0, 0))}]); fire('touchend', el, []); return { swiped: true, experimental: true, realDevice: false }; }
    fire('touchstart', el, [p]); fire('touchend', el, []); return { pinched: true, experimental: true, realDevice: false, note: 'Synthetic pinch is not a real multi-touch device.' }; })()`
}
export function animationScript(action, { selector, value } = {}) {
  if (!['list', 'pause', 'play', 'rate', 'seek'].includes(action)) throw engineFail('INVALID_ARGUMENT', 'animation action must be list, pause, play, rate or seek.')
  const target = selector ? `document.querySelector(${JSON.stringify(String(selector))})` : 'document'
  return `(() => { const animations = ${target}.getAnimations ? ${target}.getAnimations({ subtree: true }) : []; const action = ${JSON.stringify(action)};
    if (action === 'list') return animations.slice(0, 100).map(a => ({ id: a.id, playState: a.playState, currentTime: a.currentTime, duration: a.effect?.getTiming?.().duration, target: a.effect?.target?.tagName }));
    for (const a of animations) { if (action === 'pause') a.pause(); else if (action === 'play') a.play(); else if (action === 'rate') a.playbackRate = ${Number(value) || 1}; else if (action === 'seek') a.currentTime = ${Math.max(0, Number(value) || 0)}; }
    return { action, affected: animations.length, note: 'Web Animations API only; timers, canvas/WebGL and library-internal animation are not controlled.' }; })()`
}
export function performanceScript() {
  return `(async () => { const out = { metrics: {}, resources: 0, gaps: ['No CPU/heap profiler or Chromium tracing; long-task and layout-shift coverage depends on the browser.'] };
    const collect = (type, limit = 200) => new Promise(resolve => { let done = false; const finish = list => { if (done) return; done = true; resolve(list.getEntries().slice(-limit)); }; try { const po = new PerformanceObserver(list => finish(list)); po.observe({ type, buffered: true }); setTimeout(() => { po.disconnect(); finish({ getEntries: () => [] }); }, 250); } catch { resolve([]); } });
    for (const type of ['paint', 'largest-contentful-paint', 'layout-shift', 'longtask', 'navigation']) { const entries = await collect(type); out.metrics[type] = entries.map(e => ({ name: e.name, startTime: Math.round(e.startTime), duration: Math.round(e.duration || 0), value: e.value })).slice(0, 50); }
    out.resources = performance.getEntriesByType('resource').length; return out; })()`
}
export const ENGINE_LIMITS = Object.freeze({ shadowClosed: 'not inspectable', crossOriginFrames: 'not inspectable', nonDomContent: 'canvas/WebGL pixels not extractable', timeoutStopsWaitingOnly: true })
