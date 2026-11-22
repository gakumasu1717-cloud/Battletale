// Pokémon-style battle screen pieces: scene, info boxes, HP bars, sprites, menu grid.
import { escapeHtml as h, clamp } from './util.js';
import { STATUS, typeName, typeIn, typesFor, skillLine, POKE_TYPES, ELEMENT_KO } from './catalog.js';
import * as E from './engine.js';

const hpCls = p => (p > 50 ? 'g' : p > 20 ? 'y' : 'r');
const STAGE_SHORT = { pow: '공격', mag: '특공', def: '방어', res: '특방', spd: '스피드', acc: '명중', eva: '회피', luk: '운' };
const STAT_NAME = { pow: '공격', mag: '특수공격', def: '방어', res: '특수방어', spd: '스피드', acc: '명중', luk: '운' };
const stageX = (k, v = 0) => (k === 'acc' || k === 'eva' ? (v >= 0 ? (3 + v) / 3 : 3 / (3 - v)) : (v >= 0 ? (3 + v) / 3 : 3 / (3 - v)));
const STATUS_SHORT = { burn: '화상', poison: '독', bleed: '출혈', regen: '재생', stun: '기절', freeze: '얼음', sleep: '잠듦', blind: '실명', silence: '침묵', confuse: '혼란', shield: '보호막', taunt: '도발', fear: '공포' };


/* ---------- Pixel silhouettes (16×16). # = body, o = eye/highlight ---------- */
const PIX = {
  male: ['......####......', '.....######.....', '.....######.....', '.....#o##o#.....', '.....######.....', '......####......', '....########....', '...##########...', '..############..', '..##.######.##..', '..##.######.##..', '..##.######.##..', '.....######.....', '.....##..##.....', '.....##..##.....', '....###..###....'],
  female: ['.....######.....', '....########....', '....##o##o##....', '....########....', '...##########...', '...##.####.##...', '...#.######.#...', '..##.######.##..', '..#..######..#..', '.....######.....', '....########....', '...##########...', '..############..', '.....##..##.....', '.....##..##.....', '....###..###....'],
  monster: ['................', '..#..........#..', '..##........##..', '...##########...', '...#o######o#...', '...##########...', '....##.##.##....', '..############..', '.##############.', '.##############.', '.##############.', '..############..', '..##..####..##..', '..##..####..##..', '..##........##..', '.###........###.'],
  geometric: ['.......##.......', '......####......', '.....######.....', '....########....', '...####oo####...', '..############..', '.##############.', '################', '.##############.', '..############..', '...##########...', '....########....', '.....######.....', '......####......', '.......##.......', '................'],
  kaiju: ['.........#.#.#..', '........#######.', '.......####o###.', '.......#########', '..#....######...', '.##...#######...', '.##..#########..', '..############..', '..#############.', '...############.', '...###########..', '....##########..', '....###...###...', '....###...###...', '...####..####...', '................'],
  unknown: ['.....######.....', '....########....', '...##########...', '..############..', '..############..', '.##############.', '.##############.', '.##############.', '.##############.', '.##############.', '..############..', '..############..', '...##########...', '...##.####.##...', '...#...##...#...', '................'],
  fairy: ['................', '..##........##..', '.####......####.', '.#####.##.#####.', '.####.####.####.', '..###.#oo#.###..', '...##.####.##...', '......####......', '.....######.....', '....##.##.##....', '.......##.......', '......#..#......', '......#..#......', '................', '................', '................'],
};
export const SHAPE_KO = { male: '남자', female: '여자', monster: '몬스터', geometric: '도형', kaiju: '괴수', unknown: '미지', fairy: '요정' };
const svgCache = {};
export function pixelSvg(shape, color) {
  const key = `${shape}|${color}`;
  if (svgCache[key]) return svgCache[key];
  const rows = PIX[shape] ?? PIX.unknown;
  let rects = '';
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '#') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
    else if (c === 'o') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="#fff"/>`;
  }));
  // A 1px dark outline makes the silhouette pop on any background.
  return (svgCache[key] = `<svg class="pk-pix" viewBox="-1 -1 18 18" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><g filter="url(#o)">${rects}</g>${shape === 'unknown' ? '<text x="8" y="11.5" font-size="8" text-anchor="middle" fill="#fff" font-weight="900" font-family="monospace">?</text>' : ''}</svg>`);
}

export const TYPE_HEX = { normal: '#8a8c8a', fire: '#d8401f', water: '#2b74d6', grass: '#3a9128', electric: '#c09a00', ice: '#36b6d8', fighting: '#e07000', poison: '#8238b5', ground: '#86501f', earth: '#86501f', flying: '#6f9fd6', wind: '#6f9fd6', psychic: '#d93a6c', aether: '#d93a6c', bug: '#829018', rock: '#9c9670', ghost: '#633a63', dragon: '#4654c8', dark: '#4f3e3f', steel: '#56909f', fairy: '#d863d8', light: '#d863d8', poison2: '#8238b5' };

const SHAPE_WORDS = [
  ['fairy', /요정|정령|페어리|님프|fairy|sprite|pixie|nymph|wisp/i],
  ['geometric', /골렘|구조체|기계|로봇|슬라임|큐브|수정|크리스탈|드론|포탑|토템|golem|construct|robot|slime|crystal|cube|drone|turret|totem|machine/i],
  ['kaiju', /드래곤|비룡|와이번|거대|괴수|타이탄|히드라|베헤모스|용왕|dragon|wyvern|giant|titan|kaiju|behemoth|hydra|leviathan/i],
  ['monster', /고블린|오크|오우거|늑대|야수|몬스터|괴물|해골|언데드|좀비|거미|박쥐|쥐|곰|뱀|리자드|구울|트롤|beast|wolf|goblin|orc|ogre|skeleton|zombie|spider|bat|rat|bear|snake|ghoul|troll|monster/i],
  ['female', /그녀|여자|여성|소녀|아가씨|마녀|여왕|공주|누나|언니|여사|female|woman|girl|lady|queen|witch|princess|\bshe\b/i],
  ['male', /헌터|검객|기사|경비|병사|도적|남자|소년|아저씨|청년|무사|사수|건슬링거|hunter|knight|guard|soldier|thief|man|boy|swordsman|gunslinger/i],
];
export function shapeOf(f, { side, intel = 2 } = {}) {
  if (side === 'enemy' && intel === 0) return 'unknown';
  const set = String(f.shape ?? '').toLowerCase();
  if (PIX[set]) return set;
  const g = String(f.gender ?? '').toLowerCase();
  if (/^(f|female|여|여자|여성)$/.test(g)) return 'female';
  if (/^(m|male|남|남자|남성)$/.test(g)) return 'male';
  const text = `${f.name ?? ''} ${f.desc ?? ''} ${f.className ?? ''}`;
  for (const [k, re] of SHAPE_WORDS) if (re.test(text)) return k;
  if (f.isPlayer || f.persistent || f.codexId) return 'male';
  return f.threat === 'boss' ? 'kaiju' : 'monster';
}

export function mapOf(place = '', mode = '') {
  const t = String(place);
  if (/동굴|광산|폐광|갱도|cave|mine/i.test(t)) return 'cave';
  if (/숲|정글|forest|jungle|woods/i.test(t)) return 'forest';
  if (/던전|균열|폐허|성채|유적|왕좌|dungeon|rift|ruin|castle/i.test(t)) return 'dungeon';
  if (/투기장|훈련장|경기장|아레나|도장|arena|dojo|stadium/i.test(t)) return 'arena';
  if (/바다|해변|호수|강가|sea|beach|lake|river/i.test(t)) return 'water';
  if (/설원|빙하|눈|snow|glacier|ice/i.test(t)) return 'snow';
  if (/창고|실내|보관소|건물 안|사무실|warehouse|indoor|office|archive/i.test(t)) return 'indoor';
  if (/도시|거리|빌딩|옥상|골목|city|street|roof|alley/i.test(t)) return 'city';
  if (/화산|용암|volcano|lava/i.test(t)) return 'volcano';
  return mode === 'stealth' ? 'indoor' : 'field';
}

/**
 * View fighter: { name, tier, types[], hp, maxHp, hpUnknown, showNums, sp, maxSp, statuses[], note, noteCls,
 *                 down, side, selected, posture, sub, sprite }
 */
export function vf(f, { side, intel = 2, typeSystem = 'world', note = '', noteCls = '', selected = false, posture = null, sub = '' } = {}) {
  return {
    name: f.name, tier: f.tier, types: typesFor(f, typeSystem).map(t => ({ id: t, label: typeName(t, typeSystem) })),
    hp: f.hp, maxHp: f.maxHp, hpUnknown: side === 'enemy' && intel === 0, showNums: side !== 'enemy' || intel >= 2,
    sp: side === 'ally' || (!f.noSp && intel >= 1) ? f.sp : null, maxSp: f.maxSp, statuses: f.statuses ?? [], note, noteCls,
    down: !!(f.down || f.out), out: f.out, side, selected, posture, sub, threat: f.threat,
    row: f.row === 'back' ? 'back' : 'front', shape: shapeOf(f, { side, intel }), portrait: f.portrait?.src ? f.portrait : null, hidden: side === 'enemy' && intel === 0,
    stages: f.stages ?? {}, typeSystem,
  };
}

function hpBar(F, ctx) {
  const to = F.hpUnknown ? 100 : clamp(Math.round(F.hp / Math.max(1, F.maxHp) * 100), 0, 100);
  const prev = ctx?.ui?.prevHp?.[F.name];
  const from = F.hpUnknown || prev == null ? to : prev;
  return `<div class="pk-hp"><div class="pk-hp-track"><div class="pk-hp-fill ${F.hpUnknown ? 'u' : hpCls(to)}" style="width:${from}%" data-to="${to}"></div></div></div>`;
}

export function infoBox(F, ctx, { compact = false } = {}) {
  const chips = F.statuses.map(s => `<span class="pk-st st-${s.id}">${STATUS_SHORT[s.id] ?? STATUS[s.id]?.ko ?? s.id}</span>`).join('')
    + Object.entries(F.stages ?? {}).filter(([, v]) => v).map(([k, v]) => `<span class="pk-stage ${v > 0 ? 'up' : 'down'}">${STAGE_SHORT[k] ?? k}${v > 0 ? '▲' : '▼'}${Math.abs(v)}</span>`).join('');
  const state = F.out === 'yield' ? '항복' : F.out ? '이탈' : F.down ? '기절' : '';
  const tlist = F.types.length ? F.types : F.typeSystem === 'pokemon' ? [{ id: 'normal', label: '노말' }] : [];
  const types = tlist.map(t => `<span class="pk-tdot t-${t.id}" title="${h(t.label)}">${h(t.label)}</span>`).join('');
  const nums = F.showNums ? `<span class="pk-nums">${F.hp}/${F.maxHp}</span>` : '';
  const sp = F.sp != null && !compact ? `<div class="pk-spl"><div style="width:${clamp(Math.round(F.sp / Math.max(1, F.maxSp) * 100), 0, 100)}%"></div></div>` : '';
  return `<div class="pk-info ${F.side} ${F.selected ? 'sel' : ''} ${F.down ? 'down' : ''} ${compact ? 'compact' : ''}" data-act="pk:inspect" data-v="${h(F.name)}">
    <div class="pk-row1"><span class="pk-name">${h(F.name)}</span>${types}${F.threat === 'boss' ? '<span class="pk-boss">BOSS</span>' : F.threat === 'elite' ? '<span class="pk-elite">★</span>' : ''}<span class="pk-lv">${h(F.tier || '')}</span></div>
    <div class="pk-hprow">${hpBar(F, ctx)}${!compact ? nums : ''}</div>${sp}
    ${chips || state ? `<div class="pk-chips">${state ? `<span class="pk-st down">${state}</span>` : ''}${chips}</div>` : ''}
    ${F.note && !F.down ? `<div class="pk-note ${F.noteCls}">${h(F.note)}</div>` : ''}
  </div>`;
}

/** A registered character's own picture instead of the silhouette (unknown enemies show as a shadow). */
export function portraitImg(p, { hidden = false, cls = 'pk-pix' } = {}) {
  return `<img class="${cls} pk-img ${p.pixel ? 'px' : ''} ${hidden ? 'shadow' : ''}" src="${h(p.src)}" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer">`;
}

export function sprite(F, ctx) {
  const t = F.types[0]?.id ?? 'normal';
  const color = F.shape === 'unknown' ? '#16181f' : TYPE_HEX[t] ?? '#6b6e78';
  const fx = ctx?.ui?.fx?.[F.name];
  const pops = fx?.length ? `<div class="bt-fx-wrap">${fx.slice(0, 5).map((x, i) => `<span class="bt-fx ${x.cls}" style="animation-delay:${x.d ?? i * 0.18}s">${h(x.text)}</span>`).join('')}</div>` : '';
  const firstHit = fx?.find(x => ['dmg', 'crit', 'super', 'ko'].includes(x.cls));
  const hit = firstHit ? 'hit' : '';
  const bursts = (ctx?.ui?.anim?.[F.name] ?? []).slice(0, 4).map(a => `<div class="pk-hitfx k-${a.k} ${a.super ? 'super' : ''}" style="--c:${a.c};--d:${a.d}s"></div>`).join('');
  const atkD = ctx?.ui?.atk?.[F.name];
  const tgt = ctx?.ui?.targetable?.includes(F.name) ? 'tgt' : '';
  const sel = tgt && ctx.ui.target === F.name ? 'sel' : (!ctx?.ui?.targetable && F.selected ? 'sel' : '');
  return `<div class="pk-mon ${F.side} ${F.down ? 'down' : ''} ${sel} ${tgt} ${atkD != null ? 'atk' : ''}" style="${atkD != null ? `--d:${atkD}s;` : ''}${firstHit ? `--hd:${firstHit.d ?? 0}s` : ''}" ${!F.down || bursts ? `data-act="pk:pick" data-v="${h(F.name)}"` : ''}>
    <div class="pk-plat"></div><div class="pk-sprite ${hit} ${F.side === 'ally' ? 'back' : ''}" title="${h(SHAPE_KO[F.shape] ?? '')}">${F.portrait ? portraitImg(F.portrait, { hidden: F.hidden }) : pixelSvg(F.shape, color)}</div>${bursts}<div class="pk-tag">${h(F.name)}</div>${pops}</div>`;
}

const balls = list => (list?.length > 1 ? `<div class="pk-balls">${list.map(x => `<i class="b-${x === '*' ? 'on' : x === 'o' ? 'wait' : 'out'}"></i>`).join('')}</div>` : '');

/** Mirrored rows: the enemy front line stands nearest to us (lower), ours nearest to them (upper). */
function monRows(list, side, ctx) {
  const front = list.filter(F => F.row !== 'back'), back = list.filter(F => F.row === 'back');
  const line = (arr, cls) => (arr.length ? `<div class="pk-line ${cls}">${arr.map(F => sprite(F, ctx)).join('')}</div>` : '');
  return side === 'enemy' ? line(back, 'far') + line(front, 'near') : line(front, 'near') + line(back, 'far');
}

export function scene(V, ctx) {
  const n = V.foes.length, na = V.allies.length;
  const sizeF = n <= 1 ? 'n1' : n === 2 ? 'n2' : n <= 4 ? 'n4' : 'n6';
  const sizeA = na <= 1 ? 'n1' : na === 2 ? 'n2' : na <= 4 ? 'n4' : 'n6';
  return `<div class="pk-scene map-${V.map ?? 'field'} ${V.sceneCls ?? ''} ${n >= 4 ? 'crowd' : ''} ${na >= 4 ? 'crowd-a' : ''}">
    <div class="pk-top"><div class="pk-foe-infos">${balls(V.foeBalls)}${V.foes.map(F => infoBox(F, ctx, { compact: n > 2 })).join('')}</div>
      <div class="pk-foe-mons ${sizeF}">${monRows(V.foes, 'enemy', ctx)}</div></div>
    <div class="pk-bot"><div class="pk-ally-mons ${sizeA}">${monRows(V.allies, 'ally', ctx)}</div>
      <div class="pk-ally-infos">${balls(V.allyBalls)}${V.allies.map(F => infoBox(F, ctx, { compact: na > 2 })).join('')}</div></div>
    <svg width="0" height="0" style="position:absolute"><filter id="o"><feMorphology in="SourceAlpha" operator="dilate" radius="0.6" result="d"/><feFlood flood-color="#111"/><feComposite in2="d" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></svg>
  </div>${V.banner ?? ''}`;
}

/** items: [{ label, sub, meta, cls, disabled, act, v, page, target: [names] }] */
/** Short effect summary for a skill button (the card shows everything on long-press). */
export function fxLine(k, sys = 'world') {
  const c = skillCard(k, { sys });
  return c.lines.filter(l => !/^(선공|후공|재사용|\d+회 공격)/.test(l)).slice(0, 2).join(' · ');
}

export function menuGrid(items, { cols = 2, main = false } = {}) {
  return `<div class="pk-menu c${cols} ${main ? 'main' : ''}">${items.map((it, i) => `<button class="pk-btn ${it.cls ?? ''}" data-act="pk:item" data-i="${i}" ${it.disabled ? 'disabled' : ''}>
    <b>${h(it.label)}</b>${it.meta ? `<em>${h(it.meta)}</em>` : ''}${it.sub ? `<small>${h(it.sub)}</small>` : ''}${it.fx ? `<i class="pk-fx">${h(it.fx)}</i>` : ''}</button>`).join('')}</div>`;
}

/** After the HTML is in the page: slide HP bars from their old width to the new one. */
export function animateBars(root) {
  const bars = root?.querySelectorAll?.('.pk-hp-fill[data-to]') ?? [];
  if (!bars.length) return;
  const go = () => bars.forEach(b => { b.style.width = `${b.dataset.to}%`; b.className = b.className.replace(/\b[gyr]\b/, hpCls(+b.dataset.to)); });
  (globalThis.requestAnimationFrame ?? (f => setTimeout(f, 16)))(() => (globalThis.requestAnimationFrame ?? (f => setTimeout(f, 16)))(go));
}

/** Detail sheet for one fighter: stats with stage multipliers, status, type matchups, known skills. */
export function inspectHtml(f, { b, profile, intel = 2, side }) {
  if (!f) return '';
  const sys = b?.typeSystem ?? 'world';
  const known = side !== 'enemy' || intel >= 2;
  const types = typesFor(f, sys);
  const hp = side !== 'enemy' || intel >= 2 ? `${f.hp} / ${f.maxHp}` : intel === 1 ? `${Math.round(f.hp / f.maxHp * 100)}%` : '???';
  const SHORTN = { pow: '공격', mag: '특공', def: '방어', res: '특방', spd: '스피드', acc: '명중', luk: '운' };
  const rows = ['pow', 'mag', 'def', 'res', 'spd', 'acc', 'luk'].map(k => {
    const st = f.stages?.[k] ?? 0;
    const base = Math.round(f.derived?.[k] ?? 0);
    const eff = Math.round(base * stageX(k, st));
    return `<div class="ps"><small>${SHORTN[k]}</small><b>${known ? eff : '?'}</b><em class="${st > 0 ? 'up' : st < 0 ? 'down' : ''}">${st ? `${st > 0 ? '▲' : '▼'}${Math.abs(st)} ×${stageX(k, st).toFixed(2)}` : known ? `기본 ${base}` : ''}</em></div>`;
  }).join('') + (f.stages?.eva ? `<div class="ps"><small>회피</small><b>${f.stages.eva > 0 ? '▲' : '▼'}${Math.abs(f.stages.eva)}</b><em></em></div>` : '');
  // Matchups against every attacking type the rules know.
  const attackTypes = sys === 'pokemon' ? POKE_TYPES : Object.keys(b?.chart ?? {});
  const groups = {};
  for (const t of attackTypes) {
    const m = E.elementMul(f, t, b).mul;
    if (Math.abs(m - 1) < 0.01) continue;
    (groups[m] ??= []).push(typeName(t, sys));
  }
  const order = Object.keys(groups).map(Number).sort((a, c) => c - a);
  const match = order.map(m => `<div class="pk-mu"><b class="${m > 1 ? 'up' : m === 0 ? 'zero' : 'down'}">×${m === 0 ? '0' : m}</b> ${groups[m].map(t => `<span class="bt-type t-${typeIn(attackTypes.find(x => typeName(x, sys) === t) ?? '', sys)}">${h(t)}</span>`).join('')}</div>`).join('');
  const skills = side !== 'enemy' || intel >= 2 ? f.skills : f.skills.filter(k => f.revealed?.includes(k.name));
  const world = known && f.stats ? Object.entries(f.stats).map(([k, v]) => `<span>${h(k)} <b>${v}</b></span>`).join('') : '';
  return `<div class="pk-inspect"><div class="pk-ins-box">
    <div class="pk-ins-head"><b>${h(f.name)}</b> <small>${h(f.tier ?? '')}</small> ${types.map(t => `<span class="bt-type t-${typeIn(t, sys)}">${h(typeName(t, sys))}</span>`).join('')}<button class="pk-ins-x" data-act="pk:inspect-close">✕</button></div>
    <div class="pk-ins-hp">${h(profile.hpLabel)} <b>${hp}</b>${side !== 'enemy' ? ` · ${h(profile.spLabel)} <b>${f.sp} / ${f.maxSp}</b>` : ''}${f.row && b?.format !== 'singles' ? ` · ${f.row === 'back' ? '후열' : '전열'}` : ''}</div>
    ${f.statuses?.length ? `<div class="pk-chips">${f.statuses.map(x => `<span class="pk-st st-${x.id}">${STATUS[x.id]?.ko} ${x.turns}턴</span>`).join('')}</div>` : ''}
    <div class="pk-stats">${rows}</div>
    ${world ? `<div class="pk-world">${world}</div>` : ''}
    ${match ? `<div class="pk-sub">받는 상성</div>${match}` : ''}
    <div class="pk-sub">기술${side === 'enemy' && intel < 2 ? ' (드러난 것만)' : ''}</div>
    ${skills.length ? skills.map(k => `<div class="pk-skl">${h(skillLine(k, sys))}</div>`).join('') : '<div class="pk-note">아직 알 수 없음</div>'}
  </div></div>`;
}

/* ---------- Library-of-Ruina style combat pages ---------- */
const KIND_ICON = { physical: '⚔', magic: '✦', heal: '✚', buff: '▲', debuff: '▼', guard: '⛨', revive: '✚', cleanse: '❖' };
const KIND_NAME = { physical: '물리', magic: '특수', heal: '회복', buff: '강화', debuff: '방해', guard: '방어', revive: '부활', cleanse: '정화' };
const STG = { pow: '공격', mag: '특공', def: '방어', res: '특방', spd: '스피드', acc: '명중', eva: '회피', luk: '운' };

export function skillCard(k, { sys = 'world', spLabel = 'SP', targets = null, disabled = false, why = '', act = 'm:skill', v = null, extra = [] } = {}) {
  const t = k.element && !['none', 'physical'].includes(k.element) ? typeIn(k.element, sys) : 'normal';
  const lines = [];
  if (k.hits > 1) lines.push(`${k.hits}회 공격`);
  if (k.target === 'enemies') lines.push('적 전체'); else if (k.target === 'allies') lines.push('아군 전체'); else if (k.target === 'ally') lines.push('아군 1명'); else if (k.target === 'self' && !['physical', 'magic'].includes(k.kind) && !Object.keys(k.stages ?? {}).length && k.kind !== 'heal') lines.push('자신');
  if (k.priority > 0) lines.push(`선공 +${k.priority}`); else if (k.priority < 0) lines.push(`후공 ${k.priority}`);
  if (k.acc && k.acc !== 95) lines.push(k.acc >= 100 ? '필중' : `명중 ${k.acc}`);
  if (k.status) lines.push(`${STATUS[k.status.id]?.ko ?? k.status.id} ${k.status.chance < 100 ? `${k.status.chance}%` : ''}`.trim());
  for (const [s2, v2] of Object.entries(k.stages ?? {})) lines.push(`${k.kind === 'buff' && k.target === 'self' ? '자신' : k.kind === 'buff' ? '아군' : '대상'} ${STG[s2] ?? s2} ${v2 > 0 ? '▲' : '▼'}${Math.abs(v2)}`);
  for (const [s2, v2] of Object.entries(k.selfStages ?? {})) lines.push(`자신 ${STG[s2] ?? s2} ${v2 > 0 ? '▲' : '▼'}${Math.abs(v2)}`);
  if (k.kind === 'heal') lines.push(`HP ${k.power}% 회복`);
  if (k.selfHeal) lines.push(`자신 HP ${k.selfHeal}% 회복`);
  if (k.drain) lines.push(`흡수 ${Math.round(k.drain * 100)}%`);
  if (k.crit) lines.push('급소율 ↑');
  if (k.charge) lines.push('충전 후 발동');
  if (k.cooldown) lines.push(`재사용 ${k.cooldown}턴`);
  lines.push(...extra);
  const fx = (k.status ? 1 : 0) + Object.keys(k.stages ?? {}).length + Object.keys(k.selfStages ?? {}).length + (k.selfHeal ? 1 : 0) + (k.drain ? 1 : 0) + (k.priority ? 1 : 0);
  const rarity = k.basic ? 'paper' : k.cooldown >= 3 || k.power >= 110 ? 'art' : k.power >= 80 || fx >= 2 ? 'limited' : fx ? 'hard' : 'paper';
  return { name: k.name, cost: k.cost ?? 0, spLabel, type: t, typeLabel: typeName(t === 'normal' && k.element !== 'normal' ? 'normal' : k.element, sys), kind: k.kind, power: ['physical', 'magic'].includes(k.kind) ? k.power : null,
    lines, rarity, disabled, why, act, v: v ?? k.name, target: targets, desc: k.desc ?? '' };
}

export function handHtml(cards, sel) {
  return `<div class="lr-hand">${cards.map((c, i) => `<div class="lr-card r-${c.rarity} t-${c.type} ${i === sel ? 'sel' : ''} ${c.disabled ? 'off' : ''}" data-act="pk:card" data-i="${i}" title="${h(c.desc || c.name)}">
    <div class="lr-top"><span class="lr-cost">${c.cost ?? ''}</span><span class="lr-typ">${h(c.typeLabel ?? '')}</span></div>
    <div class="lr-art"><span class="lr-kind">${c.icon ?? KIND_ICON[c.kind] ?? '◆'}</span>${c.power != null ? `<b class="lr-pow">${c.power}</b>` : ''}<span class="lr-kn">${h(c.kindLabel ?? KIND_NAME[c.kind] ?? '')}</span></div>
    <div class="lr-name">${h(c.name)}</div>
    <ul class="lr-fx">${c.lines.slice(0, 6).map(l => `<li>${h(l)}</li>`).join('')}</ul>${c.desc ? `<div class="lr-desc">${h(c.desc)}</div>` : ''}
    ${c.disabled && c.why ? `<div class="lr-why">${h(c.why)}</div>` : ''}
  </div>`).join('')}</div>`;
}

/** Speed order strip ("speed dice"). */
export function orderHtml(order) {
  if (!order?.length) return '';
  return `<div class="lr-order"><span class="lr-ol">행동 순서</span>${order.map((o, i) => `<span class="lr-oc ${o.side} ${o.down ? 'down' : ''}"><i>${i + 1}</i>${h(o.name)}<em>${o.spd ?? '?'}</em></span>`).join('')}</div>`;
}
