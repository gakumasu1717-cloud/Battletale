// Pokémon-style battle screen pieces: scene, info boxes, HP bars, sprites, menu grid.
import { escapeHtml as h, clamp } from './util.js';
import { STATUS, typeName, typeIn, typesFor, skillLine, POKE_TYPES, ELEMENT_KO, bonusText } from './catalog.js';
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
export function vf(f, { side, intel = 2, typeSystem = 'world', note = '', noteCls = '', selected = false, posture = null, sub = '', spLabel = 'SP' } = {}) {
  return {
    name: f.name, tier: f.tier, types: typesFor(f, typeSystem).map(t => ({ id: t, label: typeName(t, typeSystem) })),
    hp: f.hp, maxHp: f.maxHp, hpUnknown: side === 'enemy' && intel === 0, showNums: side !== 'enemy' || intel >= 2,
    sp: f.maxSp > 0 && (side === 'ally' || !f.noSp) ? f.sp : null, maxSp: f.maxSp, spLabel, statuses: f.statuses ?? [], note, noteCls,
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
    ${F.note && !F.down ? `<div class="pk-note ${F.noteCls}" title="${h(F.noteTitle || F.note)}">${h(F.note)}</div>` : ''}
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

/* ---------- Battlefield: unified entity cards ----------
 * Enemies: one card per fighter (art + name + HP with a delayed trail + chips), intent badge on top,
 * back row (small) above the front row. Allies: a compact HUD strip under the message ticker.
 * Art is the character's own portrait as a full-bleed background, else an original vector emblem
 * on a type-coloured glow. */
const EMBLEM = {
  male: '<circle cx="12" cy="7.6" r="4"/><path d="M3.6 21.5c.6-4.7 4.1-7.7 8.4-7.7s7.8 3 8.4 7.7z"/>',
  female: '<path d="M12 3c-3.1 0-5.2 2.4-5.2 5.4 0 2.3.7 4-.9 5.8 1.5.7 3.4.5 4.4-.4h3.4c1 .9 2.9 1.1 4.4.4-1.6-1.8-.9-3.5-.9-5.8C17.2 5.4 15.1 3 12 3z"/><path d="M4 21.5c.7-4 4-6.5 8-6.5s7.3 2.5 8 6.5z"/>',
  monster: '<path d="M2.5 3.5 7 7.2h10l4.5-3.7-1.2 8.3c0 5.1-3.7 9.2-8.3 9.2s-8.3-4.1-8.3-9.2z"/><path fill="#0d0f14" d="M7.2 11.2l3.3 1.4-.6 1.6-3-1.2zM16.8 11.2l-3.3 1.4.6 1.6 3-1.2zM9 16.6h6l-1 2-1-1-1 1-1-1-1 1z"/>',
  kaiju: '<path d="M3.5 2 7 7.4h10L20.5 2l-.6 8 2.1 2.6-3.3 1-1.6 7.4H7l-1.6-7.4-3.3-1L4.1 10z"/><path fill="#0d0f14" d="M8 11.5l2.6.8-.4 1.3-2.4-.6zM16 11.5l-2.6.8.4 1.3 2.4-.6z"/>',
  geometric: '<path d="M12 1.8 19.5 8 12 22.2 4.5 8z"/><path fill="#0d0f14" opacity=".35" d="M12 1.8 4.5 8h15z"/>',
  fairy: '<path d="M12 10c-3.1-6.4-9.5-6.3-9.5-.9S7.8 14.2 12 12c4.2 2.2 9.5 2.5 9.5-2.9S15.1 3.6 12 10z"/><circle cx="12" cy="16.2" r="3.2"/>',
  unknown: '<circle cx="12" cy="12" r="9.5" opacity=".35"/><path d="M9.2 9.3c0-1.8 1.3-3 2.9-3s2.8 1.1 2.8 2.6c0 2.4-2.9 2.5-2.9 5.1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.4"/>',
};
const CROWN = '<svg class="en-crown" viewBox="0 0 24 12"><path d="M2 11 3.5 2l5 5L12 1l3.5 6 5-5L22 11z"/></svg>';
function artHtml(F, cls = 'en-art') {
  if (F.portrait) return `<div class="${cls} has-img">${portraitImg(F.portrait, { hidden: F.hidden, cls: 'en-bg' })}</div>`;
  return `<div class="${cls}"><svg class="en-emblem" viewBox="0 0 24 24" aria-hidden="true">${EMBLEM[F.shape] ?? EMBLEM.monster}</svg></div>`;
}
function hpTrail(F, ctx, cls) {
  const to = F.hpUnknown ? 100 : clamp(Math.round(F.hp / Math.max(1, F.maxHp) * 100), 0, 100);
  const prev = ctx?.ui?.prevHp?.[F.name];
  const from = F.hpUnknown || prev == null ? to : prev;
  const label = F.hpUnknown ? '???' : F.showNums ? `${F.hp}/${F.maxHp}` : `${to}%`;
  return `<div class="${cls}"><div class="en-trail" style="width:${Math.max(from, to)}%" data-to="${to}"></div><div class="pk-hp-fill ${F.hpUnknown ? 'u' : hpCls(to)}" style="width:${from}%" data-to="${to}"></div><span>${h(label)}</span></div>`;
}
function chipsHtml(F) {
  return F.statuses.map(s => `<span class="pk-st st-${s.id}">${STATUS_SHORT[s.id] ?? STATUS[s.id]?.ko ?? s.id}${s.turns ? ` ${s.turns}` : ''}</span>`).join('')
    + Object.entries(F.stages ?? {}).filter(([, v]) => v).map(([k, v]) => `<span class="pk-stage ${v > 0 ? 'up' : 'down'}">${STAGE_SHORT[k] ?? k}${v > 0 ? '▲' : '▼'}${Math.abs(v)}</span>`).join('');
}
function fxLayer(F, ctx) {
  const fx = ctx?.ui?.fx?.[F.name];
  const pops = fx?.length ? `<div class="bt-fx-wrap">${fx.slice(0, 5).map((x, i) => `<span class="bt-fx ${x.cls}" style="animation-delay:${x.d ?? i * 0.18}s">${h(x.text)}</span>`).join('')}</div>` : '';
  const bursts = (ctx?.ui?.anim?.[F.name] ?? []).slice(0, 4).map(a => `<div class="pk-hitfx k-${a.k} ${a.super ? 'super' : ''}" style="--c:${a.c};--d:${a.d}s"></div>`).join('');
  const firstHit = fx?.find(x => ['dmg', 'crit', 'super', 'ko'].includes(x.cls));
  return { html: bursts + pops, hit: firstHit ? `hit ${firstHit.cls === 'crit' || firstHit.cls === 'super' ? 'hard' : ''}` : '', hd: firstHit?.d ?? 0 };
}
function cardState(F, ctx) {
  const tgt = ctx?.ui?.targetable?.includes(F.name) ? 'tgt' : '';
  const sel = (tgt && ctx.ui.target === F.name) || (!ctx?.ui?.targetable && F.selected) ? 'sel' : '';
  const atkD = ctx?.ui?.atk?.[F.name];
  return { cls: `${F.down ? 'down' : ''} ${sel} ${tgt} ${atkD != null ? 'atk' : ''}`, style: atkD != null ? `--d:${atkD}s;` : '' };
}

export function enemyCard(F, ctx, { small = false } = {}) {
  const t = F.types[0]?.id ?? 'normal';
  const fx = fxLayer(F, ctx);
  const st = cardState(F, ctx);
  const state = F.out === 'yield' ? '항복' : F.out ? '이탈' : F.down ? '기절' : '';
  const intent = F.note && !F.down ? `<div class="en-intent ${F.noteCls ?? ''}" title="${h(F.noteTitle || F.note)}" data-act="pk:tip" data-v="${h(F.noteTitle || F.note)}">${h(F.note)}</div>` : '';
  const types = (F.types.length ? F.types : F.typeSystem === 'pokemon' ? [{ id: 'normal', label: '노말' }] : []).map(x => `<span class="pk-tdot t-${x.id}">${h(x.label)}</span>`).join('');
  const spPct = F.sp != null && F.maxSp > 0 ? clamp(Math.round(F.sp / Math.max(1, F.maxSp) * 100), 0, 100) : null;
  const spBar = spPct != null ? `<div class="en-sp" title="${h(F.spLabel ?? 'SP')} ${F.showNums ? `${F.sp}/${F.maxSp}` : `${spPct}%`}"><div style="width:${spPct}%"></div><span>${h(F.spLabel ?? 'SP')} ${F.showNums ? `${F.sp}/${F.maxSp}` : `${spPct}%`}</span></div>` : '';
  return `<div class="en-card ${small ? 'small' : ''} ${st.cls} ${fx.hit}" style="--tc:${TYPE_HEX[t] ?? '#6b6e78'};${st.style}--hd:${fx.hd}s" ${!F.down || fx.html ? `data-act="pk:pick" data-v="${h(F.name)}"` : ''}>
    ${intent}${F.threat === 'boss' ? CROWN : ''}
    ${artHtml(F)}
    <button class="en-i" data-act="pk:inspect" data-v="${h(F.name)}" title="상세">ⓘ</button>
    <div class="en-overlay">
      <div class="en-top"><span class="en-name">${h(F.name)}</span>${F.threat === 'elite' ? '<span class="en-elite">★</span>' : ''}<span class="en-tier">${h(F.tier || '')}</span></div>
      <div class="en-types">${types}</div>
      ${hpTrail(F, ctx, 'en-hp')}${spBar}
      ${state || F.statuses.length || Object.values(F.stages ?? {}).some(Boolean) ? `<div class="en-chips">${state ? `<span class="pk-st down">${state}</span>` : ''}${chipsHtml(F)}</div>` : ''}
    </div>${fx.html}</div>`;
}

export function allyCard(F, ctx) {
  const t = F.types[0]?.id ?? 'normal';
  const fx = fxLayer(F, ctx);
  const st = cardState(F, ctx);
  const state = F.out ? '이탈' : F.down ? '기절' : '';
  const sp = F.sp != null ? `<div class="al-sp"><div style="width:${clamp(Math.round(F.sp / Math.max(1, F.maxSp) * 100), 0, 100)}%"></div></div>` : '';
  return `<div class="al-card ${st.cls} ${fx.hit}" style="--tc:${TYPE_HEX[t] ?? '#6b6e78'};${st.style}--hd:${fx.hd}s" data-act="pk:pick" data-v="${h(F.name)}">
    ${artHtml(F, 'al-art')}
    <div class="al-body">
      <div class="en-top"><span class="en-name">${h(F.name)}</span>${F.row === 'back' ? '<span class="al-row">후열</span>' : ''}${F.note && !F.down && F.note !== '후열' ? `<span class="al-note">${h(F.note)}</span>` : ''}<span class="en-tier">${h(F.tier || '')}</span></div>
      ${hpTrail(F, ctx, 'en-hp')}${sp}
      ${state || F.statuses.length || Object.values(F.stages ?? {}).some(Boolean) ? `<div class="en-chips">${state ? `<span class="pk-st down">${state}</span>` : ''}${chipsHtml(F)}</div>` : ''}
    </div>${fx.html}</div>`;
}

/** Field = enemy rows (back above front) · message ticker · ally HUD strip. */
export function scene(V, ctx, { box = '' } = {}) {
  const foes = V.foes ?? [], allies = V.allies ?? [];
  const back = foes.filter(F => F.row === 'back'), front = foes.filter(F => F.row !== 'back');
  const row = (list, small) => (list.length ? `<div class="bf-row ${small ? 'back' : 'front'} n${Math.min(4, list.length)}">${list.map(F => enemyCard(F, ctx, { small })).join('')}</div>` : '');
  const shake = (ctx?.ui?.lastEvents ?? []).some(e => (e.t === 'hit' && (e.crit || e.eff === 'super')) || ['break', 'down', 'enrage'].includes(e.t));
  return `<div class="bf-field map-${V.map ?? 'field'} ${V.sceneCls ?? ''} ${shake ? 'shake' : ''}">
      ${V.place ? `<div class="bf-place">${h(V.place)}</div>` : ''}
      <div class="bf-foes">${balls(V.foeBalls)}${row(back, true)}${row(front, false)}</div>
    </div>${box}
    <div class="bf-allies">${balls(V.allyBalls)}${allies.map(F => allyCard(F, ctx)).join('')}</div>${V.banner ?? ''}`;
}

/** Skill details in the panel's own style (bottom sheet), from a skillCard() object. */
export function skillSheet(c) {
  if (!c) return '';
  const col = TYPE_HEX[c.type] ?? '#8a8c8a';
  const kind = KIND_NAME[c.kind] ?? c.kind ?? '';
  return `<div class="pk-inspect sk-sheet" data-act="pk:peek-close"><div class="pk-ins-box" style="--tc:${col}">
    <div class="pk-ins-head"><i class="sk-dot"></i><b>${h(c.name)}</b>${c.typeLabel ? `<span class="pk-tdot t-${c.type}">${h(c.typeLabel)}</span>` : ''}<small>${h(c.kindLabel ?? kind)}</small><button class="pk-ins-x" data-act="pk:peek-close">✕</button></div>
    <div class="sk-sheet-nums">${c.power != null ? `<span><small>위력</small><b>${c.power}</b></span>` : ''}<span><small>${h(c.spLabel ?? 'SP')}</small><b>${c.cost ?? 0}</b></span>${c.est != null ? `<span><small>예상</small><b>≈${c.est}%</b></span>` : ''}</div>
    ${c.lines?.length ? `<div class="sk-sheet-fx">${c.lines.map(l => `<span>${h(l)}</span>`).join('')}</div>` : ''}
    ${c.desc ? `<div class="sk-sheet-desc">${h(c.desc)}</div>` : ''}
    ${c.disabled && c.why ? `<div class="sk-sheet-why">${h(c.why)}</div>` : ''}
  </div></div>`;
}

/** items: [{ label, sub, meta, cls, disabled, act, v, page, target: [names] }] */
/** Short effect summary for a skill button (the card shows everything on long-press). */
export function fxLine(k, sys = 'world') {
  const c = skillCard(k, { sys });
  return c.lines.filter(l => !/^(선공|후공|재사용|\d+회 공격)/.test(l)).slice(0, 2).join(' · ');
}

/**
 * Menu grid. Items with `tags` are skill buttons in two lines: [type dot] name · cost badge / 2-4 small tags,
 * on a dark card with a type-coloured left bar. Items with `bar: true` are left out here (see barRow).
 * Indices stay those of the full list, so clicks map back to ui.menuItems.
 */
export function menuGrid(items, { cols = 2, main = false } = {}) {
  const btn = (it, i) => {
    if (it.tags) {
      const col = TYPE_HEX[it.type] ?? '#8a8c8a';
      const cost = it.over ? '<em class="sk-cost over">과로</em>' : it.cost ? `<em class="sk-cost">${h(it.cost)}</em>` : '<em class="sk-cost free">무료</em>';
      return `<button class="pk-btn sk ${it.over ? 'over' : ''}" style="--tc:${col}" data-act="pk:item" data-i="${i}" ${it.disabled ? 'disabled' : ''} title="${h(it.title ?? '')}">
        <span class="sk-l1"><i class="sk-dot"></i><b>${h(it.label)}</b>${cost}</span>
        <span class="sk-l2">${it.tags.slice(0, 4).map(t => `<span class="sk-tag ${t.cls ?? ''}">${h(t.text ?? t)}</span>`).join('')}${it.why ? `<span class="sk-tag why">${h(it.why)}</span>` : ''}</span>
        ${it.peek !== false ? `<span class="sk-info" data-act="pk:peekbtn" data-i="${i}" title="상세">ⓘ</span>` : ''}</button>`;
    }
    return `<button class="pk-btn ${it.cls ?? ''}" data-act="pk:item" data-i="${i}" ${it.disabled ? 'disabled' : ''}>
    <b>${h(it.label)}</b>${it.meta ? `<em>${h(it.meta)}</em>` : ''}${it.sub ? `<small>${h(it.sub)}</small>` : ''}${it.fx ? `<i class="pk-fx">${h(it.fx)}</i>` : ''}</button>`;
  };
  return `<div class="pk-menu c${cols} ${main ? 'main' : ''}">${items.map((it, i) => (it.bar ? '' : btn(it, i))).join('')}</div>`;
}

/** The fixed mini bar under the skills: basic attack / guard / rest | bag / party / run. */
export function barRow(items) {
  const bar = items.map((it, i) => [it, i]).filter(([it]) => it.bar);
  if (!bar.length) return '';
  return `<div class="pk-bar">${bar.map(([it, i]) => `${it.sep ? '<i class="pk-bar-sep"></i>' : ''}<button class="pk-bb ${it.icon ? 'ic' : ''} ${it.cls ?? ''}" data-act="pk:item" data-i="${i}" ${it.disabled ? 'disabled' : ''} title="${h(it.title ?? it.sub ?? '')}">${h(it.label)}</button>`).join('')}</div>`;
}

/** Two-line skill button data shared by the 1:1 and party menus. */
export function skillItem(k, { actor, b, sys, foe = null, cd = 0, used = false, target = null, act = 'm:skill' }) {
  const t = k.element && !['none', 'physical'].includes(k.element) ? typeIn(k.element, sys) : 'normal';
  const over = (k.cost ?? 0) > actor.sp;
  const tags = [];
  if (['physical', 'magic'].includes(k.kind)) tags.push({ text: `${k.kind === 'magic' ? '✦' : '⚔'}${k.power}${k.hits > 1 ? `×${k.hits}` : ''}` });
  else if (k.kind === 'heal') tags.push({ text: `✚${k.power}%` });
  else tags.push({ text: { buff: '▲강화', debuff: '▼방해', guard: k.protect ? '⛨막기' : '⛨방어', revive: '✚부활', cleanse: '❖정화' }[k.kind] ?? k.kind });
  if (k.priority > 0) tags.push({ text: '선공', cls: 'prio' });
  if (foe && ['physical', 'magic'].includes(k.kind)) {
    const mul = E.elementMul(foe, k.element, b).mul;
    if (mul === 0) tags.push({ text: '무효', cls: 'bad' });
    else {
      const est = Math.min(100, Math.round((E.estimate(b, actor, foe, k) / Math.max(1, foe.hp)) * 100));
      tags.push({ text: `≈${est}%`, cls: mul > 1.01 ? 'good' : mul < 0.99 ? 'weak' : '' });
      if (mul > 1.01) tags.push({ text: `×${mul}`, cls: 'good' }); else if (mul < 0.99) tags.push({ text: `×${mul}`, cls: 'weak' });
    }
  }
  const first = skillCard(k, { sys }).lines.find(l => !/^(선공|후공|재사용|\d+회 공격|적 전체|아군|자신|명중|HP \d+% 회복)/.test(l));
  if (first) tags.push({ text: first.length > 12 ? `${first.slice(0, 11)}…` : first, cls: 'fx' });
  const why = used ? '사용함' : cd ? `⏳${cd}` : '';
  const title = `${k.name}${k.desc ? ` — ${k.desc}` : ''}${over ? `\n⚠ 기력 부족 → 과로 (HP 소모·다음 턴 탈진)` : ''}`;
  return { label: k.name, type: t, cost: k.cost, over, tags, why, title, disabled: !!(cd || used), act, v: k.name, target };
}

/** After the HTML is in the page: slide HP bars from their old width to the new one. */
export function animateBars(root) {
  const bars = root?.querySelectorAll?.('.pk-hp-fill[data-to], .en-trail[data-to]') ?? [];
  if (!bars.length) return;
  // The fill drops at once; the pale trail behind it follows a moment later (CSS delay) — the "delayed drain".
  const go = () => bars.forEach(b => { b.style.width = `${b.dataset.to}%`; if (b.classList.contains('pk-hp-fill')) b.className = b.className.replace(/\b[gyr]\b/, hpCls(+b.dataset.to)); });
  (globalThis.requestAnimationFrame ?? (f => setTimeout(f, 16)))(() => (globalThis.requestAnimationFrame ?? (f => setTimeout(f, 16)))(go));
}

/** Detail sheet for one fighter: stats with stage multipliers, status, type matchups, known skills. */
export function inspectHtml(f, { b, profile, intel = 2, side, intent = '' }) {
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
  const cp = f.customPassive;
  const pstateEntries = Object.entries(f.pstate ?? {}).filter(([k]) => !k.startsWith('__'));
  const cpHtml = cp && cp.enabled && b?.customPassives !== false && (side !== 'enemy' || intel >= 1)
    ? `<div class="pk-passive"><b>✦ ${h(cp.name)}</b>${cp.desc ? ` <small>${h(cp.desc)}</small>` : ''}${pstateEntries.length ? `<div class="pk-pstate">${pstateEntries.map(([k, v]) => `<span>${h(k)}: <b>${h(String(v))}</b></span>`).join('')}</div>` : ''}</div>`
    : '';
  return `<div class="pk-inspect"><div class="pk-ins-box">
    <div class="pk-ins-head"><b>${h(f.name)}</b> <small>${h(f.tier ?? '')}</small> ${types.map(t => `<span class="bt-type t-${typeIn(t, sys)}">${h(typeName(t, sys))}</span>`).join('')}<button class="pk-ins-x" data-act="pk:inspect-close">✕</button></div>
    <div class="pk-ins-hp">${h(profile.hpLabel)} <b>${hp}</b>${f.maxSp > 0 && (side !== 'enemy' || !f.noSp) ? ` · ${h(profile.spLabel)} <b>${side !== 'enemy' || intel >= 2 ? `${f.sp} / ${f.maxSp}` : `${Math.round(f.sp / Math.max(1, f.maxSp) * 100)}%`}</b>` : ''}${f.row && b?.format !== 'singles' ? ` · ${f.row === 'back' ? '후열' : '전열'}` : ''}</div>
    ${intent ? `<div class="pk-ins-intent">다음 행동: ${h(intent)}</div>` : ''}
    ${cpHtml}
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

const SCALE_TEXT = {
  self: '자신 버프 수 비례 피해 (+12%/단계)',
  target: '적 디버프·상태이상 수 비례 피해 (+12%/개)',
  ally: '아군 전체 버프 수 비례 피해 (+8%/단계)',
};

/** Detailed human-readable mechanics lines for a skill (shared by combat cards & codex skill details). */
export function skillDetailLines(k, { verbose = false } = {}) {
  const lines = [];
  if (k.hits > 1) lines.push(`${k.hits}회 공격`);
  if (k.target === 'enemies') lines.push('적 전체');
  else if (k.target === 'allies') lines.push('아군 전체');
  else if (k.target === 'ally') lines.push('아군 1명');
  else if (k.target === 'self' && (verbose || (!['physical', 'magic'].includes(k.kind) && !Object.keys(k.stages ?? {}).length && k.kind !== 'heal'))) lines.push('대상: 자신');
  if (verbose && k.target === 'enemy') lines.push('대상: 적 1명');
  if (verbose && ['physical', 'magic'].includes(k.kind)) lines.push(`사거리: ${k.range === 'melee' ? '근접(전열)' : '원거리'}`);
  if (k.priority > 0) lines.push(`선공 +${k.priority}`); else if (k.priority < 0) lines.push(`후공 ${k.priority}`);
  if (k.acc && (verbose || k.acc !== 95)) lines.push(k.acc >= 100 ? '필중' : `명중 ${k.acc}%`);
  if (k.status) {
    const def = STATUS[k.status.id];
    const base = `${def?.ko ?? k.status.id}${k.status.chance < 100 ? ` ${k.status.chance}%` : ''}${k.status.turns ? ` (${k.status.turns}턴)` : ''}`;
    lines.push(verbose && def?.desc ? `${base} — ${def.desc}` : base);
  }
  for (const [s2, v2] of Object.entries(k.stages ?? {})) lines.push(`${k.kind === 'buff' && k.target === 'self' ? '자신' : k.kind === 'buff' ? '아군' : '대상'} ${STG[s2] ?? s2} ${v2 > 0 ? '▲' : '▼'}${Math.abs(v2)}`);
  for (const [s2, v2] of Object.entries(k.selfStages ?? {})) lines.push(`자신 ${STG[s2] ?? s2} ${v2 > 0 ? '▲' : '▼'}${Math.abs(v2)}`);
  if (k.kind === 'heal') lines.push(`HP ${k.power}% 회복`);
  if (k.selfHeal) lines.push(`자신 HP ${k.selfHeal}% 회복`);
  if (k.drain) lines.push(`피해 흡수 ${Math.round(k.drain * 100)}%`);
  if (k.crit) lines.push('급소율 상승');
  if (k.bonusIf) lines.push(bonusText(k.bonusIf));
  if (k.scaleStages && SCALE_TEXT[k.scaleStages]) lines.push(SCALE_TEXT[k.scaleStages]);
  if (k.recoil) lines.push(`반동 피해 ${Math.round(k.recoil * 100)}%`);
  if (k.hpCost) lines.push(`HP ${k.hpCost}% 소모`);
  if (k.protect) lines.push('이번 턴 공격 방어 (연속 사용 시 성공률 감소)');
  if (k.pivot) lines.push(verbose ? '쓴 뒤 교체 (1:1: 대기 동료와 교체 / 파티전: 후열 후퇴)' : '쓴 뒤 교체');
  if (k.move) lines.push(verbose ? (k.move === 'back' ? '쓴 뒤 후열로 이동 (파티전 전용)' : '쓴 뒤 전열로 이동 (파티전 전용)') : (k.move === 'back' ? '쓴 뒤 후열로' : '쓴 뒤 전열로'));
  if (k.pull) lines.push(verbose ? '후열 적을 전열로 끌어냄 (파티전 전용)' : '후열 적을 전열로 끌어냄');
  if (k.once) lines.push('전투당 1회');
  if (k.charge) lines.push('1턴 충전 후 발동');
  if (k.cooldown) lines.push(`재사용 ${k.cooldown}턴`);
  return lines;
}

export function skillCard(k, { sys = 'world', spLabel = 'SP', targets = null, disabled = false, why = '', act = 'm:skill', v = null, extra = [] } = {}) {
  const t = k.element && !['none', 'physical'].includes(k.element) ? typeIn(k.element, sys) : 'normal';
  const lines = [...skillDetailLines(k, { verbose: false }), ...extra];
  const fx = (k.status ? 1 : 0) + Object.keys(k.stages ?? {}).length + Object.keys(k.selfStages ?? {}).length + (k.selfHeal ? 1 : 0) + (k.drain ? 1 : 0) + (k.priority ? 1 : 0) + (k.bonusIf ? 1 : 0) + (k.scaleStages ? 1 : 0) + (k.pivot || k.protect ? 1 : 0);
  const rarity = k.basic ? 'paper' : k.cooldown >= 3 || k.power >= 110 || k.once ? 'art' : k.power >= 80 || fx >= 2 ? 'limited' : fx ? 'hard' : 'paper';
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
