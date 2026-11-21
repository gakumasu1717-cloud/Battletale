// Stealth as a turn-based grid puzzle (Hitman GO style).
// You move one tile at a time; guards walk fixed routes with visible vision cones.
// Judgment = reading routes and cones. Aggro = noise and suspicion. Luck = a little,
// at the edges (far edge of a cone, where a thrown stone lands, a sideways takedown).
// Being spotted at range gives a "?" warning first; a second sighting or a close one is "!" → battle.
import * as E from '../engine.js';
import { escapeHtml as h, clamp, norm, clone, num } from '../util.js';
import { splitBody, seededRng, aiLevelOf } from './shared.js';
import { vf, pixelSvg, shapeOf, TYPE_HEX, portraitImg } from '../pkui.js';
import { josa } from '../narrate.js';

const W = 7, H = 8;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const DIR_KO = { up: '위', down: '아래', left: '왼쪽', right: '오른쪽' };
const ARROW = { up: '▲', down: '▼', left: '◀', right: '▶' };
const DIR_WORDS = { up: ['up', '위', '↑', '북', '앞'], down: ['down', '아래', '↓', '남', '뒤'], left: ['left', '왼쪽', '←', '좌', '서'], right: ['right', '오른쪽', '→', '우', '동'] };

/*
 Map legend: # wall · . floor · c cover (crate/bush: hides you, blocks sight) · d dark floor (seen only up close)
             S start · G goal.  Guards: route = waypoints walked in a loop; face = rotation for posts.
*/
const MAPS = [
  { name: '창고 통로', rows: ['#..G..#', '#.#.#.#', '#.....#', '#c#.#c#', '#.....#', '#.c.c.#', '#.....#', '###S###'],
    guards: [{ route: [[1, 2], [5, 2]] }, { route: [[5, 4], [1, 4]] }, { post: [5, 6], face: ['left', 'up', 'left', 'down'] }, { post: [3, 0], face: ['down', 'left', 'down', 'right'] }] },
  { name: '어두운 회랑', rows: ['#G....#', '#.###.#', '#.#d#.#', '#..d..#', '#.#d#.#', '#.###.#', '#..c..#', '###S###'],
    guards: [{ route: [[2, 0], [5, 0]] }, { post: [5, 3], face: ['left', 'up', 'left', 'down'] }, { post: [3, 3], face: ['left', 'right', 'right'] }, { post: [1, 3], face: ['up', 'right', 'down', 'right'] }] },
  { name: '안뜰', rows: ['#.G...#', '#.....#', '#c.#.c#', '#..#..#', '#c...c#', '#..#..#', '#.....#', '#S....#'],
    guards: [{ route: [[1, 1], [5, 1]] }, { post: [3, 4], face: ['down', 'left', 'up', 'right'] }, { route: [[5, 6], [5, 3]] }, { route: [[1, 5], [2, 5]] }] },
  { name: '서고', rows: ['##..G.#', '#c...##', '#.##..#', '#....c#', '##.##.#', '#c....#', '#..#..#', '#..S..#'],
    guards: [{ route: [[2, 3], [4, 3]] }, { post: [5, 5], face: ['left', 'up'] }, { route: [[1, 1], [4, 1]] }, { post: [2, 6], face: ['up', 'right'] }] },
];

const me = st => st.b.fighters.find(f => f.side === 'ally' && f.isPlayer) ?? st.b.fighters.find(f => f.side === 'ally');
const guards = st => st.b.fighters.filter(f => f.side === 'enemy');
const placed = st => guards(st).filter(g => st.g[g.id]?.x != null);
const tile = (st, x, y) => (x < 0 || y < 0 || x >= W || y >= H ? '#' : st.map[y][x]);
const walkable = (st, x, y) => !'#'.includes(tile(st, x, y));
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const key = (x, y) => `${x},${y}`;
const guardAt = (st, x, y) => placed(st).find(g => st.g[g.id].x === x && st.g[g.id].y === y);
const dirTo = (from, to) => { const dx = to.x - from.x, dy = to.y - from.y; return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up'); };

function bfsStep(st, from, to, { avoidGuards = true } = {}) {
  if (from.x === to.x && from.y === to.y) return null;
  const q = [[from.x, from.y]], prev = new Map([[key(from.x, from.y), null]]);
  while (q.length) {
    const [x, y] = q.shift();
    if (x === to.x && y === to.y) break;
    for (const [dx, dy] of Object.values(DIRS)) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (prev.has(k) || !walkable(st, nx, ny)) continue;
      if (avoidGuards && guardAt(st, nx, ny) && !(nx === to.x && ny === to.y)) continue;
      prev.set(k, [x, y]); q.push([nx, ny]);
    }
  }
  if (!prev.has(key(to.x, to.y))) return null;
  let cur = [to.x, to.y], p = prev.get(key(...cur));
  while (p && !(p[0] === from.x && p[1] === from.y)) { cur = p; p = prev.get(key(...cur)); }
  return { x: cur[0], y: cur[1] };
}

/** Line of sight between two tiles: walls and cover block (the end tile itself never blocks). */
function los(st, a, b) {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  for (let i = 1; i < n; i++) {
    const x = Math.round(a.x + (b.x - a.x) * i / n), y = Math.round(a.y + (b.y - a.y) * i / n);
    if ('#c'.includes(tile(st, x, y))) return false;
  }
  return true;
}

function rangeOf(st) { return st.alert >= 50 ? 4 : 3; }

/** Tiles a guard can see right now, with their distance (k). */
function cone(st, g) {
  const s = st.g[g.id];
  if (!E.active(g) || s.x == null) return [];
  const [dx, dy] = DIRS[s.face];
  const px = -dy, py = dx;
  const out = [];
  const R = rangeOf(st);
  for (let k = 1; k <= R; k++) {
    // The beam stops at a wall or crate straight ahead: no peeking around pillars.
    if (k >= 2 && '#c'.includes(tile(st, s.x + dx * (k - 1), s.y + dy * (k - 1)))) break;
    const spread = k === 1 ? 0 : 1;
    for (let j = -spread; j <= spread; j++) {
      const x = s.x + dx * k + px * j, y = s.y + dy * k + py * j;
      if (!walkable(st, x, y) && tile(st, x, y) !== 'c') continue;
      if (tile(st, x, y) === '#') continue;
      if (!los(st, s, { x, y })) continue;
      if (tile(st, x, y) === 'd' && k > 1) continue;
      out.push({ x, y, k, edge: k === R });
    }
  }
  return out;
}

function nextWaypointStep(st, g) {
  const s = st.g[g.id];
  if (s.post) return null;
  const wp = s.route[s.wi];
  if (s.x === wp[0] && s.y === wp[1]) { s.wi = (s.wi + 1) % s.route.length; }
  const t = s.route[s.wi];
  return bfsStep(st, s, { x: t[0], y: t[1] });
}

/** Where a guard will be and face next turn (for the "next move" arrows). */
function predict(st, g) {
  const s = st.g[g.id];
  if (!E.active(g) || s.x == null) return null;
  if (s.state === 'chase' || s.state === 'check' || s.state === 'distract') return { face: s.face, step: s.target ? bfsStep(st, s, s.target) : null };
  if (s.post) return { face: s.faces[(s.fi + 1) % s.faces.length], step: null };
  const copy = { ...s };
  const wp = copy.route[copy.wi];
  let wi = copy.wi;
  if (copy.x === wp[0] && copy.y === wp[1]) wi = (wi + 1) % copy.route.length;
  const step = bfsStep(st, s, { x: copy.route[wi][0], y: copy.route[wi][1] });
  return { step, face: step ? dirTo(s, step) : s.face };
}

export default {
  id: 'stealth', ko: '잠입', icon: '🫥',

  create({ spec, profile, party, enemies, seed, settings }) {
    const b = E.createBattle({ party: party.slice(0, 1), enemies, profile, seed, place: spec.place, flee: true, length: Number(settings.length) || 1, aiLevel: aiLevelOf(settings), costScale: settings.spCostScale ?? 1.3, title: spec.title });
    const variant = /chase|추격|도주|pursu/i.test(spec.variant ?? '') ? 'chase' : 'sneak';
    const rng = seededRng(b.seed, 'map', 0);
    const T = MAPS[Math.floor(rng.next() * MAPS.length)];
    const flip = rng.next() < 0.5;
    const rows = T.rows.map(r => (flip ? [...r].reverse().join('') : r));
    const fx = x => (flip ? W - 1 - x : x);
    const st = {
      kind: 'stealth', variant, b, seed: b.seed, turn: 1, status: 'active', title: spec.title, place: spec.place, mapName: T.name,
      goal: String(spec.goal ?? (variant === 'chase' ? '출구까지 도망친다' : '들키지 않고 목표 지점에 도달한다')),
      map: rows, alert: clamp(num(spec.alert, 0), 0, 80), stones: clamp(num(spec.stones, 2), 0, 5), g: {}, bodies: [], spotted: 0, lost: 0,
    };
    const sy = rows.findIndex(r => r.includes('S'));
    st.p = { x: rows[sy].indexOf('S'), y: sy };
    st.start = { ...st.p };
    if (variant === 'chase') {
      // Start a few tiles in, the nearest walkable tile to the middle that you can reach.
      let best = null;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ('.cd'.includes(rows[y][x])) { const d = Math.abs(x - 3) + Math.abs(y - 4) * 1.2; if (!best || d < best.d) best = { x, y, d }; }
      if (best) st.p = { x: best.x, y: best.y };
    }
    const gl = rows.findIndex(r => r.includes('G'));
    st.goalAt = { x: rows[gl].indexOf('G'), y: gl };
    const gs = guards(st);
    gs.forEach((g, i) => {
      const slot = T.guards[i];
      if (!slot) { st.g[g.id] = { reserve: true, state: 'reserve' }; return; }
      if (variant === 'chase') {
        // Pursuers come up from the entrance, already hunting; you start further in.
        const spots = [[st.start.x, st.start.y], ...Object.values(DIRS).map(([dx, dy]) => [st.start.x + dx, st.start.y + dy])].filter(([x, y]) => walkable(st, x, y) && !(x === st.p.x && y === st.p.y));
        const spot = spots[i % Math.max(1, spots.length)] ?? [st.start.x, st.start.y];
        st.g[g.id] = { x: spot[0], y: spot[1], face: 'up', state: 'chase', target: { ...st.p }, route: [[spot[0], spot[1]]], wi: 0 };
        return;
      }
      if (slot.post) {
        const faces = slot.face.map(f => (flip && (f === 'left' || f === 'right') ? (f === 'left' ? 'right' : 'left') : f));
        st.g[g.id] = { x: fx(slot.post[0]), y: slot.post[1], home: { x: fx(slot.post[0]), y: slot.post[1] }, post: true, faces, fi: 0, face: faces[0], state: 'patrol' };
      } else {
        const route = slot.route.map(([x, y]) => [fx(x), y]);
        st.g[g.id] = { x: route[0][0], y: route[0][1], route, wi: 1 % route.length, face: dirTo({ x: route[0][0], y: route[0][1] }, { x: route[1 % route.length][0], y: route[1 % route.length][1] }), state: 'patrol' };
      }
    });
    return st;
  },

  resolve(st0, commands) {
    const st = clone(st0);
    if (st.status !== 'active') return { st, events: [] };
    const rng = seededRng(st.seed, 'stealth', st.turn);
    const P = me(st);
    const cmd = commands.find(c => c.actor === P.id) ?? commands[0] ?? { type: 'wait' };
    const ev = [{ t: 'turn', n: st.turn }];
    let transition = null;
    const detect = (why, initiative, who) => {
      ev.push({ t: 'detected', why, initiative, who });
      st.status = st.variant === 'chase' ? 'caught' : 'detected';
      return { mode: 'party', initiative, enemies: guards(st).filter(E.active).map(g => g.id) };
    };

    // ---------- 1. player ----------
    let moved = false, noise = null;
    if (cmd.type === 'fight') {
      transition = detect('fight', placed(st).filter(E.active).every(g => st.g[g.id].state === 'patrol') ? 'player' : 'normal');
    } else if (cmd.type === 'move' || cmd.type === 'run') {
      const [dx, dy] = DIRS[cmd.dir] ?? [0, 0];
      let steps = cmd.type === 'run' ? 2 : 1;
      if (cmd.type === 'run') {
        const cost = Math.max(1, Math.round(P.maxSp * 0.06));
        // Out of breath: the run doesn't happen at all (the turn still passes).
        if (P.sp < cost) { ev.push({ t: 'blocked', who: P.name, why: 'sp' }); steps = 0; }
        else P.sp -= cost;
      }
      for (let i = 0; i < steps; i++) {
        const nx = st.p.x + dx, ny = st.p.y + dy;
        if (!walkable(st, nx, ny) || guardAt(st, nx, ny)) break;
        st.p = { x: nx, y: ny }; moved = true;
      }
      if (steps) ev.push({ t: 'sact', who: P.name, action: cmd.type === 'run' ? 'dash' : 'sneak', target: DIR_KO[cmd.dir] ?? null });
      if (cmd.type === 'run' && moved) noise = { x: st.p.x, y: st.p.y, r: 2 };
    } else if (cmd.type === 'throw') {
      if (st.stones <= 0) ev.push({ t: 'blocked', who: P.name, why: 'stones' });
      else {
        st.stones -= 1;
        let at = { x: clamp(cmd.x, 0, W - 1), y: clamp(cmd.y, 0, H - 1) };
        const luk = E.stat(P, 'luk') / Math.max(1, st.b.refStat);
        const accurate = rng.next() < clamp(0.72 + 0.12 * Math.log2(Math.max(0.25, luk)), 0.45, 0.95);
        if (!accurate) {
          const opts = Object.values(DIRS).map(([dx, dy]) => ({ x: at.x + dx, y: at.y + dy })).filter(c => walkable(st, c.x, c.y));
          if (opts.length) at = opts[Math.floor(rng.next() * opts.length)];
        }
        ev.push({ t: 'sact', who: P.name, action: 'distract', desc: accurate ? null : '빗나감' });
        for (const g of placed(st).filter(E.active)) {
          const s = st.g[g.id];
          if (s.state === 'chase') continue;
          if (manhattan(s, at) <= 3) { s.state = 'distract'; s.target = at; s.timer = 3; s.face = dirTo(s, at); ev.push({ t: 'distract', target: g.name }); }
        }
        st.alert = clamp(st.alert + 4, 0, 100);
      }
    } else if (cmd.type === 'takedown') {
      const g = placed(st).filter(E.active).find(x => norm(x.name) === norm(cmd.target)) ?? adjacentGuards(st)[0];
      const s = g && st.g[g.id];
      if (!g || manhattan(s, st.p) !== 1) ev.push({ t: 'blocked', who: P.name, why: 'reach' });
      else {
        const side = facingSide(s, st.p);
        const base = { back: 0.95, side: 0.6, front: 0.12 }[side];
        const ratio = E.stat(P, 'spd') / Math.max(1, E.stat(g, 'spd'));
        const chance = clamp(base + 0.1 * Math.log2(clamp(ratio, 0.25, 4)) + (s.state === 'distract' ? 0.15 : 0), 0.05, 0.98);
        const ok = rng.next() < chance;
        ev.push({ t: 'takedown', who: P.name, target: g.name, ok, chance: Math.round(chance * 100), side });
        if (ok) { g.hp = 0; g.out = 'subdued'; st.bodies.push({ x: s.x, y: s.y, id: g.id, found: false }); s.state = 'down'; st.alert = clamp(st.alert + 6, 0, 100); }
        else transition = detect('spotted', 'enemy', g.name);
      }
    } else {
      // wait / hide
      ev.push({ t: 'sact', who: P.name, action: 'hide' });
      st.alert = clamp(st.alert - 4, 0, 100);
    }

    if (!transition && st.p.x === st.goalAt.x && st.p.y === st.goalAt.y) {
      st.status = 'success';
      ev.push({ t: 'end', result: 'success' });
    }

    // Stepping into a cone you could see is on you.
    if (!transition && st.status === 'active' && moved) transition = sight(st, ev, rng, detect, 'move');

    // ---------- 2. noise ----------
    if (!transition && st.status === 'active' && noise) {
      for (const g of placed(st).filter(E.active)) {
        const s = st.g[g.id];
        if (s.state === 'chase') continue;
        if (manhattan(s, noise) <= noise.r) { s.state = 'check'; s.target = { x: noise.x, y: noise.y }; s.timer = 3; s.face = dirTo(s, noise); ev.push({ t: 'suspicious', who: g.name, why: 'noise' }); }
      }
      st.alert = clamp(st.alert + 8, 0, 100);
    }

    // ---------- 3. guards ----------
    if (!transition && st.status === 'active') {
      for (const g of placed(st).filter(E.active)) moveGuard(st, g, ev);
      transition = caughtCheck(st, ev, detect) ?? sight(st, ev, rng, detect, 'guard');
      if (!transition) bodiesCheck(st, ev);
      if (!transition && st.alert >= 100) transition = detect('alarm', 'enemy');
    }

    if (!transition && st.status === 'active' && st.variant === 'chase') {
      const seen = placed(st).some(g => E.active(g) && cone(st, g).some(c => c.x === st.p.x && c.y === st.p.y));
      st.lost = seen ? 0 : st.lost + 1;
      for (const g of placed(st).filter(E.active)) if (seen) st.g[g.id].target = { ...st.p };
    }

    if (!transition && st.status === 'active' && st.turn >= 40) transition = detect('alarm', 'enemy');
    st.turn += 1;
    st.b.turn = st.turn;
    return { st, events: ev, transition };
  },

  controlled: st => [me(st)],

  quick(body, st) {
    const { what, target } = splitBody(body);
    const P = me(st);
    const t = norm(what);
    const dir = Object.keys(DIR_WORDS).find(d => DIR_WORDS[d].some(w => t.includes(norm(w)) || what.includes(w)));
    if (/^(달리기|달린다|run|dash|질주)/i.test(what) && dir) return { actor: P.id, type: 'run', dir };
    if (/^(이동|move|걷기|간다)/i.test(what) && dir) return { actor: P.id, type: 'move', dir };
    const thr = /(던지기|던진다|throw)\s*(\d)\s*[,\s]\s*(\d)/i.exec(what);
    if (thr) return { actor: P.id, type: 'throw', x: Number(thr[2]), y: Number(thr[3]) };
    if (/^(제압|takedown|암살)/i.test(what)) return { actor: P.id, type: 'takedown', target: target ?? what.replace(/^(제압|takedown|암살)\s*/i, '') };
    if (/^(전투|정면|fight)/i.test(what)) return { actor: P.id, type: 'fight' };
    if (/^(대기|숨기|숨는다|wait|hide)/i.test(what)) return { actor: P.id, type: 'wait' };
    if (dir) return { actor: P.id, type: 'move', dir };
    return null;
  },

  local(text, st) {
    const c = this.quick(String(text ?? ''), st);
    return c ? [c] : [];
  },

  auxSchema(st) {
    const P = me(st);
    return `## Stealth grid puzzle
Goal: ${st.goal}
{"actor": "${P.name}", "type": "move|run|wait|throw|takedown|fight", "dir": "up|down|left|right", "x": 0, "y": 0, "target": "<guard>"}
move = one tile, run = two tiles (noisy), wait = stay hidden, throw = stone to tile x,y, takedown = adjacent guard.`;
  },

  mapAux(actions, st) {
    const a = (Array.isArray(actions) ? actions : [])[0];
    if (!a) return [];
    const type = String(a.type ?? '').toLowerCase();
    if (!['move', 'run', 'wait', 'throw', 'takedown', 'fight'].includes(type)) return [];
    return [{ actor: me(st).id, type, dir: a.dir, x: num(a.x, 0), y: num(a.y, 0), target: a.target ?? null }];
  },

  status(st, profile, { lang = 'en' } = {}) {
    const ko = lang === 'ko', P = me(st);
    const left = manhattan(st.p, st.goalAt);
    const lines = [ko ? `[${st.variant === 'chase' ? '도주' : '잠입'} · ${st.mapName}] 목표: ${st.goal}` : `[${st.variant === 'chase' ? 'Escape' : 'Infiltration'} · ${st.mapName}] Goal: ${st.goal}`,
      `- ${P.name}: ${profile.hpLabel} ${P.hp}/${P.maxHp}, ${profile.spLabel} ${P.sp}/${P.maxSp}`,
      ko ? `- 목표까지 ${left}칸 · 경계도 ${Math.round(st.alert)}/100 · 돌 ${st.stones}개` : `- ${left} tiles from the goal · Alert ${Math.round(st.alert)}/100 · ${st.stones} stones left`];
    for (const g of guards(st)) {
      const s = st.g[g.id];
      const what = !E.active(g) ? (ko ? '제압됨' : 'subdued') : s.reserve ? (ko ? '다른 구역' : 'elsewhere') : (ko ? { patrol: '순찰', check: '수상한 소리 확인', distract: '돌 소리 쪽으로', chase: '추격 중' } : { patrol: 'patrolling', check: 'checking a noise', distract: 'drawn to a sound', chase: 'chasing' })[s.state] ?? s.state;
      lines.push(`- ${g.name}${g.tier ? ` [${g.tier}]` : ''}: ${what}`);
    }
    return lines.join('\n');
  },

  nextHint: () => '',
  timingPlan: () => [],
  applyGrades: cmd => cmd,
  autoGrades: () => [],
  results: st => { const P = me(st); return [{ id: P.id, hp: P.hp, sp: P.sp, down: P.hp <= 0 }]; },
  enemiesOf: st => guards(st),
  threat: st => E.threatOf(st.b),

  view(st, profile, ctx0) {
    const ctx = { ...ctx0, ui: ctx0?.ui ?? {} };
    const P = me(st), sys = st.b.typeSystem;
    return {
      foes: [], allies: [], custom: board(st, profile, ctx),
      intro: [st.variant === 'chase' ? '추격자가 바짝 쫓아온다! 출구까지 도망쳐야 한다.' : `${st.mapName}. 경비의 시선(빨간 칸)을 피해 🚩까지 가자.`],
      idle: ctx.ui.pzMode === 'throw' ? '돌을 던질 칸을 누르세요 (3칸 이내)' : ctx.ui.pzMode === 'run' ? '두 칸 달릴 방향의 칸을 누르세요 (시끄러움!)' : `칸을 눌러 이동 · ${josa(P.name, '은', '는')} 어떻게 할까?`,
      _sys: sys,
    };
  },

  menu(st, page, ctx0) {
    const ctx = { ...ctx0, ui: ctx0?.ui ?? {} };
    const P = me(st);
    const adj = adjacentGuards(st).filter(g => facingSide(st.g[g.id], st.p) !== 'front');
    const runCost = Math.max(1, Math.round(P.maxSp * 0.06));
    const m = ctx.ui.pzMode;
    return [
      { mini: true, label: '🚶 이동', sub: '칸을 눌러 한 칸', cls: !m ? 'm-party on' : 'plain', act: 'pk:uiset', k: 'pzMode', v: null },
      { mini: true, label: '🏃 달리기', sub: `2칸·소음·${ctx.spLabel ?? 'SP'}${runCost}`, cls: m === 'run' ? 'm-fight on' : 'plain', act: 'pk:uiset', k: 'pzMode', v: 'run', disabled: P.sp < runCost },
      { mini: true, label: `🪨 유인 ×${st.stones}`, sub: '3칸 안 경비 끌기', cls: m === 'throw' ? 'm-bag on' : 'plain', act: 'pk:uiset', k: 'pzMode', v: 'throw', disabled: st.stones <= 0 || st.variant === 'chase' },
      adj.length ? { mini: true, label: '🗡 제압', sub: adj.map(g => `${g.name}(${facingSide(st.g[g.id], st.p) === 'back' ? '뒤' : '옆'})`).join(','), cls: 'm-party', act: 'm:takedown', v: adj[0].name, target: adj.length > 1 ? adj.map(g => g.name) : null }
        : { mini: true, label: '🗡 제압', sub: '옆·뒤에서만', cls: 'plain', disabled: true },
      { mini: true, label: '🫥 대기', sub: '엄폐 중이면 안 보임', cls: 'plain', act: 'm:wait' },
      { mini: true, label: '⚔️ 돌파', sub: '전투로 전환', cls: 'm-run', act: 'm:fight' },
    ];
  },

  onAct(act, v, st, ctx) {
    const P = me(st);
    const mode = ctx.ui.pzMode;
    switch (act) {
      case 'm:tile': {
        const [x, y] = String(v).split(',').map(Number);
        if (mode === 'throw') { ctx.ui.pzMode = null; return { body: `던지기 ${x},${y}`, cmd: { actor: P.id, type: 'throw', x, y } }; }
        const dx = x - st.p.x, dy = y - st.p.y;
        const dir = dx === 0 && dy < 0 ? 'up' : dx === 0 && dy > 0 ? 'down' : dy === 0 && dx < 0 ? 'left' : dy === 0 && dx > 0 ? 'right' : null;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (!dir) return null;
        if (dist === 2 || mode === 'run') { ctx.ui.pzMode = null; return { body: `달리기 ${DIR_KO[dir]}`, cmd: { actor: P.id, type: 'run', dir } }; }
        if (dist === 1) return { body: `이동 ${DIR_KO[dir]}`, cmd: { actor: P.id, type: 'move', dir } };
        return null;
      }
      case 'm:wait': return { body: '대기', cmd: { actor: P.id, type: 'wait' } };
      case 'm:takedown': { const t = ctx.ui.target && adjacentGuards(st).some(g => g.name === ctx.ui.target) ? ctx.ui.target : v; return { body: `제압 → ${t}`, cmd: { actor: P.id, type: 'takedown', target: t } }; }
      case 'm:fight': return { body: '전투', cmd: { actor: P.id, type: 'fight' } };
      default: return null;
    }
  },
};

/* ---------- guard logic ---------- */
function bfsFar(st, from, minDist) {
  // A walkable tile at least minDist away, preferring "behind" (larger y) the player.
  let best = null;
  for (let y = H - 1; y >= 0; y--) for (let x = 0; x < W; x++) {
    if (!walkable(st, x, y) || tile(st, x, y) === 'G') continue;
    const d = Math.abs(x - from.x) + Math.abs(y - from.y);
    if (d >= minDist && d <= minDist + 1 && (!best || y > best[1])) best = [x, y];
  }
  return best;
}

function adjacentGuards(st) {
  return placed(st).filter(g => E.active(g) && manhattan(st.g[g.id], st.p) === 1);
}

function facingSide(s, p) {
  const [dx, dy] = DIRS[s.face];
  const vx = p.x - s.x, vy = p.y - s.y;
  const dot = dx * vx + dy * vy;
  return dot > 0 ? 'front' : dot < 0 ? 'back' : 'side';
}

function moveGuard(st, g, ev) {
  const s = st.g[g.id];
  if (s.state === 'chase') {
    const step = bfsStep(st, s, s.target ?? st.p);
    if (step && !(step.x === st.p.x && step.y === st.p.y)) { s.face = dirTo(s, step); s.x = step.x; s.y = step.y; }
    else if (step) s.face = dirTo(s, step);
    if (s.target && s.x === s.target.x && s.y === s.target.y && st.lost >= 2) {
      // Lost the trail: look around.
      s.face = ['up', 'left', 'down', 'right'][st.turn % 4];
    }
    return;
  }
  if (s.state === 'check' || s.state === 'distract') {
    s.timer = (s.timer ?? 3) - 1;
    const step = s.target ? bfsStep(st, s, s.target) : null;
    if (step && !(step.x === st.p.x && step.y === st.p.y)) { s.face = dirTo(s, step); s.x = step.x; s.y = step.y; }
    else if (!step) s.face = ['up', 'right', 'down', 'left'][(st.turn + g.id.length) % 4];
    if (s.timer <= 0) { s.state = 'patrol'; s.target = null; ev.push({ t: 'calm', who: g.name }); }
    return;
  }
  if (s.post) {
    if (s.home && (s.x !== s.home.x || s.y !== s.home.y)) { const st2 = bfsStep(st, s, s.home); if (st2 && !(st2.x === st.p.x && st2.y === st.p.y)) { s.face = dirTo(s, st2); s.x = st2.x; s.y = st2.y; } return; }
    s.fi = (s.fi + 1) % s.faces.length; s.face = s.faces[s.fi]; return;
  }
  const step = nextWaypointStep(st, g);
  if (step && !(step.x === st.p.x && step.y === st.p.y)) { s.face = dirTo(s, step); s.x = step.x; s.y = step.y; }
  else if (step) s.face = dirTo(s, step);
}

function caughtCheck(st, ev, detect) {
  if (st.variant !== 'chase') {
    // Walking into you face-first.
    for (const g of placed(st).filter(E.active)) {
      const s = st.g[g.id];
      if (manhattan(s, st.p) === 1 && facingSide(s, st.p) === 'front' && tile(st, st.p.x, st.p.y) !== 'c') return detect('spotted', 'enemy', g.name);
    }
    return null;
  }
  for (const g of placed(st).filter(E.active)) if (manhattan(st.g[g.id], st.p) <= 1) return detect('caught', 'enemy', g.name);
  return null;
}

function sight(st, ev, rng, detect, when) {
  for (const g of placed(st).filter(E.active)) {
    const s = st.g[g.id];
    const c = cone(st, g).find(t => t.x === st.p.x && t.y === st.p.y);
    if (!c) continue;
    if (tile(st, st.p.x, st.p.y) === 'c' && c.k > 1) continue; // hidden in cover
    if (st.variant === 'chase') { s.target = { ...st.p }; continue; }
    if (c.edge && s.state === 'patrol') {
      // Far edge of the cone: a bit of luck decides whether they register it.
      const P = me(st);
      const ratio = E.stat(g, 'acc') / Math.max(1, E.stat(P, 'luk'));
      const p = clamp(0.5 + 0.15 * Math.log2(clamp(ratio, 0.25, 4)), 0.25, 0.8);
      if (rng.next() >= p) { ev.push({ t: 'glance', who: g.name }); continue; }
    }
    if (s.state === 'check' || c.k <= 2 || st.spotted >= 2) return detect('spotted', c.k <= 1 ? 'enemy' : 'normal', g.name);
    s.state = 'check'; s.target = { ...st.p }; s.timer = 3; s.face = dirTo(s, st.p);
    st.spotted += 1;
    st.alert = clamp(st.alert + 20, 0, 100);
    ev.push({ t: 'spotted', who: g.name });
  }
  return null;
}

function bodiesCheck(st, ev) {
  for (const body of st.bodies.filter(x => !x.found)) {
    for (const g of placed(st).filter(E.active)) {
      if (!cone(st, g).some(t => t.x === body.x && t.y === body.y)) continue;
      body.found = true;
      const s = st.g[g.id];
      s.state = 'check'; s.target = { x: body.x, y: body.y }; s.timer = 4;
      st.alert = clamp(st.alert + 25, 0, 100);
      ev.push({ t: 'suspicious', who: g.name, why: 'body' });
      break;
    }
  }
}

/* ---------- board ---------- */
function board(st, profile, ctx) {
  const P = me(st);
  const mode = ctx.ui.pzMode;
  const cones = new Map();
  const nexts = new Map();
  const future = new Set();
  for (const g of placed(st).filter(E.active)) {
    for (const c of cone(st, g)) cones.set(key(c.x, c.y), st.g[g.id].state === 'patrol' ? (cones.get(key(c.x, c.y)) === 'hot' ? 'hot' : 'warm') : 'hot');
    const pr = predict(st, g);
    if (pr?.step) nexts.set(key(pr.step.x, pr.step.y), ARROW[dirTo(st.g[g.id], pr.step)]);
    // Where this guard will be looking after it moves (dashed outline).
    if (pr) {
      const gs = st.g[g.id];
      const ghost = { ...st, g: { ...st.g, [g.id]: { ...gs, x: pr.step?.x ?? gs.x, y: pr.step?.y ?? gs.y, face: pr.face } } };
      for (const c of cone(ghost, g)) future.add(key(c.x, c.y));
    }
  }
  const reach = new Set();
  if (st.status === 'active') {
    if (mode === 'throw') { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (walkable(st, x, y) && manhattan({ x, y }, st.p) <= 3 && !(x === st.p.x && y === st.p.y)) reach.add(key(x, y)); }
    else for (const [d, [dx, dy]] of Object.entries(DIRS)) {
      const a = { x: st.p.x + dx, y: st.p.y + dy };
      if (mode !== 'run' && walkable(st, a.x, a.y) && !guardAt(st, a.x, a.y)) reach.add(key(a.x, a.y));
      const b2 = { x: st.p.x + dx * 2, y: st.p.y + dy * 2 };
      if (walkable(st, a.x, a.y) && walkable(st, b2.x, b2.y) && !guardAt(st, a.x, a.y) && !guardAt(st, b2.x, b2.y) && P.sp >= Math.max(1, Math.round(P.maxSp * 0.06))) reach.add(`${key(b2.x, b2.y)}:run`);
    }
  }
  const pColor = TYPE_HEX[(P.elements ?? [])[0]] ?? '#e8a33d';
  let cells = '';
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = tile(st, x, y);
    const k = key(x, y);
    let inner = '';
    if (t === 'G') inner += '<span class="pz-goal">🚩</span>';
    if (t === 'c') inner += '<span class="pz-crate"></span>';
    const body = st.bodies.find(bd => bd.x === x && bd.y === y);
    if (body) inner += '<span class="pz-body">✕</span>';
    if (nexts.has(k) && !guardAt(st, x, y)) inner += `<span class="pz-next">${nexts.get(k)}</span>`;
    const g = guardAt(st, x, y);
    if (g && E.active(g)) {
      const s = st.g[g.id];
      const bub = s.state === 'check' ? '<b class="pz-bub">?</b>' : s.state === 'chase' ? '<b class="pz-bub red">!</b>' : s.state === 'distract' ? '<b class="pz-bub">♪</b>' : '';
      inner += `<span class="pz-tok guard f-${s.face}" data-act="pk:pick" data-v="${h(g.name)}">${g.portrait?.src ? portraitImg(g.portrait, { cls: 'pz-img' }) : pixelSvg(shapeOf(g, { side: 'enemy', intel: 2 }), '#b03030')}<i class="pz-face">${ARROW[s.face]}</i>${bub}</span>`;
    }
    if (st.p.x === x && st.p.y === y) inner += `<span class="pz-tok me ${cones.has(k) && t !== 'c' ? 'danger' : ''} ${t === 'c' ? 'hidden' : ''}">${P.portrait?.src ? portraitImg(P.portrait, { cls: 'pz-img' }) : pixelSvg(shapeOf(P, { side: 'ally' }), pColor)}</span>`;
    const canGo = reach.has(k) ? 'go' : reach.has(`${k}:run`) && (mode === 'run' || mode == null) ? 'go run' : '';
    cells += `<div class="pz-t t-${t === '#' ? 'wall' : t === 'c' ? 'cover' : t === 'd' ? 'dark' : 'floor'} ${cones.get(k) ?? ''} ${future.has(k) ? 'nx' : ''} ${canGo}" ${canGo ? `data-act="m:tile" data-v="${k}"` : ''}>${inner}</div>`;
  }
  const reserves = guards(st).filter(g => st.g[g.id]?.reserve).length;
  const STATE_KO = { patrol: '순찰 중', check: '수상한 걸 확인하러 옴 (?)', distract: '소리 쪽으로 가는 중 (♪)', chase: '추격 중 (!)' };
  const sel = placed(st).find(g => g.name === ctx.ui.target && E.active(g));
  let info = '';
  if (sel) {
    const gs = st.g[sel.id], pr = predict(st, sel);
    const nextTxt = pr?.step ? `${DIR_KO[dirTo(gs, pr.step)]}으로 한 칸` : gs.post ? `${DIR_KO[pr?.face] ?? ''} 쪽으로 돌아봄` : '제자리';
    const side = facingSide(gs, st.p);
    info = `<div class="pz-info"><b>${h(sel.name)}</b>${sel.tier ? ` <small>[${h(sel.tier)}]</small>` : ''} · ${ARROW[gs.face]} ${DIR_KO[gs.face]}을 봄 · ${STATE_KO[gs.state] ?? gs.state}<br><small>다음 턴: ${nextTxt}${manhattan(gs, st.p) === 1 ? ` · 지금 ${side === 'back' ? '등 뒤' : side === 'side' ? '옆' : '정면'}에 있음` : ''}</small><button class="pz-x" data-act="pz:unpick">✕</button></div>`;
  }
  const MODE_TXT = { run: '🏃 달리기: 두 칸 떨어진 노란 칸을 누르세요 (근처 경비가 소리를 들어요)', throw: '🪨 유인: 돌을 던질 칸을 누르세요 (3칸 이내)' };
  const banner = mode && MODE_TXT[mode] ? `<div class="pz-mode">${MODE_TXT[mode]}<button data-act="pz:cancel">취소</button></div>` : '';
  return `<div class="pz-wrap ${st.variant}">
    <div class="pz-hud"><div class="pk-meter alert pz-alert"><div style="width:${clamp(st.alert, 0, 100)}%"></div><span>👁 경계 ${Math.round(st.alert)}${st.alert >= 50 ? ' · 시야+1' : ''}</span></div><span>🗺 ${h(st.mapName)}</span><span>${P.sp}/${P.maxSp} ${h(profile.spLabel)}</span></div>
    ${banner}<div class="pz-grid" style="grid-template-columns:repeat(${W},1fr)">${cells}</div>
    ${info}<div class="pz-legend"><span class="go">●</span>이동 <span class="hot">■</span>시선 <span class="warm">■</span>순찰 시야 <span class="nx">▢</span>다음 턴 시야 · 경비를 누르면 정보${reserves ? ` · 다른 구역 ${reserves}명` : ''}</div>
  </div>`;
}

export { MAPS, cone, predict };
