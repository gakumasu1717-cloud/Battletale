// BattleTale party-combat engine. Pure functions over plain JSON state, so the
// same input + seed always gives the same result (swipes never reroll).
//
// Strategy layer (Slay the Spire / Darkest Dungeon style):
//  - enemies announce their next action ("intents") before the player commits
//  - big skills need a wind-up turn and can be broken by heavy damage or stuns
//  - front/back rows: melee only reaches the front line while it stands
//  - terrain, initiative (ambush) and intel (how much you know) come from the story
// Physical layer: optional timing grades for the player's attacks and defenses.
import { STATUS, DERIVED, derive, inferItem, elementId, stageKey, typeIn } from './catalog.js';
import { makeRng, clamp, clone, norm, pct, num } from './util.js';

const STAGE_MIN = -4, STAGE_MAX = 4;
const stageMul = (s = 0) => (s >= 0 ? (3 + s) / 3 : 3 / (3 - s));
const accMul = (s = 0) => (s >= 0 ? (3 + s) / 3 : 3 / (3 - s));
const DIFF_BASE = { trivial: 95, easy: 80, normal: 60, hard: 40, extreme: 20, impossible: 5 };
const DIFF_POWER = { trivial: 30, easy: 45, normal: 65, hard: 90, extreme: 130, impossible: 160 };
export const DIFF_KO = { trivial: '매우 쉬움', easy: '쉬움', normal: '보통', hard: '어려움', extreme: '매우 어려움', impossible: '불가능' };
export const GRADE_ATTACK = { perfect: 1.0, good: 1, miss: 0.75 };       // perfect also forces a critical
export const GRADE_DEFENSE = { perfect: 0, good: 0.6, miss: 1.1 };

/* ---------- Battle creation ---------- */
export function createBattle({ party = [], allies = [], enemies = [], profile, seed, place = '', flee = true, length = 1, title = '', terrain = [], initiative = 'normal', format = 'multi', aiLevel = 'hard', costScale = 1 }) {
  const fighters = [];
  const add = (sheet, side, persistent) => {
    const f = clone(sheet);
    f.side = side;
    f.persistent = !!persistent;
    f.derived = derive(f, profile);
    f.stages = {};
    f.cds = {};
    f.guard = false;
    f.down = f.hp <= 0;
    f.out = null;
    f.statuses = (f.statuses ?? []).filter(s => STATUS[s.id]);
    f.taunter = null;
    f.enraged = false;
    f.charging = null;
    f.staggered = false;
    f.row = f.row === 'back' ? 'back' : 'front';
    // Resource: rank-and-file enemies fight without one (free skills, cooldowns still apply);
    // the player's side and major enemies (elite/boss/registered) pay scaled costs.
    f.noSp = side === 'enemy' && !['elite', 'boss'].includes(f.threat) && !f.codexId;
    const scale = Math.max(0.25, Math.min(3, Number(costScale) || 1));
    f.skills = (f.skills ?? []).map(k => { const base = k.baseCost ?? k.cost ?? 0; return { ...k, baseCost: base, cost: f.noSp ? 0 : Math.round(base * scale) }; });
    f.intel = side === 'ally' ? 2 : (f.intel ?? 1);
    f.revealed = [];
    if (fighters.some(o => o.id === f.id)) f.id = `${f.id}_${fighters.length}`;
    fighters.push(f);
  };
  party.forEach(s => add(s, 'ally', true));
  allies.forEach(s => add(s, 'ally', false));
  enemies.forEach(s => add(s, 'enemy', false));
  disambiguate(fighters);
  // Singles: one fighter per side on the field, the rest wait on the bench.
  if (format === 'singles') for (const side of ['ally', 'enemy']) {
    let lead = false;
    for (const f of fighters.filter(x => x.side === side)) { if (!lead && !f.down) { lead = true; f.bench = false; } else f.bench = true; f.row = 'front'; }
  }
  // Nobody stands alone in the back row.
  for (const side of ['ally', 'enemy']) {
    const team = fighters.filter(f => f.side === side);
    if (team.length && !team.some(f => f.row === 'front')) team.sort((a, b) => b.derived.def - a.derived.def)[0].row = 'front';
  }

  const ref = list => {
    const xs = list.filter(f => f.maxHp > 0);
    const hp = xs.reduce((a, f) => a + f.maxHp, 0) / Math.max(1, xs.length);
    const st = xs.reduce((a, f) => a + avgDerived(f), 0) / Math.max(1, xs.length);
    return { hp, st };
  };
  const allyList = fighters.filter(f => f.side === 'ally');
  const basis = ref(allyList.length ? allyList : fighters);
  const hpPerStat = profile.hpPerStat ?? clamp(basis.hp / Math.max(1, basis.st), 2, 80);
  const b = {
    id: `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    seed: String(seed ?? Math.random()),
    turn: 1, status: 'active', title, place, flee: flee !== false, fleeTries: 0, aiLevel,
    scale: (hpPerStat / 3.5) * clamp(num(length, 1), 0.3, 3),
    refStat: Math.max(1, ref(fighters).st),
    initiative: ['player', 'enemy'].includes(initiative) ? initiative : 'normal',
    chart: profile.chart ?? null, stab: profile.stab ?? 1.2, typeSystem: profile.typeSystem ?? 'world',
    terrain: [],
    fighters,
    intents: {},
    format: format === 'singles' ? 'singles' : 'multi',
  };
  for (const t of (terrain ?? []).slice(0, 4)) applyTerrain(b, t);
  planIntents(b);
  return b;
}

function applyTerrain(b, t) {
  if (!t) return;
  const side = ['ally', 'enemy'].includes(t.side) ? t.side : 'all';
  const stages = {};
  for (const [k, v] of Object.entries(t.stages ?? {})) { const key = stageKey(k) ?? k; const n = clamp(Math.round(num(v)), -1, 1); if (n && (DERIVED.includes(key) || key === 'eva')) stages[key] = n; }
  for (const f of b.fighters) if (side === 'all' || f.side === side) for (const [k, v] of Object.entries(stages)) f.stages[k] = clamp((f.stages[k] ?? 0) + v, STAGE_MIN, STAGE_MAX);
  b.terrain.push({ side, stages, desc: String(t.desc ?? t.name ?? '').slice(0, 80) });
}

function disambiguate(fighters) {
  const counts = {};
  for (const f of fighters) counts[f.name] = (counts[f.name] ?? 0) + 1;
  const seen = {};
  for (const f of fighters) {
    if (counts[f.name] > 1) { seen[f.name] = (seen[f.name] ?? 0) + 1; f.name = `${f.name} ${String.fromCharCode(64 + seen[f.name])}`; }
  }
}

const avgDerived = f => ['pow', 'mag', 'def', 'res', 'spd'].reduce((a, k) => a + (f.derived?.[k] ?? 0), 0) / 5;
export const active = f => f && !f.down && !f.out;            // still in the fight (field or bench)
export const onField = f => active(f) && !f.bench;              // can act and be targeted
export const foesOf = (b, f) => b.fighters.filter(o => o.side !== f.side && onField(o));
export const alliesOf = (b, f) => b.fighters.filter(o => o.side === f.side && onField(o));
export const benchOf = (b, side) => b.fighters.filter(o => o.side === side && active(o) && o.bench);
const downedAllies = (b, f) => b.fighters.filter(o => o.side === f.side && o.down && !o.out);
export const byId = (b, id) => b.fighters.find(f => f.id === id);

export function findFighter(b, raw, { side = null, includeDown = false, bench = false } = {}) {
  if (!raw) return null;
  const k = norm(raw);
  const pool = b.fighters.filter(f => (!side || f.side === side) && (includeDown || (bench ? active(f) && f.bench : onField(f))));
  return pool.find(f => f.id === raw) ?? pool.find(f => norm(f.name) === k)
    ?? pool.find(f => norm(f.name).includes(k) || (k.length >= 2 && k.includes(norm(f.name)))) ?? null;
}

export function findSkill(f, raw) {
  if (!raw) return null;
  const k = norm(raw);
  return f.skills.find(s => norm(s.name) === k) ?? f.skills.find(s => norm(s.name).includes(k) || (k.length >= 2 && k.includes(norm(s.name)))) ?? null;
}

export const stat = (f, key) => {
  if (key === 'eva') return f.derived.spd * accMul(f.stages.eva ?? 0);
  const base = f.derived[key] ?? 1;
  return base * (key === 'acc' ? accMul(f.stages.acc ?? 0) : stageMul(f.stages[key] ?? 0));
};

export function basicAttack(f, name = '기본 공격') {
  const magic = (f.derived?.mag ?? 0) > (f.derived?.pow ?? 0) * 1.2;
  return { name, kind: magic ? 'magic' : 'physical', power: 40, target: 'enemy', hits: 1, acc: 95, element: magic ? 'none' : 'physical', status: null, stages: null, priority: 0, drain: 0, crit: 0, cooldown: 0, cost: 0, basic: true, range: magic ? 'ranged' : 'melee', charge: false };
}

/* ---------- Power estimate (honest threat label) ---------- */
export function sidePower(b, side) {
  return b.fighters.filter(f => f.side === side && active(f)).reduce((a, f) => a + Math.sqrt(f.hp) * Math.max(stat(f, 'pow'), stat(f, 'mag')) * (0.6 + 0.4 * stat(f, 'def') / b.refStat) * (f.actions ?? 1), 0);
}
export function threatOf(b) {
  const r = sidePower(b, 'enemy') / Math.max(1, sidePower(b, 'ally'));
  const level = r > 2.5 ? 'overwhelming' : r > 1.35 ? 'dangerous' : r > 0.75 ? 'even' : r > 0.35 ? 'favorable' : 'trivial';
  return { ratio: r, level };
}
export const THREAT_LABEL = { overwhelming: '압도적', dangerous: '위험', even: '대등', favorable: '우세', trivial: '쉬움' };

/* ---------- Damage math (scale-free) ---------- */
/** Type effectiveness: chart (attacker element × each defender element) × personal weak/resist/immune. */
/** Defending types. In the Pokémon rule set an untyped fighter is Normal. */
export function typesOf(f, sys) {
  const list = (f.elements?.length ? f.elements : [f.element]).map(x => x && typeIn(x, sys)).filter(x => x && !['none', 'physical'].includes(x));
  return list.length ? list : sys === 'pokemon' ? ['normal'] : [];
}

export function elementMul(target, element, b = null) {
  const sys = b?.typeSystem;
  let raw = elementId(element);
  // Pokémon rules: every move has a type; untyped moves are Normal.
  if (sys === 'pokemon' && (!raw || raw === 'none' || raw === 'physical')) raw = 'normal';
  if (!raw || raw === 'none' || raw === 'physical') return { mul: 1, eff: null };
  const e = typeIn(raw, sys);
  let mul = 1;
  const row = b?.chart?.[e];
  if (row) for (const d of typesOf(target, sys)) if (row[d] != null) mul *= row[d];
  if (sys !== 'pokemon') {
    // World rules only: per-character weaknesses written in the lore.
    if (target.immune?.includes(raw)) mul = 0;
    else { if (target.weak?.includes(e)) mul *= 1.5; if (target.resist?.includes(e)) mul *= 0.5; }
  }
  mul = clamp(mul, 0, 4);
  return { mul, eff: mul === 0 ? 'immune' : mul > 1.01 ? (mul >= 2 ? 'super' : 'weak') : mul < 0.99 ? 'resist' : null };
}
const stabOf = (b, a, skill) => {
  const sys = b?.typeSystem;
  let e = typeIn(elementId(skill.element), sys);
  if (sys === 'pokemon' && (!e || ['none', 'physical'].includes(e))) e = 'normal';
  if (!b?.stab || !e || ['none', 'physical'].includes(e)) return 1;
  return typesOf(a, sys).includes(e) ? b.stab : 1;
};

export function rawDamage(b, a, t, skill, { rand = 0.925, crit = false, aoe = false } = {}) {
  const magic = skill.kind === 'magic';
  const A = stat(a, magic ? 'mag' : 'pow');
  const D = stat(t, magic ? 'res' : 'def');
  let dmg = (skill.power / 100) * A * b.scale * Math.sqrt(clamp(A / Math.max(1, D), 0.05, 20));
  dmg *= elementMul(t, skill.element, b).mul * stabOf(b, a, skill);
  if (crit) dmg *= 1.5;
  dmg *= rand;
  if (t.guard) dmg *= 0.5;
  if (t.staggered) dmg *= 1.25;
  if (t.statuses.some(s => s.id === 'shield')) dmg *= STATUS.shield.dmgMul;
  if (a.statuses.some(s => s.id === 'fear')) dmg *= STATUS.fear.dmgOut;
  if (skill.range === 'melee' && a.row === 'back') dmg *= 0.6;
  if (aoe) dmg *= 0.75;
  return dmg;
}

export function hitChance(a, t, skill) {
  if (skill.acc >= 100 && !a.statuses.some(s => s.id === 'blind')) return 1;
  const ratio = stat(a, 'acc') / Math.max(1, stat(t, 'eva'));
  let p = (skill.acc / 100) * (1 + 0.15 * Math.log2(clamp(ratio, 0.05, 20)));
  if (a.statuses.some(s => s.id === 'blind')) p *= STATUS.blind.accMul;
  if (t.statuses.some(s => STATUS[s.id].skip) || t.charging || t.staggered) p = Math.max(p, 0.98);
  return clamp(p, 0.05, 1);
}

const critChance = (a, t, skill) => clamp(0.05 + 0.1 * clamp(Math.log2(Math.max(1, stat(a, 'luk')) / Math.max(1, stat(t, 'luk'))), -1, 1) + (skill.crit ?? 0), 0.02, 0.5);

export function estimate(b, a, t, skill) {
  if (!['physical', 'magic'].includes(skill.kind)) return 0;
  return rawDamage(b, a, t, skill, { aoe: skill.target === 'enemies' }) * skill.hits * hitChance(a, t, skill);
}

/* ---------- Targeting with rows ---------- */
export function reachable(b, f, skill) {
  const foes = foesOf(b, f);
  if (skill.range !== 'melee') return foes;
  const front = foes.filter(o => o.row === 'front');
  return front.length ? front : foes;
}

/* ---------- Intents ---------- */
/** Decide what every enemy (and guest ally) will do next turn. Enemies' intents are shown to the player. */
export function planIntents(b) {
  b.intents = {};
  if (b.status !== 'active') return;
  const rng = makeRng(`${b.seed}:intent:${b.turn}`);
  for (const f of b.fighters.filter(x => onField(x) && !x.persistent)) {
    if (b.turn === 1 && b.initiative === 'player' && f.side === 'enemy') { b.intents[f.id] = { type: 'surprised' }; continue; }
    if (f.staggered) { b.intents[f.id] = { type: 'stagger' }; continue; }
    if (f.charging) { b.intents[f.id] = { type: 'release', skill: f.charging.skill, target: f.charging.target }; continue; }
    const a = aiChoose(b, f, rng);
    const sk = a.type === 'skill' ? findSkill(f, a.skill) : null;
    b.intents[f.id] = sk?.charge ? { type: 'charge', skill: sk.name, target: a.target } : a;
  }
}

/* ---------- Turn resolution ---------- */
/**
 * commands: [{ actor, type: 'skill'|'attack'|'defend'|'item'|'flee'|'improvise'|'wait'|'scan'|'swap',
 *              skill, target, item, improv, grades?: ['perfect'|'good'|'miss'], defense?: {enemyId: grade} }]
 * Returns { battle, events, inventory }. Inputs are not mutated.
 */
export function resolveTurn(input, commands = [], { inventory = [], attackName = '기본 공격', ambush = false } = {}) {
  const b = clone(input);
  const inv = clone(inventory) ?? [];
  if (b.status !== 'active') return { battle: b, events: [], inventory: inv };
  const rng = makeRng(`${b.seed}:turn:${b.turn}${ambush ? ':ambush' : ''}`);
  // Singles: after a faint the player picks who comes out next; that costs no turn.
  if (b.needSwitch) {
    const c = (commands ?? []).find(x => x.type === 'switch');
    const pick = (c && findFighter(b, c.target, { side: 'ally', bench: true })) || benchOf(b, 'ally')[0];
    const ev0 = [];
    if (pick) { pick.bench = false; ev0.push({ t: 'sendout', who: pick.name, side: 'ally' }); }
    b.needSwitch = null;
    planIntents(b);
    return { battle: b, events: ev0, inventory: inv };
  }
  const ev = [{ t: 'turn', n: b.turn, ambush }];
  const cmds = clone(commands) ?? [];
  for (const c of cmds) { const f = byId(b, c.actor); if (f && c.defense) f.defense = c.defense; }

  // 1. One action per action-slot. Enemies follow their announced intents.
  const acts = [];
  for (const f of b.fighters.filter(onField)) {
    for (let k = 0; k < (f.actions ?? 1); k++) {
      let a;
      if (ambush && f.side === 'ally') a = { type: 'surprised' };
      else if (k === 0 && f.charging && !f.staggered) {
        // A charged move goes off this turn no matter who controls the fighter.
        const i = cmds.findIndex(c => c.actor === f.id);
        if (i >= 0) cmds.splice(i, 1);
        a = { type: 'release', skill: f.charging.skill, target: f.charging.target };
      } else if (f.persistent) {
        const i = cmds.findIndex(c => c.actor === f.id);
        if (i >= 0) a = cmds.splice(i, 1)[0];
        else if (f.isPlayer && k === 0 && commands.length) a = { type: 'defend', auto: true };
        else a = aiChoose(b, f, rng, attackName);
        // Player-side charge moves wind up first, exactly like the enemy's.
        if (a?.type === 'skill') { const sk = findSkill(f, a.skill); if (sk?.charge && sk.cost <= f.sp && !(f.cds[sk.name] > 0)) a = { ...a, type: 'charge' }; }
      } else if (k === 0 && b.intents?.[f.id]) a = { ...b.intents[f.id] };
      else a = aiChoose(b, f, rng, attackName);
      acts.push({ ...a, actor: f.id, slot: k });
    }
  }

  // 2. Order: guard > flee > priority > speed. Releases of charged moves go at normal speed.
  const prio = a => (a.type === 'switch' ? 11 : a.type === 'defend' || a.type === 'rest' ? 10 : a.type === 'flee' ? 9 : a.type === 'swap' ? 8 : a.type === 'item' ? 2 : ['surprised', 'stagger', 'charge'].includes(a.type) ? -9 : skillOf(byId(b, a.actor), a, attackName)?.priority ?? 0);
  const keyed = acts.map(a => ({ a, p: prio(a), s: stat(byId(b, a.actor), 'spd') * (a.slot ? 0.5 : 1), r: rng.next() }));
  keyed.sort((x, y) => y.p - x.p || y.s - x.s || y.r - x.r);

  // 3. Execute.
  for (const { a } of keyed) {
    if (b.status !== 'active') break;
    const f = byId(b, a.actor);
    if (!onField(f)) continue;
    act(b, f, a, rng, ev, inv, attackName);
    morale(b, rng, ev);
    checkEnd(b, ev);
  }

  // 4. End of turn upkeep.
  if (b.status === 'active') {
    for (const f of b.fighters.filter(onField)) upkeep(b, f, ev);
    // Benched fighters catch their breath too.
    for (const f of b.fighters.filter(x => x.bench && !x.down)) f.sp = Math.min(f.maxSp, f.sp + Math.round(f.maxSp * 0.05) + 1);
    checkEnd(b, ev);
  }
  if (b.status === 'active' && b.format === 'singles') replaceFainted(b, ev);
  for (const f of b.fighters) { f.guard = false; delete f.defense; if (f.stunnedThisTurn) delete f.stunnedThisTurn; }
  b.turn += 1;
  planIntents(b);
  return { battle: b, events: ev, inventory: inv };
}

function skillOf(f, a, attackName) {
  if (!f) return null;
  if (a.type === 'attack') return basicAttack(f, attackName);
  if (a.type === 'skill' || a.type === 'release') return findSkill(f, a.skill) ?? null;
  return null;
}

function act(b, f, a, rng, ev, inv, attackName) {
  if (a.type === 'switch') return actSwitch(b, f, a, ev);
  if (a.type === 'surprised') { ev.push({ t: 'surprised', who: f.name, side: f.side }); return; }
  if (a.type === 'stagger') { f.staggered = false; ev.push({ t: 'staggered', who: f.name }); return; }
  const skip = f.statuses.find(s => STATUS[s.id]?.skip);
  if (skip) { ev.push({ t: 'skip', who: f.name, status: skip.id }); if (f.charging) breakCharge(f, ev); return; }
  if (f.statuses.some(s => s.id === 'confuse') && !['defend', 'swap'].includes(a.type) && rng.chance(STATUS.confuse.selfHit)) {
    const dmg = Math.max(1, Math.round(rawDamage(b, f, f, basicAttack(f), { rand: 0.9 })));
    ev.push({ t: 'confused', who: f.name });
    applyDamage(b, f, f, dmg, ev, { label: '혼란' });
    return;
  }
  switch (a.type) {
    case 'rest': {
      const gain = Math.round(f.maxSp * 0.15);
      f.sp = Math.min(f.maxSp, f.sp + gain);
      ev.push({ t: 'rest', who: f.name, sp: gain });
      return;
    }
    case 'defend': {
      f.guard = true;
      const gain = Math.round(f.maxSp * 0.05);
      f.sp = Math.min(f.maxSp, f.sp + gain);
      ev.push({ t: 'defend', who: f.name, sp: gain, auto: !!a.auto });
      return;
    }
    case 'wait': ev.push({ t: 'wait', who: f.name, why: a.why ?? '' }); return;
    case 'swap': return swapRow(b, f, a, ev);
    case 'scan': return scan(b, f, a, rng, ev);
    case 'flee': return flee(b, f, rng, ev);
    case 'item': return useItem(b, f, a, rng, ev, inv);
    case 'improvise': return improvise(b, f, a, rng, ev);
    case 'charge': {
      const sk = findSkill(f, a.skill);
      if (!sk || sk.cost > f.sp) { return useSkill(b, f, basicAttack(f, attackName), a.target, rng, ev, a); }
      f.sp = Math.max(0, f.sp - sk.cost);
      f.charging = { skill: sk.name, target: a.target ?? null, threshold: Math.max(1, Math.round(f.maxHp * (f.threat === 'boss' ? 0.15 : 0.25))), taken: 0 };
      reveal(f, sk.name);
      ev.push({ t: 'charge', who: f.name, skill: sk.name });
      return;
    }
    case 'release': {
      const sk = findSkill(f, a.skill);
      f.charging = null;
      if (!sk) return;
      if (sk.cooldown) f.cds[sk.name] = sk.cooldown + 1;
      return useSkill(b, f, { ...sk, cost: 0 }, a.target, rng, ev, a, { released: true });
    }
    case 'attack': case 'skill': default: {
      let skill = skillOf(f, a.type === 'skill' ? a : { type: 'attack' }, attackName);
      let fallback = null;
      if (!skill) { fallback = 'unknown'; skill = basicAttack(f, attackName); }
      else if (skill.cost > f.sp) {
        // Overexertion (Temtem): the move still happens; the missing resource is paid in HP and the next turn is lost.
        const deficit = skill.cost - f.sp;
        const loss = Math.max(1, Math.round((deficit / Math.max(1, f.maxSp)) * f.maxHp * 0.5));
        f.sp = 0;
        ev.push({ t: 'overexert', who: f.name, skill: skill.name, dmg: Math.min(loss, f.hp) });
        applyDamage(b, f, f, loss, ev);
        if (!active(f)) return;
        addStatus(f, { id: 'exhausted', turns: 2 }, ev, f);
        skill = { ...skill, cost: 0 };
      }
      else if ((f.cds[skill.name] ?? 0) > 0) fallback = 'cooldown';
      else if (skill.kind === 'magic' && f.statuses.some(s => s.id === 'silence')) fallback = 'silence';
      if (fallback && !skill.basic) {
        ev.push({ t: 'fallback', who: f.name, skill: skill.name ?? a.skill, why: fallback });
        skill = basicAttack(f, attackName);
      } else if (fallback === 'unknown') ev.push({ t: 'fallback', who: f.name, skill: a.skill, why: 'unknown' });
      return useSkill(b, f, skill, a.target, rng, ev, a);
    }
  }
}

function actSwitch(b, f, a, ev) {
  const to = findFighter(b, a.target, { side: f.side, bench: true }) ?? benchOf(b, f.side)[0];
  if (!to) { ev.push({ t: 'wait', who: f.name }); return; }
  f.bench = true; f.stages = {}; f.charging = null; f.guard = false;
  to.bench = false;
  b.lastSwitch = { ...(b.lastSwitch ?? {}), [f.side]: b.turn };
  ev.push({ t: 'switch', who: f.name, to: to.name, side: f.side });
}

/** Singles: refill empty field slots at the end of the turn. */
function replaceFainted(b, ev) {
  for (const side of ['enemy', 'ally']) {
    if (b.fighters.some(f => f.side === side && onField(f))) continue;
    const bench = benchOf(b, side);
    if (!bench.length) continue;
    if (side === 'ally') { b.needSwitch = 'ally'; ev.push({ t: 'choose' }); continue; }
    // The opponent sends whoever fares best against the current foe.
    const foe = b.fighters.find(f => f.side === 'ally' && onField(f));
    const pick = foe ? bench.slice().sort((x, y) => sendScore(b, y, foe) - sendScore(b, x, foe))[0] : bench[0];
    pick.bench = false;
    ev.push({ t: 'sendout', who: pick.name, side });
  }
}
const sendScore = (b, f, foe) => Math.max(0, ...f.skills.filter(s => ['physical', 'magic'].includes(s.kind)).map(s => estimate(b, f, foe, s)), estimate(b, f, foe, basicAttack(f))) / Math.max(1, foe.hp) - Math.max(0, ...foe.skills.filter(s => ['physical', 'magic'].includes(s.kind)).map(s => estimate(b, foe, f, s))) / Math.max(1, f.hp);

function reveal(f, name) { if (f.side === 'enemy' && name && !f.revealed.includes(name)) f.revealed.push(name); }

function pickTargets(b, f, skill, wanted, rng, ev) {
  const friends = alliesOf(b, f);
  switch (skill.target) {
    case 'enemies': return reachable(b, f, skill);
    case 'allies': return skill.kind === 'revive' ? downedAllies(b, f) : friends;
    case 'self': return [f];
    case 'ally': {
      if (skill.kind === 'revive') {
        const want = findFighter(b, wanted, { side: f.side, includeDown: true });
        return [want?.down ? want : downedAllies(b, f)[0]].filter(Boolean);
      }
      const want = findFighter(b, wanted, { side: f.side });
      if (want) return [want];
      return [friends.slice().sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0]].filter(Boolean);
    }
    case 'enemy': default: {
      const pool = reachable(b, f, skill);
      if (f.taunter) { const t = byId(b, f.taunter); if (active(t) && pool.includes(t)) return [t]; }
      const want = findFighter(b, wanted, { side: f.side === 'ally' ? 'enemy' : 'ally' });
      if (want && pool.includes(want)) return [want];
      if (want && !pool.includes(want) && ev) ev.push({ t: 'blocked', who: f.name, target: want.name });
      if (!pool.length) return [];
      return [pool.slice().sort((x, y) => estimate(b, f, y, skill) / y.hp - estimate(b, f, x, skill) / x.hp || x.hp - y.hp)[0]];
    }
  }
}

function useSkill(b, f, skill, wanted, rng, ev, cmd = {}, { released = false } = {}) {
  const targets = pickTargets(b, f, skill, wanted, rng, ev);
  if (!released) f.sp = Math.max(0, f.sp - (skill.cost ?? 0));
  if (skill.cooldown && !released) f.cds[skill.name] = skill.cooldown + 1;
  if (!skill.basic) reveal(f, skill.name);
  ev.push({ t: 'use', who: f.name, side: f.side, skill: skill.name, kind: skill.kind, element: skill.element, basic: !!skill.basic, cost: skill.cost ?? 0, targets: targets.map(t => t.name), released, grade: cmd.grades?.[0] ?? null });
  if (!targets.length) { ev.push({ t: 'notarget', who: f.name }); return; }
  const aoe = ['enemies', 'allies'].includes(skill.target);
  try { targetsLoop(b, f, skill, targets, rng, ev, cmd, aoe); }
  finally {
    if (active(f) && skill.selfStages) applyStages(b, f, f, skill.selfStages, ev, { force: true });
    if (active(f) && skill.selfHeal) heal(f, Math.round(f.maxHp * skill.selfHeal / 100), ev);
  }
}

function targetsLoop(b, f, skill, targets, rng, ev, cmd, aoe) {

  for (const t of targets) {
    switch (skill.kind) {
      case 'physical': case 'magic': {
        let landed = 0;
        for (let h = 0; h < skill.hits && active(t); h++) {
          const grade = cmd.grades?.[h] ?? cmd.grades?.[0] ?? null;
          if (grade !== 'perfect' && !rng.chance(hitChance(f, t, skill))) { ev.push({ t: 'miss', who: f.name, target: t.name }); continue; }
          const crit = grade === 'perfect' || (grade !== 'miss' && rng.chance(critChance(f, t, skill)));
          const { eff } = elementMul(t, skill.element, b);
          let dmg = eff === 'immune' ? 0 : rawDamage(b, f, t, skill, { rand: rng.range(0.85, 1), crit, aoe: skill.target === 'enemies' }) * (GRADE_ATTACK[grade] ?? 1);
          // The target's own timing against this attacker.
          const dg = t.defense?.[f.id] ?? t.defense?.all ?? null;
          let guarded = null;
          if (dg && dmg > 0) {
            dmg *= GRADE_DEFENSE[dg] ?? 1;
            guarded = { perfect: 'parry', good: 'block', miss: 'flinch' }[dg];
          }
          dmg = guarded === 'parry' ? 0 : Math.max(1, Math.round(dmg));
          if (guarded === 'parry') {
            ev.push({ t: 'parry', who: t.name, attacker: f.name });
            const back = Math.max(1, Math.round(rawDamage(b, t, f, basicAttack(t), { rand: 0.9 }) * 0.6));
            applyDamage(b, t, f, back, ev, { label: '반격' });
            if (f.charging) breakCharge(f, ev);
            break;
          }
          applyDamage(b, f, t, dmg, ev, { crit, eff, guarded, grade });
          landed++;
          if (skill.drain && dmg) heal(f, Math.round(dmg * skill.drain), ev, { drain: true });
        }
        if (landed && active(t)) {
          if (skill.status && rng.chance(skill.status.chance / 100)) addStatus(t, skill.status, ev, f);
          if (skill.stages) applyStages(b, f, t, skill.stages, ev);
        } else if (landed && skill.stages) applyStages(b, f, t, skill.stages, ev, { selfOnly: true });
        break;
      }
      case 'heal': {
        const factor = clamp(0.75 + 0.2 * (stat(f, 'mag') / b.refStat), 0.7, 1.3);
        heal(t, Math.round(t.maxHp * (skill.power / 100) * factor), ev);
        if (skill.status) addStatus(t, skill.status, ev, f);
        break;
      }
      case 'revive': {
        if (!t.down) break;
        t.down = false;
        t.hp = Math.max(1, Math.round(t.maxHp * Math.max(10, skill.power) / 100));
        t.statuses = [];
        ev.push({ t: 'revive', who: t.name, hp: pct(t.hp, t.maxHp) });
        break;
      }
      case 'cleanse': {
        const bad = t.statuses.filter(s => !STATUS[s.id].good);
        t.statuses = t.statuses.filter(s => STATUS[s.id].good);
        for (const k of Object.keys(t.stages)) if (t.stages[k] < 0) delete t.stages[k];
        ev.push({ t: 'cleanse', who: t.name, removed: bad.map(s => s.id) });
        break;
      }
      case 'guard': {
        t.guard = true;
        ev.push({ t: 'defend', who: t.name, sp: 0 });
        if (skill.stages) applyStages(b, f, t, skill.stages, ev, { force: true });
        if (skill.status) addStatus(t, skill.status, ev, f);
        break;
      }
      case 'buff': {
        if (skill.stages) applyStages(b, f, t, skill.stages, ev, { force: true });
        if (skill.status) addStatus(t, skill.status, ev, f);
        if (!skill.stages && !skill.status) applyStages(b, f, t, { pow: 1, mag: 1 }, ev, { force: true });
        break;
      }
      case 'debuff': {
        if (t.side !== f.side && !rng.chance(hitChance(f, t, skill))) { ev.push({ t: 'miss', who: f.name, target: t.name }); break; }
        if (skill.stages) applyStages(b, f, t, skill.stages, ev, { force: true });
        if (skill.status && rng.chance(skill.status.chance / 100)) addStatus(t, skill.status, ev, f);
        else if (skill.status) ev.push({ t: 'resist', who: t.name, status: skill.status.id });
        if (skill.power > 0) applyDamage(b, f, t, Math.max(1, Math.round(rawDamage(b, f, t, { ...skill, kind: 'magic' }, { rand: rng.range(0.85, 1), aoe }))), ev, {});
        break;
      }
    }
  }
}

function breakCharge(f, ev) {
  if (!f.charging) return;
  ev.push({ t: 'break', who: f.name, skill: f.charging.skill });
  f.charging = null;
  f.staggered = true;
}

function applyDamage(b, src, t, dmg, ev, { crit = false, eff = null, label = null, guarded = null, grade = null } = {}) {
  const before = t.hp;
  t.hp = Math.max(0, t.hp - dmg);
  ev.push({ t: 'hit', who: src.name, target: t.name, dmg, crit, eff, from: pct(before, t.maxHp), to: pct(t.hp, t.maxHp), hp: t.hp, maxHp: t.maxHp, label, guarded, grade });
  if (dmg > 0) {
    const sl = t.statuses.findIndex(s => s.id === 'sleep');
    if (sl >= 0 && t.hp > 0) { t.statuses.splice(sl, 1); ev.push({ t: 'wake', who: t.name }); }
    if (t.charging && t.hp > 0 && src !== t) {
      t.charging.taken += dmg;
      if (t.charging.taken >= t.charging.threshold) breakCharge(t, ev);
    }
  }
  if (t.hp <= 0) { t.down = true; t.statuses = []; t.stages = {}; t.charging = null; ev.push({ t: 'down', who: t.name, side: t.side }); }
  else if (t.threat === 'boss' && !t.enraged && t.hp / t.maxHp <= 0.5) {
    t.enraged = true;
    t.stages.pow = clamp((t.stages.pow ?? 0) + 1, STAGE_MIN, STAGE_MAX);
    t.stages.mag = clamp((t.stages.mag ?? 0) + 1, STAGE_MIN, STAGE_MAX);
    ev.push({ t: 'enrage', who: t.name });
  }
}

function heal(t, amount, ev, { drain = false } = {}) {
  if (!active(t)) return;
  const before = t.hp;
  t.hp = Math.min(t.maxHp, t.hp + Math.max(0, amount));
  ev.push({ t: 'heal', who: t.name, amount: t.hp - before, from: pct(before, t.maxHp), to: pct(t.hp, t.maxHp), hp: t.hp, maxHp: t.maxHp, drain });
}

function addStatus(t, st, ev, src) {
  if (!active(t) || !STATUS[st.id]) return;
  const have = t.statuses.find(s => s.id === st.id);
  const turns = t.threat === 'boss' && STATUS[st.id].skip ? 1 : st.turns ?? STATUS[st.id].turns;
  if (have) have.turns = Math.max(have.turns, turns);
  else t.statuses.push({ id: st.id, turns });
  if (st.id === 'taunt' && src) t.taunter = src.id;
  ev.push({ t: 'status', who: t.name, status: st.id, turns });
  if (STATUS[st.id].skip && t.charging) breakCharge(t, ev);
}

function applyStages(b, src, t, stages, ev, { force = false, selfOnly = false } = {}) {
  for (const [rawKey, delta] of Object.entries(stages)) {
    const k = stageKey(rawKey) ?? rawKey;
    const who = force ? t : delta > 0 ? src : t;
    if (selfOnly && who !== src) continue;
    if (!active(who)) continue;
    const before = who.stages[k] ?? 0;
    who.stages[k] = clamp(before + delta, STAGE_MIN, STAGE_MAX);
    if (who.stages[k] !== before) ev.push({ t: 'stage', who: who.name, stat: k, delta: who.stages[k] - before });
  }
}

function swapRow(b, f, a, ev) {
  const other = a.target ? findFighter(b, a.target, { side: f.side }) : null;
  if (other && other !== f) { [f.row, other.row] = [other.row, f.row]; ev.push({ t: 'swap', who: f.name, with: other.name, row: f.row }); return; }
  f.row = f.row === 'front' ? 'back' : 'front';
  const team = b.fighters.filter(x => x.side === f.side && active(x));
  if (!team.some(x => x.row === 'front')) { f.row = 'front'; ev.push({ t: 'swap', who: f.name, row: 'front', forced: true }); return; }
  ev.push({ t: 'swap', who: f.name, row: f.row });
}

function scan(b, f, a, rng, ev) {
  const t = findFighter(b, a.target, { side: f.side === 'ally' ? 'enemy' : 'ally' }) ?? foesOf(b, f).find(x => x.intel < 2) ?? foesOf(b, f)[0];
  if (!t) return;
  const ratio = Math.max(stat(f, 'acc'), stat(f, 'mag')) / Math.max(1, (stat(t, 'luk') + stat(t, 'res')) / 2);
  const p = clamp(0.65 * (1 + 0.35 * Math.log2(clamp(ratio, 0.05, 20))), 0.15, 0.97);
  const roll = rng.next();
  const ok = roll < p;
  if (ok) { const before = t.intel; t.intel = Math.min(2, t.intel + (roll < p * 0.3 ? 2 : 1)); for (const s of t.skills) reveal(t, s.name); ev.push({ t: 'scan', who: f.name, target: t.name, ok, from: before, to: t.intel }); }
  else ev.push({ t: 'scan', who: f.name, target: t.name, ok });
}

function flee(b, f, rng, ev) {
  if (!b.flee) { ev.push({ t: 'flee', who: f.name, ok: false, blocked: true }); return; }
  const mine = alliesOf(b, f), theirs = foesOf(b, f);
  const ms = mine.reduce((a, x) => a + stat(x, 'spd'), 0) / Math.max(1, mine.length);
  const ts = Math.max(1, ...theirs.map(x => stat(x, 'spd')));
  let p = clamp(0.4 + 0.3 * Math.log2(ms / ts) + 0.12 * b.fleeTries, 0.08, 0.95);
  if (theirs.some(x => x.threat === 'boss')) p *= 0.5;
  b.fleeTries += 1;
  const ok = rng.chance(p);
  ev.push({ t: 'flee', who: f.name, ok, chance: Math.round(p * 100) });
  if (ok) { if (f.side === 'ally') b.status = 'fled'; else f.out = 'fled'; }
}

function useItem(b, f, a, rng, ev, inv) {
  const k = norm(a.item);
  let idx = inv.findIndex(i => norm(i.name) === k);
  if (idx < 0) idx = inv.findIndex(i => k && (norm(i.name).includes(k) || k.includes(norm(i.name))));
  const item = inv[idx];
  if (!item || item.count <= 0) { ev.push({ t: 'noitem', who: f.name, item: a.item }); return; }
  const spec = item.spec ?? inferItem(item.name);
  if (!spec) { ev.push({ t: 'noitem', who: f.name, item: item.name, unusable: true }); return; }
  item.count -= 1;
  if (item.count <= 0) inv.splice(idx, 1);
  ev.push({ t: 'item', who: f.name, item: item.name, kind: spec.kind });
  const friendly = ['heal', 'sp', 'full', 'cure', 'revive', 'buff'].includes(spec.kind);
  let target = friendly ? findFighter(b, a.target, { side: f.side, includeDown: spec.kind === 'revive' }) : findFighter(b, a.target, { side: f.side === 'ally' ? 'enemy' : 'ally' });
  if (!target) target = friendly ? (spec.kind === 'revive' ? downedAllies(b, f)[0] : f) : foesOf(b, f)[0];
  if (!target) return;
  switch (spec.kind) {
    case 'heal': heal(target, Math.round(target.maxHp * spec.amount / 100), ev); break;
    case 'full': heal(target, target.maxHp, ev); target.sp = target.maxSp; target.statuses = target.statuses.filter(s => STATUS[s.id].good); break;
    case 'sp': { const g = Math.round(target.maxSp * spec.amount / 100); target.sp = Math.min(target.maxSp, target.sp + g); ev.push({ t: 'sp', who: target.name, amount: g }); break; }
    case 'cure': target.statuses = target.statuses.filter(s => STATUS[s.id].good); ev.push({ t: 'cleanse', who: target.name, removed: [] }); break;
    case 'revive': if (target.down) { target.down = false; target.hp = Math.max(1, Math.round(target.maxHp * spec.amount / 100)); ev.push({ t: 'revive', who: target.name, hp: pct(target.hp, target.maxHp) }); } break;
    case 'buff': applyStages(b, f, target, spec.stages ?? { pow: spec.amount ?? 1, mag: spec.amount ?? 1 }, ev, { force: true }); break;
    case 'damage': {
      const list = spec.target === 'enemies' ? foesOf(b, f) : [target];
      for (const t of list) {
        const A = b.refStat, D = Math.max(1, (stat(t, 'def') + stat(t, 'res')) / 2);
        let dmg = ((spec.amount ?? 60) / 100) * A * b.scale * Math.sqrt(clamp(A / D, 0.05, 20)) * elementMul(t, spec.element ?? 'none', b).mul * rng.range(0.85, 1);
        if (list.length > 1) dmg *= 0.75;
        if (t.guard) dmg *= 0.5;
        applyDamage(b, f, t, Math.max(1, Math.round(dmg)), ev, {});
      }
      break;
    }
  }
}

/**
 * Free-form action ("throw sand", "drop the pillar on it", "talk it down").
 * The aux model proposes the mechanics; the engine bounds them and rolls.
 */
function improvise(b, f, a, rng, ev) {
  const im = a.improv ?? {};
  const effect = im.effect ?? {};
  const kind = String(effect.kind ?? 'none');
  const friendly = ['heal', 'buff', 'cleanse'].includes(kind);
  let diff = DIFF_BASE[im.difficulty] != null ? im.difficulty : 'normal';
  const target = friendly ? findFighter(b, a.target ?? effect.target, { side: f.side }) ?? f
    : ['escape', 'none', 'advantage'].includes(kind) ? null : findFighter(b, a.target ?? effect.target, { side: f.side === 'ally' ? 'enemy' : 'ally' }) ?? foesOf(b, f)[0];

  let blocked = null;
  if (kind === 'yield' && target) {
    const hpRate = target.hp / target.maxHp;
    if (target.threat === 'boss') { if (hpRate > 0.3) blocked = 'bossYield'; else diff = 'extreme'; }
    else if (target.threat === 'elite' && ['trivial', 'easy', 'normal'].includes(diff)) diff = 'hard';
    if (!blocked && hpRate > 0.75 && ['trivial', 'easy'].includes(diff)) diff = 'normal';
  }
  if (kind === 'escape' && !b.flee) diff = 'impossible';
  if (kind === 'instakill') blocked = 'instakill';

  const statKey = DERIVED.includes(im.stat) ? im.stat : 'pow';
  const vsKey = DERIVED.includes(im.vs) || im.vs === 'eva' ? im.vs : { pow: 'def', mag: 'res', spd: 'eva', acc: 'eva', def: 'pow', res: 'mag', luk: 'luk' }[statKey];
  const mine = stat(f, statKey);
  const theirs = target && target.side !== f.side ? stat(target, vsKey) : b.refStat;
  const ratio = clamp(mine / Math.max(1, theirs), 0.05, 20);
  const gradeBonus = { perfect: 15, good: 0, miss: -15 }[a.grades?.[0]] ?? 0;
  const chance = blocked ? 0 : clamp(Math.round(DIFF_BASE[diff] * (1 + 0.35 * Math.log2(ratio))) + gradeBonus, 3, 97);
  f.sp = Math.max(0, f.sp - Math.round(f.maxSp * 0.05));
  const roll = rng.d100();
  const crit = !blocked && roll <= Math.max(1, Math.floor(chance * 0.1));
  const ok = !blocked && roll <= chance;
  const fumble = !ok && roll >= 98;
  ev.push({ t: 'improv', who: f.name, desc: String(im.desc ?? '').slice(0, 160), difficulty: diff, chance, roll, result: crit ? 'crit' : ok ? 'success' : fumble ? 'fumble' : 'fail', blocked, target: target?.name ?? null, kind });
  if (fumble) { applyDamage(b, f, f, Math.max(1, Math.round(f.maxHp * 0.05)), ev, { label: '역효과' }); return; }
  if (!ok) return;

  const power = Math.min(num(effect.power, DIFF_POWER[diff] * 0.8), DIFF_POWER[diff]) * (crit ? 1.5 : 1);
  switch (kind) {
    case 'damage': {
      if (!target) break;
      const skill = { kind: statKey === 'mag' ? 'magic' : 'physical', power, element: elementId(effect.element ?? 'none'), hits: 1, range: 'ranged' };
      const dmg = Math.max(1, Math.round(rawDamage(b, f, target, skill, { rand: rng.range(0.9, 1) })));
      applyDamage(b, f, target, dmg, ev, { crit, eff: elementMul(target, skill.element, b).eff });
      if (effect.status) addStatus(target, { id: effect.status.id ?? effect.status, turns: (effect.status.turns ?? 2) + (crit ? 1 : 0) }, ev, f);
      break;
    }
    case 'status': case 'debuff': {
      if (!target) break;
      if (effect.status) addStatus(target, { id: effect.status.id ?? effect.status, turns: Math.min(3, (effect.status.turns ?? 2)) + (crit ? 1 : 0) }, ev, f);
      if (effect.stages) applyStages(b, f, target, capStages(effect.stages, crit ? 2 : 1, -1), ev, { force: true });
      if (!effect.status && !effect.stages) applyStages(b, f, target, { eva: -1 }, ev, { force: true });
      break;
    }
    case 'buff': case 'advantage': {
      const list = kind === 'advantage' ? alliesOf(b, f) : [target ?? f];
      for (const t of list) applyStages(b, f, t, capStages(effect.stages ?? { acc: 1 }, crit ? 2 : 1, 1), ev, { force: true });
      if (effect.status && ['shield', 'regen'].includes(effect.status.id ?? effect.status)) addStatus(target ?? f, { id: effect.status.id ?? effect.status, turns: 2 }, ev, f);
      break;
    }
    case 'heal': if (target) heal(target, Math.round(target.maxHp * Math.min(30, power / 3) / 100), ev); break;
    case 'cleanse': if (target) { target.statuses = target.statuses.filter(s => STATUS[s.id].good); ev.push({ t: 'cleanse', who: target.name, removed: [] }); } break;
    case 'yield': if (target) { target.out = 'yield'; ev.push({ t: 'yield', who: target.name }); } break;
    case 'escape': b.status = 'fled'; ev.push({ t: 'flee', who: f.name, ok: true, chance }); break;
    case 'interrupt': if (target?.charging) breakCharge(target, ev); break;
    default: break;
  }
}

function capStages(stages, cap, sign) {
  const out = {};
  for (const [k, v] of Object.entries(stages ?? {})) {
    const key = stageKey(k) ?? k;
    const n = clamp(Math.round(num(v)), -cap, cap);
    if (n && Math.sign(n) === sign) out[key] = n;
  }
  return Object.keys(out).length ? out : sign > 0 ? { acc: 1 } : { eva: -1 };
}

/** When the leader falls, rank-and-file may break and run. */
function morale(b, rng, ev) {
  const enemies = b.fighters.filter(f => f.side === 'enemy');
  const leaders = enemies.filter(f => ['boss', 'elite'].includes(f.threat));
  if (!leaders.length || leaders.some(active) || b.moraleBroken) return;
  const rest = enemies.filter(f => active(f) && f.threat === 'minion');
  if (!rest.length) return;
  b.moraleBroken = true;
  for (const f of rest) if (rng.chance(0.5)) { f.out = 'fled'; ev.push({ t: 'rout', who: f.name }); }
}

function upkeep(b, f, ev) {
  for (const s of [...f.statuses]) {
    const def = STATUS[s.id];
    const bossCut = f.threat === 'boss' ? 0.5 : 1;
    if (def.dot) {
      const dmg = Math.max(1, Math.round(f.maxHp * def.dot * bossCut));
      ev.push({ t: 'dot', who: f.name, status: s.id, dmg });
      applyDamage(b, f, f, dmg, ev, { label: def.ko });
      if (!active(f)) return;
    }
    if (def.hot) heal(f, Math.round(f.maxHp * def.hot), ev);
    s.turns -= 1;
    if (s.turns <= 0) {
      f.statuses.splice(f.statuses.indexOf(s), 1);
      if (s.id === 'taunt') f.taunter = null;
      ev.push({ t: 'expire', who: f.name, status: s.id });
    }
  }
  for (const k of Object.keys(f.cds)) { f.cds[k] -= 1; if (f.cds[k] <= 0) delete f.cds[k]; }
  f.sp = Math.min(f.maxSp, f.sp + Math.round(f.maxSp * 0.05) + 1);
}

function checkEnd(b, ev) {
  if (b.status !== 'active') { if (!ev.some(e => e.t === 'end')) ev.push({ t: 'end', result: b.status }); return; }
  const allies = b.fighters.filter(f => f.side === 'ally' && active(f));
  const enemies = b.fighters.filter(f => f.side === 'enemy' && active(f));
  if (!enemies.length) b.status = 'win';
  else if (!allies.length) b.status = 'lose';
  if (b.status !== 'active') ev.push({ t: 'end', result: b.status });
}

/* ---------- AI ---------- */
/**
 * Enemy (and AI ally) decision making.
 * Levels: normal = loose; hard (default) = focus fire, finish kills, set up when safe, play type matchups;
 * brutal = always the best option, swaps out of bad matchups, saves resources for kills.
 */
export function aiChoose(b, f, rng, attackName = '기본 공격') {
  const level = b.aiLevel ?? 'hard';
  const hard = level !== 'normal', brutal = level === 'brutal';
  const foes = foesOf(b, f), friends = alliesOf(b, f), downed = downedAllies(b, f);
  if (!foes.length) return { type: 'wait' };
  const options = [];
  const hpRate = x => x.hp / x.maxHp;
  // What allies already plan this turn (intents are planned in order).
  const planned = Object.entries(b.intents ?? {}).filter(([id]) => id !== f.id && byId(b, id)?.side === f.side).map(([, it]) => it);
  const incoming = t => planned.filter(it => it.target === t.id).reduce((a, it) => a + (it.est ?? 0), 0);
  // How dangerous each foe is to us: their best single hit on our side.
  const danger = t => {
    let top = estimate(b, t, f, basicAttack(t, attackName));
    for (const k of t.skills) if (['physical', 'magic'].includes(k.kind) && k.cost <= t.sp) top = Math.max(top, estimate(b, t, f, k));
    return top;
  };
  const dangers = new Map(foes.map(t => [t.id, danger(t)]));
  const maxDanger = Math.max(1, ...dangers.values());
  const dmgScore = (skill, t) => {
    const e = estimate(b, f, t, skill);
    if (e <= 0) return -50; // immune or useless
    const left = Math.max(1, t.hp);
    let sc = Math.min(1, e / left) * 100;
    if (e >= left) sc += 35;                                              // secure the kill
    else if (hard && e >= left * 0.5) sc += 10;
    if (t.charging) sc += 15;
    if (hard && incoming(t) > 0 && incoming(t) < t.hp && incoming(t) + e >= t.hp) sc += 30; // finish what an ally starts
    if (hard && incoming(t) >= t.hp) sc -= 60;                             // already dead this turn
    if (hard && skill.priority > 0 && e >= t.hp && stat(t, 'spd') > stat(f, 'spd')) sc += 25; // priority finisher
    return sc;
  };
  const best = skill => {
    const pool = reachable(b, f, skill);
    if (f.taunter && skill.target === 'enemy') { const t = byId(b, f.taunter); if (active(t) && pool.includes(t)) return { score: dmgScore(skill, t), target: t.id, est: estimate(b, f, t, skill) }; }
    if (skill.target === 'enemies') return { score: pool.reduce((a, t) => a + Math.max(0, dmgScore(skill, t)), 0) * 0.85, target: null, est: 0 };
    let top = { score: -999, target: null, est: 0 };
    for (const t of pool) { const sc = dmgScore(skill, t); if (sc > top.score) top = { score: sc, target: t.id, est: estimate(b, f, t, skill) }; }
    return top;
  };
  options.push({ type: 'attack', ...best(basicAttack(f, attackName)) });
  // Can any foe kill me within two of their turns?
  const threatened = foes.some(t => dangers.get(t.id) * 2 >= f.hp);
  for (const s of f.skills) {
    if (s.cost > f.sp || (f.cds[s.name] ?? 0) > 0) continue;
    if (s.kind === 'magic' && f.statuses.some(x => x.id === 'silence')) continue;
    let o = null;
    switch (s.kind) {
      case 'physical': case 'magic': {
        const r = best(s);
        let bonus = s.status ? (s.status.chance / 100) * (hard ? 18 : 12) : 0;
        if (f.side === 'enemy') bonus += 10; // enemies fight with their techniques, not just plain hits
        if (s.selfStages) bonus += Object.values(s.selfStages).reduce((a, v) => a + v, 0) * 4;
        if (s.charge) bonus -= hard ? 4 : 10;
        const costW = brutal && f.sp - s.cost < (f.skills.find(k => k.power >= 90)?.cost ?? 0) && r.score < 150 ? 30 : 15;
        o = { score: r.score + bonus - s.cost / Math.max(1, f.maxSp) * costW, target: r.target, est: r.est };
        break;
      }
      case 'heal': {
        const pool = s.target === 'self' ? [f] : friends;
        const worst = pool.slice().sort((x, y) => hpRate(x) - hpRate(y))[0];
        const line = hard ? 0.62 : 0.55;
        if (worst && hpRate(worst) < line) o = { score: (1 - hpRate(worst)) * (hard ? 140 : 120) + (worst.threat === 'boss' ? 20 : 0), target: worst.id };
        break;
      }
      case 'revive': if (downed.length) o = { score: 115, target: downed[0].id }; break;
      case 'cleanse': { const sick = friends.find(x => x.statuses.some(st => !STATUS[st.id].good)); if (sick) o = { score: hard ? 55 : 40, target: sick.id }; break; }
      case 'buff': case 'guard': {
        const t = s.target === 'self' ? f : (friends.slice().sort((x, y) => (y.derived?.pow ?? 0) - (x.derived?.pow ?? 0))[0] ?? f);
        const total = Object.values(t.stages ?? {}).reduce((a, v) => a + Math.max(0, v), 0);
        const already = s.stages ? Object.entries(s.stages).every(([k, v]) => (t.stages[k] ?? 0) >= (hard && s.target === 'allies' ? v : Math.min(4, v * 2))) : s.status ? t.statuses.some(x => x.id === s.status.id) : false;
        if (s.kind === 'guard') o = { score: hpRate(f) < 0.3 ? 30 : 4, target: f.id };
        else if (!already) {
          // Set up when nobody can punish it; stop stacking once strong.
          const safe = !threatened && hpRate(t) > 0.55;
          const team = s.target === 'allies' ? friends.filter(x => x.id !== f.id && active(x)).length + 1 : 1;
          const offense = Object.keys(s.stages ?? {}).some(k => ['pow', 'mag', 'spd'].includes(k));
          o = { score: hard
            ? (team >= 2 && offense && b.turn <= 3 ? 26 + team * 10 : safe ? (total >= 3 ? 12 : 58) : 10)
            : (b.turn <= 2 ? 34 : 16), target: t?.id };
        }
        break;
      }
      case 'debuff': {
        // Cripple the most dangerous foe that isn't already afflicted.
        const pool = foes.filter(x => !(s.status && x.statuses.some(st => st.id === s.status.id))).sort((x, y) => dangers.get(y.id) - dangers.get(x.id));
        const t = hard ? pool[0] : pool.find(() => true);
        if (t) o = { score: (hard ? 26 + (dangers.get(t.id) / maxDanger) * 12 : 22) + (s.status ? s.status.chance / 5 : 6), target: t.id };
        break;
      }
    }
    if (o) options.push({ type: 'skill', skill: s.name, ...o });
  }
  // Resource play: when the move that matters is just out of reach, take a breath instead of poking.
  {
    const basicScore = options[0]?.score ?? 0;
    let want = null;
    for (const k of f.skills) {
      if (!['physical', 'magic'].includes(k.kind) || k.cost <= f.sp || (f.cds[k.name] ?? 0) > 1) continue;
      const r = best(k);
      if (!want || r.score > want.score) want = { score: r.score, cost: k.cost };
    }
    const gain = Math.round(f.maxSp * 0.2) + 1;
    if (want && f.sp + gain >= want.cost && want.score > basicScore * (hard ? 1.5 : 2.2) && !(threatened && hpRate(f) < 0.4)) {
      options.push({ type: 'rest', score: Math.max(basicScore + 1, want.score * (hard ? 0.55 : 0.4)) });
    }
  }
  if (hpRate(f) < 0.25 && !options.some(o => o.score > 50)) options.push({ type: 'defend', score: 26 });
  if (f.row === 'back' && !options.some(o => o.score > 20) && f.skills.every(s => s.range === 'melee' || !['physical', 'magic'].includes(s.kind))) options.push({ type: 'swap', score: 22 });
  // Singles: switch out only of a clearly losing type matchup, rarely (never turn 1, once per 3 turns per side).
  if (b.format === 'singles' && hard && !f.trapped && b.turn > 1 && (b.turn - (b.lastSwitch?.[f.side] ?? -9)) >= 3 && hpRate(f) > 0.3) {
    const foe = foes[0];
    const typed = (a, d) => Math.max(0, ...[basicAttack(a, attackName), ...a.skills].filter(k => ['physical', 'magic'].includes(k.kind)).map(k => elementMul(d, k.element, b).mul));
    const myBest = typed(f, foe), theirBest = typed(foe, f);
    if (myBest <= 0.5 && theirBest >= 2) {
      const pick = benchOf(b, f.side).filter(m => m.hp / m.maxHp > 0.4)
        .map(m => ({ m, safe: typed(foe, m), hit: typed(m, foe) }))
        .filter(x => x.safe <= (brutal ? 1 : 0.5) && x.hit >= 1)
        .sort((x, y) => (y.hit - y.safe) - (x.hit - x.safe))[0];
      if (pick) options.push({ type: 'switch', target: pick.m.name, score: 999 });
    }
  }
  for (const o of options) {
    if (o.type !== 'skill') continue;
    const s = f.skills.find(x => x.name === o.skill);
    if (s && ['buff', 'debuff', 'heal', 'revive', 'cleanse'].includes(s.kind) && planned.some(it => it.skill === s.name)) o.score *= 0.2;
  }
  options.sort((x, y) => y.score - x.score);
  const sharp = brutal ? 1 : hard ? (f.threat === 'boss' || f.threat === 'elite' ? 0.95 : 0.85) : (f.threat === 'boss' || f.threat === 'elite' ? 0.8 : 0.55);
  const top = options[0];
  const near = options.filter(o => o.score >= top.score - Math.abs(top.score) * 0.3);
  const pick = rng.chance(sharp) || near.length < 2 ? top : rng.pick(near) ?? top;
  return pick;
}

/* ---------- Results ---------- */
export function rewardsOf(b) {
  if (b.status !== 'win') return { exp: 0 };
  const w = { minion: 0.5, normal: 1, elite: 2, boss: 4 };
  return { exp: b.fighters.filter(f => f.side === 'enemy').reduce((a, f) => a + (w[f.threat] ?? 1), 0) };
}

export function snapshot(b) {
  return b.fighters.map(f => ({ id: f.id, name: f.name, side: f.side, hp: f.hp, maxHp: f.maxHp, sp: f.sp, maxSp: f.maxSp, down: f.down, out: f.out, statuses: f.statuses.map(s => ({ ...s })), stages: { ...f.stages } }));
}
