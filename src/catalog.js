// Rule data: status effects, word aliases, the default rule profile, and
// normalizers that turn loose LLM/user data into strict engine shapes.
import { norm, num, clamp, makeRng, hashStr, evalExpr, clone } from './util.js';

/* ---------- Status effects (engine-owned, deterministic) ---------- */
// clearOnSwitch: true = 휘발성 상태이상(교체 시 해제), false = 지속 상태이상(교체해도 유지).
export const STATUS = {
  burn:      { ko: '화상', en: 'Burn',       dot: 0.06, physOut: 0.8, turns: 3, clearOnSwitch: false, desc: '매 턴 최대 HP 6% 피해 · 물리 피해 -20% (교체 유지)' },
  poison:    { ko: '중독', en: 'Poison',     dot: 0.08, turns: 4, clearOnSwitch: false, desc: '매 턴 최대 HP 8% 독 피해 (교체 유지)' },
  bleed:     { ko: '출혈', en: 'Bleed',      dot: 0.06, turns: 3, clearOnSwitch: false, desc: '매 턴 최대 HP 6% 출혈 피해 (교체 유지)' },
  regen:     { ko: '재생', en: 'Regen',      hot: 0.08, turns: 3, good: true, clearOnSwitch: false, desc: '매 턴 최대 HP 8% 회복 (교체 유지)' },
  freeze:    { ko: '빙결', en: 'Freeze',     skip: true, thawChance: 0.25, thawOnFire: true, turns: 2, clearOnSwitch: false, desc: '행동 불가 · 턴마다 25% 자연 해동 / 화염 피격 시 즉시 해동 (교체 유지)' },
  sleep:     { ko: '수면', en: 'Sleep',      skip: true, wake: true, turns: 2, clearOnSwitch: false, desc: '행동 불가 · 피격 시 기상 (교체 유지)' },
  stun:      { ko: '기절', en: 'Stun',       skip: true, turns: 1, clearOnSwitch: true, desc: '1턴 행동 불가 (교체 시 해제)' },
  blind:     { ko: '실명', en: 'Blind',      accMul: 0.65, turns: 2, clearOnSwitch: true, desc: '명중률 대폭 하락 (교체 시 해제)' },
  silence:   { ko: '침묵', en: 'Silence',    noMagic: true, turns: 2, clearOnSwitch: true, desc: '마법·특수 기술 봉인 (교체 시 해제)' },
  confuse:   { ko: '혼란', en: 'Confuse',    selfHit: 0.33, turns: 2, clearOnSwitch: true, desc: '33% 확률로 자해 (교체 시 해제)' },
  shield:    { ko: '보호막', en: 'Shield',   dmgMul: 0.6, turns: 2, good: true, clearOnSwitch: true, desc: '받는 피해 40% 경감 (교체 시 해제)' },
  taunt:     { ko: '도발', en: 'Taunt',      taunt: true, turns: 2, clearOnSwitch: true, desc: '도발한 대상을 공격하도록 유도 (교체 시 해제)' },
  fear:      { ko: '공포', en: 'Fear',       dmgOut: 0.75, turns: 2, clearOnSwitch: true, desc: '가하는 피해 25% 감소 (교체 시 해제)' },
  exhausted: { ko: '탈진', en: 'Exhausted',  skip: true, turns: 2, clearOnSwitch: true, desc: '무리한 행동으로 일시 행동 불가 (교체 시 해제)' },
  // Combo triggers & tactical debuffs
  mark:      { ko: '표식', en: 'Marked',     evaMul: 0.7, turns: 3, clearOnSwitch: true, desc: '회피율 하락 · 연계 기술의 추가 피해 조건 (교체 시 해제)' },
  vulnerable: { ko: '취약', en: 'Vulnerable', dmgIn: 1.35, turns: 2, clearOnSwitch: true, desc: '받는 피해 +35% 증가 (교체 시 해제)' },
};

const words = groups => {
  const m = new Map();
  for (const [value, list] of Object.entries(groups)) for (const w of list) m.set(norm(w), value);
  return m;
};

const STATUS_WORDS = words({
  burn: ['burn', 'burned', 'fire', '화상', '불', '연소'], poison: ['poison', 'poisoned', 'toxic', 'venom', '독', '중독', '맹독'],
  bleed: ['bleed', 'bleeding', '출혈', '피'], regen: ['regen', 'regeneration', '재생', '리젠'],
  stun: ['stun', 'stunned', 'paralyze', 'paralysis', 'paralyzed', '기절', '스턴', '마비', '경직'],
  freeze: ['freeze', 'frozen', '빙결', '동결', '얼음'], sleep: ['sleep', 'asleep', '수면', '잠', '잠듦'],
  blind: ['blind', 'blinded', '실명', '암흑', '시야차단'], silence: ['silence', 'silenced', '침묵', '봉인'],
  confuse: ['confuse', 'confused', 'confusion', '혼란'], shield: ['shield', 'barrier', 'ward', '보호막', '배리어', '실드', '방벽'],
  taunt: ['taunt', 'provoke', '도발'], fear: ['fear', 'terror', 'intimidated', '공포', '위축'],
  mark: ['mark', 'marked', 'brand', '표식', '낙인', '표적'], vulnerable: ['vulnerable', 'expose', 'exposed', '취약', '무방비'],
});
export const statusId = raw => (STATUS[raw] ? raw : STATUS_WORDS.get(norm(raw)) ?? null);

/* Engine-side derived combat stats. World stats map onto these through the profile. */
export const DERIVED = ['pow', 'mag', 'def', 'res', 'spd', 'acc', 'luk'];
export const DERIVED_KO = { pow: '물리공격', mag: '마법공격', def: '방어', res: '저항', spd: '속도', acc: '명중', luk: '행운', eva: '회피' };
const STAGE_WORDS = words({
  pow: ['pow', 'atk', 'attack', 'power', 'str', 'strength', '공격', '공격력', '힘', '물리'],
  mag: ['mag', 'magic', 'int', 'intelligence', 'spatk', '마력', '마법', '지능', '마공'],
  def: ['def', 'defense', 'armor', 'end', 'endurance', '방어', '방어력', '인내', '내구'],
  res: ['res', 'resist', 'resistance', 'spdef', 'will', '저항', '마방', '정신력'],
  spd: ['spd', 'speed', 'agi', 'agility', 'dex', '속도', '민첩', '스피드'],
  acc: ['acc', 'accuracy', 'sen', 'sense', 'senses', '명중', '감각', '정확도'],
  eva: ['eva', 'evasion', 'dodge', '회피'],
  luk: ['luk', 'luck', '운', '행운'],
});
export const stageKey = raw => STAGE_WORDS.get(norm(raw)) ?? null;

/* ---------- Skill coefficients (like Pokémon's Body Press / Foul Play) ----------
 * Which combat stats a damaging skill hits with, and which stat of the target blocks it.
 * atk: up to 2 stats with weights summing to 1 (default: pow for physical, mag for magic); def: one stat
 * (default: def / res). Written as {atk: {pow: 0.7, spd: 0.3}, def: 'def'} or "물공 70 + 속도 30 / 방어". */
const COEF_KEYS = ['pow', 'mag', 'def', 'res', 'spd', 'acc', 'luk'];
const coefKey = raw => { const k = stageKey(raw) ?? ({ 물공: 'pow', 마공: 'mag', 특공: 'mag', 특수: 'mag', 방어력: 'def', 특방: 'res', 운: 'luk' })[String(raw ?? '').trim()]; return k === 'eva' ? 'spd' : COEF_KEYS.includes(k) ? k : null; };
export const defaultScale = kind => (kind === 'magic' ? { atk: { mag: 1 }, def: 'res' } : { atk: { pow: 1 }, def: 'def' });
export function normalizeScale(raw, kind) {
  if (!raw || !['physical', 'magic'].includes(kind)) return null;
  let atkRaw, defRaw;
  if (typeof raw === 'string') { const [a, d] = raw.split(/\/|\bvs\b|대\s/i); atkRaw = a; defRaw = d; }
  else { atkRaw = raw.atk ?? raw.attack; defRaw = raw.def ?? raw.defense; }
  const terms = [];
  if (typeof atkRaw === 'string') {
    for (const part of atkRaw.split(/[+,]/)) {
      const m = /^\s*([^\d*x×%]+?)\s*[*x×]?\s*(\d+(?:\.\d+)?)?\s*%?\s*$/.exec(part);
      const k = m && coefKey(m[1]);
      if (k) terms.push([k, m[2] != null ? Number(m[2]) : 1]);
    }
  } else if (atkRaw && typeof atkRaw === 'object') {
    for (const [k0, w] of Object.entries(atkRaw)) { const k = coefKey(k0); if (k && Number(w) > 0) terms.push([k, Number(w)]); }
  }
  const def = defRaw != null ? coefKey(String(defRaw).trim()) : null;
  const base = defaultScale(kind);
  const merged = {};
  for (const [k, w] of terms.slice(0, 2)) merged[k] = (merged[k] ?? 0) + w;
  const total = Object.values(merged).reduce((a, w) => a + w, 0);
  const atk = total > 0 ? Object.fromEntries(Object.entries(merged).map(([k, w]) => [k, Math.round(w / total * 100) / 100])) : base.atk;
  const out = { atk, def: def ?? base.def };
  return JSON.stringify(out) === JSON.stringify(base) ? null : out;
}
/** "위력 80 · 공격 = 물공 70% + 속도 30% · 막는 쪽 = 상대 방어" (with the world's stat names when a profile is given). */
export function formulaText(k, profile = null) {
  if (!['physical', 'magic'].includes(k?.kind)) return '';
  const sc = k.scale ?? defaultScale(k.kind);
  const ko = { pow: '물공', mag: '마공', def: '방어', res: '저항', spd: '속도', acc: '명중', luk: '행운' };
  const world = d => { const expr = String(profile?.map?.[d] ?? ''); if (!expr) return ''; const names = (profile.stats ?? []).filter(s => new RegExp('(^|[^A-Za-z0-9_가-힣])' + s.key.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_가-힣])').test(expr)).map(s => s.label || s.key); return names.length ? '(' + names.join('·') + ')' : ''; };
  const atk = Object.entries(sc.atk).map(([s, w]) => ko[s] + world(s) + (Object.keys(sc.atk).length > 1 ? ' ' + Math.round(w * 100) + '%' : '')).join(' + ');
  return '위력 ' + k.power + (k.hits > 1 ? '×' + k.hits : '') + ' · 공격 = ' + atk + ' · 막는 쪽 = 상대 ' + ko[sc.def] + world(sc.def);
}

const KIND_WORDS = words({
  physical: ['physical', 'phys', 'melee', 'attack', '물리', '근접', '공격'],
  magic: ['magic', 'magical', 'spell', 'special', 'ranged', '마법', '술식', '원거리', '특수'],
  heal: ['heal', 'healing', '회복', '치유', '힐'], buff: ['buff', 'boost', '버프', '강화'],
  debuff: ['debuff', 'weaken', '디버프', '약화'], guard: ['guard', 'defend', 'block', '방어', '가드'],
  revive: ['revive', 'resurrect', '부활', '소생'], cleanse: ['cleanse', 'cure', 'purify', '정화', '해제'],
  status: ['status', '상태이상'],
});
const TARGET_WORDS = words({
  enemy: ['enemy', 'foe', 'single', 'target', '적', '단일', '적단일'], enemies: ['enemies', 'allenemies', 'aoe', 'all', 'area', '적전체', '광역', '전체'],
  ally: ['ally', 'friend', '아군', '아군단일'], allies: ['allies', 'party', 'team', '아군전체', '파티'], self: ['self', 'user', 'me', '자신', '본인', '자기'],
});

const ELEMENT_WORDS = words({
  fire: ['fire', 'flame', '불', '화염', '불꽃'], water: ['water', '물', '수'], ice: ['ice', 'frost', 'cold', '얼음', '냉기', '빙결'],
  electric: ['electric', 'lightning', 'thunder', 'shock', '전기', '번개', '뇌전', '뇌'], wind: ['wind', 'air', '바람', '풍', 'flying', '비행'],
  earth: ['earth', 'ground', '대지', '땅'], rock: ['rock', 'stone', '바위', '암석'], dark: ['dark', 'shadow', 'darkness', '어둠', '암흑', '그림자', '악'],
  light: ['light', 'holy', 'radiant', '빛', '광휘', '신성', '성', 'fairy', '페어리', '요정'], aether: ['aether', 'ether', 'arcane', '에테르', '비전', 'psychic', '에스퍼', '초능력'],
  poison: ['poison', 'toxic', '독'], normal: ['normal', '노말', '노멀'], grass: ['grass', 'plant', 'leaf', '풀', '식물'], fighting: ['fighting', '격투', '무투'],
  bug: ['bug', 'insect', '벌레', '곤충'], ghost: ['ghost', 'spirit', '고스트', '유령'], dragon: ['dragon', '드래곤', '용'], steel: ['steel', 'metal', '강철', '금속', '철'],
  physical: ['physical', '물리'], none: ['none', 'neutral', '무', '무속성', '없음'],
});

/* Pokémon rule set: the official 18 types. World elements map onto them (바람→비행, 대지→땅, 광휘→페어리, 에테르→에스퍼). */
export const POKE_TYPES = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
export const POKE_KO = { normal: '노말', fire: '불꽃', water: '물', grass: '풀', electric: '전기', ice: '얼음', fighting: '격투', poison: '독', ground: '땅', flying: '비행', psychic: '에스퍼', bug: '벌레', rock: '바위', ghost: '고스트', dragon: '드래곤', dark: '악', steel: '강철', fairy: '페어리' };
/* ---------- Converting between the world's elements and the 18 Pokémon types ----------
 * Every sheet may carry both: `elements` (the world's own words) and `ptypes` (1-2 Pokémon types).
 * When one is missing it is derived here, so switching the rule set never loses a character's type. */
const POKE_SET = new Set(POKE_TYPES);
const TO_POKE = { wind: 'flying', earth: 'ground', light: 'fairy', aether: 'psychic', physical: 'normal', none: 'normal' };
// Pokémon type → world element candidates, best first (the first one the world actually has wins).
const TO_WORLD = {
  normal: [], fighting: ['fighting'], rock: ['rock', 'earth'], ground: ['earth'], flying: ['wind'], fairy: ['light', 'aether'],
  psychic: ['aether', 'light'], ghost: ['ghost', 'dark'], steel: ['steel', 'earth'], grass: ['grass', 'earth', 'water'],
  bug: ['bug', 'poison', 'earth'], dragon: ['dragon', 'aether', 'fire'], fire: ['fire'], water: ['water'], ice: ['ice', 'water'],
  electric: ['electric', 'wind'], poison: ['poison', 'dark'], dark: ['dark'],
};
// Words in a world's own element names → the closest Pokémon type (for elements like 성광, 혼돈, 시간).
const POKE_GUESS = [
  [/용암|불|화|염|열|태양|fire|flame|heat|lava|sun/i, 'fire'], [/얼음|빙|냉|설|서리|ice|frost|snow/i, 'ice'], [/물|수|해|파도|비|water|sea|tide|rain/i, 'water'],
  [/뇌|번개|전|electr|thunder|lightning|storm/i, 'electric'], [/바람|풍|하늘|공기|wind|air|sky/i, 'flying'], [/바위|돌|암석|수정|rock|stone|crystal/i, 'rock'],
  [/땅|대지|흙|모래|earth|sand|ground/i, 'ground'], [/금속|강철|철|기계|metal|steel|iron|machine/i, 'steel'], [/독|부식|산|toxic|poison|venom|acid/i, 'poison'],
  [/풀|나무|숲|식물|생명|자연|plant|wood|forest|nature|life/i, 'grass'], [/벌레|곤충|bug|insect/i, 'bug'],
  [/영혼|유령|망령|사령|죽음|저주|ghost|spirit|soul|death|curse|necro/i, 'ghost'], [/용|drag/i, 'dragon'],
  [/어둠|암흑|그림자|혼돈|공허|악|dark|shadow|chaos|void/i, 'dark'], [/빛|광|신성|성|천|holy|light|divine|radiant|요정|fairy/i, 'fairy'],
  [/정신|마나|비전|에테르|시간|공간|환상|마법|mind|psy|arcane|aether|time|space|illusion|magic/i, 'psychic'], [/무|격|권|기공|fight|martial|ki/i, 'fighting'],
];
const DEFAULT_WORLD = new Set(['fire', 'water', 'ice', 'electric', 'wind', 'earth', 'light', 'dark', 'aether', 'poison']);
let CUSTOM_POKE = {};   // world element id → Pokémon type, from the rule profile ("pokeMap")
let WORLD_IDS = null;   // element ids the current world really has
/** Remember the current world's elements and its Pokémon mapping (called whenever a profile is normalized). */
export function useTypeProfile(p) {
  CUSTOM_POKE = {};
  for (const [k, v] of Object.entries(p?.pokeMap ?? {})) { const t = String(v); const id = POKE_SET.has(t) ? t : Object.keys(POKE_KO).find(x => POKE_KO[x] === t) ?? TO_POKE[elementId(t)] ?? elementId(t); if (POKE_SET.has(id)) CUSTOM_POKE[elementId(k)] = id; }
  const ids = (p?.elements ?? []).map(elementId).filter(x => x && x !== 'none');
  WORLD_IDS = ids.length ? new Set(ids) : null;
}
export function toPoke(id) {
  if (!id) return 'normal';
  if (POKE_SET.has(id)) return id;
  if (TO_POKE[id]) return TO_POKE[id];
  if (CUSTOM_POKE[id]) return CUSTOM_POKE[id];
  for (const [re, t] of POKE_GUESS) if (re.test(id)) return t;
  return 'normal';
}
export function toWorld(id) {
  if (!id || id === 'normal') return 'none';
  const have = WORLD_IDS ?? DEFAULT_WORLD;
  if (have.has(id)) return id;
  if (!POKE_SET.has(id)) return id;                         // a custom world element: keep it
  const custom = Object.entries(CUSTOM_POKE).find(([w, t]) => t === id && have.has(w));
  if (custom) return custom[0];
  return (TO_WORLD[id] ?? []).find(x => have.has(x)) ?? 'none';
}
export const typeIn = (id, system) => (system === 'pokemon' ? toPoke(id) : toWorld(id));

/** The element a character's damaging skills use most (a sheet without a type, e.g. an old persona sheet). */
function mainSkillElement(f) {
  const count = {};
  for (const k of f.skills ?? []) if ((k.kind === 'physical' || k.kind === 'magic') && k.element && !['none', 'physical', 'normal'].includes(k.element)) count[k.element] = (count[k.element] ?? 0) + (k.power || 1);
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return top ? [top[0]] : [];
}
/** A fighter's types in the active system (Pokémon: 1-2 of the 18, never empty). */
export function typesFor(f, sys) {
  if (!f) return sys === 'pokemon' ? ['normal'] : [];
  if (sys === 'pokemon' && f.ptypes?.length) return [...new Set(f.ptypes.map(toPoke))].slice(0, 2);
  let raw = (f.elements?.length ? f.elements : [f.element]).filter(x => x && !['none', 'physical'].includes(x));
  if (!raw.length) raw = mainSkillElement(f);
  let list = [...new Set(raw.map(x => typeIn(x, sys)))].filter(x => x && !['none', 'physical'].includes(x));
  if (sys === 'pokemon') { if (list.length > 1) list = list.filter(x => x !== 'normal'); return list.length ? list.slice(0, 2) : ['normal']; }
  return list.slice(0, 2);
}
export const POKEMON_CHART = Object.freeze({
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
});
export const elementId = raw => {
  if (raw == null || raw === '') return 'none';
  const k = norm(raw);
  return ELEMENT_WORDS.get(k) ?? k;
};
export const ELEMENT_KO = { fire: '불', water: '물', ice: '얼음', electric: '전기', wind: '바람', earth: '대지', dark: '어둠', light: '광휘', aether: '에테르', poison: '독', physical: '물리', none: '무', normal: '노말', grass: '풀', fighting: '격투', rock: '바위', bug: '벌레', ghost: '고스트', dragon: '드래곤', steel: '강철' };
export const typeName = (id, system) => (system === 'pokemon' ? POKE_KO[typeIn(id, 'pokemon')] ?? ELEMENT_KO[id] ?? id : ELEMENT_KO[id] ?? id);

const THREAT_WORDS = words({
  minion: ['minion', 'swarm', 'mob', 'fodder', '군집', '잡몹', '졸개', '하수인', '쫄'],
  normal: ['normal', 'common', 'regular', '일반', '보통'],
  elite: ['elite', 'named', 'champion', 'veteran', '정예', '네임드', '엘리트', '강적'],
  boss: ['boss', 'raid', 'legendary', '보스', '레이드', '최종보스', '관장'],
});
export const threatId = raw => THREAT_WORDS.get(norm(raw)) ?? 'normal';
export const THREAT_KO = { minion: '군집', normal: '일반', elite: '정예', boss: '보스' };

/* ---------- Default rule profile (generic, used until the aux model analyzes the world) ---------- */
export const DEFAULT_PROFILE = Object.freeze({
  name: '기본 범용 룰',
  stats: [
    { key: 'STR', label: '힘' }, { key: 'INT', label: '지능' }, { key: 'AGI', label: '민첩' },
    { key: 'END', label: '인내' }, { key: 'SEN', label: '감각' }, { key: 'LUK', label: '운' },
  ],
  hpLabel: 'HP', spLabel: 'SP',
  map: { pow: 'STR', mag: 'INT', def: 'END', res: '(END+INT)/2', spd: 'AGI', acc: 'SEN', luk: 'LUK' },
  hpPerStat: null,
  tiers: [
    { name: '일반인', hp: [80, 120], sp: [0, 10], stat: [8, 12], desc: '훈련 안 된 민간인·짐승' },
    { name: '하급', hp: [150, 300], sp: [20, 50], stat: [15, 28], desc: '견습·신참·잡졸, 막 싸움을 배운 수준' },
    { name: '중급', hp: [400, 800], sp: [60, 150], stat: [35, 65], desc: '숙련된 전투원·정식 모험가·정규병' },
    { name: '상급', hp: [900, 1600], sp: [180, 400], stat: [70, 130], desc: '이름난 실력자·엘리트·간부급' },
    { name: '최상급', hp: [1800, 3500], sp: [450, 900], stat: [140, 240], desc: '한 지역·세력의 정점, 최강자 반열' },
    { name: '전설', hp: [4000, 8000], sp: [1000, 2000], stat: [260, 420], desc: '세계관 최상위, 신화·전설 속 존재' },
  ],
  elements: ['불', '물', '얼음', '전기', '바람', '대지', '어둠', '빛'],
  notes: '',
});

/* ---------- Tier presets ----------
 * Rank names are only labels; the numbers (HP/SP/stat ranges) keep the same scale so sheets stay comparable.
 * A world with its own ranks (헌터 F~S, 무협 삼류~화경…) should keep them — these are for worlds without. */
const scaleTiers = (names) => {
  const base = DEFAULT_PROFILE.tiers;
  return names.map(([name, desc], i) => {
    const pos = names.length > 1 ? (i / (names.length - 1)) * (base.length - 1) : 0;
    const lo = base[Math.floor(pos)], hi = base[Math.ceil(pos)], w = pos - Math.floor(pos);
    const mix = k => [0, 1].map(j => Math.round(lo[k][j] + (hi[k][j] - lo[k][j]) * w));
    return { name, hp: mix('hp'), sp: mix('sp'), stat: mix('stat'), desc };
  });
};
export const TIER_PRESETS = {
  generic: { ko: '범용 6단계 (일반인~전설)', tiers: DEFAULT_PROFILE.tiers },
  pokemon: { ko: '포켓몬 레벨대 (Lv.10~Lv.100)', tiers: scaleTiers([
    ['Lv.10', '입문 — 갓 출발한 트레이너·흔한 야생 개체'], ['Lv.25', '중견 — 배지 몇 개, 동네에선 강한 편'],
    ['Lv.45', '베테랑 — 숙련 트레이너·간부급 조직원'], ['Lv.65', '관장급 — 체육관 관장·사천왕 후보'],
    ['Lv.85', '챔피언급 — 사천왕·챔피언'], ['Lv.100', '전설 — 전설·환상 급 존재'],
  ]) },
  hunter: { ko: '헌터 랭크 (F~S)', tiers: scaleTiers([
    ['F', '각성 직후·최하급'], ['E', '신참 헌터'], ['D', '일반 헌터'], ['C', '숙련 헌터·중견 길드원'],
    ['B', '정예·길드 간부'], ['A', '국가급 전력'], ['S', '국가 최상위·재앙급'],
  ]) },
};
const sameTierNames = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((t, i) => (t?.name ?? t) === (b[i]?.name ?? b[i]));
/** Apply a preset. Returns { profile, map } where map(oldTierName) → new tier name (by relative position). */
export function applyTierPreset(profile, key) {
  const preset = TIER_PRESETS[key];
  if (!preset) return { profile, map: x => x };
  const old = profile.tiers ?? [];
  const next = preset.tiers.map(t => ({ ...t, hp: [...t.hp], sp: [...t.sp], stat: [...t.stat] }));
  const map = name => {
    const i = old.findIndex(t => t.name === name);
    if (i < 0) return name;
    const r = old.length > 1 ? i / (old.length - 1) : 0;
    return next[Math.round(r * (next.length - 1))].name;
  };
  return { profile: normalizeProfile({ ...profile, tiers: next }), map };
}
export const isDefaultTiers = p => sameTierNames(p?.tiers, DEFAULT_PROFILE.tiers);

/**
 * Character picture: an https/relative URL (loaded from where it lives, nothing stored) or a small
 * data-URL image (already downscaled by the panel, capped at ~80 KB). Anything else is dropped.
 */
export function safePortrait(p) {
  if (!p) return null;
  const src = String(typeof p === 'string' ? p : p.src ?? '').trim();
  const ok = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src) ? src.length <= 110000
    : /^(https:\/\/|\/)[^\s"'<>`]+$/.test(src);
  return ok ? { src, pixel: !!(typeof p === 'object' && p.pixel) } : null;
}

/* Battle stage art: a standing picture plus optional attack / hit / down poses. Pictures are drawn facing left
 * (toward the allies, as an enemy stands) unless facing is 'right'; allies are mirrored on the stage. */
export const SPRITE_SLOTS = ['idle', 'attack', 'hit', 'down'];
const spriteSrc = v => {
  const src = String(typeof v === 'string' ? v : v?.src ?? '').trim();
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src)) return src.length <= 700000 ? src : null;
  return /^(https:\/\/|\/)[^\s"'<>`()\\]+$/.test(src) ? src : null;
};
export function safeSprites(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of SPRITE_SLOTS) { const s = spriteSrc(raw[k]); if (s) out[k] = s; }
  if (!out.idle) return null;
  out.facing = raw.facing === 'right' ? 'right' : 'left';
  return out;
}

/** Labels that end up in the panel: no markup characters, bounded length. */
export const plain = (v, max = 40) => String(v ?? '').replace(/[<>"'`&\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export function normalizeProfile(raw) {
  const out = buildProfile(raw);
  useTypeProfile(out);
  return out;
}
function buildProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const stats = Array.isArray(p.stats) && p.stats.length
    ? p.stats.map(s => (typeof s === 'string' ? { key: plain(s), label: plain(s) } : { key: plain(s.key ?? s.name ?? ''), label: plain(s.label ?? s.key ?? '') })).filter(s => s.key)
    : DEFAULT_PROFILE.stats.map(s => ({ ...s }));
  const keys = stats.map(s => s.key);
  const map = {};
  for (const d of DERIVED) {
    const given = p.map?.[d];
    map[d] = given ? String(given) : guessMap(d, keys);
  }
  const tiers = (Array.isArray(p.tiers) && p.tiers.length ? p.tiers : DEFAULT_PROFILE.tiers).map(t => ({
    name: plain(t.name ?? '?') || '?', hp: range(t.hp, [100, 200]), sp: range(t.sp, [0, 50]), stat: range(t.stat, [10, 20]),
    ...(t.desc ? { desc: plain(t.desc, 80) } : {}),
    // The same rank in the world's other ladders (magic-power grades, guild ranks, levels…).
    ...(Array.isArray(t.aliases) && t.aliases.length ? { aliases: t.aliases.map(x => plain(x, 24)).filter(Boolean).slice(0, 6) } : {}),
  }));
  const poke = p.typeSystem === 'pokemon';
  const worldChart = p.worldChart && typeof p.worldChart === 'object'
    ? normalizeChart(p.worldChart)
    : (!poke ? normalizeChart(p.chart) : null);
  const out = {
    name: plain(p.name ?? '사용자 룰') || '사용자 룰', stats, map, tiers,
    hpLabel: plain(p.hpLabel ?? 'HP', 12) || 'HP', spLabel: plain(p.spLabel ?? 'SP', 12) || 'SP',
    hpPerStat: p.hpPerStat ? clamp(num(p.hpPerStat, 0), 2, 80) : null,
    elements: Array.isArray(p.elements) ? p.elements.map(String) : [...DEFAULT_PROFILE.elements],
    notes: String(p.notes ?? ''),
    // World element → swatch name (or #hex): the colour this world gives each element.
    colors: p.colors && typeof p.colors === 'object' ? Object.fromEntries(Object.entries(p.colors).slice(0, 30).map(([k, v]) => [elementId(k), plain(v, 12)]).filter(([k, v]) => k && k !== 'none' && v)) : {},
    pokeMap: p.pokeMap && typeof p.pokeMap === 'object' ? Object.fromEntries(Object.entries(p.pokeMap).slice(0, 24).map(([k, v]) => [plain(k, 20), plain(v, 12)])) : {},
    typeSystem: poke ? 'pokemon' : 'world',
    chart: poke ? clone(POKEMON_CHART) : clone(worldChart ?? normalizeChart(p.chart)),
    worldChart: worldChart ? clone(worldChart) : null,
    stab: poke ? 1.5 : p.stab != null ? clamp(num(p.stab, 1.2), 1, 2) : 1.2,
  };
  useTypeProfile(out);
  return out;
}

/* ---------- Rule editor: the profile as a few plain-text fields the user can edit ---------- */
const rangeTxt = r => `${r[0]}~${r[1]}`;
/** Profile → text fields (one tier per line, one attacking element per chart line). */
export function rulesToText(p) {
  // Show the world's own words (화염), not the engine's generic label (불).
  const nameOf = id => (p.elements ?? []).find(e => elementId(e) === id) ?? typeName(id);
  const chart = p.typeSystem === 'pokemon' ? (p.worldChart ?? {}) : (p.chart ?? {});
  const chartLines = Object.entries(chart).map(([a, row]) => {
    const by = test => Object.entries(row).filter(([, v]) => test(v)).map(([d]) => nameOf(d));
    const parts = [['강함', by(v => v > 1)], ['약함', by(v => v > 0 && v < 1)], ['무효', by(v => v === 0)]].filter(([, l]) => l.length).map(([k, l]) => `${k}: ${l.join(', ')}`);
    return parts.length ? `${nameOf(a)} → ${parts.join(' · ')}` : '';
  }).filter(Boolean);
  return {
    name: p.name ?? '', hpLabel: p.hpLabel ?? 'HP', spLabel: p.spLabel ?? 'SP',
    stats: p.stats.map(s => (s.label && s.label !== s.key ? `${s.key}(${s.label})` : s.key)).join(', '),
    tiers: p.tiers.map(t => [t.name, `HP ${rangeTxt(t.hp)}`, `SP ${rangeTxt(t.sp)}`, `스탯 ${rangeTxt(t.stat)}`, t.aliases?.length ? `별칭: ${t.aliases.join(', ')}` : '', t.desc ?? ''].filter(Boolean).join(' | ')).join('\n'),
    elements: (p.elements ?? []).join(', '),
    colors: Object.entries(p.colors ?? {}).map(([k, v]) => `${nameOf(k)}: ${v}`).join(', '),
    chart: chartLines.join('\n'),
    notes: p.notes ?? '',
  };
}
/** Text fields → a profile (built on the current one, so fields the form doesn't show are kept). Throws with a readable message. */
export function rulesFromText(base, f) {
  const nums = s => { const m = /(\d+)\s*[~\-–]\s*(\d+)/.exec(s); return m ? [Number(m[1]), Number(m[2])] : null; };
  const stats = String(f.stats ?? '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean).map(x => { const m = /^([^()（）]+)[(（]([^)）]+)[)）]$/.exec(x); return m ? { key: m[1].trim(), label: m[2].trim() } : { key: x, label: x }; });
  if (stats.length < 2) throw new Error('스탯은 2개 이상 적어 주세요 (예: STR(힘), AGI(민첩)).');
  const tiers = String(f.tiers ?? '').split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
    const [name, ...rest] = line.split('|').map(x => x.trim());
    if (!name) throw new Error(`등급 ${i + 1}번째 줄에 이름이 없어요.`);
    const t = { name };
    const desc = [];
    for (const part of rest) {
      if (/^(hp|체력)\b/i.test(part) && nums(part)) t.hp = nums(part);
      else if (/^(sp|mp|자원|마나|기력)\b/i.test(part) && nums(part)) t.sp = nums(part);
      else if (/^(스탯|능력치|stat)/i.test(part) && nums(part)) t.stat = nums(part);
      else if (/^(별칭|alias)/i.test(part)) t.aliases = part.replace(/^[^:：]*[:：]?/, '').split(/[,，\/]/).map(x => x.trim()).filter(Boolean);
      else if (part) desc.push(part);
    }
    const prev = base.tiers.find(x => x.name === name) ?? base.tiers[Math.min(i, base.tiers.length - 1)];
    return { hp: prev?.hp, sp: prev?.sp, stat: prev?.stat, ...t, ...(desc.length ? { desc: desc.join(' ') } : prev?.desc && prev.name === name ? { desc: prev.desc } : {}) };
  });
  if (!tiers.length) throw new Error('등급을 한 줄에 하나씩 적어 주세요.');
  const elements = String(f.elements ?? '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
  const chart = {};
  const MUL = { 강함: 2, 강: 2, 유리: 2, strong: 2, 약함: 0.5, 약: 0.5, 불리: 0.5, weak: 0.5, 반감: 0.5, 무효: 0, immune: 0 };
  for (const [i, line] of String(f.chart ?? '').split('\n').map(l => l.trim()).filter(Boolean).entries()) {
    const m = /^(.+?)\s*(?:→|->|=>|>)\s*(.+)$/.exec(line);
    if (!m) throw new Error(`상성표 ${i + 1}번째 줄 형식: "불 → 강함: 얼음, 풀 · 약함: 물"`);
    const row = (chart[m[1].trim()] ??= {});
    for (const seg of m[2].split(/[·;]/)) {
      const s = /^\s*([^:：]+?)\s*[:：]\s*(.+)$/.exec(seg);
      const mul = s && MUL[s[1].trim().toLowerCase()];
      if (mul == null) throw new Error(`상성표 ${i + 1}번째 줄: "강함: … · 약함: … · 무효: …" 중 하나로 적어 주세요.`);
      for (const d of s[2].split(/[,，]/).map(x => x.trim()).filter(Boolean)) row[d] = mul;
    }
  }
  const poke = base.typeSystem === 'pokemon';
  return normalizeProfile({
    ...base, name: String(f.name ?? base.name).trim() || base.name,
    hpLabel: String(f.hpLabel ?? '').trim() || base.hpLabel, spLabel: String(f.spLabel ?? '').trim() || base.spLabel,
    stats, map: undefined, tiers, elements: elements.length ? elements : base.elements, notes: String(f.notes ?? ''),
    colors: f.colors == null ? base.colors : Object.fromEntries(String(f.colors).split(/[,，\n]/).map(x => x.split(/[:：=]/).map(y => y.trim())).filter(([k, v]) => k && v)),
    ...(poke ? { worldChart: Object.keys(chart).length ? chart : false } : { chart: Object.keys(chart).length ? chart : false, worldChart: undefined }),
  });
}

export function setTypeSystem(profile, system) {
  // Untouched generic ranks read oddly next to Pokémon rules: swap in the level bands (custom world ranks stay).
  const tiers = system === 'pokemon' && isDefaultTiers(profile) ? TIER_PRESETS.pokemon.tiers
    : system !== 'pokemon' && sameTierNames(profile.tiers, TIER_PRESETS.pokemon.tiers) ? DEFAULT_PROFILE.tiers : profile.tiers;
  const worldChart = profile.typeSystem !== 'pokemon'
    ? normalizeChart(profile.chart)
    : (profile.worldChart ? normalizeChart(profile.worldChart) : null);
  return normalizeProfile({ ...profile, tiers, typeSystem: system, worldChart, chart: system === 'pokemon' ? undefined : (worldChart ?? undefined), stab: system === 'pokemon' ? 1.5 : 1.2 });
}

/* ---------- Element chart (attacker element → defender element → multiplier) ---------- */
export const DEFAULT_CHART = Object.freeze({
  fire: { ice: 2, earth: 0.5, water: 0.5, fire: 0.5 },
  water: { fire: 2, earth: 2, water: 0.5, ice: 0.5 },
  ice: { wind: 2, earth: 2, fire: 0.5, ice: 0.5, water: 0.5 },
  electric: { water: 2, wind: 2, earth: 0, electric: 0.5 },
  wind: { earth: 2, electric: 0.5, wind: 0.5, ice: 0.5 },
  earth: { electric: 2, fire: 2, wind: 0.5, earth: 0.5, water: 0.5 },
  light: { dark: 2, light: 0.5 },
  dark: { light: 2, aether: 2, dark: 0.5 },
  aether: { dark: 1.5, light: 1.5, aether: 0.5 },
  poison: { poison: 0.5, earth: 0.5 },
});

export function normalizeChart(raw) {
  if (raw === false) return {};
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return clone(DEFAULT_CHART);
  const out = {};
  for (const [a, row] of Object.entries(raw)) {
    if (!row || typeof row !== 'object') continue;
    const ka = elementId(a);
    out[ka] ??= {};
    for (const [d, m] of Object.entries(row)) out[ka][elementId(d)] = clamp(num(m, 1), 0, 4);
  }
  return out;
}

/* ---------- One-line skill notation ----------
 * "신속사격: 물리 40 우선도2 바람 명중95"
 * "백스탭: 우선도-1 자신 방어+1 저항+1 회복25%"
 * "폭풍 탄막: 마법 60 광역 바람 3연타 쿨3 비용30 (탄환을 흩뿌린다)"
 */
const STAGE_ALIAS = { 공: 'pow', 공격: 'pow', 특공: 'mag', 마공: 'mag', 방: 'def', 방어: 'def', 특방: 'res', 마방: 'res', 저항: 'res', 스피드: 'spd', 속도: 'spd', 민첩: 'spd', 명중: 'acc', 회피: 'eva', 운: 'luk', 행운: 'luk' };
export function parseSkillLine(line, { prefersMagic = false } = {}) {
  const src = String(line ?? '').trim();
  if (!src) return null;
  let name = src, rest = '';
  const m = /^([^:：]+?)\s*[:：]\s*(.*)$/.exec(src);
  if (m) { name = m[1].trim(); rest = m[2]; }
  let desc = '';
  // Coefficients token: 계수=pow60+spd40@def (kept out of the parenthesised description).
  let coef = null;
  rest = rest.replace(/(?:계수|coef)\s*[=＝]\s*(\S+)/i, (_, v) => { coef = v.replace('@', '/'); return ' '; });
  rest = rest.replace(/[(（]([^)）]*)[)）]/g, (_, d) => { desc = d.trim(); return ' '; }).replace(/—\s*(.+)$/, (_, d) => { desc = desc || d.trim(); return ' '; });
  const out = { name };
  if (coef) out.scale = coef;
  let ctx = null;                   // 'self' | 'target' for stage tokens
  const stages = {}, selfStages = {};
  let heal = null, powerSeen = false;
  for (let tok of rest.split(/[\s,/·]+/).filter(Boolean)) {
    const t = tok.toLowerCase();
    let x;
    if (/^(물리|physical|phys)$/.test(t)) out.kind = 'physical';
    else if (/^(마법|특수|magic|special|spell)$/.test(t)) out.kind = 'magic';
    else if (/^(회복기|heal|치유|회복|힐)$/.test(t)) out.kind = 'heal';
    else if (/^(강화|버프|buff|변화)$/.test(t)) out.kind = 'buff';
    else if (/^(약화|디버프|debuff)$/.test(t)) out.kind = 'debuff';
    else if (/^(방어기|가드|guard)$/.test(t)) out.kind = 'guard';
    else if (/^(부활|revive)$/.test(t)) out.kind = 'revive';
    else if (/^(정화|cleanse)$/.test(t)) out.kind = 'cleanse';
    else if ((x = /^(?:위력|power|pow)?(\d{1,3})$/.exec(t)) && !powerSeen) { out.power = +x[1]; powerSeen = true; }
    else if ((x = /^(?:우선도|priority|prio)([+\-]?\d)$/.exec(t))) out.priority = +x[1];
    else if (/^(선공|선제)$/.test(t)) out.priority = 1;
    else if (/^(후공|후제)$/.test(t)) out.priority = -1;
    else if ((x = /^(?:명중|acc|accuracy)(\d{1,3})%?$/.exec(t))) out.acc = +x[1];
    else if (/^(필중|sure)$/.test(t)) out.acc = 100;
    else if ((x = /^(?:비용|cost|sp|mp|소모)(\d+)$/.exec(t)) || (x = /^(\d+)(?:sp|mp)$/.exec(t))) out.cost = +x[1];
    else if ((x = /^(?:쿨|쿨타임|cd|cooldown)(\d)$/.exec(t))) out.cooldown = +x[1];
    else if (/^(1회|1회한정|전투1회)$/.test(t)) out.once = true;   // "1회" = once per battle ("2회"/"3연타" = hits)
    else if ((x = /^(\d)(?:연타|회|hits?|타)$/.exec(t)) || (x = /^(?:x|×)(\d)$/.exec(t))) out.hits = +x[1];
    else if (/^(광역|전체|적전체|aoe|all)$/.test(t)) out.target = 'enemies';
    else if (/^(단일|single)$/.test(t)) out.target = 'enemy';
    else if (/^(아군전체|파티|allies|party)$/.test(t)) out.target = 'allies';
    else if (/^(아군|ally)$/.test(t)) out.target = 'ally';
    else if (/^(근접|melee)$/.test(t)) out.range = 'melee';
    else if (/^(원거리|ranged|range)$/.test(t)) out.range = 'ranged';
    else if (/^(충전|charge)$/.test(t)) out.charge = true;
    else if (/^(급소|치명|crit|급소율업)\+?$/.test(t)) out.crit = 0.2;
    else if (/^(자신|self|자기)$/.test(t)) { ctx = 'self'; if (!out.target && !powerSeen) out.target = 'self'; }
    else if (/^(대상|상대|적|target|enemy)$/.test(t)) ctx = 'target';
    else if ((x = /^(?:회복|heal)(\d{1,3})%?$/.exec(t))) heal = +x[1];
    else if ((x = /^(?:흡수|흡혈|drain)(\d{1,3})%?$/.exec(t))) out.drain = +x[1] / 100;
    else if ((x = /^(?:반동|recoil)(\d{1,2})%?$/.exec(t))) out.recoil = +x[1] / 100;
    else if ((x = /^(?:hp소모|체력소모|피소모|hpcost)(\d{1,2})%?$/.exec(t))) out.hpCost = +x[1];
    else if (/^(1회|소멸|exhaust|once)$/.test(t)) out.once = true;
    else if (/^(교체|유턴|pivot|switch)$/.test(t)) out.pivot = true;
    else if (/^(방어막기|프로텍트|protect)$/.test(t)) { out.kind = 'guard'; out.protect = true; }
    else if (/^(후퇴|후열로)$/.test(t)) out.move = 'back';
    else if (/^(돌진|전열로)$/.test(t)) out.move = 'front';
    else if (/^(끌어당기기|pull)$/.test(t)) out.pull = true;
    else if ((x = /^(?:조건|추가|vs)[:：]?(.+?)[×x*](\d(?:\.\d)?)(소모)?$/i.exec(tok))) {
      const cond = x[1].toLowerCase();
      const c = /^(반피|빈사|lowhp)$/.test(cond) ? { selfHpBelow: 0.5 } : /^(풀피|fullhp)$/.test(cond) ? { targetFullHp: true } : /^(충전|charging)$/.test(cond) ? { targetCharging: true }
        : /^(상태|any)$/.test(cond) ? { status: 'any' } : statusId(cond) ? { status: statusId(cond) } : null;
      if (c) out.bonusIf = { ...c, mul: +x[2], ...(x[3] ? { consume: true } : {}) };
    }
    else if ((x = /^(.+?)([+\-]\d)$/.exec(tok)) || (x = /^(.+?)(\d)(업|다운|up|down)$/i.exec(tok))) {
      const key = STAGE_ALIAS[x[1]] ?? stageKey(x[1]);
      if (!key) continue;
      const v = x[3] ? (/(다운|down)/i.test(x[3]) ? -x[2] : +x[2]) : +x[2];
      const where = ctx ?? (v > 0 && (out.power || powerSeen) ? 'self' : v > 0 && !powerSeen && out.target !== 'enemy' ? 'self' : 'target');
      (where === 'self' ? selfStages : stages)[key] = v;
    } else if ((x = /^(.+?)(\d{1,3})%$/.exec(tok)) && statusId(x[1])) out.status = { id: statusId(x[1]), chance: +x[2] };
    else if (statusId(tok)) out.status = { id: statusId(tok), chance: 100 };
    else if (/(속성|타입|type)$/.test(tok)) out.element = tok.replace(/(속성|타입|type)$/, '');
    else if (ELEMENT_WORDS.has(norm(tok))) out.element = tok;
  }
  if (out.status && out.status.chance === 100 && (out.power ?? 0) > 0 && !/100/.test(rest)) out.status.chance = 30;
  if (Object.keys(stages).length) out.stages = stages;
  if (Object.keys(selfStages).length) out.selfStages = selfStages;
  if (!out.kind) {
    if ((out.power ?? 0) > 0) out.kind = prefersMagic && out.element && out.element !== '물리' ? 'magic' : inferSkill(name, { prefersMagic }).kind === 'magic' ? 'magic' : 'physical';
    else if (heal != null && !out.selfStages && !out.stages) out.kind = 'heal';
    else if (out.stages && !out.selfStages) out.kind = 'debuff';
    else if (out.status && !STATUS[out.status.id]?.good) out.kind = 'debuff';
    else out.kind = 'buff';
  }
  if (heal != null) { if (out.kind === 'heal') out.power = heal; else out.selfHeal = heal; }
  if (out.kind === 'buff' && !out.target) out.target = 'self';
  if (out.kind === 'buff' && out.selfStages && !out.stages && ['allies', 'ally'].includes(out.target)) { out.stages = out.selfStages; delete out.selfStages; }
  if (out.kind === 'buff' && out.selfStages && out.target === 'self') { out.stages = { ...(out.stages ?? {}), ...out.selfStages }; delete out.selfStages; }
  if (desc) out.desc = desc;
  return out;
}

const KIND_SHORT = { physical: '물리', magic: '마법', heal: '회복기', buff: '강화', debuff: '약화', guard: '방어기', revive: '부활', cleanse: '정화' };
const TARGET_SHORT = { enemies: '광역', allies: '아군전체', ally: '아군', self: '자신' };
const STAGE_SHORT = { pow: '공격', mag: '마공', def: '방어', res: '저항', spd: '속도', acc: '명중', eva: '회피', luk: '운' };
/** Inverse of parseSkillLine: compact, editable, cheap to put in prompts. */
export function skillLine(k, system = 'world') {
  if (!k) return '';
  const parts = [KIND_SHORT[k.kind] ?? k.kind];
  if (k.power && k.kind !== 'heal') parts.push(String(k.power));
  if (k.kind === 'heal') parts.push(`회복${k.power}%`);
  if (k.element && !['none', 'physical'].includes(k.element)) parts.push(typeName(k.element, system));
  if (k.hits > 1) parts.push(`${k.hits}연타`);
  if (k.scale) parts.push(`계수=${Object.entries(k.scale.atk).map(([s, w]) => `${s}${Math.round(w * 100)}`).join('+')}@${k.scale.def}`);
  if (TARGET_SHORT[k.target] && !(k.kind === 'buff' && k.target === 'self')) parts.push(TARGET_SHORT[k.target]);
  if (k.priority) parts.push(`우선도${k.priority > 0 ? '+' : ''}${k.priority}`);
  if (k.acc && k.acc !== 95) parts.push(`명중${k.acc}`);
  if (k.status) parts.push(`${STATUS[k.status.id]?.ko ?? k.status.id}${k.status.chance}%`);
  if (k.stages) parts.push(...(k.kind === 'buff' && k.target === 'self' ? ['자신'] : k.kind === 'buff' ? [] : ['대상']), ...Object.entries(k.stages).map(([s, v]) => `${STAGE_SHORT[s] ?? s}${v > 0 ? '+' : ''}${v}`));
  if (k.selfStages) parts.push('자신', ...Object.entries(k.selfStages).map(([s, v]) => `${STAGE_SHORT[s] ?? s}${v > 0 ? '+' : ''}${v}`));
  if (k.selfHeal) parts.push(`회복${k.selfHeal}%`);
  if (k.drain) parts.push(`흡수${Math.round(k.drain * 100)}%`);
  if (k.crit) parts.push('급소');
  if (k.recoil) parts.push(`반동${Math.round(k.recoil * 100)}%`);
  if (k.hpCost) parts.push(`HP소모${k.hpCost}%`);
  if (k.bonusIf) parts.push(`조건:${bonusLabel(k.bonusIf)}×${k.bonusIf.mul}${k.bonusIf.consume ? '소모' : ''}`);
  if (k.once) parts.push('1회');
  if (k.pivot) parts.push('교체');
  if (k.protect) parts.push('프로텍트');
  if (k.move) parts.push(k.move === 'back' ? '후퇴' : '돌진');
  if (k.pull) parts.push('끌어당기기');
  if (k.charge) parts.push('충전');
  if (k.cooldown) parts.push(`쿨${k.cooldown}`);
  if (k.range === 'ranged' && k.kind === 'physical') parts.push('원거리');
  parts.push(`비용${k.cost}`);
  return `${k.name}: ${parts.join(' ')}${k.desc ? ` (${k.desc})` : ''}`;
}

/** Short Korean label of a bonusIf condition (also used by the card UI). */
export function bonusLabel(c) {
  if (!c) return '';
  if (c.selfHpBelow) return '반피';
  if (c.targetFullHp) return '풀피';
  if (c.targetCharging) return '충전';
  if (c.status === 'any') return '상태';
  return STATUS[c.status]?.ko ?? String(c.status ?? '');
}
const BONUS_KO = c => (c.selfHpBelow ? '내 HP 절반 이하일 때' : c.targetFullHp ? '대상 HP가 가득일 때' : c.targetCharging ? '대상이 충전 중일 때' : c.status === 'any' ? '대상이 상태이상일 때' : `대상이 ${STATUS[c.status]?.ko ?? c.status}일 때`);
export const bonusText = c => (c ? `${BONUS_KO(c)} 위력 ×${c.mul}${c.consume ? ` (${c.status === 'any' ? '상태' : STATUS[c.status]?.ko ?? ''} 소모)` : ''}` : '');

function normalizeBonus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mul = clamp(num(raw.mul ?? raw.multiplier, 1.5), 1.1, 2);
  let c = null;
  if (raw.selfHpBelow != null) c = { selfHpBelow: clamp(num(raw.selfHpBelow, 0.5), 0.2, 0.6) };
  else if (raw.targetFullHp) c = { targetFullHp: true };
  else if (raw.targetCharging) c = { targetCharging: true };
  else if (raw.status) { const id = raw.status === 'any' ? 'any' : statusId(raw.status); if (id) c = { status: id }; }
  if (!c) return null;
  if (raw.consume && c.status) c.consume = true;
  return { ...c, mul };
}

function range(v, d) {
  if (Array.isArray(v) && v.length >= 2) return [num(v[0], d[0]), num(v[1], d[1])];
  if (typeof v === 'string') { const m = v.match(/[\d.]+/g); if (m?.length >= 2) return [num(m[0]), num(m[1])]; if (m?.length === 1) return [num(m[0]), num(m[0])]; }
  if (typeof v === 'number') return [v, v];
  return d;
}

function guessMap(d, keys) {
  const find = (...cands) => keys.find(k => cands.some(c => norm(k) === norm(c))) ?? keys.find(k => cands.some(c => norm(k).includes(norm(c))));
  const pick = {
    pow: find('STR', 'ATK', 'POW', '힘', '공격'), mag: find('INT', 'MAG', 'WIS', '지능', '마력'),
    def: find('END', 'DEF', 'VIT', 'CON', '인내', '방어', '체력'), spd: find('AGI', 'SPD', 'DEX', '민첩', '속도'),
    acc: find('SEN', 'DEX', 'PER', 'ACC', '감각', '명중'), luk: find('LUK', 'LCK', '운', '행운'),
  };
  if (d === 'res') {
    const r = find('RES', 'WIL', 'SPI', 'MDEF', '저항', '정신');
    if (r) return r;
    const a = pick.def, b = pick.mag;
    return a && b ? `(${a}+${b})/2` : a ?? b ?? keys[0] ?? '10';
  }
  return pick[d] ?? (d === 'acc' ? pick.spd : null) ?? keys[0] ?? '10';
}

export function tierOf(profile, name) {
  if (!name) return null;
  const k = norm(name);
  if (!k) return null;
  const tiers = profile.tiers ?? [];
  const exact = tiers.find(t => norm(t.name) === k) ?? tiers.find(t => (t.aliases ?? []).some(a => norm(a) === k));
  if (exact) return exact;
  // Longest label/alias first so "최상급"/"SS" wins over "상급"/"S" when suffixes like "급" or descriptions are attached.
  const keys = [];
  for (const t of tiers) {
    keys.push([norm(t.name), t]);
    for (const a of t.aliases ?? []) keys.push([norm(a), t]);
  }
  keys.sort((a, b) => b[0].length - a[0].length);
  for (const [tk, t] of keys) {
    if (!tk) continue;
    if (k.startsWith(tk) || tk.startsWith(k)) return t;
  }
  for (const [tk, t] of keys) {
    if (tk.length >= 2 && k.includes(tk)) return t;
  }
  return null;
}

/* ---------- Skill inference & normalization ---------- */
const INFER = [
  [/부활|소생|revive|resurrect|phoenix/i, { kind: 'revive', power: 40, target: 'ally' }],
  [/정화|해제|해독|cleanse|purif|dispel|antidote|cure\b/i, { kind: 'cleanse', power: 0, target: 'ally' }],
  [/치유|회복|힐|치료|heal|mend|recover|restor|medic|첫\s*치료/i, { kind: 'heal', power: 30, target: 'ally' }],
  [/보호막|배리어|방벽|실드|barrier|shield|ward|aegis/i, { kind: 'buff', power: 0, target: 'self', status: { id: 'shield', chance: 100, turns: 2 } }],
  [/방어|막기|가드|패리|철벽|guard|block|parry|fortify|금강/i, { kind: 'guard', power: 0, target: 'self' }],
  [/도발|taunt|provoke/i, { kind: 'debuff', power: 0, target: 'enemy', status: { id: 'taunt', chance: 100, turns: 2 } }],
  [/함성|포효|기합|격려|축복|노래|찬가|warcry|roar|rally|bless|anthem|song|aria|inspire/i, { kind: 'buff', power: 0, target: 'allies', stages: { pow: 1, mag: 1 } }],
  [/가속|신속|헤이스트|haste|quicken|accelerat/i, { kind: 'buff', power: 0, target: 'self', stages: { spd: 2 } }],
  [/집중|조준|focus|concentrat|aim\b/i, { kind: 'buff', power: 0, target: 'self', stages: { pow: 1, acc: 1 } }],
  [/저주|약화|위협|curse|weaken|hex|intimidat|debuff/i, { kind: 'debuff', power: 0, target: 'enemy', stages: { pow: -1, def: -1 } }],
  [/수면|자장|최면|sleep|lull|hypno/i, { kind: 'debuff', power: 0, target: 'enemy', status: { id: 'sleep', chance: 60, turns: 2 } }],
  [/혼란|환각|환영|confus|illusion|hallucin/i, { kind: 'debuff', power: 0, target: 'enemy', status: { id: 'confuse', chance: 55, turns: 2 } }],
  [/침묵|봉인|silence|seal/i, { kind: 'debuff', power: 0, target: 'enemy', status: { id: 'silence', chance: 60, turns: 2 } }],
  [/연막|섬광|모래|눈부|smoke|flash|blind/i, { kind: 'debuff', power: 0, target: 'enemy', status: { id: 'blind', chance: 65, turns: 2 } }],
];
const FLAVOR = [
  [/독|맹독|poison|toxic|venom/i, { element: 'poison', status: { id: 'poison', chance: 35, turns: 3 } }],
  [/불|화염|파이어|플레임|폭염|화|fire|flame|blaze|inferno|burn/i, { element: 'fire', status: { id: 'burn', chance: 20, turns: 3 } }],
  [/얼음|빙|냉기|서리|ice|frost|freez|blizzard|glacier/i, { element: 'ice', status: { id: 'freeze', chance: 12, turns: 1 } }],
  [/번개|전기|뇌|썬더|스파크|lightning|thunder|shock|spark|electr|volt/i, { element: 'electric', status: { id: 'stun', chance: 12, turns: 1 } }],
  [/물|파도|해일|water|aqua|wave|tide/i, { element: 'water' }],
  [/바람|풍|돌풍|폭풍|wind|gale|tornado|tempest|storm/i, { element: 'wind' }],
  [/바위|암석|stone|rock/i, { element: 'rock' }],
  [/대지|땅|지진|earth|quake|ground/i, { element: 'earth' }],
  [/풀|덩굴|잎|grass|leaf|vine/i, { element: 'grass' }],
  [/강철|금속|steel|iron|metal/i, { element: 'steel' }],
  [/용|드래곤|dragon/i, { element: 'dragon' }],
  [/유령|고스트|원혼|ghost|spirit/i, { element: 'ghost' }],
  [/격투|권|주먹|발차기|fist|punch|kick|martial/i, { element: 'fighting' }],
  [/빛|광휘|성광|신성|홀리|light|holy|radiant|smite|lumen|photon/i, { element: 'light' }],
  [/어둠|암흑|그림자|섀도|dark|shadow|void|abyss/i, { element: 'dark' }],
  [/에테르|aether|ether|arcane/i, { element: 'aether' }],
  [/베기|참격|칼날|찢|slash|blade|cut|rend|claw|발톱/i, { status: { id: 'bleed', chance: 25, turns: 3 } }],
  [/흡혈|흡수|드레인|drain|leech|vampir|siphon/i, { drain: 0.5 }],
  [/난타|연타|연속|난무|연사|flurry|barrage|combo|rapid|volley/i, { hits: 3, powerMul: 0.4 }],
  [/광역|폭발|전체|메테오|비|폭격|explos|nova|meteor|rain|sweep|whirl|회오리|쇄도/i, { target: 'enemies', powerMul: 0.85 }],
  [/저격|정밀|급소|snipe|precise|critical|vital|헤드샷|headshot/i, { acc: 100, crit: 0.2 }],
  [/필살|궁극|오의|비기|극의|ultimate|finisher|ultima|overdrive/i, { powerMul: 1.8, cooldown: 4 }],
  [/선공|신속|발도|기습|퀵|quick|swift|ambush|first/i, { priority: 1, powerMul: 0.75 }],
  [/기절|충격|강타|해머|stun|bash|slam|smash/i, { status: { id: 'stun', chance: 20, turns: 1 } }],
];
const RANGED_HINT = /활|화살|총|사격|저격|투척|던지|탄환|탄막|연사|권총|포격|레이저|원거리|bow|arrow|gun|shot|shoot|throw|snipe|laser|cannon|ranged/i;
const ATTACK_HINT = /베기|베어|참격|찌르기|일격|일섬|타격|강타|공격|난무|연타|사격|발사|돌진|slash|strike|stab|thrust|blow|smash|shot|charge|rush/i;
const WEAPON_HINT = /검|칼|도|창|주먹|권|발차기|각|베기|참|화살|활|총|탄환|사격|도끼|망치|sword|blade|saber|spear|fist|punch|kick|slash|arrow|bow|gun|shot|axe|hammer|claw|bite/i;
const MAGIC_HINT = /마법|주문|술식|볼트|미사일|탄|빔|레이|파동|magic|spell|bolt|missile|beam|ray|blast|orb|wave|노래|aria/i;

export function inferSkill(name, { prefersMagic = false } = {}) {
  const n = String(name ?? '').trim();
  const skill = { name: n, kind: prefersMagic || MAGIC_HINT.test(n) ? 'magic' : 'physical', power: 60, target: 'enemy', acc: 95 };
  const rule = INFER.find(([re]) => re.test(n));
  const attacky = ATTACK_HINT.test(n) || WEAPON_HINT.test(n);
  if (rule && attacky && ['debuff', 'buff'].includes(rule[1].kind) && rule[1].status && rule[1].target === 'enemy') {
    // "섬광 베기" = a slash that may blind, not a pure blinding spell.
    skill.status = { ...rule[1].status, chance: Math.min(30, rule[1].status.chance) };
  } else if (rule && !(attacky && ['debuff', 'buff'].includes(rule[1].kind) && rule[1].target !== 'self' && rule[1].target !== 'allies')) Object.assign(skill, rule[1]);
  let mul = 1;
  for (const [re, patch] of FLAVOR) {
    if (!re.test(n)) continue;
    const { powerMul, ...rest } = patch;
    if (powerMul) mul *= powerMul;
    if (rest.status && (skill.status || !['physical', 'magic'].includes(skill.kind))) delete rest.status;
    if (rest.target && !['physical', 'magic'].includes(skill.kind)) delete rest.target;
    Object.assign(skill, rest);
  }
  if (['physical', 'magic'].includes(skill.kind)) {
    skill.power = Math.round(skill.power * mul);
    const elemental = ['fire', 'ice', 'electric', 'water', 'wind', 'earth', 'light', 'dark', 'aether'].includes(skill.element);
    if (elemental && !WEAPON_HINT.test(n) && !ATTACK_HINT.test(n)) skill.kind = 'magic';
    if (/안개|구름|mist|cloud|fog|gas/i.test(n)) { skill.kind = 'magic'; skill.target = 'enemies'; }
  }
  return skill;
}

/** Strict skill shape. `maxSp` lets us price skills that came without a cost. */
export function normalizeSkill(raw, { maxSp = 100, prefersMagic = false } = {}) {
  if (!raw) return null;
  if (typeof raw === 'string') raw = /[:：]/.test(raw) ? parseSkillLine(raw, { prefersMagic }) : inferSkill(raw, { prefersMagic });
  if (raw && typeof raw === 'object' && raw.line && !raw.kind) raw = { ...parseSkillLine(raw.line, { prefersMagic }), ...raw };
  const name = String(raw.name ?? '').trim();
  if (!name) return null;
  const base = raw.kind ? {} : inferSkill(name, { prefersMagic });
  const s = { ...base, ...raw };
  const kind = KIND_WORDS.get(norm(s.kind)) ?? (['physical', 'magic', 'heal', 'buff', 'debuff', 'guard', 'revive', 'cleanse'].includes(s.kind) ? s.kind : 'physical');
  const finalKind = kind === 'status' ? 'debuff' : kind;
  const defTarget = { heal: 'ally', revive: 'ally', cleanse: 'ally', buff: 'self', guard: 'self' }[finalKind] ?? 'enemy';
  const target = TARGET_WORDS.get(norm(s.target)) ?? defTarget;
  const st = s.status ? (typeof s.status === 'string' ? { id: s.status } : s.status) : null;
  const sid = st ? statusId(st.id ?? st.name) : null;
  const stages = {};
  for (const [k, v] of Object.entries(s.stages ?? s.buffs ?? {})) { const key = stageKey(k); if (key && num(v)) stages[key] = clamp(Math.round(num(v)), -3, 3); }
  const selfStages = {};
  for (const [k, v] of Object.entries(s.selfStages ?? s.self ?? {})) { const key = stageKey(k); if (key && num(v)) selfStages[key] = clamp(Math.round(num(v)), -3, 3); }
  const power = clamp(Math.round(num(s.power, ['physical', 'magic'].includes(finalKind) ? 60 : finalKind === 'heal' ? 35 : 0)), 0, 300);
  const hits = clamp(Math.round(num(s.hits, 1)), 1, 6);
  const out = {
    name, kind: finalKind, power, target, hits,
    acc: clamp(Math.round(num(s.acc ?? s.accuracy, 95)), 10, 100),
    element: elementId(s.element ?? (finalKind === 'physical' ? 'physical' : 'none')),
    status: sid ? { id: sid, chance: clamp(num(st.chance, 100), 1, 100), turns: clamp(Math.round(num(st.turns, STATUS[sid].turns)), 1, 6) } : null,
    stages: Object.keys(stages).length ? stages : null,
    selfStages: Object.keys(selfStages).length ? selfStages : null,
    selfHeal: clamp(num(s.selfHeal ?? s.heal, 0), 0, 100),
    priority: clamp(Math.round(num(s.priority, 0)), -3, 3),
    drain: clamp(num(s.drain, 0), 0, 1),
    crit: clamp(num(s.crit, 0), 0, 0.5),
    cooldown: clamp(Math.round(num(s.cooldown ?? s.cd, 0)), 0, 9),
    desc: String(s.desc ?? s.description ?? '').slice(0, 200),
  };
  // Trade-offs and combo hooks (Pokémon recoil/U-turn/Protect, Slay the Spire exhaust & conditional damage).
  const damaging = ['physical', 'magic'].includes(finalKind);
  const recoil = damaging ? clamp(num(s.recoil, 0), 0, 0.5) : 0;
  if (recoil) out.recoil = Math.round(recoil * 100) / 100;
  const hpCost = clamp(Math.round(num(s.hpCost ?? s.hpcost, 0)), 0, 50);
  if (hpCost) out.hpCost = hpCost;
  if (s.once || s.exhaust) out.once = true;
  const bonus = damaging ? normalizeBonus(s.bonusIf ?? s.bonus) : null;
  if (bonus) out.bonusIf = bonus;
  const scRaw = norm(s.scaleStages ?? s.scaleBuffs ?? s.stageScale ?? '');
  if (damaging && scRaw) {
    if (['self', 'buff', 'buffs', '자신', '자신버프', '내버프'].includes(scRaw)) out.scaleStages = 'self';
    else if (['target', 'foe', 'enemy', 'debuff', 'debuffs', '적', '상대', '적디버프', '상대디버프'].includes(scRaw)) out.scaleStages = 'target';
    else if (['ally', 'allies', 'team', 'party', '아군', '파티', '아군버프'].includes(scRaw)) out.scaleStages = 'ally';
  }
  if (s.pivot || s.switchAfter) out.pivot = true;
  if (finalKind === 'guard' && (s.protect || /프로텍트|protect|완전\s*방어|간파|detect/i.test(name))) out.protect = true;
  const mv = norm(s.move ?? s.moveRow ?? '');
  if (['back', '후열', '후퇴'].includes(mv)) out.move = 'back'; else if (['front', '전열', '돌진'].includes(mv)) out.move = 'front';
  if (s.pull && damaging) out.pull = true;
  // A "debuff" that also deals damage is really an attack with a secondary effect.
  if (finalKind === 'debuff' && power > 0) { out.kind = 'magic'; out.range = 'ranged'; }
  const rg = norm(s.range ?? '');
  out.range = ['melee', '근접', 'close'].includes(rg) ? 'melee' : ['ranged', '원거리', 'far', 'range'].includes(rg) ? 'ranged'
    : finalKind === 'physical' && !RANGED_HINT.test(name) ? 'melee' : 'ranged';
  out.charge = s.charge != null ? !!s.charge : ['physical', 'magic'].includes(finalKind) && power >= 110;
  const auto = autoCost(out, maxSp);
  // Written costs can't undercut the economy by much (a 60-power move is never nearly free).
  out.cost = s.cost != null && s.cost !== '' ? Math.max(Math.round(num(s.cost)), Math.round(auto * 0.9)) : auto;
  const sc = normalizeScale(s.scale ?? s.coef ?? s.coefficient ?? s['계수'], finalKind);
  if (sc) out.scale = sc;
  // An AI-coded extra effect that runs only when this skill is used (same sandbox as signature passives).
  const fx = safeCustomPassive(s.customFx);
  if (fx) out.customFx = fx;
  return out;
}

/**
 * Resource cost, Temtem-style: a standard move ≈ 15-25% of the bar, a strong one ≈ 30%, a signature ≈ 40%+.
 * With ~5% regen per turn, a fighter gets two or three real moves before resting or overexerting.
 */
export function autoCost(skill, maxSp) {
  const unit = Math.max(1, maxSp) / 100;
  let c = { physical: skill.power / 3.2, magic: skill.power / 3, heal: 26, buff: 18, debuff: 18, guard: 0, revive: 45, cleanse: 15 }[skill.kind] ?? 15;
  if (skill.hits > 1) c *= 1.1;
  if (['enemies', 'allies'].includes(skill.target)) c *= 1.4;
  if (skill.status && ['physical', 'magic'].includes(skill.kind)) c += 4;
  if (skill.priority > 0) c += 3;
  if (skill.cooldown) c *= 0.85;
  if (skill.hpCost) c *= Math.max(0.2, 1 - skill.hpCost / 20);   // paid in blood instead of resource
  if (skill.once) c *= 0.8;
  if (skill.pivot) c += 2;
  return Math.max(0, Math.round(c * unit));
}

/* ---------- Items ---------- */
const ITEM_RULES = [
  [/부활|소생|revive|phoenix|불사조/i, { kind: 'revive', amount: 30 }],
  [/엘릭서|elixir|만병/i, { kind: 'full', amount: 100 }],
  [/에테르|마나|마력|sp|ether|mana|정신력|마석/i, { kind: 'sp', amount: 40 }],
  [/해독|만능약|정화|antidote|cure|panacea|remedy/i, { kind: 'cure', amount: 0 }],
  [/폭탄|수류탄|화염병|다이너마이트|bomb|grenade|molotov|explosive/i, { kind: 'damage', amount: 60, target: 'enemies' }],
  [/부적|스크롤|주문서|scroll|talisman/i, { kind: 'damage', amount: 70, target: 'enemy' }],
  [/강화제|버프|각성제|아드레날린|stim|boost|adrenal/i, { kind: 'buff', amount: 1 }],
  [/포션|물약|회복|약|붕대|구급|힐|medkit|potion|bandage|heal|salve|tonic|stimpak/i, { kind: 'heal', amount: 35 }],
];
export function inferItem(name) {
  const n = String(name ?? '').trim();
  const rule = ITEM_RULES.find(([re]) => re.test(n));
  const spec = rule ? { ...rule[1] } : null;
  if (!spec) return null;
  if (/하이|상급|고급|hi-?|greater|super|mega/i.test(n)) spec.amount = Math.round(spec.amount * 1.6);
  if (/풀|full|max|최상급/i.test(n)) spec.amount = 100;
  if (spec.kind === 'damage') spec.element = elementId(FLAVOR.find(([re, p]) => re.test(n) && p.element)?.[1].element ?? 'none');
  return spec;
}
export const ITEM_KIND_KO = { heal: 'HP 회복', sp: 'SP 회복', full: '완전 회복', cure: '상태이상 해제', revive: '부활', damage: '공격', buff: '강화' };

/* ---------- Character sheets ---------- */
export function normalizeSheet(raw, profile, { side = 'enemy', seed = '' } = {}) {
  const r = raw && typeof raw === 'object' ? raw : { name: String(raw ?? '???') };
  const rng = makeRng(`${seed}:${r.name ?? ''}`);
  const tier = tierOf(profile, r.tier ?? r.rank) ?? null;
  const roll = ([lo, hi]) => Math.round(lo + (hi - lo) * (0.35 + 0.3 * rng.next()));
  const stats = {};
  const given = r.stats && typeof r.stats === 'object' ? r.stats : r;
  for (const s of profile.stats) {
    const key = Object.keys(given).find(k => norm(k) === norm(s.key) || norm(k) === norm(s.label));
    stats[s.key] = key != null && given[key] !== '' && given[key] != null ? Math.max(0, num(given[key])) : tier ? roll(tier.stat) : 10;
  }
  // Role/focus nudges for generated stats: "focus: AGI, INT"
  const focus = String(r.focus ?? '').split(/[,\s/]+/).filter(Boolean);
  if (focus.length && !r.stats) for (const f of focus) { const k = profile.stats.find(s => norm(s.key) === norm(f) || norm(s.label) === norm(f))?.key; if (k) stats[k] = Math.round(stats[k] * 1.3); }

  const threat = threatId(r.threat ?? r.danger ?? r.class ?? (side === 'enemy' ? 'normal' : 'normal'));
  const threatHp = { minion: 0.6, normal: 1, elite: 1.5, boss: 2.5 }[threat];
  // "hp": 260 means max 260 (full); "hp": "120/260" means current/max.
  const [hpCur, hpMax] = splitPair(r.hp ?? r.HP);
  let maxHp = num(r.maxHp ?? r.maxhp ?? hpMax ?? (r.maxHp == null && hpMax == null && r.currentHp == null ? hpCur : null), 0);
  if (!maxHp) maxHp = tier ? Math.round(roll(tier.hp) * (side === 'enemy' ? threatHp : 1)) : 100;
  let hp = r.currentHp != null ? num(r.currentHp) : hpMax != null || r.maxHp != null ? hpCur : null;
  hp = hp == null ? maxHp : clamp(hp, 0, maxHp);
  const [spCur, spMax] = splitPair(r.sp ?? r.SP);
  let maxSp = num(r.maxSp ?? r.maxsp ?? spMax ?? (r.maxSp == null && spMax == null && r.currentSp == null ? spCur : null), 0);
  if (!maxSp && !(spCur === 0 && spMax == null)) maxSp = tier ? roll(tier.sp) : 50;
  let sp = r.currentSp != null ? num(r.currentSp) : spMax != null || r.maxSp != null ? spCur : null;
  sp = sp == null ? maxSp : clamp(sp, 0, maxSp);

  const prefersMagic = (() => {
    const mag = profile.map.mag, pow = profile.map.pow;
    const v = k => stats[k] ?? 0;
    return v(mag) > v(pow) * 1.15;
  })();
  const skills = (Array.isArray(r.skills) ? r.skills : String(r.skills ?? '').split(/[,¶]/))
    .map(s => (typeof s === 'string' ? s.replace(/^[^§]*§\s*/, '').trim() : s))
    .filter(Boolean).map(s => normalizeSkill(s, { maxSp, prefersMagic })).filter(Boolean).slice(0, 12);

  const list = v => (Array.isArray(v) ? v : String(v ?? '').split(/[,/·]+/)).map(x => String(x).trim()).filter(Boolean).map(elementId).filter(e => e !== 'none');
  let elements = list(r.elements ?? r.element ?? r.types ?? r.type ?? r['속성'] ?? r['타입']).filter(e => e !== 'physical');
  let ptypes = [...new Set(list(r.ptypes ?? r.pokemonTypes ?? r.pokemon_types ?? r['포켓몬타입'] ?? r['포켓몬속성']).map(toPoke))];
  // No type given (common for a persona): take the element its damaging skills use most.
  if (!elements.length && !ptypes.length) {
    const count = {};
    for (const k of skills) if ((k.kind === 'physical' || k.kind === 'magic') && k.element && !['none', 'physical', 'normal'].includes(k.element)) count[k.element] = (count[k.element] ?? 0) + (k.power ?? 1);
    const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    if (top) elements = [top[0]];
  }
  if (!ptypes.length) ptypes = elements.length ? [...new Set(elements.map(toPoke))] : ['normal'];
  if (!elements.length && ptypes.length) elements = [...new Set(ptypes.map(toWorld))].filter(x => x && x !== 'none');
  elements = [...new Set(elements)].slice(0, 2);
  if (ptypes.length > 1) ptypes = ptypes.filter(x => x !== 'normal');
  ptypes = [...new Set(ptypes)].slice(0, 2);
  if (!ptypes.length) ptypes = ['normal'];
  return {
    id: r.id ?? `${side[0]}${hashStr(`${seed}${r.name}${Math.random()}`).slice(0, 5)}`,
    name: String(r.name ?? '???').slice(0, 40), side, isPlayer: !!r.isPlayer,
    tier: tier?.name ?? (r.tier ? String(r.tier) : ''), threat,
    stats, maxHp: Math.round(maxHp), hp: Math.round(hp), maxSp: Math.round(maxSp), sp: Math.round(sp),
    element: elements[0] ?? 'none', elements, ptypes, weak: list(r.weak), resist: list(r.resist), immune: list(r.immune),
    level: r.level != null ? Math.max(1, Math.round(num(r.level, 1))) : null,
    aliases: (Array.isArray(r.aliases) ? r.aliases : String(r.aliases ?? '').split(/[,/]/)).map(x => String(x).trim()).filter(Boolean),
    skills, passives: (Array.isArray(r.passives) ? r.passives : r.passives ? [r.passives] : []).map(String).slice(0, 6),
    desc: String(r.desc ?? r.description ?? '').slice(0, 300),
    statuses: Array.isArray(r.statuses) ? r.statuses.filter(s => STATUS[s?.id]) : [],
    row: rowOf(r.row ?? r.position ?? r.rank_position, skills, stats, profile),
    intel: r.intel != null ? clamp(Math.round(num(r.intel, 1)), 0, 2) : null,
    style: r.style ? String(r.style) : '',
    shape: r.shape ? String(r.shape) : '', gender: r.gender ? String(r.gender) : '', portrait: safePortrait(r.portrait),
    ...(safeSprites(r.sprites) ? { sprites: safeSprites(r.sprites) } : {}),
    actions: clamp(Math.round(num(r.actions, threat === 'boss' ? 1 : 1)), 1, 3),
    trait: traitId(r.trait ?? r.role_passive ?? r.passiveTag),
    customPassive: safeCustomPassive(r.customPassive),
    lines: safeLines(r.lines),
  };
}

function safeCustomPassive(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = String(raw.code ?? '').trim().slice(0, 1500);
  const name = String(raw.name ?? '').trim().slice(0, 28);
  const desc = String(raw.desc ?? '').trim().slice(0, 140);
  if (!code && !name) return null;
  const out = { name: name || '고유 특성', desc, code, enabled: raw.enabled !== false };
  if (raw.valid != null) out.valid = !!raw.valid;
  if (raw.error) out.error = String(raw.error).slice(0, 140);
  return out;
}

function safeLines(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ['attack', 'finisher', 'ko']) {
    const v = String(raw[k] ?? '').replace(/^["'「『]+|["'」』]+$/g, '').trim().slice(0, 70);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/* ---------- Role traits (one fixed passive per fighter, engine-owned) ---------- */
export const TRAITS = {
  intimidate: { ko: '위협', desc: '등장할 때 맞은편 전원 공격 -1' },
  vanguard: { ko: '선봉', desc: '전열에 있으면 받는 피해 -20%' },
  opportunist: { ko: '약점포착', desc: '상태이상에 걸린 적에게 피해 +25%' },
  medic: { ko: '의무병', desc: '회복량 +30%' },
  avenger: { ko: '복수', desc: '아군이 쓰러진 뒤 공격 +1 (1회)' },
};
const TRAIT_WORDS = words({
  intimidate: ['intimidate', '위협', '위압', '위협감'], vanguard: ['vanguard', 'tank', '선봉', '탱커', '수호'],
  opportunist: ['opportunist', '기회주의', '약점공략', '틈새'], medic: ['medic', 'healer', '의무병', '치유사', '힐러'], avenger: ['avenger', '복수', '복수자'],
});
export const traitId = raw => (raw ? (TRAITS[raw] ? raw : TRAIT_WORDS.get(norm(raw)) ?? null) : null);

function rowOf(raw, skills, stats, profile) {
  const k = norm(raw ?? '');
  if (['front', 'f', '전열', '앞', '앞줄', '전위', 'vanguard'].includes(k)) return 'front';
  if (['back', 'b', 'rear', '후열', '뒤', '뒷줄', '후위'].includes(k)) return 'back';
  const dmg = skills.filter(x => ['physical', 'magic'].includes(x.kind));
  const ranged = dmg.filter(x => x.range === 'ranged').length;
  const support = skills.filter(x => ['heal', 'revive', 'cleanse'].includes(x.kind)).length;
  return (dmg.length && ranged > dmg.length / 2) || support >= 2 ? 'back' : 'front';
}

function splitPair(v) {
  if (v == null || v === '') return [null, null];
  if (typeof v === 'number') return [v, null];
  const m = String(v).match(/([\d,.]+)\s*\/\s*([\d,.]+)/);
  if (m) return [num(m[1]), num(m[2])];
  const one = String(v).match(/[\d,.]+/);
  return one ? [num(one[0]), null] : [null, null];
}

/** What each fixed combat stat does in the engine (shown in the character card and rules page). */
export const DERIVED_USE = {
  pow: '물리 기술 피해', mag: '마법 기술 피해', def: '받는 물리 피해 감소', res: '받는 마법 피해 감소',
  spd: '행동 순서 · 회피', acc: '명중 · 정보 파악', luk: '치명타 · 상태이상 거는/버티는 확률',
};
/** World stat key → the combat stats whose formula uses it (from the rule profile's map). */
export function statRoles(profile) {
  const out = {};
  for (const s of profile.stats ?? []) {
    const re = new RegExp(`(^|[^A-Za-z0-9_가-힣])${s.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_가-힣])`);
    out[s.key] = DERIVED.filter(d => re.test(String(profile.map?.[d] ?? '')));
  }
  return out;
}

export function derive(sheet, profile) {
  const out = {};
  for (const d of DERIVED) out[d] = Math.max(1, evalExpr(profile.map[d], sheet.stats));
  return out;
}


/* ---------- Balance audit ----------
 * Generated or user-described sheets are clamped to what their rank can afford in this world.
 * A character's concept never buys extra power: rank decides the budget.
 */
/** Default skill cap is 6 (2-6 generated); raised up to 12 when the user explicitly requests more skills. */
export function requestedSkillCap(text = '', { statFields = null, current = null } = {}) {
  const base = 6;
  const s = String(text ?? '');
  let cap = base;
  if (Array.isArray(statFields?.skillNames) && statFields.skillNames.length > cap) cap = Math.max(cap, statFields.skillNames.length);
  if (Array.isArray(current?.skills) && current.skills.length > cap) cap = Math.max(cap, current.skills.length);
  for (const m of s.matchAll(/(?:스킬|기술|무공|마법|능력|skills?|moves?)\s*(?:은|는|을|를|이|가|:|최대|총)?\s*(\d{1,2})\s*(?:개|가지)?/gi)) {
    const n = Number(m[1]);
    if (n > cap) cap = n;
  }
  for (const m of s.matchAll(/(\d{1,2})\s*(?:개|가지)\s*(?:의\s*)?(?:스킬|기술|무공|마법)/gi)) {
    const n = Number(m[1]);
    if (n > cap) cap = n;
  }
  if (/(?:스킬|기술|skills?|moves?)[^\n]{0,20}(?:추가|늘려|더\s*넣|더\s*만들|더\s*줘)|(?:추가|늘려|더\s*넣|더\s*만들)[^\n]{0,20}(?:스킬|기술)|add\s+(?:a\s+|more\s+)?skills?/i.test(s)) {
    cap = Math.max(cap, (current?.skills?.length ?? base) + 2);
  }
  return clamp(cap, base, 12);
}

const HARD_CC = ['sleep', 'stun', 'paralyze', 'freeze', 'petrify'];
export function auditSheet(sheet, profile, { bonusTier = 0, clampStats: clampIn = false, maxSkills = 6 } = {}) {
  let clampStats = clampIn;
  const notes = [];
  if (!sheet) return { sheet, notes };
  const tiers = profile.tiers ?? [];
  const n = Math.max(1, tiers.length);
  let idx = tiers.findIndex(t => t.name === sheet.tier);
  const known = idx >= 0;
  if (!known) { idx = Math.floor((n - 1) / 2); clampStats = false; }
  idx = Math.min(n - 1, idx + bonusTier);
  const r = n > 1 ? idx / (n - 1) : 0.5;
  const maxPow = Math.round(60 + 45 * r);            // F≈60 … S≈105
  const sigPow = maxPow + 35;                         // one signature move (cooldown ≥3 or charge)
  const skillCap = clamp(Math.round(num(maxSkills, 6)), 1, 12);
  const cap = (k, field, max, label) => { if ((k[field] ?? 0) > max) { notes.push(`${k.name} ${label} ${k[field]}→${max}`); k[field] = max; } };
  if (sheet.skills.length > skillCap) { notes.push(`기술 ${sheet.skills.length}개→${skillCap}개`); sheet.skills = sheet.skills.slice(0, skillCap); }
  let sigUsed = false;
  const damaging = k => ['physical', 'magic'].includes(k.kind);
  for (const k of sheet.skills) {
    if (damaging(k)) {
      const isSig = !sigUsed && ((k.cooldown ?? 0) >= 3 || k.charge || k.once);
      if (isSig) sigUsed = true;
      // A real price buys power: recoil, paying HP, a self-debuff, or once per battle.
      const selfDown = Object.values(k.selfStages ?? {}).filter(v => v < 0).reduce((a, v) => a - v, 0);
      const paid = ((k.recoil ?? 0) >= 0.25 ? 15 : (k.recoil ?? 0) >= 0.1 ? 8 : 0) + ((k.hpCost ?? 0) >= 10 ? 12 : 0) + (selfDown >= 2 ? 15 : selfDown ? 8 : 0) + (k.once && !isSig ? 25 : 0);
      cap(k, 'power', (isSig ? sigPow : maxPow) + Math.min(30, paid), '위력');
      if (k.bonusIf) {
        // Conditional bursts are the point of combos, but the condition must be real.
        const lim = k.bonusIf.consume ? 1.8 : k.bonusIf.selfHpBelow || k.bonusIf.targetFullHp ? 1.4 : 1.6;
        if (k.bonusIf.mul > lim) { notes.push(`${k.name} 조건 배율 ×${k.bonusIf.mul}→×${lim}`); k.bonusIf.mul = lim; }
      }
      if (k.pivot) cap(k, 'power', Math.round(maxPow * 0.75), '교체기 위력');
      if ((k.hits ?? 1) > 1) { cap(k, 'hits', 3, '타수'); cap(k, 'power', Math.round(maxPow * 0.4), '타당 위력'); }
      if (k.target === 'enemies') cap(k, 'power', Math.round(maxPow * 0.8), '광역 위력');
      if (k.priority > 0) { cap(k, 'priority', r >= 0.5 ? 2 : 1, '우선도'); cap(k, 'power', r >= 0.8 ? 60 : 50, '선공기 위력'); }
      if (k.status) {
        const lim = HARD_CC.includes(k.status.id) ? 20 : k.status.id === 'mark' ? 100 : k.status.id === 'vulnerable' ? ((k.power ?? 0) >= 60 ? 50 : 100) : (k.power ?? 0) >= 60 ? 30 : 50;
        if (k.status.chance > lim) { notes.push(`${k.name} ${k.status.id} 확률 ${k.status.chance}%→${lim}%`); k.status.chance = lim; }
      }
      if (k.selfStages) {
        const up = Object.values(k.selfStages).filter(v => v > 0).reduce((a, v) => a + v, 0);
        if (up > 1) { notes.push(`${k.name} 공격하며 자기 강화 +${up}→+1`); const [first] = Object.keys(k.selfStages).filter(x => k.selfStages[x] > 0); for (const x of Object.keys(k.selfStages)) if (k.selfStages[x] > 0) k.selfStages[x] = x === first ? 1 : 0; for (const x of Object.keys(k.selfStages)) if (!k.selfStages[x]) delete k.selfStages[x]; }
      }
      cap(k, 'drain', 0.5, '흡수');
      cap(k, 'selfHeal', 20, '자힐');
      // One secondary effect per attack.
      const fx = [k.status && 'status', k.stages && Object.keys(k.stages).length && 'stages', k.selfStages && Object.keys(k.selfStages).length && 'selfStages', k.drain && 'drain', k.selfHeal && 'selfHeal'].filter(Boolean);
      for (const extra of fx.slice(1)) { notes.push(`${k.name} 부가효과 정리 (${extra} 제거)`); delete k[extra]; }
    } else {
      if (k.kind === 'heal') cap(k, 'power', r >= 0.5 ? 50 : 35, '회복량');
      const tot = o => Object.values(o ?? {}).reduce((a, v) => a + Math.abs(v), 0);
      for (const f of ['stages', 'selfStages']) if (tot(k[f]) > 2) {
        notes.push(`${k.name} 랭크 변화 합 ${tot(k[f])}→2`);
        let left = 2; for (const x of Object.keys(k[f])) { const v = k[f][x], m = Math.min(Math.abs(v), left); k[f][x] = Math.sign(v) * m; left -= m; if (!k[f][x]) delete k[f][x]; }
      }
      cap(k, 'selfHeal', 25, '자힐');
      if (k.status && HARD_CC.includes(k.status.id) && (k.acc ?? 95) > 75) { notes.push(`${k.name} 명중 ${k.acc ?? 95}→75`); k.acc = 75; }
    }
  }
  // Free secondary effects: up to half of the attacks. Effects that come with a price
  // (a self-debuff, recoil, HP cost) or that set up a combo (mark/vulnerable) don't count against it.
  const att = sheet.skills.filter(damaging);
  const priced = k => k.recoil || k.hpCost || Object.values(k.selfStages ?? {}).some(v => v < 0);
  const combo = k => ['mark', 'vulnerable'].includes(k.status?.id);
  const withFx = att.filter(k => (k.status || k.stages || k.selfStages || k.drain || k.selfHeal) && !priced(k) && !combo(k));
  const allow = Math.max(att.length >= 2 ? 1 : 0, Math.ceil(att.length / 2));
  for (const k of withFx.slice(allow).reverse()) {
    notes.push(`${k.name} 부가효과 제거 (무상 부가효과는 공격기 절반까지)`);
    for (const f of ['status', 'stages', 'selfStages', 'drain', 'selfHeal']) delete k[f];
  }
  if (att.length >= 2 && att.filter(k => k.once).length > 1) for (const k of att.filter(x => x.once).slice(1)) { notes.push(`${k.name} 1회 제한 해제 (1회기는 하나만)`); delete k.once; cap(k, 'power', maxPow, '위력'); }
  if (clampStats && tiers[idx]) {
    const t = tiers[idx];
    const [lo, hi] = t.stat ?? [0, Infinity];
    const keys = Object.keys(sheet.stats ?? {});
    // Allow strong character identity (+35% peak / -35% dump) while keeping the overall stat total fair for the tier.
    const top = Math.round(hi * 1.35), bot = Math.max(1, Math.round(lo * 0.65));
    for (const key of keys) {
      const v = sheet.stats[key];
      if (v > top) { notes.push(`${key} ${v}→${top} (${t.name}급 특화 상한)`); sheet.stats[key] = top; }
      else if (v < bot && v > 0) sheet.stats[key] = bot;
    }
    const total = keys.reduce((a, k) => a + (sheet.stats[k] ?? 0), 0);
    const totalMax = Math.round(keys.length * hi * 1.05);
    if (keys.length && total > totalMax) {
      const ratio = totalMax / total;
      notes.push(`스탯 합계 ${total}→${totalMax} (${t.name}급 총합 기준)`);
      for (const k of keys) sheet.stats[k] = Math.max(bot, Math.round(sheet.stats[k] * ratio));
    }
    if (t.hp && sheet.maxHp > t.hp[1] * 1.3) { const m = Math.round(t.hp[1] * 1.3); notes.push(`HP ${sheet.maxHp}→${m}`); sheet.hp = Math.min(sheet.hp, m); sheet.maxHp = m; }
  }
  return { sheet, notes };
}
