// Small shared helpers: seeded RNG, hashing, normalization, safe stat expressions.

export function hashStr(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** mulberry32 seeded RNG. Same seed -> same sequence (swipes never reroll). */
export function makeRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : parseInt(hashStr(seed).slice(0, 8), 36) >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    chance: p => next() < p,
    pick: list => list[Math.floor(next() * list.length)],
    d100: () => Math.floor(next() * 100) + 1,
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const norm = s => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[\s_\-·.,'"`~!?()[\]{}<>:;/\\|]+/g, '');
export const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
export const num = (v, d = 0) => {
  if (v == null || v === '' || typeof v === 'boolean') return d;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%]/g, ''));
  return Number.isFinite(n) ? n : d;
};
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
export const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Safe arithmetic over stat names: "(END+INT)/2", "STR*1.2", "AGI". No eval.
 * Unknown names count as 0.
 */
export function evalExpr(expr, vars) {
  const src = String(expr ?? '').trim();
  if (!src) return 0;
  const tokens = src.match(/\d+(?:\.\d+)?|[A-Za-z가-힣_][A-Za-z0-9가-힣_]*|[+\-*/()]/g) ?? [];
  let i = 0;
  const lookup = name => {
    if (Object.hasOwn(vars, name)) return num(vars[name]);
    const key = Object.keys(vars).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? num(vars[key]) : 0;
  };
  const primary = () => {
    const t = tokens[i++];
    if (t === '(') { const v = sum(); i++; return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t == null) return 0;
    if (/^\d/.test(t)) return Number(t);
    return lookup(t);
  };
  const product = () => {
    let v = primary();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++]; const r = primary();
      v = op === '*' ? v * r : (r === 0 ? 0 : v / r);
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++]; const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try { const v = sum(); return Number.isFinite(v) ? v : 0; } catch { return 0; }
}

/** Pull the first JSON object/array out of an LLM answer (code fences, chatter tolerated). */
/**
 * Pull the JSON out of a model reply. Handles ```json fences (closed or not), <think> blocks,
 * trailing commas, and replies cut off by the token limit (keeps every element that was complete).
 */
export function extractJson(text) {
  let s = String(text ?? '');
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)(?:```|$)/.exec(s);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(s);
  for (const c of candidates) {
    const start = c.search(/[{[]/);
    if (start < 0) continue;
    const body = c.slice(start);
    const whole = balanced(body);
    if (whole != null) { const v = parseLoose(whole); if (v !== undefined) return v; }
    const salvaged = salvage(body);
    if (salvaged !== undefined) { if (salvaged && typeof salvaged === 'object') Object.defineProperty(salvaged, '__truncated', { value: true }); return salvaged; }
  }
  return null;
}

function parseLoose(t) {
  for (const x of [t, t.replace(/,\s*([}\]])/g, '$1')]) { try { return JSON.parse(x); } catch { /* next */ } }
  return undefined;
}

/** The first complete {...} or [...] value, or null if the text ends before it closes. */
function balanced(c) {
  const open = c[0], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let j = 0; j < c.length; j++) {
    const ch = c[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return c.slice(0, j + 1);
  }
  return null;
}

/** A truncated reply: cut back to the last complete element and close every open bracket. */
function salvage(c) {
  const cuts = [];           // [index after a complete element, stack at that point]
  const stack = [];
  let inStr = false, esc = false;
  for (let j = 0; j < c.length; j++) {
    const ch = c[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') { stack.pop(); cuts.push([j + 1, [...stack]]); if (!stack.length) break; }
    else if (ch === ',') cuts.push([j, [...stack]]);
  }
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 80; k--, tries++) {
    const [at, st] = cuts[k];
    const tail = st.slice().reverse().map(x => (x === '{' ? '}' : ']')).join('');
    const v = parseLoose(c.slice(0, at).replace(/,\s*$/, '') + tail);
    if (v !== undefined) return v;
  }
  return undefined;
}

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
