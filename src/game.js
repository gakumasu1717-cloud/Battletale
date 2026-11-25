// Game controller: everything between "chat happened" and "engine resolved".
// Kept free of SillyTavern globals so it can be tested with plain objects.
import { normalizeProfile, setTypeSystem, normalizeSheet, normalizeSkill, inferSkill, parseSkillLine, skillLine, DEFAULT_PROFILE, tierOf, elementId, auditSheet, requestedSkillCap, toPoke, typesFor, typeName } from './catalog.js';
import { THREAT_LABEL, threatOf, createBattle } from './engine.js';
import { parseBattleBody, parseChange, sheetFromStatFields, stripBlocks } from './parse.js';
import { ruleMessages, setupMessages, briefText, sheetMessages, forgeMessages, planMessages, commandMessages, sheetText, turnPrompt, startPrompt, idlePrompt, worldPrompt, summaryPrompt, panelWaitPrompt } from './prompts.js';
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
  s.chatEnabled ??= s.disabled ? 'off' : 'inherit'; // 'inherit' | 'on' | 'off'
  s.customPassives ??= false; // opt-in per chat: only runs in this chat when explicitly enabled
  s.roster ??= {};
  s.brief ??= null;        // world brief from the one-time setup
  s.activated ??= false;   // the user turned BattleTale on for this chat (wand menu)
  if (s.battle && !s.battle.st) s.battle = null;   // v1 battle format → drop
  return s;
}

/**
 * Resolve whether BattleTale is active for the current chat + character.
 * Precedence: global off → per-chat override → per-character override → opt-in default → default on.
 */
export function resolveEnabled({ settings = {}, state = null, charKey = '', charName = '' } = {}) {
  const chatMode = state?.chatEnabled === 'on' || state?.chatEnabled === 'off'
    ? state.chatEnabled
    : (state?.disabled ? 'off' : 'inherit');
  const charMap = settings?.charEnabled && typeof settings.charEnabled === 'object' ? settings.charEnabled : {};
  const charMapVal = charKey ? charMap[charKey] : null;
  const excludeList = String(settings?.exclude ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const excludedByName = !!(charName && excludeList.includes(String(charName).toLowerCase()));
  const charMode = charMapVal === 'on' || charMapVal === 'off'
    ? charMapVal
    : (excludedByName ? 'off' : 'inherit');

  if (settings?.enabled === false) return { enabled: false, reason: 'global-off', chatMode, charMode };
  if (chatMode === 'off') return { enabled: false, reason: 'chat-off', chatMode, charMode };
  if (chatMode === 'on') return { enabled: true, reason: 'chat-on', chatMode, charMode };
  if (charMode === 'off') return { enabled: false, reason: 'char-off', chatMode, charMode };
  if (charMode === 'on') return { enabled: true, reason: 'char-on', chatMode, charMode };
  if (settings?.optIn) {
    const active = !!(state?.activated || state?.brief || state?.player || state?.battle);
    return { enabled: active, reason: active ? 'optin-active' : 'optin-wait', chatMode, charMode };
  }
  return { enabled: true, reason: 'default-on', chatMode, charMode };
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
    deps.toast?.('보조모델이 세계관 룰을 분석하는 중…');
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
  // Only an explicit choice in the panel or the status window's own rank field pins the tier; anything written in
  // the persona or description ("3등급", "프로기오", "B랭크") is read and mapped by the aux model.
  // A rank name the ladder doesn't know ("도미누스" in a world whose ladder came out as 하급…전설) must not be pinned
  // as-is: an unknown tier means default stats and mid-ladder caps. Hand it to the aux model to map instead.
  const statedRaw = String(partial?.tier || deps.statedRank?.() || '').trim();
  const stated = statedRaw && tierOf(profile, statedRaw);
  const fixedTier = (s.playerTier && tierOf(profile, s.playerTier)?.name) || (partial?.tier && stated ? stated.name : '') || '';
  const mapRank = statedRaw && !stated ? statedRaw : '';
  const current = instruction && s.player ? s.player : null;
  const maxSkills = requestedSkillCap([persona.text, extra, s.playerConcept, instruction].join('\n'), { statFields: partial ?? statFields, current });
  let raw = null;
  if (deps.auxReady()) {
    deps.toast?.(`보조모델이 ${persona.name}의 전투 시트를 만드는 중…`);
    try {
      // The persona and the lorebook entries about the player come first; once the world brief exists,
      // skip dumping the entire lorebook so the player's explicit rank in the persona isn't buried in noise.
      deps.trace?.('start', `플레이어 시트 생성 · ${persona.name}`, `페르소나: ${persona.text ? `${persona.text.length}자 (${persona.source ?? 'direct'})` : '비어 있음'}${fixedTier ? ` · 고정 등급: ${fixedTier}` : ''}`);
      const own = deps.matchLore ? ((await deps.matchLore(`${persona.name}\n${persona.text}`).catch(() => null))?.text ?? '') : '';
      const story = deps.mentions?.([persona.name]) ?? '';
      const worldLore = s.brief ? '' : await deps.lore();
      raw = await deps.auxJson(sheetMessages({ profile, lore: worldLore, persona: persona.text, personaName: persona.name, statFields, own, story, brief: briefText(s.brief), card: deps.character?.() ?? '', scene: deps.scene?.(Number(deps.settings?.()?.sheetScene) || 4), keepSkills: extra || s.playerConcept || '', current, instruction, tier: fixedTier, statedRank: mapRank || (!fixedTier && stated ? `${statedRaw} (= ${stated.name})` : ''), maxSkills }), { maxTokens: 2400 });
    } catch (e) {
      if (force) throw e;
      deps.toast?.(`시트 생성 실패 → 상태창/기본값 사용 (${e.message})`, 'warning');
    }
    if (raw && partial) {
      raw.stats = { ...(raw.stats ?? {}), ...partial.stats };
      if (partial.hp) raw.hp = partial.hp;
      if (partial.sp) raw.sp = partial.sp;
    }
    if (raw && fixedTier) raw.tier = fixedTier;
    // The aux mapped an unknown rank: remember it as an alias so the status window resolves from now on.
    if (raw && mapRank) {
      const t = tierOf(profile, raw.tier);
      if (t && rememberRankAlias(s, deps, t.name, mapRank)) deps.trace?.('balance', `등급 이름 연결 · ${mapRank} → ${t.name}`, '상태창·설명에 쓰인 등급 이름을 등급표의 단계에 연결했어요. 이후 상태창은 이 단계로 읽어요.');
    }
  }
  if (!raw) raw = { stats: partial?.stats, hp: partial?.hp, sp: partial?.sp, tier: fixedTier || profile.tiers[Math.min(2, profile.tiers.length - 1)]?.name, skills: partial?.skillNames ?? [] };
  if (mapRank && !tierOf(profile, raw.tier)) deps.toast?.(`"${mapRank}" 등급을 등급표에서 찾지 못했어요. 캐릭터 → 편집에서 등급을 직접 골라 주세요.`, 'warning');
  if (persona.text) s.playerPersonaHash = hashStr(persona.text);
  return applyPlayerSheet(s, deps, raw, { statFields, partial, maxSkills });
}

/**
 * One-time setup of a chat: read lore, card, persona and recent story once, and keep the rule set
 * (stats, ranks, elements + matchup chart) plus a compressed world brief that later prompts reuse.
 */
export async function setupChat(s, deps, { player = true } = {}) {
  if (!deps.auxReady()) throw new Error('보조모델이 필요해요');
  const persona = deps.persona();
  const fields = deps.statFields?.();
  const n = Math.max(4, Math.min(20, Number(deps.settings?.()?.castScene) || 12));
  const raw = await deps.auxJson(setupMessages({ lore: await deps.lore(), character: deps.character(), persona: persona.text, personaName: persona.name, history: deps.scene?.(n) ?? '', statTag: [fields ? JSON.stringify(fields) : '', deps.statedRank?.() ? `{{user}}'s rank as written in the story/status window: "${deps.statedRank()}" — this rank name MUST appear in the tier ladder (as a step name or in its aliases), at the position the world gives it.` : ''].filter(Boolean).join(' / ') }), { maxTokens: 4000 });
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tiers)) throw new Error('보조모델 답에 등급 체계가 없어요');
  const pokemon = s.profile?.typeSystem === 'pokemon' || deps.settings?.()?.ruleSet === 'pokemon';
  let profile = normalizeProfile(raw);
  if (pokemon) profile = setTypeSystem(profile, 'pokemon');
  s.profile = profile;
  deps.cache?.set(profile);
  const b = raw.brief && typeof raw.brief === 'object' ? raw.brief : {};
  const line = (v, max) => String(Array.isArray(v) ? v.join(' ') : v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const teller = (Array.isArray(b.storyteller) ? b.storyteller : String(b.storyteller ?? '').split(/\n+/)).map(x => String(x).trim()).filter(Boolean).slice(0, 4).map(x => x.slice(0, 160)).join('\n');
  s.brief = { at: Date.now(), parts: { combat: line(b.combat, 500), ranks: line(b.ranks, 400), elements: line(b.elements, 300), player: line(b.player, 300), storyteller: teller } };
  s.activated = true;
  s.disabled = false;
  deps.trace?.('setup', `기초 설정 · ${profile.name}`, `페르소나: ${persona.text ? `${persona.text.length}자 (${persona.source ?? 'direct'})` : '비어 있음'}\n${briefText(s.brief)}\n\n[메인 모델용]\n${teller || '(없음)'}`);
  // A sheet made before the setup was judged without it; only build one when there is none (edits are kept).
  if (player && !s.player) await ensurePlayer(s, deps);
  return s.brief;
}

/** Add a world rank name as an alias of a ladder step (kept in the chat's profile and the cached rule set). */
export function rememberRankAlias(s, deps, tierName, alias) {
  const p = profileOf(s);
  const t = p.tiers?.find(x => x.name === tierName);
  const a = String(alias ?? '').trim().slice(0, 24);
  if (!t || !a || norm(a) === norm(t.name) || (t.aliases ?? []).some(x => norm(x) === norm(a))) return false;
  // The same name must not point at two steps.
  for (const o of p.tiers) if (o !== t && o.aliases) o.aliases = o.aliases.filter(x => norm(x) !== norm(a));
  t.aliases = [...(t.aliases ?? []), a].slice(-6);
  s.profile = p;
  deps.cache?.set?.(p);
  return true;
}

/** Turn a raw (aux model) sheet into the player's sheet: normalize, audit, keep the portrait. */
export function applyPlayerSheet(s, deps, raw, { statFields = deps.statFields?.(), partial = null, maxSkills = 6 } = {}) {
  const profile = profileOf(s);
  const persona = deps.persona();
  if (raw.tierReason) deps.trace?.('balance', `등급 판단 · ${persona.name} → ${raw.tier ?? '?'}`, String(raw.tierReason));
  const sheet = normalizeSheet({ ...raw, name: persona.name, isPlayer: true, id: 'player' }, profile, { side: 'ally', seed: persona.name });
  sheet.id = 'player';
  sheet.isPlayer = true;
  if (s.player?.portrait && !sheet.portrait) sheet.portrait = s.player.portrait;
  const audit = auditSheet(sheet, profile, { clampStats: !statFields, maxSkills });
  if (audit.notes.length) { deps.toast?.(`등급(${sheet.tier || '?'})에 맞게 조정: ${audit.notes.slice(0, 3).join(' · ')}${audit.notes.length > 3 ? ` 외 ${audit.notes.length - 3}건` : ''}`, 'info'); deps.trace?.('balance', `밸런스 조정 · ${sheet.name}`, audit.notes.join('\n')); }
  if (!sheet.skills.length) sheet.skills = [normalizeSkill({ name: '전력 일격', kind: 'physical', power: 75, cost: Math.round(sheet.maxSp * 0.12) }, { maxSp: sheet.maxSp })];
  s.player = sheet;
  if (!s.inventory.length && partial?.items?.length) s.inventory = partial.items.map(name => ({ name, count: 1 }));
  return sheet;
}


/* ---------------- Character codex (world-level base sheets) + per-chat roster (growth) ---------------- */
// Names compared without parenthetical titles: "엘리어스 (총사)" → "엘리어스".
const nk = x => norm(String(x ?? '').replace(/[(（\[][^)）\]]*[)）\]]/g, ''));
/* ---------- Dex storage ---------- */
const CODEX_VERSIONS = 5;
/** What makes two sheets "different builds" (pictures and on/off switches do not count). */
const sheetSig = sh => JSON.stringify([sh?.tier, sh?.maxHp, sh?.maxSp, sh?.stats, sh?.elements, sh?.ptypes, sh?.skills, sh?.trait, sh?.customPassive?.code ?? '']);
const lightSheet = sh => { const c = clone(sh); delete c.portrait; return c; };
/** The character dex over one world's book: active list, archive, kept versions. */
export function codexBook(book, saveSettings = () => {}) {
  const all = () => Object.values(book()).sort((a, b) => a.name.localeCompare(b.name));
  return {
    // Everything that plays (matching by name, prompts, the cast scan) sees only active entries.
    list: () => all().filter(e => !e.archived),
    archived: () => all().filter(e => e.archived),
    all,
    // Replacing a sheet with a different build keeps the old one, so a reroll can always be undone.
    put: entry => {
      const prev = book()[entry.id];
      let versions = Array.isArray(prev?.versions) ? prev.versions : Array.isArray(entry.versions) ? entry.versions : [];
      if (prev?.sheet && entry.sheet && sheetSig(prev.sheet) !== sheetSig(entry.sheet)) {
        versions = [{ at: Date.now(), concept: prev.concept ?? '', sheet: lightSheet(prev.sheet) }, ...versions].slice(0, CODEX_VERSIONS);
      }
      book()[entry.id] = { ...entry, versions };
      saveSettings();
    },
    /** Swap the current sheet with a kept version (the current one goes back into the list). */
    restore: (id, index) => {
      const e = book()[id];
      const v = e?.versions?.[index];
      if (!v?.sheet) return null;
      const rest = e.versions.filter((_, i) => i !== index);
      const sheet = { ...clone(v.sheet), codexId: id, ...(e.sheet?.portrait ? { portrait: e.sheet.portrait } : {}) };
      book()[id] = { ...e, name: sheet.name ?? e.name, sheet, concept: v.concept || e.concept, updated: Date.now(),
        versions: [{ at: Date.now(), concept: e.concept ?? '', sheet: lightSheet(e.sheet) }, ...rest].slice(0, CODEX_VERSIONS) };
      saveSettings();
      return book()[id];
    },
    archive: (id, on) => { const e = book()[id]; if (!e) return null; if (on) e.archived = Date.now(); else delete e.archived; saveSettings(); return e; },
    remove: id => { delete book()[id]; saveSettings(); },
  };
}


/** Parse an exported dex file into plain { name, concept, role, archived, sheet } items (throws on anything else). */
export function importedEntries(text) {
  if (String(text ?? '').length > 6_000_000) throw new Error('파일이 너무 커요.');
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('JSON 파일이 아니에요.'); }
  const raw = Array.isArray(j?.entries) ? j.entries : j?.sheet ? [j] : null;
  if (!raw || (j.battletale == null && !j.sheet)) throw new Error('BattleTale 도감 파일이 아니에요.');
  const okPic = p => p && typeof p === 'object' && typeof p.src === 'string' && /^(data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s"'<>]+)$/.test(p.src) && p.src.length < 400_000;
  const out = [];
  for (const e of raw.slice(0, 60)) {
    const sh = e?.sheet;
    const name = String(e?.name ?? sh?.name ?? '').trim().slice(0, 40);
    if (!name || !sh || typeof sh !== 'object' || Array.isArray(sh)) continue;
    const sheet = JSON.parse(JSON.stringify(sh));
    for (const k of ['codexId', 'side', 'id', '__proto__', 'constructor']) delete sheet[k];
    if (okPic(sheet.portrait)) sheet.portrait = { src: sheet.portrait.src, pixel: !!sheet.portrait.pixel }; else delete sheet.portrait;
    out.push({ name, concept: String(e.concept ?? '').slice(0, 400), role: String(e.role ?? '').replace(/[^a-z]/gi, '').slice(0, 12), archived: !!e.archived, sheet });
  }
  if (!out.length) throw new Error('불러올 캐릭터가 없어요.');
  return out;
}


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

export function registerCharacter(s, deps, raw, { side = 'enemy', locked = false, maxSkills = 6 } = {}) {
  const profile = profileOf(s);
  const sheet = normalizeSheet(raw, profile, { side, seed: raw.name });
  if (raw.tierReason) deps.trace?.('balance', `등급 판단 · ${sheet.name} → ${sheet.tier || '?'}`, String(raw.tierReason));
  const { notes } = auditSheet(sheet, profile, { clampStats: true, bonusTier: sheet.threat === 'boss' ? 1 : 0, maxSkills });
  if (notes.length) { deps.toast?.(`${sheet.name} 밸런스 조정: ${notes.slice(0, 3).join(' · ')}${notes.length > 3 ? ` 외 ${notes.length - 3}건` : ''}`, 'info'); deps.trace?.('balance', `밸런스 조정 · ${sheet.name}`, notes.join('\n')); }
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
      deps.toast?.(`도감에 등록: ${e.name}`);
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
    case 'element': {
      const ids = String(op.value).split(/[\/,\s]+/).filter(Boolean).map(elementId).filter(x => x !== 'none').slice(0, 2);
      if (profile.typeSystem === 'pokemon') sheet.ptypes = [...new Set(ids.map(toPoke))]; else { sheet.elements = ids; sheet.element = ids[0] ?? 'none'; }
      done.push(`타입 ${op.value}`); break;
    }
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

/* Story-driven changes (<bt-change> or the aux watcher) are applied once per message VERSION.
 * Before the first change of a message the party is snapshotted; when the same message comes back with new text
 * (swipe, regenerate, edit) the snapshot is restored first, so a reroll never stacks the same growth twice.
 * Only the newest changed message keeps a snapshot: anything older may already have later changes built on it. */
const changeSnap = s => clone({ player: s.player, companions: s.companions, inventory: s.inventory, roster: s.roster });
export function rollbackChanges(s, index, log = () => {}) {
  const cl = s.changeLog;
  if (!cl || cl.index !== index || !cl.snap) return false;
  Object.assign(s, clone(cl.snap));
  log('change', `메시지 #${index}가 바뀌어 이전 버전의 변경을 되돌림`, (cl.done ?? []).join(', ') || '(기록 없음)');
  s.changeLog = { index, snap: cl.snap, done: [] };
  return true;
}
export function beginChanges(s, index) {
  if (s.changeLog?.index !== index) s.changeLog = { index, snap: changeSnap(s), done: [] };
  return s.changeLog;
}

/** Exact name first, then a partial match (the story may shorten a skill's name). */
function findSkill(sheet, name) {
  const k = nk(name);
  if (!k || !sheet?.skills) return null;
  return sheet.skills.find(x => nk(x.name) === k) ?? sheet.skills.find(x => nk(x.name).includes(k) || k.includes(nk(x.name))) ?? null;
}

/**
 * Story growth is free to stack, so every upgrade / new skill is checked against the same rank budget that sheets are
 * built with: a rank-B fighter can't reach rank-S power by ten "+10" lines. Returns notes for what was trimmed.
 */
function growthAudit(sheet, profile, names) {
  if (!sheet || !names?.length) return [];
  const keep = new Set(names.map(nk));
  const probe = { ...sheet, skills: sheet.skills.map(k => clone(k)) };
  const { notes } = auditSheet(probe, profile, { maxSkills: Math.max(12, sheet.skills.length), bonusTier: sheet.threat === 'boss' ? 1 : 0 });
  const out = [];
  probe.skills.forEach((k, i) => { if (keep.has(nk(k.name))) sheet.skills[i] = k; });
  for (const n of notes) if ([...keep].some(x => nk(n).includes(x))) out.push(`등급 상한 조정: ${n}`);
  return out;
}

/** Growth events for a registered character (from <bt-change> npc: lines or the panel). */
export function applyNpcOps(s, deps, name, subs, { fromStory = true } = {}) {
  const entry = codexFind(deps, name);
  const comp = entry ? s.companions.find(c => c.codexId === entry.id) : s.companions.find(c => nk(c.name) === nk(name));
  if (!entry && !comp) return { done: [], why: 'unknown' };
  if (entry?.locked && fromStory) return { done: [], why: 'locked' };
  const profile = profileOf(s);
  let sheet = comp ?? (s.roster[entry.id] ??= clone(entry.sheet));
  const done = subs.flatMap(op => {
    const out = editSheet(sheet, op, profile);
    const touched = op.op === 'upgrade' ? [findSkill(sheet, op.name)?.name] : op.op === 'learn' ? [sheet.skills.at(-1)?.name] : [];
    return out.length ? [...out, ...growthAudit(sheet, profile, touched.filter(Boolean))] : out;
  });
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
  // Allies are no longer fixed: the encounter builder picks registered characters who are really in the scene.
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
  const settings = deps.settings?.() ?? {};
  const withCompanions = spec => spec;
  if (!deps.auxReady()) return resolveRegistered(s, withCompanions(fallbackSpec(hint, s)), deps, settings);
  deps.toast?.('최근 대화를 보고 등장 인물을 판별하는 중…');
  const party = [s.player].filter(Boolean).map(x => sheetText(x, profile)).join('\n');
  const travelling = new Set(s.companions.map(c => c.codexId).filter(Boolean));
  const allowed = allowedModes(settings);
  try {
    // Step 1: lightweight scene classification — NO lorebook scan! Only recent chat + short codex index.
    const codex = [
      ...(deps.codex?.list() ?? []).slice(0, 50).map(e => {
        const sh = rosterSheet(s, e);
        const als = aliasesOf(e);
        return `- ${e.name}${als.length ? ` (${als.slice(0, 2).join(', ')})` : ''}${sh.tier ? ` [${sh.tier}]` : ''}${e.role ? ` · ${e.role}` : ''}${travelling.has(e.id) ? ' · travelling with {{user}}' : ''}${sh.hp <= 0 ? ' · knocked out' : ''}`;
      }),
      ...s.companions.filter(c => !c.codexId).map(c => `- ${c.name}${c.tier ? ` [${c.tier}]` : ''} · travelling with {{user}}`),
    ].join('\n');
    const scene = deps.scene?.(settings.sceneSize ?? 3) ?? '';
    const json = await deps.auxJson(planMessages({
      profile, scene, party, hint,
      inventory: s.inventory.map(i => `${i.name} ×${i.count}`).join(', '),
      modes: allowed, codex,
      difficulty: settings.difficulty ?? 'normal',
      brief: briefText(s.brief),
    }), { maxTokens: 2600 });
    const parsed = parseBattleBody(JSON.stringify(json));
    if (!parsed) return resolveRegistered(s, fallbackSpec(hint, s), deps, settings);

    // Step 2: resolve each participant according to its kind:
    //  - already in codex → reuse stored sheet (0 lore lookups, 0 extra calls)
    //  - mook / monster   → instantiate directly (supports count: 2..5)
    //  - unregistered major named character → look up ONLY their lore/mentions, generate proper sheet, register into codex
    const counts = { codex: 0, mook: 0, major: 0 };
    const majorLogs = [];
    const seenMajor = new Set();
    const fl = settings.forgeLore ?? 'auto';
    const brief = briefText(s.brief);
    const card = deps.character?.() ?? '';

    const buildMajor = async (item, side) => {
      const name = String(item.name ?? item.ref ?? '').trim();
      const aliases = Array.isArray(item.aliases) ? item.aliases.map(x => String(x).trim()).filter(Boolean) : [];
      const query = [name, ...aliases, item.concept ?? ''].filter(Boolean).join('\n');
      const matched = fl !== 'never' && deps.matchLore ? await deps.matchLore(query).catch(() => ({ text: '', names: [] })) : { text: '', names: [] };
      const story = deps.mentions?.([name, ...aliases]) ?? '';
      const roster = deps.rosterBrief?.(name) ?? '';
      deps.toast?.(`주요 인물 도감 생성 중: ${name}${matched.names?.length ? ` (월드인포 ${matched.names.length}개 참고)` : ''}`, 'info');
      try {
        const raw = await deps.auxJson(sheetMessages({
          profile, lore: '', own: matched.text, story, brief,
          persona: item.concept || `${name} (${side === 'ally' ? '아군' : '적'})`,
          personaName: name, npc: true, card, scene, roster,
        }), { maxTokens: 2400 });
        if (raw && typeof raw === 'object') {
          const merged = {
            ...raw,
            name: raw.name || name,
            aliases: [...new Set([...(Array.isArray(raw.aliases) ? raw.aliases : []), ...aliases])],
            threat: item.threat ?? raw.threat ?? (side === 'enemy' ? 'elite' : 'normal'),
            style: item.style ?? raw.style,
            row: item.row ?? raw.row,
            intel: item.intel ?? 2,
          };
          counts.major++;
          majorLogs.push(`${merged.name} (${matched.names?.length ? `로어 ${matched.names.length}건` : '대화 기반'})`);
          if (settings.autoRegister !== false) {
            const entry = registerCharacter(s, deps, merged, { side });
            const base = clone(rosterSheet(s, entry));
            return { ...base, codexId: entry.id, _src: 'major', row: merged.row ?? base.row, intel: merged.intel ?? 2, threat: merged.threat ?? base.threat, style: merged.style ?? base.style, hp: base.hp > 0 ? base.hp : base.maxHp, maxHp: base.maxHp };
          }
          return { ...merged, _src: 'major' };
        }
      } catch (err) {
        deps.trace?.('error', `주요 인물 도감 생성 실패 · ${name}`, err?.message ?? String(err));
      }
      // Safe fallback if Step-2 call failed
      counts.mook++;
      return { ...item, name, _src: 'mook', threat: item.threat ?? 'elite', desc: item.concept ?? item.desc ?? '' };
    };

    const pendingMajors = [];
    const resolveList = (list, side, cap) => {
      const out = [];
      for (const item of list ?? []) {
        if (out.length >= cap) break;
        const refName = typeof item === 'string' ? item : item.ref ?? item.name;
        const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
        let entry = codexFind(deps, refName);
        if (!entry) for (const a of aliases) { entry = codexFind(deps, a); if (entry) break; }
        if (entry) {
          counts.codex++;
          const base = clone(rosterSheet(s, entry));
          out.push({ ...base, codexId: entry.id, _src: 'codex', row: item?.row ?? base.row, intel: item?.intel ?? 2, threat: item?.threat ?? base.threat, style: item?.style ?? base.style, hp: base.hp > 0 ? base.hp : base.maxHp, maxHp: base.maxHp });
          continue;
        }
        if (typeof item !== 'object') continue;
        const kind = String(item.kind ?? '').toLowerCase();
        const isMajor = kind === 'major' || (kind === 'codex' && !item.skills?.length && refName) || (item.named && !item.skills?.length && refName);
        if (isMajor && refName && !seenMajor.has(nk(refName))) {
          seenMajor.add(nk(refName));
          const slot = out.length;
          out.push(null);
          pendingMajors.push({ out, slot, item, side });
          continue;
        }
        // Mook / generic monster (or inline sheet with skills)
        if (item.named && settings.autoRegister !== false && !item.ref) {
          const e = registerCharacter(s, deps, item, { side });
          deps.toast?.(`도감에 등록: ${e.name}`);
          counts.major++;
          out.push({ ...item, codexId: e.id, _src: 'major' });
          continue;
        }
        const n = clamp(Math.round(num(item.count, 1)), 1, Math.min(5, cap - out.length));
        const letters = 'ABCDE';
        for (let i = 0; i < n && out.length < cap; i++) {
          const copy = clone(item);
          delete copy.count; delete copy.kind;
          copy._src = 'mook';
          if (n > 1) copy.name = `${copy.name} ${letters[i] ?? (i + 1)}`;
          out.push(copy);
          counts.mook++;
        }
      }
      return out;
    };

    const enemies = resolveList(parsed.enemies, 'enemy', 8);
    const allies = resolveList(parsed.allies, 'ally', 4);
    if (pendingMajors.length) {
      const concurrency = clamp(Math.round(num(settings.majorConcurrency, 2)), 1, 4);
      if (pendingMajors.length > 1) deps.toast?.(`미등록 주요 인물 ${pendingMajors.length}명 도감 생성 중 (동시 최대 ${concurrency})…`, 'info');
      let cursor = 0;
      const worker = async () => {
        while (cursor < pendingMajors.length) {
          const task = pendingMajors[cursor++];
          try {
            task.out[task.slot] = await buildMajor(task.item, task.side);
          } catch (err) {
            deps.trace?.('error', `주요 인물 처리 예외 · ${task.item?.name ?? '?'}`, err?.message ?? String(err));
            task.out[task.slot] = { ...task.item, _src: 'mook' };
          }
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(concurrency, pendingMajors.length) }, worker));
    }
    parsed.enemies = enemies.filter(Boolean);
    parsed.allies = allies.filter(Boolean);
    if (!parsed.enemies.length) return resolveRegistered(s, fallbackSpec(hint, s), deps, settings);
    deps.trace?.('start', `전투 구성 · 도감 ${counts.codex} · 잡병 ${counts.mook} · 신규도감 ${counts.major}`, [
      `모드: ${parsed.mode ?? 'party'}${parsed.why ? ` (${parsed.why})` : ''}`,
      `적: ${parsed.enemies.map(e => `${e.name}${e.codexId ? ' [도감]' : ''}`).join(', ')}`,
      parsed.allies.length ? `아군: ${parsed.allies.map(a => `${a.name}${a.codexId ? ' [도감]' : ''}`).join(', ')}` : null,
      majorLogs.length ? `신규 도감 생성: ${majorLogs.join(', ')}` : null,
    ].filter(Boolean).join('\n'));
    return parsed;
  } catch (e) {
    deps.toast?.(`적 생성 실패 → 간이 생성 사용 (${e.message})`, 'warning');
    return resolveRegistered(s, withCompanions(fallbackSpec(hint, s)), deps, settings);
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
    else sh.codexId = e.codexId;
    return sh;
  });
  // Allies: whoever the encounter builder put in the scene. If it never decided (no aux model, old block),
  // the characters travelling with the player come along.
  const decided = spec.alliesDecided || (spec.allies?.length > 0);
  const pool = decided ? spec.allies ?? [] : s.companions.filter(c => c.hp > 0).map(c => clone(c));
  const allies = pool.slice(0, 4).map((e, i) => {
    const sh = normalizeSheet(e, profile, { side: 'ally', seed: `${seed}:a${i}` });
    if (e.codexId) sh.codexId = e.codexId; else auditSheet(sh, profile, { clampStats: true });
    return sh;
  });
  const M = modeOf(mode);
  // 1:1 (Pokémon singles): allies wait on the bench and can be switched in.
  const party = partyFor(s, { solo: mode === 'stealth' });
  if (mode === 'duel') party.push(...allies);
  const fit = fitThreat(enemies, [...party, ...(mode === 'party' ? allies : [])], profile, settings, spec);
  if (fit) spec.threatFit = fit;
  const effSettings = { ...settings, customPassives: !!(s.customPassives && settings.customPassives !== false) };
  let st = M.create({ spec, profile, party, allies: mode === 'party' ? allies : [], enemies, seed, settings: effSettings });
  let opening = null;
  const op = M.opening?.(st);
  if (op) { st = op.st; opening = op.events; }
  return { st, opening };
}

/**
 * Threat ceiling per difficulty (enemy power ÷ party power, same measure as the threat label:
 * >2.5 압도적, >1.35 위험, >0.75 대등). Ordinary encounters stay within reach of the party; only when the
 * referee marks the scene "outmatched" (a canonically stronger foe, a place known for higher-rank monsters,
 * the story saying {{user}} is outclassed) is the ceiling lifted.
 */
export const THREAT_CAP = { easy: 1.0, normal: 1.35, hard: 1.9, nightmare: 2.6 };
export function fitThreat(enemies, side, profile, settings = {}, spec = {}) {
  if (spec.outmatched || !side.length || !enemies.length) return null;
  const cap = THREAT_CAP[settings.difficulty ?? 'normal'] ?? 1.35;
  // Registered characters keep their canon sheet; only generic mooks and monsters are toned down.
  const scalable = enemies.filter(e => !e.codexId);
  if (!scalable.length) return null;
  const ratio = () => threatOf(createBattle({ party: side, enemies, profile, seed: 'fit', format: 'multi' })).ratio;
  const from = ratio();
  if (from <= cap) return null;
  // With a canon character in the fight, the mooks beside them shrink at most ~-50% (they must not vanish
  // just because the boss is strong); an all-generic encounter is brought all the way under the ceiling.
  const maxSteps = scalable.length < enemies.length ? 8 : 60;
  let r = from, steps = 0;
  while (r > cap && steps < maxSteps) {
    for (const e of scalable) {
      for (const k of Object.keys(e.stats ?? {})) e.stats[k] = Math.max(1, Math.round(e.stats[k] * 0.92));
      const rate = e.hp / Math.max(1, e.maxHp);
      e.maxHp = Math.max(1, Math.round(e.maxHp * 0.9)); e.hp = Math.max(1, Math.round(e.maxHp * rate));
    }
    r = ratio(); steps++;
  }
  // The rank label follows the new numbers (a "전설" bandit toned down to 중급 strength reads as 중급).
  const tiers = profile.tiers ?? [];
  if (steps && tiers.length) for (const e of scalable) {
    const vals = Object.values(e.stats ?? {}).map(Number).filter(v => v > 0);
    if (!vals.length) continue;
    const avg = vals.reduce((a, v) => a + v, 0) / vals.length;
    const best = tiers.slice().sort((a, b) => Math.abs((a.stat[0] + a.stat[1]) / 2 - avg) - Math.abs((b.stat[0] + b.stat[1]) / 2 - avg))[0];
    if (best && best.name !== e.tier) e.tier = best.name;
  }
  return { from: Math.round(from * 100) / 100, to: Math.round(r * 100) / 100, cap, steps };
}

/** Deterministic difficulty nudges on top of what the referee wrote. */
function applyDifficulty(spec, settings, seed) {
  const d = settings.difficulty ?? 'normal';
  const out = { ...spec, terrain: [...(spec.terrain ?? [])] };
  // hashStr is base-36 text; read its tail as a number (the old `% 1000` on the string was always NaN).
  const roll = (parseInt(hashStr(`${seed}:diff`).slice(-6), 36) % 1000) / 1000;
  const init = out.initiative ?? 'normal';
  if (d === 'easy' && init === 'enemy') out.initiative = 'normal';
  // HARD: no random ambush on top of the story — difficulty comes from enemy composition and AI.
  // Only NIGHTMARE adds surprise rounds the story did not call for.
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
    id: `e${uid()}`, mode, st, seed, spec: clone(spec), spec0: clone(spec0), status: st.status,
    // Everything a retry needs to put back: the party and bag exactly as they were before the fight.
    pre: clone({ player: s.player, companions: s.companions, inventory: s.inventory, roster: s.roster }), turn: st.turn, title: spec.title || '', place: spec.place || '',
    history: [], originIndex, originHash, loot: spec.loot ?? [], opening, why: spec.why ?? '', threat: M.threat(st),
  };
  s.battle = b;
  s.idle = {};
  return b;
}

/**
 * Retry a finished fight that has not been sent to the story yet: put the party, bag and wounds back as they were
 * before it, and start the same encounter again with a new seed (dice roll differently).
 */
export function retryBattle(s, settings = {}) {
  const b = s.battle;
  if (!b || b.status === 'active' || b.resultKey && b.resultKey !== 'dismissed') return null;
  const pre = b.pre ?? (b.partyBefore ? { ...b.partyBefore, inventory: s.inventory, roster: s.roster } : null);
  if (pre) {
    s.player = clone(pre.player); s.companions = clone(pre.companions ?? []);
    s.inventory = clone(pre.inventory ?? s.inventory); s.roster = clone(pre.roster ?? s.roster);
  }
  s.archive = s.archive.filter(a => a.id !== b.id);
  s.lastResult = null;
  const spec = clone(b.spec0 ?? b.spec);
  const next = beginBattle(s, spec, { originIndex: b.originIndex, originHash: b.originHash, settings, mode: b.mode });
  next.retryOf = b.id;
  next.retries = (b.retries ?? 0) + 1;
  return next;
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
export async function playLocal(s, text, deps, { commands = null } = {}) {
  const b = s.battle;
  if (!b || b.status !== 'active') return null;
  return playText(s, `local:${b.id}:${b.history.length}:${uid()}`, -1, text, deps, { commands });
}

async function playText(s, key, index, mes, deps, { commands: direct = null } = {}) {
  const b = s.battle;
  const known = b.history.find(h => h.key === key);
  if (known) return { entry: known, reused: true };
  if (s.idle[key]) return { idle: true, reused: true };
  const settings = deps.settings();
  const { commands: raw, via } = direct?.length ? { commands: direct, via: 'quick' } : await interpret(s, stripBlocks(mes), deps);
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
  // Registered characters who fought beside the player keep their wounds in this chat.
  for (const f of (b.st.fighters ?? b.st.b?.fighters ?? [])) {
    if (f.side !== 'ally' || !f.codexId || s.companions.some(c => c.codexId === f.codexId)) continue;
    const r = res.get(f.id);
    if (!r) continue;
    const cur = s.roster[f.codexId] ?? stripRuntime(clone(f));
    s.roster[f.codexId] = { ...cur, hp: r.down || r.hp <= 0 ? (settings.reviveAfter === false ? 0 : 1) : r.hp, sp: r.sp, statuses: [] };
  }
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
  // A leading companion name ("서윤 화염방사 power +10") picks who the line is about; otherwise it is {{user}}.
  const ownerOf = (text, ok) => {
    const t = String(text ?? '').trim();
    for (const x of s.companions) {
      const n = String(x.name ?? '').trim();
      if (n && norm(t).startsWith(norm(n)) && t.length > n.length) {
        const rest = t.slice(n.length).replace(/^[\s|:,·-]+/, '');
        if (rest && ok(x, rest)) return { who: x, rest };
      }
    }
    return { who: s.player ?? null, rest: t };
  };
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
      case 'cure': if (who) { who.statuses = []; done.push(`${who.name} 상태이상 해제`); } break;
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
        // "skill: Name: physical 70 fire (desc)" or "skill: Name (desc)"; a companion's name in front picks them.
        const { who: tgt, rest } = ownerOf(op.text, x => true);
        if (!tgt) break;
        const had = new Set(tgt.skills.map(x => norm(x.name)));
        const out = editSheet(tgt, { op: 'learn', text: rest }, profile);
        const fresh = tgt.skills.filter(x => !had.has(norm(x.name)));
        if (out.length) done.push(...out.map(x => `${tgt === s.player ? '' : `${tgt.name} `}${x.replace(/^습득 /, '스킬 습득: ')}`), ...growthAudit(tgt, profile, fresh.map(x => x.name)));
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
      case 'upgrade': {
        // "upgrade: Skill power +10" for {{user}}, "upgrade: Companion Skill power +10" for a companion.
        const { who: tgt, rest } = ownerOf(op.name, (x, n) => !!findSkill(x, n));
        if (!tgt || !findSkill(tgt, rest)) { done.push(`강화 대상 없음: ${op.name}`); break; }
        const out = editSheet(tgt, { ...op, name: findSkill(tgt, rest).name }, profile);
        done.push(...out.map(x => (tgt === s.player ? x : `${tgt.name} ${x}`)), ...growthAudit(tgt, profile, [findSkill(tgt, rest).name]));
        break;
      }
      case 'level': if (who) done.push(...editSheet(who, { op: 'level', value: op.value }, profile).map(x => `${who.name} ${x}`)); break;
      case 'npc': {
        if (!deps) break;
        const r = applyNpcOps(s, deps, op.name, op.subs, { fromStory: true });
        if (r.done.length) done.push(`${r.name}: ${r.done.join(', ')}`);
        else if (r.why === 'locked') done.push(`${op.name}: 잠김 (변경 무시)`);
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
  return worldPrompt({ mode: settings.startMode, player: s.player, party: s.companions, profile, statusWindow: opts.statusWindow, changes: settings.trackChanges, lastResult: s.lastResult, registered, inventory: s.inventory ?? [], fightGuard: settings.fightGuard !== false, brief: s.brief?.parts?.storyteller ?? '' });
}

export function claimLoot(s, b) {
  if (!b?.loot?.length || b.lootClaimed) return [];
  const added = [];
  s.inventory ??= [];
  for (const raw of b.loot) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const m = /^(.+?)\s*[×xX*]\s*(\d+)$/.exec(text);
    const name = (m ? m[1] : text).trim().slice(0, 50);
    const count = m ? Math.max(1, Math.min(99, Number(m[2]) || 1)) : 1;
    const it = s.inventory.find(i => norm(i.name) === norm(name));
    if (it) it.count += count; else s.inventory.push({ name, count });
    added.push(`${name}${count > 1 ? ` ×${count}` : ''}`);
  }
  b.lootClaimed = true;
  return added;
}

export function restAfterBattle(s, kind = 'short') {
  const members = [s.player, ...(s.companions ?? [])].filter(Boolean);
  if (!members.length) return [];
  const full = kind === 'full';
  const done = [];
  for (const m of members) {
    const hp0 = m.hp, sp0 = m.sp, st0 = m.statuses?.length ?? 0;
    if (full) {
      m.hp = m.maxHp; m.sp = m.maxSp; m.statuses = [];
    } else {
      m.hp = clamp(m.hp + Math.round(m.maxHp * 0.3), 0, m.maxHp);
      m.sp = clamp(m.sp + Math.round(m.maxSp * 0.3), 0, m.maxSp);
      if (m.hp === 0 && m.maxHp > 0) m.hp = Math.max(1, Math.round(m.maxHp * 0.2));
    }
    if (m.hp !== hp0 || m.sp !== sp0 || (m.statuses?.length ?? 0) !== st0) {
      done.push(m.name);
      if (m.codexId && s.roster?.[m.codexId]) {
        s.roster[m.codexId].hp = m.hp;
        s.roster[m.codexId].sp = m.sp;
        s.roster[m.codexId].statuses = [...(m.statuses ?? [])];
      }
    }
  }
  return done;
}

export const threatKo = b => THREAT_LABEL[b?.threat?.level] ?? '';
export { MODES, modeOf, skillLine };
