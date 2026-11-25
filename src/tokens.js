// Per-turn & per-call token measurement and recording.
// Priority:
//   1. Exact API `usage` / `usageMetadata` returned by the provider (zero latency, 100% accurate)
//   2. Remote Gemini `countTokens` API (if enabled / key configured)
//   3. SillyTavern built-in Gemma SentencePiece tokenizer (`/api/tokenizers/gemma/encode` or `getTokenCountAsync`)
//   4. Fast offline heuristic fallback (`estTokens`)

import { estTokens } from './assist.js';

export const TOKEN_SOURCE_KO = {
  api: '실측',
  gemini: 'Gemini',
  gemma: 'Gemma',
  st: 'ST',
  est: '추정',
};

const CACHE = new Map();
const MAX_CACHE = 256;

function cacheKey(mode, model, text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${mode}:${model}:${text.length}:${(h >>> 0).toString(36)}`;
}

function cacheSet(k, v) {
  if (CACHE.size >= MAX_CACHE) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(k, v);
}

/**
 * Extract exact token usage from OpenAI, Gemini native, or Anthropic API JSON payloads.
 * Returns { inTok, outTok, reasonTok, source: 'api' } or null.
 */
export function extractUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // OpenAI-compatible (also OpenRouter, Google OpenAI-compat, LiteLLM, DeepSeek)
  const u = raw.usage;
  if (u && typeof u === 'object') {
    const inTok = Number(u.prompt_tokens ?? u.input_tokens);
    const outTok = Number(u.completion_tokens ?? u.output_tokens);
    const reasonTok = Number(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0) || 0;
    if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
      return {
        inTok: Math.max(0, Math.round(Number.isFinite(inTok) ? inTok : 0)),
        outTok: Math.max(0, Math.round(Number.isFinite(outTok) ? outTok : 0)),
        reasonTok: Math.max(0, Math.round(reasonTok)),
        source: 'api',
      };
    }
  }
  // Google Gemini native API (`usageMetadata`)
  const m = raw.usageMetadata;
  if (m && typeof m === 'object') {
    const inTok = Number(m.promptTokenCount);
    const outTok = Number(m.candidatesTokenCount);
    const reasonTok = Number(m.thoughtsTokenCount ?? 0) || 0;
    if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
      return {
        inTok: Math.max(0, Math.round(Number.isFinite(inTok) ? inTok : 0)),
        outTok: Math.max(0, Math.round(Number.isFinite(outTok) ? outTok : 0)),
        reasonTok: Math.max(0, Math.round(reasonTok)),
        source: 'api',
      };
    }
  }
  return null;
}

async function countGeminiRemote(text, settings, fetchFn) {
  const key = String(settings?.geminiTokenKey ?? '').trim();
  if (!key) return null;
  const model = String(settings?.geminiTokenModel ?? '').trim() || 'gemini-2.5-flash';
  const base = String(settings?.geminiTokenBase ?? '').trim().replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${encodeURIComponent(model)}:countTokens?key=${encodeURIComponent(key)}`;
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    });
    if (!r?.ok) return null;
    const j = await r.json();
    const n = Number(j?.totalTokens);
    return Number.isFinite(n) ? { tokens: Math.max(0, Math.round(n)), source: 'gemini' } : null;
  } catch {
    return null;
  }
}

async function countStGemma(text, stCtx, fetchFn) {
  // Only attempt relative ST backend route when running in browser or with injected fetchFn
  if (!fetchFn) return null;
  try {
    const headers = typeof stCtx?.getRequestHeaders === 'function'
      ? { ...stCtx.getRequestHeaders(), 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
    const r = await fetchFn('/api/tokenizers/gemma/encode', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
    });
    if (!r?.ok) return null;
    const j = await r.json();
    const n = Number(j?.count ?? (Array.isArray(j?.ids) ? j.ids.length : NaN));
    return Number.isFinite(n) ? { tokens: Math.max(0, Math.round(n)), source: 'gemma' } : null;
  } catch {
    return null;
  }
}

async function countStActive(text, stCtx) {
  if (typeof stCtx?.getTokenCountAsync !== 'function') return null;
  try {
    const n = Number(await stCtx.getTokenCountAsync(text));
    return Number.isFinite(n) ? { tokens: Math.max(0, Math.round(n)), source: 'st' } : null;
  } catch {
    return null;
  }
}

/**
 * Count tokens for a single string using the configured tokenizer strategy.
 * Returns { tokens: number, source: 'gemini'|'gemma'|'st'|'est' }.
 */
export async function countText(text, settings = {}, { fetchFn = null, stCtx = null, skipCache = false } = {}) {
  const s = String(text ?? '');
  if (!s) return { tokens: 0, source: 'est' };
  const mode = settings?.tokenizerMode || 'auto';
  const model = String(settings?.geminiTokenModel ?? '').trim() || 'gemini-2.5-flash';
  const key = cacheKey(mode, model, s);
  if (!skipCache && CACHE.has(key)) return CACHE.get(key);

  const f = fetchFn ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const st = stCtx ?? (typeof globalThis.SillyTavern?.getContext === 'function' ? globalThis.SillyTavern.getContext() : null);
  const canRelativeFetch = !!fetchFn || (typeof globalThis.window !== 'undefined' && typeof globalThis.location?.origin === 'string');

  let res = null;
  if (mode === 'est') {
    res = { tokens: estTokens(s), source: 'est' };
  } else if (mode === 'gemini') {
    res = (f ? await countGeminiRemote(s, settings, f) : null)
      ?? (canRelativeFetch ? await countStGemma(s, st, f) : null)
      ?? await countStActive(s, st);
  } else if (mode === 'gemma') {
    res = (canRelativeFetch ? await countStGemma(s, st, f) : null)
      ?? await countStActive(s, st);
  } else if (mode === 'st') {
    res = await countStActive(s, st)
      ?? (canRelativeFetch ? await countStGemma(s, st, f) : null);
  } else {
    // 'auto': if user provided a Gemini countTokens key use remote Gemini first, else ST built-in Gemma -> ST active -> heuristic
    if (String(settings?.geminiTokenKey ?? '').trim() && f) {
      res = await countGeminiRemote(s, settings, f);
    }
    if (!res && canRelativeFetch) res = await countStGemma(s, st, f);
    if (!res) res = await countStActive(s, st);
  }

  if (!res) res = { tokens: estTokens(s), source: 'est' };
  if (!skipCache) cacheSet(key, res);
  return res;
}

/** Count tokens for an array of chat messages [{ role, content }]. */
export async function countMessages(messages, settings = {}, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return { tokens: 0, source: 'est' };
  const joined = list.map(m => `${m.role ?? 'user'}: ${String(m.content ?? '')}`).join('\n');
  const r = await countText(joined, settings, opts);
  // Small per-message role framing overhead (~3 tokens/msg)
  return { tokens: r.tokens + list.length * 3, source: r.source };
}

/** Ensure per-chat token stats structure exists. */
export function ensureTokenStats(s) {
  if (!s || typeof s !== 'object') return null;
  s.tokenStats ??= {};
  const ts = s.tokenStats;
  ts.turnSeq ??= 0;
  ts.total ??= { inTok: 0, outTok: 0, reasonTok: 0, injectTok: 0, mainTurns: 0, auxCalls: 0 };
  ts.lastTurn ??= null;
  ts.log ??= [];
  return ts;
}

export function resetTokenStats(s) {
  if (!s || typeof s !== 'object') return;
  s.tokenStats = {
    turnSeq: 0,
    total: { inTok: 0, outTok: 0, reasonTok: 0, injectTok: 0, mainTurns: 0, auxCalls: 0 },
    lastTurn: null,
    log: [],
  };
}

/**
 * Record one main-turn or aux-call token measurement into the chat state.
 * `kind`: 'main' | 'aux'
 */
export function recordTokenUsage(s, { kind = 'aux', label = '', inTok = 0, outTok = 0, reasonTok = 0, injectTok = 0, source = 'est', sameTurn = false } = {}) {
  const ts = ensureTokenStats(s);
  if (!ts) return null;
  const i = Math.max(0, Math.round(Number(inTok) || 0));
  const o = Math.max(0, Math.round(Number(outTok) || 0));
  const r = Math.max(0, Math.round(Number(reasonTok) || 0));
  const inj = Math.max(0, Math.round(Number(injectTok) || 0));

  ts.total.inTok += i;
  ts.total.outTok += o;
  ts.total.reasonTok += r;
  ts.total.injectTok += inj;
  if (kind === 'main') {
    ts.total.mainTurns += 1;
    ts.turnSeq += 1;
    ts.lastTurn = {
      turnSeq: ts.turnSeq,
      ts: Date.now(),
      inTok: i,
      outTok: o,
      reasonTok: r,
      injectTok: inj,
      mainIn: i,
      mainOut: o,
      auxIn: 0,
      auxOut: 0,
      auxCalls: 0,
      source,
    };
  } else {
    ts.total.auxCalls += 1;
    if (!ts.lastTurn || (!sameTurn && ts.lastTurn.mainIn === 0 && ts.lastTurn.auxCalls >= 8)) {
      ts.turnSeq += 1;
      ts.lastTurn = {
        turnSeq: ts.turnSeq,
        ts: Date.now(),
        inTok: i,
        outTok: o,
        reasonTok: r,
        injectTok: 0,
        mainIn: 0,
        mainOut: 0,
        auxIn: i,
        auxOut: o,
        auxCalls: 1,
        source,
      };
    } else {
      ts.lastTurn.ts = Date.now();
      ts.lastTurn.inTok += i;
      ts.lastTurn.outTok += o;
      ts.lastTurn.reasonTok += r;
      ts.lastTurn.auxIn += i;
      ts.lastTurn.auxOut += o;
      ts.lastTurn.auxCalls += 1;
      if (source === 'api' || ts.lastTurn.source === 'est') ts.lastTurn.source = source;
    }
  }

  const entry = {
    ts: Date.now(),
    turnSeq: ts.turnSeq,
    kind,
    label: String(label || (kind === 'main' ? '메인 턴' : '보조모델')).slice(0, 48),
    inTok: i,
    outTok: o,
    reasonTok: r,
    injectTok: inj,
    source,
  };
  ts.log.push(entry);
  if (ts.log.length > 40) ts.log.splice(0, ts.log.length - 40);
  return entry;
}
