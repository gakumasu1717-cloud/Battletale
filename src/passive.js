// Safe sandboxed runtime for LLM-coded per-character custom passives.
// Defense-in-depth:
//   1. Strict JS tokenizer + ALLOWLIST validator: only ctx / fx / Math / own variables and a fixed list of property
//      names; no dynamic brackets, no loops/functions, assignment only to own variables
//   2. Strict-mode Function compilation with shadowed globals + frozen safe Math (no Math.random); the code's own
//      names are parameters too, so nothing it writes can resolve to a page global
//   3. Read-only snapshot context (cannot mutate battle objects directly)
//   4. Bounded, engine-clamped effect collector (fx.*) with per-turn & per-battle caps
//   5. Deterministic seeded RNG + dry-run self-test across all hooks

import { STATUS } from './catalog.js';
import { clamp } from './util.js';

export const PASSIVE_HOOKS = [
  'battleStart', 'turnStart', 'beforeAttack', 'afterAttack',
  'beforeHit', 'afterHit', 'turnEnd', 'onKill', 'onAllyDown',
];

const MAX_CODE_LEN = 1500;
const MAX_CODE_LINES = 40;
const VALID_STATS = new Set(['pow', 'mag', 'def', 'res', 'spd', 'acc', 'eva', 'luk']);
const HARD_CC = new Set(['stun', 'freeze', 'sleep', 'confuse', 'fear']);
const SOFT_CC = new Set(['blind', 'silence']);
const SELF_BUFF_STATUS = new Set(['regen', 'shield', 'taunt']);
const DEBUFF_STATUS = new Set(['burn', 'poison', 'bleed', 'stun', 'freeze', 'sleep', 'blind', 'silence', 'confuse', 'fear', 'vulnerable', 'mark']);

const nullObj = o => Object.freeze(Object.assign(Object.create(null), o));

const SAFE_MATH = nullObj({
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, abs: Math.abs, pow: Math.pow, sqrt: Math.sqrt,
  sign: Math.sign, trunc: Math.trunc,
});

const SHADOW_NAMES = [
  'window', 'document', 'globalThis', 'self', 'top', 'parent', 'frames',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker',
  'localStorage', 'sessionStorage', 'indexedDB', 'location', 'history', 'navigator',
  'Function', 'Object', 'Array', 'BigInt', 'Proxy', 'Reflect', 'Symbol', 'RegExp', 'Date', 'Promise',
  'SillyTavern', 'jQuery', 'console', 'alert', 'confirm', 'prompt',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'process', 'global', 'require', 'module', 'exports', 'Buffer',
];

// Minimal JS tokenizer for strict security validation (zero dependencies).
function tokenize(code) {
  const tokens = [];
  let i = 0, n = code.length;
  const isIdStart = ch => /[a-zA-Z_$]/.test(ch);
  const isIdPart = ch => /[a-zA-Z0-9_$]/.test(ch);
  const exprEnd = tok => tok && (tok.type === 'id' || tok.type === 'num' || tok.type === 'str' || tok.v === ')' || tok.v === ']');

  while (i < n) {
    const ch = code[i];
    if (/\s/.test(ch)) { i++; continue; }
    // Comments
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return { error: '닫히지 않은 주석(/* ... */)이 있어요.' };
      i = end + 2;
      continue;
    }
    // Backticks blocked (tagged templates / interpolation tricks)
    if (ch === '`') return { error: '보안상 템플릿 문자열(백틱 `)은 사용할 수 없어요. 작은따옴표/큰따옴표를 쓰세요.' };
    // String literals
    if (ch === "'" || ch === '"') {
      const q = ch;
      let j = i + 1, s = '';
      while (j < n && code[j] !== q) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '\n' || code[j] === '\r') return { error: '문자열 안에 줄바꿈이 있어요.' };
        s += code[j++];
      }
      if (j >= n) return { error: '닫히지 않은 문자열이 있어요.' };
      tokens.push({ type: 'str', v: s });
      i = j + 1;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
      let j = i;
      if (ch === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X' || code[i + 1] === 'b' || code[i + 1] === 'o')) {
        return { error: '10진수 숫자만 사용할 수 있어요.' };
      }
      while (j < n && /[0-9.]/.test(code[j])) j++;
      if (code[j] === 'e' || code[j] === 'E') return { error: '지수 표기 숫자는 사용할 수 없어요.' };
      tokens.push({ type: 'num', v: code.slice(i, j) });
      i = j;
      continue;
    }
    // Identifiers
    if (isIdStart(ch)) {
      let j = i + 1;
      while (j < n && isIdPart(code[j])) j++;
      tokens.push({ type: 'id', v: code.slice(i, j) });
      i = j;
      continue;
    }
    // Arrow function '=>' blocked explicitly
    if (ch === '=' && code[i + 1] === '>') {
      return { error: '보안상 화살표 함수(=>)는 사용할 수 없어요.' };
    }
    // Regex literal detection: '/' not preceded by expression end
    if (ch === '/') {
      const prev = tokens[tokens.length - 1];
      if (!exprEnd(prev)) return { error: '보안상 정규식 리터럴(/.../)은 사용할 수 없어요.' };
    }
    // Multi-char punctuators
    const three = code.slice(i, i + 3);
    if (three === '===' || three === '!==' || three === '...') {
      if (three === '...') return { error: '전개 연산자(...)는 사용할 수 없어요.' };
      tokens.push({ type: 'punc', v: three });
      i += 3;
      continue;
    }
    const two = code.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '++', '--'].includes(two)) {
      tokens.push({ type: 'punc', v: two });
      i += 2;
      continue;
    }
    // Single-char punctuators
    if ('(){}[];:,.+-*/%<>=!?'.includes(ch)) {
      tokens.push({ type: 'punc', v: ch });
      i++;
      continue;
    }
    return { error: `허용되지 않은 문자(${ch})가 포함되어 있어요.` };
  }
  return { tokens };
}

/* ---------- Allowlist (everything not listed here is rejected) ---------- */
// Blocklists cannot work in a browser: every element id is a global (`chat.innerHTML = …`), every library the host
// page loads is a global (`localforage.clear()`), and `?.[` reaches `constructor`. So a name must be KNOWN to be safe.
const KEYWORDS = new Set(['if', 'else', 'const', 'let', 'return', 'typeof']);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const SAFE_GLOBALS = ['Number', 'String', 'Boolean'];
const ROOTS = new Set(['ctx', 'fx', 'Math', ...SAFE_GLOBALS]);
const SAFE_PROPS = new Set([
  // ctx
  'hook', 'turn', 'isBoss', 'allyCount', 'foeCount', 'self', 'target', 'attacker', 'victim', 'fallen', 'skill',
  'dmg', 'crit', 'eff', 'effMul', 'ko', 'fatal', 'hit', 'firstHit', 'mem', 'hasStatus', 'stageOf', 'rng', 'chance',
  // fighter snapshot
  'name', 'hp', 'maxHp', 'hpPct', 'sp', 'maxSp', 'spPct', 'row', 'tier', 'elements', 'statuses', 'statusCount',
  'hasDebuff', 'hasBuff', 'down',
  // skill snapshot
  'kind', 'element', 'power', 'range', 'isBasic', 'hits', 'priority',
  // fx
  'dmgMul', 'dmgFlat', 'heal', 'stage', 'status', 'counter', 'endure', 'flag', 'log',
  // Math
  'min', 'max', 'floor', 'ceil', 'round', 'abs', 'pow', 'sqrt', 'sign', 'trunc',
  // read-only string / array helpers
  'length', 'includes', 'indexOf', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'trim', 'slice', 'at',
]);
const NEVER_NAMES = new Set(['constructor', 'prototype', '__proto__', 'eval', 'arguments', 'callee', 'caller']);
const KNOWN_BAD_SYNTAX = new Set([
  'while', 'for', 'do', 'function', 'class', 'extends', 'super', 'new', 'this', 'with', 'delete', 'try', 'catch',
  'finally', 'throw', 'async', 'await', 'yield', 'import', 'export', 'debugger', 'void', 'in', 'instanceof', 'var', 'switch', 'case',
]);
const MEM_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/;
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=']);

/** Tokenize + allowlist check. Returns { ok, error?, locals? } — locals are the names the code declares. */
function analyze(code) {
  if (typeof code !== 'string') return { ok: false, error: '코드가 문자열이 아니에요.' };
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: '코드가 비어 있어요.' };
  if (trimmed.length > MAX_CODE_LEN) return { ok: false, error: `코드가 너무 길어요 (${trimmed.length}/${MAX_CODE_LEN}자).` };
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > MAX_CODE_LINES) return { ok: false, error: `코드 줄 수가 너무 많아요 (${lines.length}/${MAX_CODE_LINES}줄).` };

  const lex = tokenize(trimmed);
  if (lex.error) return { ok: false, error: lex.error };
  const toks = lex.tokens;
  if (!toks.length) return { ok: false, error: '실행할 코드가 없어요.' };
  const fail = error => ({ ok: false, error });
  const exprEnd = tok => tok && (tok.type === 'id' || tok.type === 'num' || tok.type === 'str' || tok.v === ')' || tok.v === ']');
  const isDot = tok => tok?.type === 'punc' && (tok.v === '.' || tok.v === '?.');

  // Pass 1: names declared with const/let.
  const locals = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'id' || (t.v !== 'const' && t.v !== 'let') || isDot(toks[i - 1])) continue;
    const name = toks[i + 1];
    if (name?.type !== 'id') return fail('보안상 구조 분해 선언은 사용할 수 없어요. const 이름 = 값 형태만 쓰세요.');
    if (KEYWORDS.has(name.v) || LITERALS.has(name.v) || ROOTS.has(name.v) || NEVER_NAMES.has(name.v) || KNOWN_BAD_SYNTAX.has(name.v) || name.v.length > 24) {
      return fail(`'${name.v}'은(는) 변수 이름으로 쓸 수 없어요.`);
    }
    locals.add(name.v);
  }

  // Pass 2: every token must be something we know.
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], prev = toks[i - 1], next = toks[i + 1];
    if (t.type === 'id') {
      if (NEVER_NAMES.has(t.v)) return fail(`보안상 '${t.v}' 식별자는 사용할 수 없어요.`);
      if (isDot(prev)) {
        // Property name: known API field, or a key read straight off ctx.mem.
        const isMemKey = toks[i - 2]?.v === 'mem' && isDot(toks[i - 3]) && toks[i - 4]?.v === 'ctx' && !isDot(toks[i - 5]);
        if (isMemKey ? !(MEM_KEY.test(t.v) && !t.v.startsWith('__')) : !SAFE_PROPS.has(t.v)) {
          return fail(`'.${t.v}'은(는) 허용된 속성이 아니에요. 안내된 ctx.* / fx.* / Math.* 만 쓰세요 (저장값은 ctx.mem.키 로 바로 읽기).`);
        }
        continue;
      }
      if (KNOWN_BAD_SYNTAX.has(t.v)) return fail(`보안·안정성상 '${t.v}' 문법은 사용할 수 없어요.`);
      if (KEYWORDS.has(t.v) || LITERALS.has(t.v) || ROOTS.has(t.v) || locals.has(t.v)) continue;
      return fail(`'${t.v}'은(는) 쓸 수 없는 이름이에요. ctx, fx, Math와 const/let으로 직접 선언한 변수만 쓸 수 있어요.`);
    }
    if (t.type !== 'punc') {
      // Block string-keyed property syntax (`'constructor': ...`)
      if (t.type === 'str' && next?.type === 'punc' && next.v === ':' && !(prev?.v === '?')) {
        // `cond ? 'a' : 'b'` is fine; a string directly followed by ':' anywhere else is an object key.
        let depth = 0, ternary = false;
        for (let k = i - 1; k >= 0 && !ternary; k--) {
          const v = toks[k].type === 'punc' ? toks[k].v : '';
          if (v === ')' || v === ']') depth++;
          else if (v === '(' || v === '[') { if (depth === 0) break; depth--; }
          else if (v === ';' || v === '{' || v === '}') break;
          else if (v === '?' && depth === 0) ternary = true;
        }
        if (!ternary) return fail('보안상 문자열 키 문법은 사용할 수 없어요.');
      }
      continue;
    }
    if ((t.v === '.' || t.v === '?.') && next?.type !== 'id') {
      return fail('보안상 점(.) 뒤에는 속성 이름만 올 수 있어요 (?.[ ] 나 ?.( ) 금지).');
    }
    // Braces are ONLY block statements (no object literals / destructuring).
    if (t.v === '{') {
      const isBlock = !prev || prev.v === ')' || prev.v === ';' || prev.v === '{' || prev.v === '}' || (prev.type === 'id' && prev.v === 'else');
      if (!isBlock) return fail('보안상 객체 리터럴 및 구조 분해({ ... })는 사용할 수 없어요. 점 표기(ctx.prop)만 쓰세요.');
    }
    // obj[...] only with one small integer literal; a bare [ ... ] is an array literal.
    if (t.v === '[' && exprEnd(prev)) {
      if (prev.type === 'id' && (prev.v === 'const' || prev.v === 'let')) return fail('보안상 배열 구조 분해(const [...])는 사용할 수 없어요.');
      const inner = toks[i + 1], close = toks[i + 2];
      if (!(inner?.type === 'num' && /^\d{1,2}$/.test(inner.v) && close?.type === 'punc' && close.v === ']')) {
        return fail('보안상 동적 속성 접근(obj[expr])은 허용되지 않아요. 점 표기(obj.prop)나 숫자 인덱스([0])만 쓰세요.');
      }
    }
    // Assignment only to a plain local variable — never to a property of anything.
    if (ASSIGN_OPS.has(t.v)) {
      if (!(prev?.type === 'id' && locals.has(prev.v) && !isDot(toks[i - 2]))) {
        return fail('값 대입은 const/let으로 선언한 변수에만 할 수 있어요 (ctx·fx 속성은 읽기 전용).');
      }
    }
    if (t.v === '++' || t.v === '--') return fail("'++' / '--' 대신 x += 1 형태를 쓰세요.");
  }

  // Syntax check, compiled exactly the way it will run.
  try {
    build(trimmed, [...locals]);
  } catch (e) {
    return fail(`문법 오류: ${e.message}`);
  }
  return { ok: true, locals: [...locals] };
}

/**
 * Static security & syntax check for LLM-generated passive code.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export function validatePassiveCode(code) {
  const r = analyze(code);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

const SAFE_GLOBAL_VALUES = [x => Number(x), x => String(x).slice(0, 200), x => Boolean(x)].map(Object.freeze);
const FIXED_PARAMS = ['ctx', 'fx', 'Math', ...SAFE_GLOBALS, ...SHADOW_NAMES];

/**
 * The code's own variable names are also parameters, and the code runs one block deeper: a name used outside the
 * block that declared it resolves to an (undefined) parameter, never to a page global of the same name.
 */
function build(code, locals) {
  const extra = locals.filter(n => !FIXED_PARAMS.includes(n));
  // eslint-disable-next-line no-new-func
  return new Function(...FIXED_PARAMS, ...extra, `"use strict";\n{\n${code}\n}`);
}

const COMPILE_CACHE = new Map();
const SHADOW_VALUES = SHADOW_NAMES.map(() => undefined);

export function compilePassive(code) {
  const key = String(code ?? '').trim();
  if (COMPILE_CACHE.has(key)) return COMPILE_CACHE.get(key);
  const v = analyze(key);
  if (!v.ok) return { fn: null, error: v.error };
  try {
    const raw = build(key, v.locals);
    const fn = (ctx, fx) => raw(ctx, fx, SAFE_MATH, ...SAFE_GLOBAL_VALUES, ...SHADOW_VALUES);
    const entry = { fn, error: null };
    if (COMPILE_CACHE.size > 64) COMPILE_CACHE.clear();
    COMPILE_CACHE.set(key, entry);
    return entry;
  } catch (e) {
    return { fn: null, error: `컴파일 오류: ${e.message}` };
  }
}

/**
 * Sanitize and validate a custom passive descriptor from LLM or user input.
 * Returns null if missing/empty; otherwise { name, desc, code, enabled, valid, error? }.
 */
export function normalizeCustomPassive(raw, { strict = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const code = String(raw.code ?? '').trim();
  const name = String(raw.name ?? '').trim().slice(0, 28);
  const desc = String(raw.desc ?? '').trim().slice(0, 140);
  if (!code && !name) return null;
  const check = validatePassiveCode(code);
  if (strict && !check.ok) return null;
  return {
    name: name || '고유 특성',
    desc: desc || '',
    code,
    enabled: raw.enabled !== false && check.ok,
    valid: check.ok,
    ...(check.ok ? {} : { error: check.error }),
  };
}

function summarizeFighter(f) {
  if (!f) return null;
  const statuses = (f.statuses ?? []).map(x => x.id);
  const hasDebuff = statuses.some(id => DEBUFF_STATUS.has(id)) || Object.values(f.stages ?? {}).some(v => v < 0);
  const hasBuff = statuses.some(id => SELF_BUFF_STATUS.has(id)) || Object.values(f.stages ?? {}).some(v => v > 0);
  return nullObj({
    name: String(f.name ?? ''),
    hp: Number(f.hp ?? 0),
    maxHp: Math.max(1, Number(f.maxHp ?? 1)),
    hpPct: Math.round((Math.max(0, Number(f.hp ?? 0)) / Math.max(1, Number(f.maxHp ?? 1))) * 100),
    sp: Number(f.sp ?? 0),
    maxSp: Math.max(0, Number(f.maxSp ?? 0)),
    spPct: f.maxSp > 0 ? Math.round((Math.max(0, Number(f.sp ?? 0)) / f.maxSp) * 100) : 100,
    row: f.row ?? 'front',
    tier: f.tier ?? '',
    elements: Object.freeze([...(f.elements ?? [])]),
    statuses: Object.freeze(statuses),
    statusCount: statuses.length,
    hasDebuff,
    hasBuff,
    isBoss: !!f.isBoss,
    down: !!f.down || f.hp <= 0,
  });
}

function summarizeSkill(sk) {
  if (!sk) return null;
  return nullObj({
    name: String(sk.name ?? ''),
    kind: String(sk.kind ?? 'physical'),
    element: sk.element ?? null,
    power: Number(sk.power ?? 0),
    range: sk.range ?? 'melee',
    isBasic: !!sk.isBasic,
    hits: Number(sk.hits ?? 1),
    priority: Number(sk.priority ?? 0),
  });
}

function buildContext(hook, b, f, extra = {}, rng) {
  const fighters = b?.fighters ?? [];
  const aliveSide = side => fighters.filter(x => x.side === side && !x.down && !x.out && x.hp > 0).length;
  const selfSnap = summarizeFighter(f);
  const targetRaw = extra.target ?? extra.attacker ?? null;
  const targetSnap = summarizeFighter(targetRaw);
  const attackerSnap = summarizeFighter(extra.attacker ?? null);
  const victimSnap = summarizeFighter(extra.victim ?? null);
  const fallenSnap = summarizeFighter(extra.fallen ?? null);
  const rawMem = Object.create(null);
  for (const [k, v] of Object.entries(f?.pstate ?? {})) {
    if (!k.startsWith('__') && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) rawMem[k] = v;
  }
  const byWho = who => who === 'self' ? f : who === 'attacker' ? extra.attacker : targetRaw;
  return nullObj({
    hook,
    turn: Math.max(1, Number(b?.turn ?? 1)),
    isBoss: !!f?.isBoss,
    allyCount: aliveSide(f?.side ?? 'ally'),
    foeCount: aliveSide((f?.side ?? 'ally') === 'ally' ? 'enemy' : 'ally'),
    self: selfSnap,
    target: targetSnap,
    attacker: attackerSnap,
    victim: victimSnap,
    fallen: fallenSnap,
    skill: summarizeSkill(extra.skill ?? null),
    dmg: Number(extra.dmg ?? 0),
    crit: !!extra.crit,
    eff: extra.eff ?? null,
    effMul: Number(extra.effMul ?? 1),
    ko: !!extra.ko,
    fatal: !!extra.fatal,
    hit: Math.max(0, Math.trunc(Number(extra.hit ?? 0)) || 0),
    firstHit: !(Number(extra.hit) > 0),
    mem: Object.freeze(rawMem),
    hasStatus: (who, id) => typeof id === 'string' && !!(byWho(who)?.statuses ?? []).some(x => x.id === id),
    stageOf: (who, stat) => (VALID_STATS.has(stat) ? Number(byWho(who)?.stages?.[stat] ?? 0) || 0 : 0),
    rng: () => (rng ? rng.next() : 0.5),
    chance: pct => (rng ? rng.chance(clamp(Number(pct) || 0, 0, 100) / 100) : false),
  });
}

function createCollector() {
  const ops = {
    dmgMul: 1,
    dmgFlatPct: 0,
    healPct: 0,
    spPct: 0,
    stages: [],
    statuses: [],
    counterPct: 0,
    endure: false,
    flags: [],
    logs: [],
    called: false,
  };
  const addLog = msg => {
    // Shown in the battle log AND quoted to the story model: plain short text only (no tags, no line breaks).
    if (typeof msg !== 'string' || msg.length > 400) return;
    const s = msg.replace(/[<>\[\]{}\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
    if (s && ops.logs.length < 3 && !ops.logs.includes(s)) ops.logs.push(s);
  };
  const fx = nullObj({
    dmgMul(mul, msg) {
      const m = Number(mul);
      if (!Number.isFinite(m) || m <= 0) return;
      ops.called = true;
      ops.dmgMul = clamp(ops.dmgMul * clamp(m, 0.65, 1.45), 0.6, 1.5);
      addLog(msg);
    },
    dmgFlat(pctMaxHp, msg) {
      const p = Number(pctMaxHp);
      if (!Number.isFinite(p) || p === 0) return;
      ops.called = true;
      ops.dmgFlatPct = clamp(ops.dmgFlatPct + clamp(p, -10, 12), -10, 12);
      addLog(msg);
    },
    heal(pctMaxHp, msg) {
      const p = Number(pctMaxHp);
      if (!Number.isFinite(p) || p <= 0) return;
      ops.called = true;
      ops.healPct = clamp(ops.healPct + p, 0, 20);
      addLog(msg);
    },
    sp(pctMaxSp, msg) {
      const p = Number(pctMaxSp);
      if (!Number.isFinite(p) || p === 0) return;
      ops.called = true;
      ops.spPct = clamp(ops.spPct + p, -25, 25);
      addLog(msg);
    },
    stage(who, stat, delta, msg) {
      if (ops.stages.length >= 2) return;
      const w = ['self', 'target', 'foes', 'allies'].includes(who) ? who : null;
      const st = VALID_STATS.has(stat) ? stat : null;
      const d = Math.trunc(Number(delta));
      if (!w || !st || !d) return;
      ops.called = true;
      ops.stages.push({ who: w, stat: st, delta: clamp(d, -2, 2) });
      addLog(msg);
    },
    status(who, statusId, chancePct = 100, turns = 2, msg) {
      if (ops.statuses.length >= 1) return;
      const w = who === 'self' || who === 'target' ? who : null;
      if (!w || typeof statusId !== 'string' || !Object.hasOwn(STATUS, statusId)) return;
      const maxCh = HARD_CC.has(statusId) ? 25
        : SOFT_CC.has(statusId) ? 40
        : SELF_BUFF_STATUS.has(statusId) ? 100
        : 60;
      const ch = clamp(Number(chancePct) || 0, 0, maxCh);
      const t = clamp(Math.trunc(Number(turns) || 2), 1, 3);
      if (ch <= 0) return;
      ops.called = true;
      ops.statuses.push({ who: w, id: statusId, chance: ch, turns: t });
      addLog(msg);
    },
    counter(pctMaxHp, msg) {
      const p = Number(pctMaxHp);
      if (!Number.isFinite(p) || p <= 0) return;
      ops.called = true;
      ops.counterPct = clamp(p, 3, 15);
      addLog(msg);
    },
    endure(msg) {
      ops.called = true;
      ops.endure = true;
      addLog(msg);
    },
    flag(key, value) {
      if (typeof key !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/.test(key) || key.startsWith('__')) return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return;
        value = clamp(Math.round(value * 100) / 100, -999, 999);
      } else if (typeof value === 'string') {
        if (value.length > 400) return;
        value = value.replace(/[<>\r\n]/g, ' ').slice(0, 24);
      } else if (typeof value !== 'boolean') {
        return;
      }
      ops.called = true;
      ops.flags.push([key, value]);
    },
    log(msg) {
      ops.called = true;
      addLog(msg);
    },
  });
  return { fx, ops };
}

/**
 * Execute a fighter's custom passive for a given hook.
 * Returns collected (clamped) ops, or null if skipped/disabled/invalid/errored.
 * Caller (engine.js) applies ops through engine helpers so state stays valid & logged.
 */
export function evalPassive(hook, b, f, extra = {}, rng) {
  if (!f?.customPassive?.enabled || !f.customPassive.code) return null;
  if (b?.customPassives === false) return null;
  const compiled = compilePassive(f.customPassive.code);
  if (!compiled.fn) return null;

  const ctx = buildContext(hook, b, f, extra, rng);
  const { fx, ops } = createCollector();
  try {
    compiled.fn(ctx, fx);
  } catch (e) {
    return { error: e.message || String(e), ops: null };
  }

  // Persist user flags immediately (max 8 keys)
  if (ops.flags.length) {
    f.pstate ??= {};
    for (const [k, v] of ops.flags) {
      const userKeys = Object.keys(f.pstate).filter(x => !x.startsWith('__'));
      if (!(k in f.pstate) && userKeys.length >= 8) continue;
      f.pstate[k] = v;
    }
  }

  return { error: null, ops };
}

/**
 * Dry-run self-test across all hooks on synthetic healthy & crisis battle snapshots.
 * Verifies security, compilation, zero runtime exceptions, and reports which hooks triggered.
 */
export function testPassive(passive) {
  const code = typeof passive === 'string' ? passive : String(passive?.code ?? '');
  const v = validatePassiveCode(code);
  if (!v.ok) return { ok: false, error: v.error, triggeredHooks: [], warnings: [] };
  const compiled = compilePassive(code);
  if (!compiled.fn) return { ok: false, error: compiled.error, triggeredHooks: [], warnings: [] };

  const mkFighter = (name, side, hp, maxHp, statuses = [], stages = {}) => ({
    name, side, hp, maxHp, sp: 40, maxSp: 100, row: 'front', tier: 'B',
    elements: ['화염'], statuses, stages, isBoss: false, down: false, out: null, pstate: {},
    customPassive: { name: passive?.name || '테스트', code, enabled: true },
  });
  const mkRng = () => {
    let s = 1234567;
    const next = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    return { next, chance: p => next() < p };
  };
  const triggered = new Set();

  const scenarios = [
    {
      selfHp: 80, foeHp: 70, selfSt: [], foeSt: [], stages: {},
      skill: { name: '강타', kind: 'physical', element: '화염', power: 60, range: 'melee', isBasic: false, hits: 1, priority: 0 },
      dmg: 25, crit: false, eff: null, effMul: 1, ko: false, fatal: false, turn: 1,
    },
    {
      selfHp: 18, foeHp: 15, selfSt: [{ id: 'burn', turns: 2 }], foeSt: [{ id: 'poison', turns: 2 }], stages: { pow: 1, def: -1 },
      skill: { name: '마력탄', kind: 'magic', element: '화염', power: 80, range: 'ranged', isBasic: false, hits: 1, priority: 1 },
      dmg: 45, crit: true, eff: 'super', effMul: 1.5, ko: true, fatal: true, turn: 4,
    },
  ];

  const rng = mkRng();
  for (const sc of scenarios) {
    const self = mkFighter('테스트', 'ally', sc.selfHp, 100, sc.selfSt, sc.stages);
    const foe = mkFighter('상대', 'enemy', sc.foeHp, 100, sc.foeSt, {});
    const ally = mkFighter('동료', 'ally', 50, 100, [], {});
    const b = { turn: sc.turn, fighters: [self, ally, foe], customPassives: true };

    for (const hook of PASSIVE_HOOKS) {
      const extra = hook === 'beforeAttack' || hook === 'afterAttack'
        ? { target: foe, skill: sc.skill, dmg: sc.dmg, crit: sc.crit, eff: sc.eff, effMul: sc.effMul, ko: sc.ko }
        : hook === 'beforeHit' || hook === 'afterHit'
          ? { attacker: foe, target: foe, skill: sc.skill, dmg: sc.dmg, crit: sc.crit, eff: sc.eff, effMul: sc.effMul, ko: sc.ko, fatal: sc.fatal }
          : hook === 'onKill' ? { victim: foe, target: foe, skill: sc.skill }
          : hook === 'onAllyDown' ? { fallen: ally }
          : {};
      const res = evalPassive(hook, b, self, extra, rng);
      if (res?.error) {
        return { ok: false, error: `실행 오류 (${hook}): ${res.error}`, triggeredHooks: [...triggered], warnings: [] };
      }
      if (res?.ops?.called) triggered.add(hook);
    }
  }

  const warnings = [];
  if (!triggered.size) warnings.push('테스트 조건에서 발동한 훅이 없어요 (특정 속성·스킬명·조건 전용이면 정상일 수 있어요).');
  return { ok: true, triggeredHooks: [...triggered], warnings };
}
