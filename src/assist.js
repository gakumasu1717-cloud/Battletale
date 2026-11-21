// The auxiliary model: a separate (usually cheaper/faster) model that reads
// rules, builds sheets, forges encounters and interprets commands.
import { extractJson } from './util.js';

const ctx = () => SillyTavern.getContext();

export function auxReady(settings) {
  if (settings.auxSource === 'profile') return !!settings.auxProfile && !!ctx().ConnectionManagerRequestService;
  if (settings.auxSource === 'openai') return !!settings.auxUrl && !!settings.auxModel;
  return settings.auxSource === 'main';
}

export async function callAux(messages, settings, { maxTokens } = {}) {
  // The user's limit wins (reasoning models need room); the per-call value is only a fallback.
  const tokens = Number(settings.auxMaxTokens) > 0 ? Number(settings.auxMaxTokens) : (maxTokens ?? 10000);
  const c = ctx();
  const userName = c.name1 || 'User';
  const msgs = messages.map(m => ({ role: m.role, content: String(m.content).replace(/\{\{user\}\}/gi, userName) }));

  if (settings.auxSource === 'profile') {
    const svc = c.ConnectionManagerRequestService;
    if (!svc) throw new Error('이 SillyTavern 버전에는 Connection Manager 요청 기능이 없어요. 업데이트하거나 다른 보조모델 방식을 골라주세요.');
    const withPreset = !!settings.auxProfilePreset;
    const override = { ...(settings.auxOverride ? sampling(settings) : {}), ...(String(settings.auxProfileModel ?? '').trim() ? { model: String(settings.auxProfileModel).trim() } : {}) };
    const res = await svc.sendRequest(settings.auxProfile, msgs, tokens, { stream: false, extractData: true, includePreset: withPreset, includeInstruct: withPreset }, override);
    return typeof res === 'string' ? res : res?.content ?? res?.choices?.[0]?.message?.content ?? '';
  }

  if (settings.auxSource === 'openai') {
    const body = { model: settings.auxModel, messages: msgs, max_tokens: tokens, ...sampling(settings) };
    if (settings.auxReasoning) { body.reasoning_effort = settings.auxReasoning; body.reasoning = { effort: settings.auxReasoning }; }
    if (settings.auxJsonMode) body.response_format = { type: 'json_object' };
    Object.assign(body, parseJsonSetting(settings.auxExtra, '추가 요청 본문'));
    const r = await fetch(endpoint(settings, '/chat/completions'), { method: 'POST', headers: headersOf(settings), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`보조모델 API 오류 ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const msg = j?.choices?.[0]?.message;
    return msg?.content ?? j?.choices?.[0]?.text ?? '';
  }

  // Main API, quiet raw generation.
  const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const prompt = msgs.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  try {
    return await c.generateRaw({ prompt, systemPrompt: system, responseLength: tokens, trimNames: false });
  } catch (e) {
    // Older signature: generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength)
    return await c.generateRaw(prompt, null, false, false, system, tokens);
  }
}

function sampling(settings) {
  const o = {};
  if (settings.auxTemp != null && settings.auxTemp !== '') o.temperature = Number(settings.auxTemp);
  if (settings.auxTopP != null && settings.auxTopP !== '') o.top_p = Number(settings.auxTopP);
  return o;
}
function parseJsonSetting(text, label) {
  if (!String(text ?? '').trim()) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { throw new Error(`${label} JSON이 잘못됐어요`); }
}
function endpoint(settings, path) {
  const base = String(settings.auxUrl ?? '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return `${base}${path}`;
}
function headersOf(settings) {
  return { 'Content-Type': 'application/json', ...(settings.auxKey ? { Authorization: `Bearer ${settings.auxKey}` } : {}), ...parseJsonSetting(settings.auxHeaders, '추가 헤더') };
}

/** Model ids from an OpenAI-compatible /models endpoint. */
export async function listModels(settings) {
  if (settings.auxSource !== 'openai' || !settings.auxUrl) throw new Error('커스텀 API 주소를 먼저 넣어주세요');
  const r = await fetch(endpoint(settings, '/models'), { headers: headersOf(settings) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  return (j?.data ?? j?.models ?? []).map(m => m.id ?? m.name).filter(Boolean).sort();
}

export async function auxJson(messages, settings, opts) {
  const text = await callAux(messages, settings, opts);
  const json = extractJson(text);
  if (!json) throw new Error(`보조모델 답변에서 JSON을 찾지 못했어요: ${String(text).slice(0, 160)}`);
  return json;
}

/* ---------- Gathering lore for the aux model ---------- */
let activated = new Map();
export function rememberActivated(entries) {
  if (!Array.isArray(entries)) return;
  for (const e of entries) if (e?.content) activated.set(`${e.world ?? ''}:${e.uid ?? e.comment}`, e);
}
export const forgetActivated = () => { activated = new Map(); };

const cleanLore = s => String(s ?? '')
  .replace(/<%[\s\S]*?%>/g, '')          // template code (EJS / prompt-template)
  .replace(/\{\{\/?\/?[^}]*\}\}/g, m => (/^\{\{(user|char)\}\}$/i.test(m) ? m : ''))
  .replace(/\n{3,}/g, '\n\n').trim();

const COMBAT_WORDS = /stat|rank|tier|level|skill|ability|class|hp\b|sp\b|mp\b|mana|combat|battle|fight|monster|weapon|element|attribute|능력치|스탯|등급|랭크|레벨|스킬|기술|클래스|직업|전투|몬스터|무기|속성|마력|체력|에테르|던전|헌터|위협/i;

async function loadBook(name) {
  const c = ctx();
  try {
    if (typeof c.loadWorldInfo === 'function') return await c.loadWorldInfo(name);
  } catch { /* fall through */ }
  try {
    const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ name }) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function bookNames(settings) {
  const c = ctx();
  const names = new Set();
  const ch = c.characters?.[c.characterId];
  const charBook = ch?.data?.extensions?.world;
  if (charBook) names.add(charBook);
  const chatBook = c.chatMetadata?.world_info;
  if (chatBook) names.add(chatBook);
  for (const n of String(settings.loreBooks ?? '').split(',').map(x => x.trim()).filter(Boolean)) names.add(n);
  return [...names];
}

/** Lore text for the aux model: combat-relevant and constant entries first, within a budget. */
export async function gatherLore(settings) {
  const budget = settings.loreBudget ?? 14000;
  const entries = new Map();
  for (const name of bookNames(settings)) {
    const book = await loadBook(name);
    for (const e of Object.values(book?.entries ?? {})) if (e?.content && !e.disable) entries.set(`${name}:${e.uid}`, { ...e, world: name });
  }
  for (const [k, e] of activated) if (!entries.has(k)) entries.set(k, e);
  const scored = [...entries.values()].map(e => {
    const text = cleanLore(e.content);
    let score = 0;
    if (COMBAT_WORDS.test(e.comment ?? '')) score += 6;
    score += Math.min(10, (text.match(new RegExp(COMBAT_WORDS.source, 'gi')) ?? []).length);
    if (e.constant) score += 3;
    if (/^\[룰\]|rule|format|display|디스플레이|이미지/i.test(e.comment ?? '') && !COMBAT_WORDS.test(e.comment ?? '')) score -= 8;
    return { text, title: e.comment ?? '', score };
  }).filter(x => x.text.length > 20).sort((a, b) => b.score - a.score);
  let out = '', used = 0;
  for (const x of scored) {
    const piece = `### ${x.title}\n${x.text}\n\n`;
    if (used + piece.length > budget) { if (used > budget * 0.8) break; continue; }
    out += piece; used += piece.length;
  }
  return out.trim();
}

const PERSON_HINT = /성격|외모|나이|성별|직업|출신|personality|appearance|age:|gender|occupation|인물|캐릭터|npc|등장인물|character/i;
/**
 * World-info entries whose keys appear in the given text (scene + hint).
 * Used at battle start: minor fights get none, named characters get their own entries.
 */
export async function matchLore(settings, text, { max = 6, perEntry = 1800, budget = 6000 } = {}) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return { text: '', names: [], important: false };
  const entries = new Map();
  for (const name of bookNames(settings)) {
    const book = await loadBook(name);
    for (const e of Object.values(book?.entries ?? {})) if (e?.content && !e.disable) entries.set(`${name}:${e.uid}`, e);
  }
  const hits = [];
  for (const e of entries.values()) {
    if (e.constant) continue; // always-on rules/format entries are not "who is here"
    const keys = [...(e.key ?? []), ...(e.keysecondary ?? [])].map(k => String(k).trim().toLowerCase()).filter(k => k.length >= 2 && !k.startsWith('/'));
    const hit = keys.find(k => hay.includes(k));
    if (!hit) continue;
    const body = cleanLore(e.content);
    if (body.length < 20) continue;
    const person = PERSON_HINT.test(e.comment ?? '') || PERSON_HINT.test(body.slice(0, 400));
    hits.push({ title: e.comment || hit, key: hit, body, person, score: (person ? 10 : 0) + Math.min(5, keys.filter(k => hay.includes(k)).length) });
  }
  hits.sort((a, b) => b.score - a.score);
  let out = '', used = 0;
  const names = [];
  for (const x of hits.slice(0, max)) {
    const piece = `### ${x.title}\n${x.body.slice(0, perEntry)}\n\n`;
    if (used + piece.length > budget) break;
    out += piece; used += piece.length; names.push(x.title);
  }
  return { text: out.trim(), names, important: hits.some(x => x.person) };
}

/** World-info entries that describe people (for finding the main cast). */
export async function personEntries(settings, { budget = 7000, per = 500 } = {}) {
  const out = [];
  let used = 0;
  for (const name of bookNames(settings)) {
    const book = await loadBook(name);
    for (const e of Object.values(book?.entries ?? {})) {
      if (!e?.content || e.disable) continue;
      const body = cleanLore(e.content);
      if (!(PERSON_HINT.test(e.comment ?? '') || PERSON_HINT.test(body.slice(0, 400)))) continue;
      const piece = `### ${e.comment || (e.key ?? [])[0] || '?'}${e.key?.length ? ` (keys: ${e.key.slice(0, 4).join(', ')})` : ''}\n${body.slice(0, per)}\n`;
      if (used + piece.length > budget) return out.join('\n');
      out.push(piece); used += piece.length;
    }
  }
  return out.join('\n');
}

export function characterText() {
  const c = ctx();
  const ch = c.characters?.[c.characterId];
  if (!ch) return '';
  return cleanLore([`Name: ${ch.name}`, ch.description, ch.personality, ch.scenario].filter(Boolean).join('\n')).slice(0, 4000);
}

export function personaText() {
  const c = ctx();
  const pu = c.powerUserSettings ?? {};
  const desc = pu.persona_description ?? '';
  return cleanLore(desc).slice(0, 3000);
}

export function recentScene(chat, n = 6, strip = s => s) {
  return (chat ?? []).filter(m => !m.is_system).slice(-n)
    .map(m => `${m.is_user ? '{{user}}' : m.name}: ${strip(String(m.mes ?? '')).slice(-1500)}`).join('\n\n');
}
