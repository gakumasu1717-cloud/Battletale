// Game controller: everything between "chat happened" and "engine resolved".
// Kept free of SillyTavern globals so it can be tested with plain objects.
import { normalizeProfile, normalizeSheet, normalizeSkill, inferSkill, parseSkillLine, skillLine, DEFAULT_PROFILE, tierOf, elementId, auditSheet } from './catalog.js';
import { THREAT_LABEL } from './engine.js';
import { parseBattleBody, parseChange, sheetFromStatFields, stripBlocks } from './parse.js';
import { ruleMessages, sheetMessages, forgeMessages, commandMessages, sheetText, turnPrompt, startPrompt, idlePrompt, worldPrompt, summaryPrompt, panelWaitPrompt } from './prompts.js';
import { MODES, modeOf } from './modes/index.js';
import { quickBlocks } from './modes/shared.js';
import { hashStr, clone, norm, num, clamp, uid } from './util.js';

const HISTORY_KEEP = 20;      // turns that keep a full snapshot…
const CHECKPOINT_EVERY = 10;  // …plus one every N turns (and the first), so any turn can be rebuilt by replay
const ARCHIVE_KEEP = 8;

/**
 * Turn key for a user message. Stamped messages (extra.bt_id) are tracked by their own id, so deleting
 * or inserting OTHER messages never shifts them; the content hash still catches edits.
 * Unstamped (old) messages fall back to index + hash.
 */
export const msgKey = (index, mes, m = null) => {
  const id = m?.extra?.bt_id;
  const hsh = hashStr(String(mes ?? m?.mes ?? '').trim());
  return id ? `id:${id}:${hsh}` : `${index}:${hsh}`;
};

/** Give a chat message a stable id (returns true when it was newly stamped and the chat needs saving). */
export function stampId(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.extra?.bt_id) return false;
  m.extra = { ...(m.extra ?? {}), bt_id: uid() };
  return true;
}

/** The battle's origin message can move when earlier messages are deleted: find it again by its mark. */
export function relocateOrigin(s, chat) {
  const b = s.battle;
  if (!b || !Array.isArray(chat)) return;
  const idx = chat.findIndex(m => m?.extra?.battletale?.origin?.includes?.(b.id));
  if (idx >= 0) b.originIndex = idx;
}

export function stateOf(meta) {
  meta.battletale ??= {};
  const s = meta.battletale;
  s.v ??= 2;
  s.profile ??= null;
  s.player ??= null;
  s.companions ??= [];
  s.inventory ??= [];
  s.battle ??= null;
  s.archive ??= [];
  s.idle ??= {};
  s.timing ??= {};
  s.lastResult ??= '';
  s.disabled ??= false;
  s.roster ??= {};
  if (s.battle && !s.battle.st) s.battle = null;   // v1 battle format → drop
  return s;
}

export const profileOf = s => (s.profile ? s.profile : normalizeProfile(DEFAULT_PROFILE));

/* ---------------- Setup: rules & sheets ---------------- */
const NON_STAT = /^(hp|sp|mp|cash|dp|ap|exp|gold|money|date|time|location|weather|rank|tier|class|title|affiliation|equipment|items?|skills?|quest|돈|날짜|시간|위치|날씨|랭크|등급|클래스|칭호|소속|장비|아이템|스킬|퀘스트)$/i;

export function profileFromStatFields(fields) {
  if (!fields) return null;
  const keys = Object.entries(fields).filter(([k, v]) => !NON_STAT.test(k.trim()) && /^-?[\d,.]+$/.test(String(v).trim())).map(([k]) => k.trim());
  if (keys.length < 3) return null;
  return normalizeProfile({ ...DEFAULT_PROFILE, name: '상태창 기반 룰', stats: keys.map(k => ({ key: k, label: k })), map: undefined });
}

export async function ensureProfile(s, deps, { force = false } = {}) {
  if (s.profile && !force) return s.profile;
  const cached = !force && deps.cache?.get();
  if (cached) { s.profile = normalizeProfile(cached); return s.profile; }
  let profile = null;
  if (deps.auxReady()) {
    deps.toast?.('📜 보조모델이 세계관 룰을 분석하는 중…');
    const fields = deps.statFields?.();
    try {
      const raw = await deps.auxJson(ruleMessages({ lore: await deps.lore(), character: deps.character(), persona: deps.persona().text, statTag: fields ? JSON.stringify(fields) : '' }), { maxTokens: 1500 });
      profile = normalizeProfile(raw);
    } catch (e) {
      if (force) throw e;
      deps.toast?.(`룰 분석 실패 → 기본 룰 사용 (${e.message})`, 'warning');
    }
  }
  if (!profile) profile = profileFromStatFields(deps.statFields?.()) ?? normalizeProfile(DEFAULT_PROFILE);
  s.profile = profile;
  deps.cache?.set(profile);
  return profile;
}

export async function ensurePlayer(s, deps, { force = false, extra = '', instruction = '' } = {}) {
  if (s.player && !force) return s.player;
  const profile = await ensureProfile(s, deps);
  const persona = deps.persona();
  const statFields = deps.statFields?.();
  const partial = sheetFromStatFields(statFields, profile);
  let raw = null;
  if (deps.auxReady()) {
    deps.toast?.(`🧬 보조모델이 ${persona.name}의 전투 시트를 만드는 중…`);
    try {
      raw = await deps.auxJson(sheetMessages({ profile, lore: await deps.lore(), persona: persona.text, personaName: persona.name, statFields, scene: deps.scene?.(4), keepSkills: extra || s.playerConcept || '', current: instruction && s.player ? s.player : null, instruction }), { maxTokens: 2400 });
    } catch (e) {
      if (force) throw e;
      deps.toast?.(`시트 생성 실패 → 상태창/기본값 사용 (${e.message})`, 'warning');
    }
    if (raw && partial) {
      raw.stats = { ...(raw.stats ?? {}), ...partial.stats };
      if (partial.hp) raw.hp = partial.hp;
      if (partial.sp) raw.sp = partial.sp;
      if (partial.tier) raw.tier = partial.tier;
    }
  }
  if (!raw) raw = { stats: partial?.stats, hp: partial?.hp, sp: partial?.sp, tier: partial?.tier ?? profile.tiers[Math.min(2, profile.tiers.length - 1)]?.name, skills: partial?.skillNames ?? [] };
  const sheet = normalizeSheet({ ...raw, name: persona.name, isPlayer: true, id: 'player' }, profile, { side: 'ally', seed: persona.name });
  sheet.id = 'player';
  sheet.isPlayer = true;
  if (s.player?.portrait && !sheet.portrait) sheet.portrait = s.player.portrait;
  const audit = auditSheet(sheet, profile, { clampStats: !statFields });
  if (audit.notes.length) { deps.toast?.(`⚖️ 등급(${sheet.tier || '?'})에 맞게 조정: ${audit.notes.slice(0, 3).join(' · ')}${audit.notes.length > 3 ? ` 외 ${audit.notes.length - 3}건` : ''}`, 'info'); deps.trace?.('balance', `밸런스 조정 · ${sheet.name}`, audit.notes.join('\n')); }
  if (!sheet.skills.length) sheet.skills = [normalizeSkill({ name: '전력 일격', kind: 'physical', power: 75, cost: Math.round(sheet.maxSp * 0.12) }, { maxSp: sheet.maxSp })];
  s.player = sheet;
  if (!s.inventory.length && partial?.items?.length) s.inventory = partial.items.map(name => ({ name, count: 1 }));
  return sheet;
}


/* ---------------- Character codex (world-level base sheets) + per-chat roster (growth) ---------------- */
// Names compared without parenthetical titles: "엘리어스 (총사)" → "엘리어스".
const nk = x => norm(String(x ?? '').replace(/[(（\[][^)）\]]*[)）\]]/g, ''));
/**
 * Exact name or alias only — a wrong match would apply someone else's stats and growth.
 * Partial matches are offered separately (codexCandidates) for search UIs.
 */
export function codexFind(deps, name) {
  if (!name || !deps.codex) return null;
  const k = nk(name);
  if (!k) return null;
  return deps.codex.list().find(e => nk(e.name) === k || aliasesOf(e).some(a => nk(a) === k)) ?? null;
}
const aliasesOf = e => { const a = e.sheet?.aliases ?? e.aliases ?? []; return Array.isArray(a) ? a : String(a).split(',').map(x => x.trim()).filter(Boolean); };
export function codexCandidates(deps, name) {
  const k = nk(name);
  if (!k || k.length < 2 || !deps.codex) return [];
  return deps.codex.list().filter(e => [e.name, ...aliasesOf(e)].some(n => nk(n).includes(k) || k.includes(nk(n))));
}

/** Current version of a registered character in this chat (growth applies here first). */
export function rosterSheet(s, entry) {
  const comp = s.companions.find(c => c.codexId === entry.id);
  if (comp) return comp;
  return s.roster[entry.id] ?? entry.sheet;
}

export function registerCharacter(s, deps, raw, { side = 'enemy', locked = false } = {}) {
  const profile = profileOf(s);
  const sheet = normalizeSheet(raw, profile, { side, seed: raw.name });
  const { notes } = auditSheet(sheet, profile, { clampStats: true, bonusTier: sheet.threat === 'boss' ? 1 : 0 });
  if (notes.length) { deps.toast?.(`⚖️ ${sheet.name} 밸런스 조정: ${notes.slice(0, 3).join(' · ')}${notes.length > 3 ? ` 외 ${notes.length - 3}건` : ''}`, 'info'); deps.trace?.('balance', `밸런스 조정 · ${sheet.name}`, notes.join('\n')); }
  const existing = codexFind(deps, sheet.name);
  const entry = { id: existing?.id ?? `c${uid()}`, name: sheet.name, sheet: { ...stripRuntime(sheet), side: undefined, codexId: undefined }, locked: existing?.locked ?? locked, updated: Date.now() };
  entry.sheet.codexId = entry.id;
  deps.codex?.put(entry);
  return entry;
}

/** Replace spec entries that name a registered character with the stored sheet. */
export function resolveRegistered(s, spec, deps, settings = {}) {
  const out = { ...spec };
  const fix = (list, side) => (list ?? []).map(item => {
    const name = typeof item === 'string' ? item : item.ref ?? item.name;
    const entry = codexFind(deps, name);
    if (entry) {
      const base = clone(rosterSheet(s, entry));
      return { ...base, codexId: entry.id, row: item.row ?? base.row, intel: item.intel ?? 2, threat: item.threat ?? base.threat, style: item.style ?? base.style, hp: base.hp > 0 ? base.hp : base.maxHp, maxHp: base.maxHp };
    }
    if (typeof item === 'object' && item.named && settings.autoRegister !== false && !item.ref) {
      const e = registerCharacter(s, deps, item, { side });
      deps.toast?.(`📖 도감에 등록: ${e.name}`);
      return { ...item, codexId: e.id };
    }
    return item;
  }).filter(x => typeof x === 'object');
  out.enemies = fix(spec.enemies, 'enemy');
  out.allies = fix(spec.allies, 'ally');
  return out;
}

function editSheet(sheet, op, profile) {
  const done = [];
  const sk = name => sheet.skills.find(x => nk(x.name) === nk(name)) ?? sheet.skills.find(x => nk(x.name).includes(nk(name)));
  switch (op.op) {
    case 'stat': {
      const key = profile.stats.find(x => nk(x.key) === nk(op.stat) || nk(x.label) === nk(op.stat))?.key;
      if (key) { sheet.stats[key] = op.set != null ? op.set : num(sheet.stats[key]) + op.delta; done.push(`${key} ${sheet.stats[key]}`); }
      break;
    }
    case 'learn': {
      const raw = /[:：]/.test(op.text) ? parseSkillLine(op.text) : { ...inferSkill(op.text.replace(/[(（].*$/, '').trim()), name: op.text.replace(/[(（].*$/, '').trim(), desc: (/[(（](.+)[)）]/.exec(op.text) ?? [])[1] ?? '' };
      const k = normalizeSkill(raw, { maxSp: sheet.maxSp });
      if (k && !sk(k.name)) { sheet.skills.push(k); done.push(`습득 ${k.name}`); }
      else if (k) { Object.assign(sk(k.name), k); done.push(`갱신 ${k.name}`); }
      break;
    }
    case 'upgrade': {
      const k = sk(op.name);
      if (!k) break;
      if (op.line) { Object.assign(k, normalizeSkill(op.line, { maxSp: sheet.maxSp })); done.push(`강화 ${k.name}`); break; }
      for (const m of op.mods ?? []) {
        if (m.field === 'chance') { if (k.status) k.status.chance = clamp(m.sign === '=' ? m.value : k.status.chance + (m.sign === '-' ? -m.value : m.value), 1, 100); continue; }
        const cur = num(k[m.field], 0);
        k[m.field] = m.sign === '=' ? m.value : cur + (m.sign === '-' ? -m.value : m.value);
      }
      k.power = clamp(k.power, 0, 300); k.cost = Math.max(0, k.cost); k.acc = clamp(k.acc, 10, 100); k.priority = clamp(k.priority, -3, 3); k.hits = clamp(k.hits, 1, 6);
      done.push(`강화 ${k.name}`);
      break;
    }
    case 'forget': sheet.skills = sheet.skills.filter(x => nk(x.name) !== nk(op.name)); done.push(`망각 ${op.name}`); break;
    case 'maxhp': { const v = String(op.value); const n = num(v.replace(/[^\d\-+.]/g, ''), 0); sheet.maxHp = Math.max(1, /^[+\-]/.test(v) ? sheet.maxHp + n : n); sheet.hp = Math.min(sheet.hp, sheet.maxHp); done.push(`최대HP ${sheet.maxHp}`); break; }
    case 'maxsp': { const v = String(op.value); const n = num(v.replace(/[^\d\-+.]/g, ''), 0); sheet.maxSp = Math.max(0, /^[+\-]/.test(v) ? sheet.maxSp + n : n); sheet.sp = Math.min(sheet.sp, sheet.maxSp); break; }
    case 'tier': if (tierOf(profile, op.value)) { sheet.tier = tierOf(profile, op.value).name; done.push(`등급 ${sheet.tier}`); } break;
    case 'element': sheet.elements = String(op.value).split(/[\/,\s]+/).filter(Boolean).map(elementId); sheet.element = sheet.elements[0] ?? 'none'; done.push(`타입 ${op.value}`); break;
    case 'level': {
      const n = Math.round(num(String(op.value ?? op.who ?? '+1').replace(/[^\d\-+]/g, ''), 1));
      if (!n) break;
      const g = Math.pow(1.05, n);
      for (const k of Object.keys(sheet.stats)) sheet.stats[k] = Math.max(1, Math.round(sheet.stats[k] * g));
      const ratio = sheet.hp / Math.max(1, sheet.maxHp);
      sheet.maxHp = Math.round(sheet.maxHp * g); sheet.hp = Math.round(sheet.maxHp * ratio);
      sheet.maxSp = Math.round(sheet.maxSp * Math.pow(1.04, n));
      sheet.level = (sheet.level ?? 1) + n;
      done.push(`레벨 ${sheet.level}`);
      break;
    }
  }
  return done;
}

/** Growth events for a registered character (from <bt-change> npc: lines or the panel). */
export function applyNpcOps(s, deps, name, subs, { fromStory = true } = {}) {
  const entry = codexFind(deps, name);
  const comp = entry ? s.companions.find(c => c.codexId === entry.id) : s.companions.find(c => nk(c.name) === nk(name));
  if (!entry && !comp) return { done: [], why: 'unknown' };
  if (entry?.locked && fromStory) return { done: [], why: 'locked' };
  const profile = profileOf(s);
  let sheet = comp ?? (s.roster[entry.id] ??= clone(entry.sheet));
  const done = subs.flatMap(op => editSheet(sheet, op, profile));
  return { done, name: sheet.name };
}

/** Write a chat's grown version back into the codex (becomes the new base for every chat). */
export function promoteToCodex(s, deps, entryId) {
  const entry = deps.codex?.list().find(e => e.id === entryId);
  if (!entry) return false;
  const cur = rosterSheet(s, entry);
  deps.codex.put({ ...entry, sheet: { ...stripRuntime(clone(cur)), codexId: entry.id }, updated: Date.now() });
  return true;
}

export function joinParty(s, deps, name) {
  const entry = codexFind(deps, name);
  if (!entry) return null;
  if (s.companions.some(c => c.codexId === entry.id)) return null;
  const sheet = clone(s.roster[entry.id] ?? entry.sheet);
  sheet.side = 'ally'; sheet.codexId = entry.id;
  delete s.roster[entry.id];
  s.companions.push(sheet);
  return sheet;
}

/* ---------------- Encounters ---------------- */
function partyFor(s, { solo = false } = {}) {
  const party = [];
  if (s.player) { const p = clone(s.player); if (p.hp <= 0) p.hp = 1; party.push(p); }
  if (!solo) for (const c of s.companions) if (c.hp > 0) party.push(clone(c));
  return party;
}

export function fallbackSpec(hint, s) {
  const profile = profileOf(s);
  const known = s.player?.tier && tierOf(profile, s.player.tier);
  const tier = known ? s.player.tier : profile.tiers[1]?.name;
  const like = (threat) => {
    if (known || !s.player) return {};
    const m = { minion: 0.55, normal: 0.8, elite: 1.05, boss: 1.3 }[threat];
    const hpm = { minion: 0.35, normal: 0.6, elite: 1, boss: 2.2 }[threat];
    return { stats: Object.fromEntries(Object.entries(s.player.stats).map(([k, v]) => [k, Math.max(1, Math.round(v * m))])), hp: Math.max(10, Math.round(s.player.maxHp * hpm)), sp: Math.round(s.player.maxSp * 0.6) };
  };
  const enemies = [];
  for (const part of String(hint || '적').split(/[,，、&]|\band\b|그리고/)) {
    let name = part.trim();
    if (!name) continue;
    let n = 1;
    const m = /(?:x|×|\*)\s*(\d+)|(\d+)\s*(?:마리|명|기|체|개체)|(?:^|\s)(\d)\s*$/i.exec(name);
    if (m) { n = clamp(num(m[1] ?? m[2] ?? m[3], 1), 1, 6); name = name.replace(m[0], '').trim(); }
    const boss = /보스|boss|우두머리|대장/i.test(name);
    const threat = boss ? 'boss' : n > 2 ? 'minion' : 'normal';
    for (let i = 0; i < n && enemies.length < 6; i++) enemies.push({ name: name || '적', tier, threat, skills: [`${name || '적'}의 일격`], ...like(threat) });
  }
  const mode = /결투|대련|1:1|duel/i.test(hint) ? 'duel' : /잠입|추격|도주|stealth|chase|sneak/i.test(hint) ? 'stealth' : 'party';
  return { mode, variant: /추격|도주|chase/i.test(hint) ? 'chase' : 'sneak', enemies: enemies.length ? enemies : [{ name: '적', tier }], allies: [], flee: true, place: '', title: '', loot: [], terrain: [] };
}

export async function forgeSpec(s, deps, { hint = '' } = {}) {
  await ensurePlayer(s, deps);
  const profile = profileOf(s);
  if (!deps.auxReady()) return resolveRegistered(s, fallbackSpec(hint, s), deps, deps.settings());
  deps.toast?.('⚔️ 보조모델이 상황을 분석해 적을 구성하는 중…');
  const party = [s.player, ...s.companions].map(x => sheetText(x, profile)).join('\n');
  const allowed = allowedModes(deps.settings());
  try {
    const codex = (deps.codex?.list() ?? []).slice(0, 40).map(e => { const sh = rosterSheet(s, e); return `- ${e.name}${sh.tier ? ` [${sh.tier}]` : ''}${sh.elements?.length ? ` (${sh.elements.join('/')})` : ''}${sh.desc ? ` — ${sh.desc.slice(0, 60)}` : ''}`; }).join('\n');
    // Minor fights: the last few messages are enough. Named characters with a world-info entry: read their entries.
    const scene = deps.scene?.(deps.settings().sceneSize ?? 3) ?? '';
    const matched = deps.matchLore ? await deps.matchLore(`${scene}\n${hint}`) : { text: '', names: [], important: false };
    const fl = deps.settings().forgeLore ?? 'auto';
    const lore = fl === 'never' ? '' : matched.important || fl === 'always' ? matched.text : '';
    deps.toast?.(lore ? `📖 월드인포 ${matched.names.length}개 참고: ${matched.names.slice(0, 3).join(', ')}` : '⚔️ 최근 대화만 보고 적을 구성해요', 'info');
    const json = await deps.auxJson(forgeMessages({ profile, lore, scene, party, hint, inventory: s.inventory.map(i => `${i.name} ×${i.count}`).join(', '), modes: allowed, codex, difficulty: deps.settings().difficulty ?? 'normal' }), { maxTokens: 3500 });
    return resolveRegistered(s, parseBattleBody(JSON.stringify(json)) ?? fallbackSpec(hint, s), deps, deps.settings());
  } catch (e) {
    deps.toast?.(`적 생성 실패 → 간이 생성 사용 (${e.message})`, 'warning');
    return fallbackSpec(hint, s);
  }
}

export const allowedModes = settings => Object.keys(MODES).filter(m => settings?.modes?.[m] !== false);

function pickMode(spec, settings, override) {
  const allowed = allowedModes(settings);
  let m = override ?? spec.mode ?? 'party';
  if (!allowed.includes(m)) m = allowed.includes('party') ? 'party' : allowed[0] ?? 'party';
  return m;
}

function buildState(s, spec, mode, { seed, settings }) {
  const profile = profileOf(s);
  const enemies = spec.enemies.slice(0, 8).map((e, i) => {
    const sh = normalizeSheet(e, profile, { side: 'enemy', seed: `${seed}:e${i}` });
    if (!e.codexId) auditSheet(sh, profile, { clampStats: true, bonusTier: (sh.threat === 'boss' ? 1 : 0) + (settings.difficulty === 'nightmare' ? 1 : 0) });
    return sh;
  });
  const allies = (spec.allies ?? []).slice(0, 4).map((e, i) => normalizeSheet(e, profile, { side: 'ally', seed: `${seed}:a${i}` }));
  const M = modeOf(mode);
  let st = M.create({ spec, profile, party: partyFor(s, { solo: mode === 'stealth' }), allies: mode === 'party' ? allies : [], enemies, seed, settings });
  let opening = null;
  const op = M.opening?.(st);
  if (op) { st = op.st; opening = op.events; }
  return { st, opening };
}

/** Deterministic difficulty nudges on top of what the referee wrote. */
function applyDifficulty(spec, settings, seed) {
  const d = settings.difficulty ?? 'normal';
  const out = { ...spec, terrain: [...(spec.terrain ?? [])] };
  const roll = (hashStr(`${seed}:diff`) % 1000) / 1000;
  const init = out.initiative ?? 'normal';
  if (d === 'easy' && init === 'enemy') out.initiative = 'normal';
  if (d === 'hard' && init === 'normal' && roll < 0.25) out.initiative = 'enemy';
  if (d === 'nightmare') {
    if (init === 'normal' && roll < 0.5) out.initiative = 'enemy';
    if (!out.terrain.some(t => t.side === 'ally' || Object.values(t.stages ?? {}).some(v => v < 0))) out.terrain.push({ desc: '불리한 지형', side: 'ally', stages: { spd: -1 } });
  }
  out.difficulty = d;
  return out;
}

export function beginBattle(s, spec0, { originIndex = -1, originHash = '', settings = {}, mode: override = null } = {}) {
  const seed = `${originHash}:${uid()}`;
  const spec = applyDifficulty(spec0, settings, seed);
  const mode = pickMode(spec, settings, override);
  const { st, opening } = buildState(s, spec, mode, { seed, settings });
  const M = modeOf(mode);
  const b = {
    id: `e${uid()}`, mode, st, seed, spec: clone(spec), status: st.status, turn: st.turn, title: spec.title || '', place: spec.place || '',
    history: [], originIndex, originHash, loot: spec.loot ?? [], opening, why: spec.why ?? '', threat: M.threat(st),
  };
  s.battle = b;
  s.idle = {};
  return b;
}

/** Switch the game type before the first turn (same encounter, same seed). */
export function switchMode(s, mode, settings = {}) {
  const b = s.battle;
  if (!b || b.history.length || !MODES[mode]) return false;
  const picked = pickMode({ ...b.spec, mode }, settings, mode);
  const { st, opening } = buildState(s, b.spec, picked, { seed: b.seed, settings });
  Object.assign(b, { mode: picked, st, opening, status: st.status, turn: st.turn, threat: modeOf(picked).threat(st) });
  return picked === mode;
}

const bare = b => { const c = clone(b); delete c.history; delete c.partyBefore; return c; };

/** Undo turns whose user messages were deleted/edited; cancel a battle whose origin vanished. */
export function syncHistory(s, chat, settings = {}) {
  const b = s.battle;
  if (!b) return { changed: false };
  relocateOrigin(s, chat);
  const keys = new Set(chat.map((m, i) => (m?.is_user ? msgKey(i, m.mes, m) : null)).filter(Boolean));
  const i = b.history.findIndex(h => !String(h.key).startsWith('local:') && !keys.has(h.key));
  if (i >= 0) {
    const wasOver = b.status !== 'active';
    const rolled = b.history.length - i;
    if (wasOver && b.partyBefore) { s.player = b.partyBefore.player; s.companions = b.partyBefore.companions; s.archive = s.archive.filter(a => a.id !== b.id); }
    const rebuilt = rebuildTo(s, b, i, settings);
    if (!rebuilt) {
      // Should not happen (the first turn always keeps a checkpoint) — never silently desync.
      b.desync = true;
      return { changed: true, rolledBack: 0, desync: true };
    }
    return { changed: true, rolledBack: rolled, replayed: rebuilt.replayed };
  }
  if (!b.history.length && b.originIndex >= 0) {
    const m = chat[b.originIndex];
    if (!m || (b.originHash && hashStr(m.mes ?? '') !== b.originHash && !m.extra?.battletale?.origin?.includes(b.id))) {
      s.battle = null;
      return { changed: true, cancelled: true };
    }
  }
  return { changed: false };
}

/**
 * Restore the battle as it was right before history[i]: start from the nearest earlier snapshot
 * and deterministically replay the turns in between (same seed, same stored commands).
 */
function rebuildTo(s, b, i, settings) {
  let j = i;
  while (j >= 0 && !b.history[j]?.before) j--;
  if (j < 0) return null;
  const cp = b.history[j];
  const start = clone(cp.before);
  start.history = b.history.slice(0, j);
  start.partyBefore = b.partyBefore;
  s.inventory = clone(cp.invBefore ?? s.inventory);
  s.battle = start;
  for (let k = j; k < i; k++) applyTurn(s, b.history[k], settings, { replay: true });
  s.battle.desync = false;
  return { replayed: i - j };
}

const TAG_RE = /⟨#([a-z0-9]{4,10})⟩/i;

export async function interpret(s, raw, deps) {
  const r = await interpretInner(s, String(raw ?? '').replace(TAG_RE, '').trim(), deps);
  const tag = TAG_RE.exec(String(raw ?? ''))?.[1]?.toLowerCase();
  if (tag) for (const c of r.commands) c.nonce ??= tag;
  return r;
}

async function interpretInner(s, mes, deps) {
  const b = s.battle;
  const M = modeOf(b.mode);
  const blocks = quickBlocks(mes);
  if (blocks.length) {
    const commands = blocks.map(q => { const c = M.quick(q.body, b.st); return c ? { ...c, nonce: q.nonce } : null; }).filter(Boolean);
    if (commands.length) return { commands, via: 'quick' };
  }
  const settings = deps.settings();
  if (settings.auxCommands && deps.auxReady()) {
    try {
      const profile = profileOf(s);
      const json = await deps.auxJson(commandMessages({
        status: M.status(b.st, profile, { lang: 'en' }), recent: deps.scene?.(3), input: mes, schema: M.auxSchema(b.st, profile),
        items: s.inventory.map(i => `${i.name} ×${i.count}`).join(', '),
      }), { maxTokens: 700 });
      return { commands: M.mapAux(json?.actions ?? [], b.st), via: 'aux' };
    } catch (e) {
      deps.toast?.(`보조모델 해석 실패 → 간이 해석 사용 (${e.message})`, 'warning');
    }
  }
  return { commands: M.local(mes, b.st, s.inventory), via: 'local' };
}

/** Grades from the panel minigame (by nonce) or from stats ("auto" timing mode). */
function withGrades(s, b, cmd, settings) {
  const M = modeOf(b.mode);
  const t = cmd.nonce ? s.timing[cmd.nonce] : null;
  if (t && t.battle === b.id && t.turn === b.st.turn) return M.applyGrades(cmd, t.grades);
  if (settings.timingMode === 'auto') return M.applyGrades(cmd, M.autoGrades(b.st, cmd));
  return cmd;
}

export function storeTiming(s, grades) {
  const b = s.battle;
  if (!b) return null;
  const nonce = uid().slice(0, 6);
  s.timing[nonce] = { battle: b.id, turn: b.st.turn, grades, at: Date.now() };
  const keys = Object.keys(s.timing);
  if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete s.timing[k];
  return nonce;
}

/** Resolve (or reuse) the turn for one user message. */
export async function playUserMessage(s, index, mes, deps, m = null) {
  const b = s.battle;
  if (!b || b.status !== 'active' || index <= b.originIndex) return null;
  return playText(s, msgKey(index, mes, m), index, mes, deps);
}

/** Panel-only play: the turn never touches the chat. */
export async function playLocal(s, text, deps) {
  const b = s.battle;
  if (!b || b.status !== 'active') return null;
  return playText(s, `local:${b.id}:${b.history.length}:${uid()}`, -1, text, deps);
}

async function playText(s, key, index, mes, deps) {
  const b = s.battle;
  const known = b.history.find(h => h.key === key);
  if (known) return { entry: known, reused: true };
  if (s.idle[key]) return { idle: true, reused: true };
  const settings = deps.settings();
  const { commands: raw, via } = await interpret(s, stripBlocks(mes), deps);
  if (!raw.length) { s.idle[key] = true; return { idle: true, via }; }
  const commands = raw.map(c => withGrades(s, b, c, settings));
  const entry = applyTurn(s, { key, index, commands, via }, settings);
  return { entry, via };
}

/**
 * Resolve one turn from already-interpreted commands and append it to history.
 * Used for live play and for replaying turns during a rollback (replay: keep the stored entry).
 */
function applyTurn(s, meta, settings, { replay = false } = {}) {
  const b = s.battle;
  const { key, index, commands, via } = meta;
  const M = modeOf(b.mode);
  const invBefore = clone(s.inventory);
  const before = bare(b);
  const turn = b.st.turn;
  const r = M.resolve(clone(b.st), commands, { inventory: s.inventory });
  let events = r.events;
  const next = { ...bare(b), st: r.st, status: r.st.status, turn: r.st.turn };
  s.inventory = r.inventory ?? s.inventory;
  if (r.transition?.mode === 'party') {
    // Stealth failed → the same people now fight.
    const old = r.st;
    const guards = old.b.fighters.filter(f => f.side === 'enemy' && r.transition.enemies.includes(f.id)).map(f => ({ ...stripRuntime(f), hp: f.hp }));
    const me = old.b.fighters.find(f => f.isPlayer);
    if (s.player && me) { s.player = { ...s.player, hp: me.hp, sp: me.sp }; }
    const spec = { ...b.spec, mode: 'party', enemies: guards, initiative: r.transition.initiative };
    const built = buildState(s, spec, 'party', { seed: `${b.seed}:t${turn}`, settings });
    Object.assign(next, { mode: 'party', st: built.st, status: built.st.status, turn: built.st.turn, spec, threat: MODES.party.threat(built.st) });
    events = [...events, { t: 'transition', to: 'party' }, ...(built.opening ?? [])];
  }
  const entry = replay ? { ...meta, before: meta.before ?? null } : { key, index, turn, mode: b.mode, events, commands, via, before, invBefore };
  next.history = [...b.history, entry].map((h, i, all) => (i >= all.length - HISTORY_KEEP || i % CHECKPOINT_EVERY === 0 ? h : { ...h, before: null }));
  next.partyBefore = b.partyBefore;
  s.battle = next;
  if (!replay && next.status !== 'active') finishBattle(s, settings);
  return entry;
}

function stripRuntime(f) {
  const { derived, stages, cds, guard, down, out, taunter, enraged, charging, staggered, revealed, defense, persistent, noSp, ...rest } = f;
  // Battle-time cost scaling never leaks back into the sheet.
  if (Array.isArray(rest.skills)) rest.skills = rest.skills.map(({ baseCost, ...k }) => ({ ...k, cost: baseCost ?? k.cost }));
  return rest;
}

const RESULT_KO = { win: '승리', lose: '패배', fled: '도주', stopped: '중단', success: '성공' };

export function finishBattle(s, settings = {}) {
  const b = s.battle;
  if (!b) return;
  b.partyBefore = clone({ player: s.player, companions: s.companions });
  const res = new Map(modeOf(b.mode).results(b.st).map(r => [r.id, r]));
  const write = sheet => {
    const r = res.get(sheet.id);
    if (!r) return sheet;
    return { ...sheet, hp: r.down || r.hp <= 0 ? (settings.reviveAfter === false ? 0 : 1) : r.hp, sp: r.sp, statuses: [] };
  };
  if (s.player) s.player = write(s.player);
  s.companions = s.companions.map(write);
  const enemies = modeOf(b.mode).enemiesOf(b.st).map(f => f.name).join(', ');
  s.lastResult = `${b.title ? `${b.title}: ` : ''}vs ${enemies} — ${String(b.status).toUpperCase()} after ${b.turn - 1} turns`;
  s.archive = [{ id: b.id, title: b.title || enemies, result: RESULT_KO[b.status] ?? b.status, mode: b.mode, turns: b.turn - 1, at: Date.now(), cards: b.history.map(h => ({ key: h.key, turn: h.turn, events: h.events, via: h.via })), origin: b.originIndex }, ...s.archive.filter(a => a.id !== b.id)].slice(0, ARCHIVE_KEEP);
  for (const k of Object.keys(s.timing)) if (s.timing[k].battle === b.id) delete s.timing[k];
  b.resultPending = settings.playMode !== 'chat';
}

export function stopBattle(s, result = 'stopped', settings = {}) {
  const b = s.battle;
  if (!b || b.status !== 'active') return false;
  b.status = ['win', 'lose', 'fled', 'stopped'].includes(result) ? result : 'stopped';
  b.st.status = b.status;
  finishBattle(s, settings);
  return true;
}

/* ---------------- Outside battle: story changes & status window ---------------- */
let globalDeps = null;
export function applyChanges(s, ops, deps = null) {
  globalDeps = deps;
  const profile = profileOf(s);
  const done = [];
  const pickWho = name => {
    if (!name) return s.player;
    const k = norm(name);
    return [s.player, ...s.companions].find(x => x && (norm(x.name) === k || norm(x.name).includes(k))) ?? s.player;
  };
  const amount = (v, max, cur) => {
    const t = String(v).trim();
    if (/^(full|max|전부|완전|전체회복)$/i.test(t)) return max;
    const pc = /^([+\-]?\d+(?:\.\d+)?)%$/.exec(t);
    if (pc) return clamp(cur + Math.round(max * num(pc[1]) / 100), 0, max);
    if (/^[+\-]/.test(t)) return clamp(cur + num(t), 0, max);
    return clamp(num(t, cur), 0, max);
  };
  for (const op of ops) {
    const who = pickWho(op.who);
    switch (op.op) {
      case 'hp': if (who) { who.hp = amount(op.value, who.maxHp, who.hp); done.push(`${who.name} ${profile.hpLabel} ${who.hp}/${who.maxHp}`); } break;
      case 'sp': if (who) { who.sp = amount(op.value, who.maxSp, who.sp); done.push(`${who.name} ${profile.spLabel} ${who.sp}/${who.maxSp}`); } break;
      case 'heal': for (const x of op.all ? [s.player, ...s.companions] : [pickWho(op.who)]) if (x) { x.hp = x.maxHp; x.sp = x.maxSp; x.statuses = []; done.push(`${x.name} 완전 회복`); } break;
      case 'item': {
        const it = s.inventory.find(i => norm(i.name) === norm(op.name));
        if (it) it.count += op.delta; else if (op.delta > 0) s.inventory.push({ name: op.name, count: op.delta });
        s.inventory = s.inventory.filter(i => i.count > 0);
        done.push(`${op.name} ${op.delta > 0 ? '+' : ''}${op.delta}`);
        break;
      }
      case 'stat': {
        if (!who) break;
        const key = profile.stats.find(x => norm(x.key) === norm(op.stat) || norm(x.label) === norm(op.stat))?.key;
        if (key) { who.stats[key] = op.set != null ? op.set : num(who.stats[key]) + op.delta; done.push(`${who.name} ${key} ${who.stats[key]}`); }
        else if (/^(maxhp|최대hp|최대체력)$/i.test(norm(op.stat))) { who.maxHp += op.delta ?? 0; who.hp = Math.min(who.hp, who.maxHp); }
        break;
      }
      case 'learn': {
        const m = /^(.+?)\s*(?:[(（](.+)[)）])?$/.exec(op.text);
        const sk = normalizeSkill({ ...inferSkill(m[1].trim() + ' ' + (m[2] ?? '')), name: m[1].trim(), desc: m[2] ?? '' }, { maxSp: s.player?.maxSp ?? 100 });
        if (s.player && sk && !s.player.skills.some(x => norm(x.name) === norm(sk.name))) { s.player.skills.push(sk); done.push(`스킬 습득: ${sk.name}`); }
        break;
      }
      case 'forget': if (s.player) s.player.skills = s.player.skills.filter(x => norm(x.name) !== norm(op.name)); break;
      case 'join': {
        if (s.companions.length >= 5) break;
        const reg = joinParty(s, { ...(globalDeps ?? {}) }, op.sheet.name);
        if (reg) { done.push(`동료 합류: ${reg.name} (도감)`); break; }
        const c = normalizeSheet(op.sheet, profile, { side: 'ally', seed: op.sheet.name });
        if (![s.player, ...s.companions].some(x => x && norm(x.name) === norm(c.name))) { s.companions.push(c); done.push(`동료 합류: ${c.name}`); }
        break;
      }
      case 'leave': s.companions = s.companions.filter(x => norm(x.name) !== norm(op.name)); done.push(`동료 이탈: ${op.name}`); break;
      case 'tier': if (s.player && tierOf(profile, op.value)) { s.player.tier = tierOf(profile, op.value).name; done.push(`등급: ${s.player.tier}`); } break;
      case 'upgrade': if (s.player) done.push(...editSheet(s.player, op, profile)); break;
      case 'level': if (who) done.push(...editSheet(who, { op: 'level', value: op.value }, profile).map(x => `${who.name} ${x}`)); break;
      case 'npc': {
        if (!deps) break;
        const r = applyNpcOps(s, deps, op.name, op.subs, { fromStory: true });
        if (r.done.length) done.push(`${r.name}: ${r.done.join(', ')}`);
        else if (r.why === 'locked') done.push(`${op.name}: 🔒 잠김 (변경 무시)`);
        break;
      }
    }
  }
  return done;
}

export function syncFromStatus(s, fields, mode = 'all') {
  if (!fields || !s.player || mode === 'off') return false;
  if (s.battle?.status === 'active') return false;
  const profile = profileOf(s);
  const part = sheetFromStatFields(fields, profile);
  if (!part) return false;
  const p = s.player;
  const before = JSON.stringify([p.hp, p.maxHp, p.sp, p.maxSp, p.stats, p.tier]);
  const pair = v => { const m = String(v ?? '').match(/([\d,.]+)\s*\/\s*([\d,.]+)/); return m ? [num(m[1]), num(m[2])] : null; };
  const hp = pair(part.hp), sp = pair(part.sp);
  if (hp) { p.maxHp = Math.max(1, hp[1]); p.hp = clamp(hp[0], 0, p.maxHp); }
  if (sp) { p.maxSp = Math.max(0, sp[1]); p.sp = clamp(sp[0], 0, p.maxSp); }
  if (mode === 'all') {
    for (const [k, v] of Object.entries(part.stats)) if (Number.isFinite(v)) p.stats[k] = v;
    const t = part.tier && tierOf(profile, part.tier);
    if (t) p.tier = t.name;
    for (const name of part.skillNames ?? []) if (!p.skills.some(x => norm(x.name) === norm(name))) p.skills.push(normalizeSkill(name, { maxSp: p.maxSp }));
  }
  return JSON.stringify([p.hp, p.maxHp, p.sp, p.maxSp, p.stats, p.tier]) !== before;
}

/* ---------------- What the main model sees this generation ---------------- */
export function promptFor(s, { lastUser, settings, deps = null }) {
  const profile = profileOf(s);
  const opts = { statusWindow: !!settings.statTag, showThreat: settings.showThreat !== false };
  const b = s.battle;
  if (settings.playMode !== 'chat' && b) {
    if (b.status === 'active') return panelWaitPrompt(b, profile, opts);
    // The first user message after a panel battle carries its result (swipes reuse it).
    if (lastUser && b.originIndex < lastUser.index) {
      const key = msgKey(lastUser.index, lastUser.mes, lastUser.m);
      if (b.resultPending && !b.resultKey) { b.resultKey = key; b.resultPending = false; }
      if (b.resultKey === key) return summaryPrompt(b, profile, { ...opts, detail: settings.resultDetail ?? 'summary' });
    }
  }
  if (b && lastUser) {
    const entry = b.history.find(h => h.key === msgKey(lastUser.index, lastUser.mes, lastUser.m));
    if (entry) {
      const after = b.history.at(-1) === entry ? b : (b.history[b.history.indexOf(entry) + 1]?.before ?? b);
      return turnPrompt(entry, after, profile, opts);
    }
    if (b.status === 'active') {
      if (lastUser.index > b.originIndex && s.idle[msgKey(lastUser.index, lastUser.mes, lastUser.m)]) return idlePrompt(b, profile, opts);
      return b.history.length ? idlePrompt(b, profile, opts) : startPrompt(b, profile, opts);
    }
  } else if (b && b.status === 'active') {
    return b.history.length ? idlePrompt(b, profile, opts) : startPrompt(b, profile, opts);
  }
  const registered = (deps?.codex?.list() ?? []).map(e => e.name).slice(0, 15);
  return worldPrompt({ mode: settings.startMode, player: s.player, party: s.companions, profile, statusWindow: opts.statusWindow, changes: settings.trackChanges, lastResult: s.lastResult, registered, inventory: s.inventory ?? [] });
}

export const threatKo = b => THREAT_LABEL[b?.threat?.level] ?? '';
export { MODES, modeOf, skillLine };
