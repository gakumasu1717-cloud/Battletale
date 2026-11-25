// Text <-> data: battle/change blocks, quick command syntax, local fallback
// command parsing, and importing a status-window tag (e.g. <stat>…</stat>).
import { norm, num, extractJson } from './util.js';
import { findFighter, findSkill, active } from './engine.js';

const BLOCK_RE = /<\s*bt-(battle|change|end)\s*>([\s\S]*?)<\s*\/\s*bt-\1\s*>/gi;
// Closed tag, self-closing tag, or a bare opening tag only at the very end of the message.
// Tolerant of what models really write: <bt-start>, [bt-start], <BT_START>, an unclosed tag at the end.
const START_RE = /[<\[]\s*bt[-_ ]?start\s*(?:\/\s*[>\]]|[>\]]([\s\S]*?)[<\[]\s*\/\s*bt[-_ ]?start\s*[>\]]|[>\]]([^<\[]{0,300})$)/gi;

// Heuristic "this looks like a confrontation" check, for when the main model forgets the tag
// (or the story opens mid-crisis in a greeting the model never wrote).
const DANGER_RE = /(습격|기습|매복|덮쳐|덤벼|달려들|공격(?:해|하|을|이)|칼을 (?:뽑|겨누)|검을 (?:뽑|겨누)|활시위|포위|에워싸|살기|적의|맹수|괴물|몬스터|마물|추격|쫓기|쫓아오|도망쳐|싸움|전투|결투|대치|총구|방아쇠|ambush|attack(?:s|ed|ing)?\b|draws? (?:a |his |her )?(?:sword|blade|gun)|surround(?:ed|s)|monster|hostile|fight|duel|chas(?:e|ing)|growl)/gi;
export function dangerScore(text) {
  const t = String(text ?? '').slice(-2500);
  const hits = new Set((t.match(DANGER_RE) ?? []).map(x => x.toLowerCase()));
  return hits.size;
}

export function findBlocks(text) {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(BLOCK_RE)) out.push({ kind: m[1].toLowerCase(), body: m[2].trim(), start: m.index, end: m.index + m[0].length, raw: m[0] });
  for (const m of s.matchAll(START_RE)) out.push({ kind: 'start', body: (m[1] ?? m[2] ?? '').trim(), start: m.index, end: m.index + m[0].length, raw: m[0] });
  return out.sort((a, b) => a.start - b.start);
}

export function stripBlocks(text) {
  return String(text ?? '').replace(BLOCK_RE, '').replace(START_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- Battle block ---------- */
const KEY = {
  enemy: ['enemy', 'foe', 'monster', 'opponent', '적', '상대', '몬스터', '적군'], ally: ['ally', 'partner', 'companion', '아군', '동료', '파트너'],
  place: ['place', 'location', 'terrain', '장소', '지형', '위치'], flee: ['flee', 'escape', 'run', '도주', '도망'],
  title: ['title', 'name', 'battle', '제목', '전투'], loot: ['loot', 'reward', 'drop', '보상', '전리품', '드랍'], scene: ['scene', 'note', '상황', '메모'],
  mode: ['mode', 'type', 'format', '형식', '모드', '방식'], variant: ['variant', '변형'], initiative: ['initiative', 'ambush', '선공', '기습'],
  goal: ['goal', 'objective', '목표'], style: ['style', 'fightingstyle', '스타일', '전투스타일', '성향'], terrain: ['terrain', 'environment', '환경', '지형효과'],
};
const keyOf = raw => Object.entries(KEY).find(([, list]) => list.some(w => norm(w) === norm(raw)))?.[0] ?? null;
const YES = /^(y|yes|true|on|ok|가능|예|네|o|1)$/i;

export function parseBattleBody(body) {
  const s = String(body ?? '').trim();
  if (!s) return null;
  if (/^[{[]/.test(s) || /```/.test(s)) {
    const j = extractJson(s);
    if (j) return fromJson(j);
  }
  const spec = { enemies: [], allies: [], place: '', flee: true, title: '', loot: [], scene: '', terrain: [] };
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*•·]\s*/, '').trim();
    const m = /^([^:：]{1,20})\s*[:：]\s*(.+)$/.exec(line);
    if (!m) continue;
    const k = keyOf(m[1]);
    const v = m[2].trim();
    if (k === 'enemy') spec.enemies.push(pipeSheet(v));
    else if (k === 'ally') spec.allies.push(pipeSheet(v));
    else if (k === 'flee') spec.flee = YES.test(v) || !/^(n|no|false|off|불가|아니|x|0)/i.test(v);
    else if (k === 'loot') spec.loot.push(...v.split(/[,¶]/).map(x => x.trim()).filter(Boolean));
    else if (k === 'terrain') spec.terrain.push(...v.split(/[,¶]/).map(x => ({ desc: x.trim() })).filter(x => x.desc));
    else if (k === 'mode') spec.mode = modeWord(v);
    else if (k === 'initiative') spec.initiative = /player|유저|플레이어|아군|we|우리/i.test(v) ? 'player' : /enemy|적|ambush/i.test(v) ? 'enemy' : 'normal';
    else if (k) spec[k] = v;
  }
  return spec.enemies.length ? spec : null;
}

export function modeWord(v) {
  const t = String(v ?? '').toLowerCase();
  if (/duel|결투|1:1|1대1|일대일|심리전|대련/.test(t)) return 'duel';
  if (/stealth|sneak|chase|잠입|추격|은신|도주|infiltrat/.test(t)) return 'stealth';
  return 'party';
}

/** Model output is not trusted to be well-formed: one item → list, junk → dropped. */
const listOf = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : typeof v === 'string' ? v.split(/[,，、]/).map(x => x.trim()).filter(Boolean) : typeof v === 'object' ? (v.name || v.ref ? [v] : []) : [])
  .filter(x => (typeof x === 'string' && x.trim()) || (x && typeof x === 'object' && !Array.isArray(x) && (x.name || x.ref)));

function fromJson(j) {
  if (!j || typeof j !== 'object') return null;
  const spec = { enemies: [], allies: [], place: String(j.place ?? ''), flee: j.flee !== false, title: String(j.title ?? ''), loot: [], scene: String(j.scene ?? '') };
  if (j.mode) spec.mode = modeWord(j.mode);
  if (j.variant) spec.variant = String(j.variant);
  if (j.initiative) spec.initiative = ['player', 'enemy'].includes(j.initiative) ? j.initiative : 'normal';
  if (Array.isArray(j.terrain)) spec.terrain = j.terrain.filter(Boolean).map(t => (typeof t === 'string' ? { desc: t } : t));
  for (const k of ['goal', 'style', 'why', 'distance', 'alert', 'stones', 'outmatchedWhy']) if (j[k] != null) spec[k] = j[k];
  if (j.outmatched === true || /^(true|yes)$/i.test(String(j.outmatched ?? ''))) spec.outmatched = true;
  spec.enemies = listOf(Array.isArray(j) ? j : j.enemies).slice(0, 8);
  spec.allies = listOf(j.allies).slice(0, 4);
  spec.alliesDecided = Array.isArray(j.allies);   // the builder looked at the scene and chose (maybe nobody)
  spec.loot = Array.isArray(j.loot) ? j.loot.map(String) : j.loot ? String(j.loot).split(',') : [];
  return spec.enemies.length ? spec : null;
}

/** "Goblin | tier D | threat elite | hp 400 | STR 30 | skills Axe Swing, Warcry | weak 불" */
export function pipeSheet(text) {
  const [name, ...parts] = String(text).split('|').map(x => x.trim()).filter(Boolean);
  const out = { name: name ?? '???' };
  const stats = {};
  for (const p of parts) {
    const m = /^([^\s:：]+)\s*[:：]?\s*(.*)$/.exec(p);
    if (!m) continue;
    const k = norm(m[1]), v = m[2].trim();
    if (['tier', 'rank', '등급', '랭크', '티어'].includes(k)) out.tier = v;
    else if (['threat', 'class', 'danger', '위협', '위협도', '분류'].includes(k)) out.threat = v;
    else if (['hp', '체력', '생명력'].includes(k)) out.hp = v;
    else if (['sp', 'mp', '마나', '기력'].includes(k)) out.sp = v;
    else if (['skills', 'skill', 'moves', '기술', '스킬'].includes(k)) out.skills = splitSkills(v);
    else if (['weak', 'weakness', '약점'].includes(k)) out.weak = v;
    else if (['resist', 'resistance', '저항', '내성'].includes(k)) out.resist = v;
    else if (['immune', '면역'].includes(k)) out.immune = v;
    else if (['element', 'attr', 'attribute', '속성'].includes(k)) out.element = v;
    else if (['focus', '주스탯', '특화'].includes(k)) out.focus = v;
    else if (['desc', 'description', '설명'].includes(k)) out.desc = v;
    else if (['actions', '행동수'].includes(k)) out.actions = num(v, 1);
    else if (['row', 'position', '열', '위치'].includes(k)) out.row = v;
    else if (['intel', '정보'].includes(k)) out.intel = num(v, 1);
    else if (['style', '스타일', '성향'].includes(k)) out.style = v;
    else if (/^-?[\d.,]+$/.test(v)) stats[m[1]] = num(v);
    else if (/^[\d.,]+\s*\/\s*[\d.,]+$/.test(v)) out[m[1]] = v;
  }
  if (Object.keys(stats).length) out.stats = stats;
  return out;
}

const splitSkills = v => {
  // Keep commas inside parentheses: "Fireball (fire, burn 30%), Heal"
  const out = []; let depth = 0, cur = '';
  for (const ch of v) {
    if (ch === '(' || ch === '（') depth++;
    if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '¶') && !depth) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(x => x.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim() || x);
};

/* ---------- Change block (out-of-battle state changes) ---------- */
export function parseChange(body) {
  const ops = [];
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*•·]\s*/, '').trim();
    const m = /^([^:：]{1,16})\s*[:：]\s*(.+)$/.exec(line);
    if (!m) continue;
    const k = norm(m[1]), v = m[2].trim();
    const who = (val) => {
      const w = /^(.+?)\s+([+\-]?\d[\d,.]*%?|full|max|전부|완전|전체회복)$/i.exec(val);
      return w ? { who: w[1].trim(), value: w[2] } : { who: null, value: val };
    };
    if (['hp', '체력'].includes(k)) ops.push({ op: 'hp', ...who(v) });
    else if (['sp', 'mp', '마나', '기력'].includes(k)) ops.push({ op: 'sp', ...who(v) });
    else if (['status', '상태', '상태이상'].includes(k)) { const w = /^(.+?)\s+(clear|해제|회복|없음|정상)$/i.exec(v); ops.push({ op: 'cure', who: w ? w[1].trim() : /^(clear|해제|회복|없음|정상)$/i.test(v) ? null : v }); }
    else if (['heal', '회복'].includes(k)) ops.push({ op: 'heal', who: /^(all|전체|모두|파티)$/i.test(v) ? null : v, all: /^(all|전체|모두|파티)$/i.test(v) });
    else if (['item', '아이템'].includes(k)) {
      const im = /^(.+?)\s*([+\-]\s*\d+)?\s*(?:\|\s*(.+))?$/.exec(v);
      ops.push({ op: 'item', name: im[1].trim(), delta: im[2] ? num(im[2].replace(/\s/g, '')) : 1, spec: im[3] ?? null });
    } else if (['stat', '스탯', '능력치'].includes(k)) {
      const sm = /^(?:(.+?)\s+)?([^\s]+)\s*([+\-]\s*\d+|=\s*\d+)$/.exec(v);
      if (sm) ops.push({ op: 'stat', who: sm[1] ?? null, stat: sm[2], delta: sm[3].startsWith('=') ? null : num(sm[3].replace(/\s/g, '')), set: sm[3].startsWith('=') ? num(sm[3].slice(1)) : null });
    } else if (['skill', 'learn', '스킬', '기술', '습득'].includes(k)) ops.push({ op: 'learn', text: v });
    else if (['forget', '삭제', '망각'].includes(k)) ops.push({ op: 'forget', name: v });
    else if (['join', 'companion', '합류', '동료'].includes(k)) ops.push({ op: 'join', sheet: pipeSheet(v) });
    else if (['leave', '이탈', '탈퇴'].includes(k)) ops.push({ op: 'leave', name: v });
    else if (['tier', 'rank', '등급', '랭크'].includes(k)) ops.push({ op: 'tier', value: v });
    else if (['upgrade', '강화', '스킬강화', '기술강화'].includes(k)) ops.push({ op: 'upgrade', ...upgradeOf(v) });
    else if (['level', 'lv', '레벨'].includes(k)) ops.push({ op: 'level', ...who(v) });
    else if (['npc', '캐릭터', '인물'].includes(k)) {
      const [name, ...subs] = v.split('|').map(x => x.trim()).filter(Boolean);
      if (name) ops.push({ op: 'npc', name, subs: subs.map(npcSub).filter(Boolean) });
    }
  }
  return ops;
}

/** "섬광 베기 power +10" | "섬광 베기 위력+10 비용-2" | "섬광 베기: 물리 90 광휘" (full replace) */
export function upgradeOf(v) {
  const m = /^([^:：]+?)\s*[:：]\s*(.+)$/.exec(v);
  if (m) return { name: m[1].trim(), line: `${m[1].trim()}: ${m[2].trim()}` };
  const mods = [];
  let name = v;
  const re = /\s+(power|위력|cost|비용|acc|명중|priority|우선도|hits|타수|cooldown|쿨|heal|회복|chance|확률)\s*([+\-=]?)\s*(\d+)/gi;
  let first = null, x;
  while ((x = re.exec(v))) { if (first == null) first = x.index; mods.push({ field: FIELD[x[1].toLowerCase()] ?? FIELD[x[1]], sign: x[2] || '+', value: +x[3] }); }
  if (first != null) name = v.slice(0, first);
  return { name: name.trim(), mods };
}
const FIELD = { power: 'power', 위력: 'power', cost: 'cost', 비용: 'cost', acc: 'acc', 명중: 'acc', priority: 'priority', 우선도: 'priority', hits: 'hits', 타수: 'hits', cooldown: 'cooldown', 쿨: 'cooldown', heal: 'selfHeal', 회복: 'selfHeal', chance: 'chance', 확률: 'chance' };

function npcSub(part) {
  const m = /^(\S+)\s*(.*)$/.exec(part);
  if (!m) return null;
  const k = norm(m[1]), v = m[2].trim();
  if (['stat', '스탯', '능력치'].includes(k)) { const sm = /^([^\s]+)\s*([+\-]\s*\d+|=\s*\d+)$/.exec(v); return sm ? { op: 'stat', stat: sm[1], delta: sm[2].startsWith('=') ? null : num(sm[2].replace(/\s/g, '')), set: sm[2].startsWith('=') ? num(sm[2].slice(1)) : null } : null; }
  if (['learn', 'skill', '습득', '스킬', '기술'].includes(k)) return { op: 'learn', text: v };
  if (['upgrade', '강화'].includes(k)) return { op: 'upgrade', ...upgradeOf(v) };
  if (['forget', '망각', '삭제'].includes(k)) return { op: 'forget', name: v };
  if (['hp', '체력'].includes(k)) return { op: 'maxhp', value: v };
  if (['sp', 'mp', '마나'].includes(k)) return { op: 'maxsp', value: v };
  if (['tier', 'rank', '등급', '랭크'].includes(k)) return { op: 'tier', value: v };
  if (['element', '속성', '타입'].includes(k)) return { op: 'element', value: v };
  if (['level', 'lv', '레벨'].includes(k)) return { op: 'level', value: v };
  // "AGI +5" shorthand
  const sm = /^([+\-]\s*\d+)$/.exec(v);
  if (sm) return { op: 'stat', stat: m[1], delta: num(sm[1].replace(/\s/g, '')) };
  return null;
}

/* ---------- Commands ---------- */
function extractQuickBodies(text) {
  const s = String(text ?? ''), out = [], re = /⚔\s*\[/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    let i = m.index + m[0].length, depth = 1;
    while (i < s.length && depth > 0) { if (s[i] === '[') depth++; else if (s[i] === ']') depth--; i++; }
    if (depth !== 0) break;
    out.push(s.slice(m.index + m[0].length, i - 1).trim());
    re.lastIndex = i;
  }
  return out;
}
const W = {
  attack: /^(attack|basic|공격|기본\s*공격|평타|때리기)$/i,
  defend: /^(defend|guard|block|방어|막기|가드|방어\s*태세)$/i,
  flee: /^(flee|run|escape|도주|도망|후퇴|퇴각)$/i,
  wait: /^(wait|pass|대기|관망)$/i,
};

/** Panel buttons write "⚔[스킬명 → 대상]" so these never need the aux model. */
export function parseQuick(text, battle, actor) {
  const out = [];
  for (const body of extractQuickBodies(text)) {
    const [left, right] = body.split(/\s*(?:→|->|>|=>)\s*/);
    let who = actor;
    let what = left.trim();
    const byWho = /^(.+?)\s*[:：]\s*(.+)$/.exec(what);
    if (byWho && !(actor && findSkill(actor, what))) { const f = findFighter(battle, byWho[1], { side: 'ally' }); if (f) { who = f; what = byWho[2].trim(); } }
    if (!who) continue;
    const target = right?.trim() || null;
    const item = /^(?:item|아이템|사용)\s+(.+)$/i.exec(what);
    if (W.attack.test(what)) out.push({ actor: who.id, type: 'attack', target });
    else if (W.defend.test(what)) out.push({ actor: who.id, type: 'defend' });
    else if (W.flee.test(what)) out.push({ actor: who.id, type: 'flee' });
    else if (W.wait.test(what)) out.push({ actor: who.id, type: 'wait' });
    else if (item) out.push({ actor: who.id, type: 'item', item: item[1].trim(), target });
    else if (findSkill(who, what)) out.push({ actor: who.id, type: 'skill', skill: findSkill(who, what).name, target });
    else out.push({ actor: who.id, type: 'improvise', target, improv: { desc: what, stat: 'pow', difficulty: 'normal', effect: { kind: 'damage', power: 50 } } });
  }
  return out;
}

export const hasQuick = text => /⚔\s*\[[^\]]+\]/.test(String(text ?? ''));

/** Best-effort parsing without any model: skill names, flee/defend words, item names, target names. */
export function parseLocal(text, battle, actor, inventory = []) {
  const t = String(text ?? '');
  const k = norm(t);
  if (!actor || !active(actor)) return [];
  const foes = battle.fighters.filter(f => f.side === 'enemy' && active(f));
  const target = foes.find(f => k.includes(norm(f.name)) || (f.name.split(/\s+/)[0].length >= 2 && k.includes(norm(f.name.split(/\s+/)[0]))));
  const skill = actor.skills.slice().sort((a, b) => b.name.length - a.name.length).find(s => k.includes(norm(s.name)));
  if (skill) return [{ actor: actor.id, type: 'skill', skill: skill.name, target: target?.name ?? null }];
  const item = inventory.find(i => k.includes(norm(i.name)));
  if (item && /(사용|먹|마시|던지|꺼내|use|drink|throw)/i.test(t)) return [{ actor: actor.id, type: 'item', item: item.name, target: null }];
  if (/(도망|도주|후퇴|퇴각|달아나|flee|run away|escape|retreat)/i.test(t)) return [{ actor: actor.id, type: 'flee' }];
  if (/(방어|막는|막아|가드|피한다|회피|defend|guard|block|brace)/i.test(t)) return [{ actor: actor.id, type: 'defend' }];
  if (/(공격|친다|때린|벤다|베어|찌른|쏜다|쏘|휘두|내리찍|attack|strike|hit|slash|shoot|stab|punch|kick)/i.test(t)) return [{ actor: actor.id, type: 'attack', target: target?.name ?? null }];
  return [];
}

/* ---------- Status-window import (<stat>Rank: C | HP: 650/650 | STR: 62 …</stat>) ---------- */
/** Status-window tag names: letters, digits, hyphen, underscore only (anything else is dropped). */
export const safeTag = tag => String(tag ?? '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 32);
const reEscape = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function readStatTag(text, tag = 'stat') {
  const t = safeTag(tag);
  if (!t) return null;
  const q = reEscape(t);
  let re;
  try { re = new RegExp(`<\\s*${q}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${q}\\s*>`, 'giu'); } catch { return null; }
  const all = [...String(text ?? '').matchAll(re)];
  if (!all.length) return null;
  return statFieldsOf(all.at(-1)[1]);
}

/** "Key: value | Key: value" or one "Key: value" per line (bullets, **bold**, HTML tags around keys are fine). */
export function statFieldsOf(body) {
  const fields = {};
  const text = String(body ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const parts = text.split(/\n|\|/);
  for (const part of parts) {
    const m = /^\s*(?:[-*•·▶►]\s*)?\**\s*([^:：\n]{1,24}?)\s*\**\s*[:：]\s*([\s\S]*?)\s*$/.exec(part);
    if (m && m[2]) fields[m[1].replace(/[*_\[\]【】]/g, '').trim()] = m[2].replace(/\*\*/g, '').trim();
  }
  return Object.keys(fields).length ? fields : null;
}

/**
 * The player's rank as written in recent story messages (a status window the user's regex may hide from the prompt,
 * a narration line "…도미누스 등급의…"). Raw message text is used, so display/prompt regexes don't hide it.
 * Returns the last value found, or ''. It is only a hint for the aux model, never pinned on its own.
 */
export function statedRankIn(texts) {
  const re = /(?:등급|랭크|계급|위계|품계|경지|서열|rank|tier|grade)\s*\**\s*[:：=]\s*\**\s*([^\n|<>,/()\[\]]{1,24})/giu;
  let found = '';
  for (const t of texts) for (const m of String(t ?? '').matchAll(re)) { const v = m[1].replace(/\*+/g, '').trim(); if (v && !/^(없음|none|-|\?)$/i.test(v)) found = v; }
  return found;
}

/** Convert status-window fields into a partial sheet using the profile's stat keys. */
export function sheetFromStatFields(fields, profile) {
  if (!fields) return null;
  const get = (...names) => { const key = Object.keys(fields).find(k => names.some(n => norm(k) === norm(n))); return key ? fields[key] : null; };
  const stats = {};
  for (const s of profile.stats) { const v = get(s.key, s.label); if (v != null && /\d/.test(v)) stats[s.key] = num(v.match(/-?[\d.,]+/)?.[0]); }
  const list = v => (v ? String(v).split('¶').map(x => x.split('§').map(y => y.trim())).map(p => p.at(-1)).filter(x => x && !/^(없음|none|-)$/i.test(x)) : []);
  return {
    stats, hp: get(profile.hpLabel, 'HP', '체력'), sp: get(profile.spLabel, 'SP', 'MP', '마나'),
    tier: get('Rank', 'Tier', 'Grade', '랭크', '등급'), className: get('Class', '클래스', '직업'),
    skillNames: list(get('Skill', 'Skills', '스킬', '기술')), items: list(get('Items', 'Item', '아이템', '인벤토리')),
  };
}
