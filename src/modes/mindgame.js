// Mode: one-on-one duel / mind game (Sekiro posture + simultaneous stance picks).
//
// Both sides pick a stance at the same time:
//   strike (빠른 공격) beats heavy & feint, is stopped by guard, can be evaded
//   heavy  (강공)      breaks guard, punishes feint, loses to strike, whiffs on evade
//   guard  (방어)      stops strike (perfect timing = parry), cracks under heavy, is baited by feint
//   evade  (회피)      dodges heavy (and strike, by speed), is baited by feint
//   feint  (페인트)     opens guard/evade, loses to any attack
// Hits and parries build posture; a broken posture allows a finisher.
// The opponent shows a "tell" before you choose; how reliable it is depends on your senses.
import * as E from '../engine.js';
import { STATUS, THREAT_KO, inferItem, elementId, typeIn } from '../catalog.js';
import { escapeHtml as h, pct, clamp, num, norm, clone } from '../util.js';
import { splitBody, autoGrade, seededRng, timingFor, matchWord, fxHtml } from './shared.js';
import { vf } from '../pkui.js';
import { josa } from '../narrate.js';

export const STANCES = ['strike', 'heavy', 'guard', 'evade', 'feint'];
export const STANCE_KO = { strike: '빠른 공격', heavy: '강공', guard: '방어', evade: '회피', feint: '페인트', finisher: '결정타', open: '무방비' };
const STANCE_EN = { strike: 'quick strike', heavy: 'heavy attack', guard: 'guard', evade: 'evade', feint: 'feint', finisher: 'finisher', open: 'no defense' };
const WORDS = {
  strike: ['strike', 'quick', '빠른공격', '빠른 공격', '공격', '찌르기', '견제', '잽'], heavy: ['heavy', 'power', '강공', '강타', '내려베기', '일격'],
  guard: ['guard', 'block', 'parry', '방어', '막기', '가드', '패링', '받아치기'], evade: ['evade', 'dodge', '회피', '피하기', '흘리기', '물러서기'],
  feint: ['feint', 'bait', 'fake', '페인트', '속임수', '허초', '유인'], finisher: ['finisher', 'execute', '결정타', '마무리', '처형'],
  flee: ['flee', 'run', '도주', '이탈'], wait: ['wait', '대기', '관망'],
};
const TELL_KO = {
  strike: '칼끝이 가볍게 흔들린다 — 빠른 공격 기색', heavy: '깊게 숨을 들이켜며 무게중심을 싣는다 — 강공 기색',
  guard: '자세를 낮추고 몸을 굳힌다 — 방어 기색', evade: '발끝에 체중을 싣고 거리를 잰다 — 회피 기색', feint: '시선이 묘하게 엇나간다 — 페인트 기색',
};
const TELL_EN = {
  strike: 'their weapon tip twitches lightly (looks like a quick strike)', heavy: 'they draw a deep breath and shift their weight (looks like a heavy attack)',
  guard: 'they lower their stance and tense up (looks like guarding)', evade: 'they rise onto the balls of their feet, measuring distance (looks like evading)',
  feint: 'their eyes drift oddly (looks like a feint)',
};
const STYLE_W = {
  aggressive: { strike: 30, heavy: 30, guard: 10, evade: 15, feint: 15 }, defensive: { strike: 20, heavy: 10, guard: 35, evade: 20, feint: 15 },
  tricky: { strike: 20, heavy: 15, guard: 10, evade: 20, feint: 35 }, balanced: { strike: 25, heavy: 20, guard: 20, evade: 20, feint: 15 },
  berserker: { strike: 30, heavy: 45, guard: 5, evade: 5, feint: 15 },
};
const STYLE_KO = { aggressive: '공격형', defensive: '수비형', tricky: '기교형', balanced: '균형형', berserker: '광전사' };
const COUNTERS = { strike: ['guard', 'evade'], heavy: ['evade', 'strike'], guard: ['heavy', 'feint'], evade: ['feint', 'guard'], feint: ['strike', 'heavy'] };
const G_SPD = { perfect: 1.3, good: 1, miss: 0.8 };
const G_DMG = { perfect: 1.0, good: 1, miss: 0.8 };
const G_EVA = { perfect: 0.35, good: 0, miss: -0.3 };

const me = st => st.b.fighters.find(f => f.side === 'ally');
const foe = st => st.b.fighters.find(f => f.side === 'enemy');
const styleOf = raw => {
  const t = String(raw ?? '').toLowerCase();
  for (const k of Object.keys(STYLE_W)) if (t.includes(k)) return k;
  if (/공격|공세|맹공/.test(t)) return 'aggressive';
  if (/수비|방어|신중/.test(t)) return 'defensive';
  if (/기교|교활|트릭|변칙/.test(t)) return 'tricky';
  if (/광전|광폭|폭주/.test(t)) return 'berserker';
  return 'balanced';
};

function classOf(skill) {
  if (!skill) return null;
  if (['physical', 'magic'].includes(skill.kind)) return skill.power >= 75 || skill.charge ? 'heavy' : 'strike';
  if (skill.kind === 'debuff') return 'feint';
  if (['guard', 'buff'].includes(skill.kind)) return 'guard';
  if (['heal', 'cleanse', 'revive'].includes(skill.kind)) return 'open';
  return null;
}

function moveOf(st, f, a) {
  const opp = f.side === 'ally' ? foe(st) : me(st);
  const magic = f.derived.mag > f.derived.pow * 1.2;
  const base = { strike: { power: 45, cost: 0 }, heavy: { power: 85, cost: Math.round(f.maxSp * 0.06) }, guard: { power: 0, cost: 0 }, evade: { power: 0, cost: Math.round(f.maxSp * 0.05) }, feint: { power: 0, cost: 0 } };
  let mv = { stance: 'open', power: 0, kind: magic ? 'magic' : 'physical', element: 'none', cost: 0, name: null };
  if (a.type === 'finisher') {
    if (st.broken[opp.side === 'ally' ? 'me' : 'foe']) return { ...mv, stance: 'finisher', power: 150, name: STANCE_KO.finisher };
    a = { type: 'stance', stance: 'heavy' };
  }
  if (a.type === 'skill') {
    const sk = E.findSkill(f, a.skill);
    const cls = classOf(sk);
    if (sk && cls && sk.cost <= f.sp && !(f.cds[sk.name] > 0)) {
      mv = { stance: cls, power: sk.power || base[cls]?.power || 0, kind: sk.kind === 'magic' ? 'magic' : mv.kind, element: sk.element, cost: sk.cost, name: sk.name, status: sk.status, stages: sk.stages, heal: sk.kind === 'heal' ? sk.power : 0, cooldown: sk.cooldown };
      return mv;
    }
    a = { type: 'stance', stance: cls && cls !== 'open' ? cls : 'strike', fallback: sk?.name ?? a.skill };
  }
  if (a.type === 'stance' && STANCES.includes(a.stance)) {
    const b = base[a.stance];
    if (b.cost > f.sp) return { ...mv, stance: 'strike', power: 45, fallback: a.stance };
    return { ...mv, stance: a.stance, power: b.power, cost: b.cost, fallback: a.fallback };
  }
  if (a.type === 'item') return { ...mv, stance: 'open', item: a.item };
  if (a.type === 'improvise') return { ...mv, stance: 'open', improv: a.improv, target: a.target };
  if (a.type === 'flee') return { ...mv, stance: 'open', flee: true };
  return mv;
}

export default {
  id: 'mindgame', ko: '심리전 결투', icon: '',

  create({ spec, profile, party, enemies, seed, settings }) {
    const mine = party[0];
    const theirs = enemies[0];
    const b = E.createBattle({ party: [mine], enemies: [theirs], profile, seed, place: spec.place, flee: spec.flee, length: Number(settings.length) || 1, title: spec.title, terrain: spec.terrain });
    const st = {
      kind: 'duel', b, seed: b.seed, turn: 1, status: 'active', title: spec.title, place: spec.place, flee: spec.flee !== false,
      posture: { me: 0, foe: 0 }, opened: { me: false, foe: false }, broken: { me: false, foe: false }, stunned: { me: false, foe: false },
      habits: Object.fromEntries(STANCES.map(s => [s, 0])), style: styleOf(spec.style ?? theirs.style),
      intel: theirs.intel ?? 1, intent: null, tell: null, last: null,
    };
    if (spec.initiative === 'enemy') st.opened.me = true;
    if (spec.initiative === 'player') st.opened.foe = true;
    planFoe(st);
    return st;
  },

  resolve(st0, commands, { inventory = [] } = {}) {
    const st = clone(st0);
    const inv = clone(inventory) ?? [];
    if (st.status !== 'active') return { st, events: [], inventory: inv };
    const rng = seededRng(st.seed, 'duel', st.turn);
    const A = me(st), B = foe(st);
    const ev = [{ t: 'turn', n: st.turn }];
    const cmd = commands.find(c => c.actor === A.id) ?? commands[0] ?? { type: 'stance', stance: 'guard' };
    const prevOpen = { ...st.opened };
    st.opened = { me: false, foe: false };
    // Broken or stunned fighters stand open this exchange.
    const forced = side => st.broken[side] || st.stunned[side];
    const ma = forced('me') ? { stance: 'open', power: 0 } : moveOf(st, A, cmd);
    const mb = forced('foe') ? { stance: 'open', power: 0 } : moveOf(st, B, st.intent ?? { type: 'stance', stance: 'guard' });
    const gA = cmd.grades?.[0] ?? null;
    const gB = autoGrade(rng, E.stat(B, 'spd') / Math.max(1, E.stat(A, 'spd')));
    for (const [f, mv] of [[A, ma], [B, mb]]) { f.sp = Math.max(0, f.sp - (mv.cost ?? 0)); if (mv.cooldown && mv.name) f.cds[mv.name] = mv.cooldown + 1; }
    ev.push({ t: 'stances', me: A.name, foe: B.name, a: ma.stance, b: mb.stance, an: ma.name, bn: mb.name, ga: gA, tell: st.tell?.stance ?? null, forcedA: forced('me'), forcedB: forced('foe'), fallback: ma.fallback ?? null });
    if (STANCES.includes(ma.stance)) st.habits[ma.stance] += 1;
    for (const k of STANCES) st.habits[k] *= 0.85;

    const X = { f: A, mv: ma, g: gA, side: 'me', opened: prevOpen.me }, Y = { f: B, mv: mb, g: gB, side: 'foe', opened: prevOpen.foe };
    // Non-combat moves first (they leave you open but still happen).
    for (const P of [X, Y]) {
      const Q = P === X ? Y : X;
      if (P.mv.heal) heal(P.f, Math.round(P.f.maxHp * P.mv.heal / 100), ev);
      if (P.mv.item) useItem(st, P, ev, inv);
      if (P.mv.flee) {
        const p = st.flee ? clamp(0.35 + 0.3 * Math.log2(E.stat(P.f, 'spd') / Math.max(1, E.stat(Q.f, 'spd'))), 0.05, 0.9) : 0;
        const ok = rng.chance(p);
        ev.push({ t: 'flee', who: P.f.name, ok, chance: Math.round(p * 100), blocked: !st.flee });
        if (ok) st.status = 'fled';
      }
      if (P.mv.improv) improv(st, P, Q, rng, ev);
    }
    if (st.status === 'active') exchange(st, X, Y, rng, ev);

    // Upkeep
    for (const [f, side] of [[A, 'me'], [B, 'foe']]) {
      if (st.broken[side] && forced(side)) { st.broken[side] = false; st.posture[side] = 40; }
      st.stunned[side] = false;
      for (const s of [...f.statuses]) {
        const d = STATUS[s.id];
        if (d?.dot && f.hp > 0) { const dmg = Math.max(1, Math.round(f.maxHp * d.dot * (f.threat === 'boss' ? 0.5 : 1))); f.hp = Math.max(0, f.hp - dmg); ev.push({ t: 'hit', who: f.name, target: f.name, dmg, from: pct(f.hp + dmg, f.maxHp), to: pct(f.hp, f.maxHp), label: d.ko }); }
        if (d?.skip) st.stunned[side] = true;
        if (--s.turns <= 0) f.statuses.splice(f.statuses.indexOf(s), 1);
      }
      for (const k of Object.keys(f.cds)) if (--f.cds[k] <= 0) delete f.cds[k];
      const guarded = (side === 'me' ? ma : mb).stance === 'guard';
      if (!st.broken[side]) st.posture[side] = Math.max(0, st.posture[side] - (guarded ? 18 : 8));
      f.sp = Math.min(f.maxSp, f.sp + Math.round(f.maxSp * 0.05));
    }
    if (st.status === 'active') {
      if (B.hp <= 0 || B.out) { B.down = B.hp <= 0; st.status = 'win'; }
      else if (A.hp <= 0) { A.down = true; st.status = 'lose'; }
    }
    if (st.status !== 'active') ev.push({ t: 'end', result: st.status });
    st.last = { a: ma.stance, b: mb.stance };
    st.turn += 1;
    st.b.turn = st.turn;
    st.b.status = st.status;
    planFoe(st);
    return { st, events: ev, inventory: inv };
  },

  controlled: st => [me(st)].filter(E.active),

  quick(body, st) {
    const { what, target } = splitBody(body);
    const A = me(st);
    const w = matchWord(what, WORDS);
    if (w === 'finisher') return { actor: A.id, type: 'finisher' };
    if (w === 'flee') return { actor: A.id, type: 'flee' };
    if (w === 'wait') return { actor: A.id, type: 'stance', stance: 'guard' };
    if (w) return { actor: A.id, type: 'stance', stance: w };
    const item = /^(?:item|아이템|사용)\s+(.+)$/i.exec(what);
    if (item) return { actor: A.id, type: 'item', item: item[1].trim() };
    const sk = E.findSkill(A, what);
    if (sk) return { actor: A.id, type: 'skill', skill: sk.name };
    return { actor: A.id, type: 'improvise', target, improv: { desc: what, stat: 'pow', difficulty: 'normal', effect: { kind: 'damage', power: 50 } } };
  },

  local(text, st) {
    const t = String(text ?? ''), k = norm(t), A = me(st);
    const sk = A.skills.slice().sort((a, b) => b.name.length - a.name.length).find(s => k.includes(norm(s.name)));
    if (sk) return [{ actor: A.id, type: 'skill', skill: sk.name }];
    const pat = [
      ['finisher', /(결정타|마무리|숨통|끝장|finish|execute)/i], ['feint', /(페인트|속임|허초|유인|feint|bait|fake)/i], ['evade', /(피한|피해|회피|흘려|물러|굴러|dodge|evade|sidestep)/i],
      ['guard', /(막는|막아|방어|받아친|패링|가드|버틴|block|guard|parry)/i], ['heavy', /(힘껏|온 힘|내려찍|강타|강하게|크게 휘|전력|heavy|smash|full force)/i],
      ['strike', /(찌른|벤다|베어|친다|때린|공격|휘두|쏜다|strike|slash|stab|hit|attack|jab)/i], ['flee', /(도망|도주|이탈|flee|run away)/i],
    ];
    for (const [s, re] of pat) if (re.test(t)) return [s === 'finisher' ? { actor: A.id, type: 'finisher' } : s === 'flee' ? { actor: A.id, type: 'flee' } : { actor: A.id, type: 'stance', stance: s }];
    return [];
  },

  auxSchema(st, profile) {
    const A = me(st);
    return `## The duel
Stances: strike (quick attack), heavy (power attack), guard, evade, feint. strike beats heavy/feint; heavy breaks guard; guard stops strike; evade dodges heavy; feint baits guard/evade.
${st.broken.foe ? 'The opponent\'s posture is BROKEN: a "finisher" is possible now.' : ''}
## ${A.name}'s techniques (each acts as a stance)
${A.skills.map(s => `- ${s.name} → ${classOf(s) ?? '-'} [${s.kind}${s.power ? ` ${s.power}` : ''}, ${s.cost}${profile.spLabel}${s.desc ? `, ${s.desc}` : ''}]`).join('\n') || '- none'}

## Action shapes (exactly one)
{"actor": "${A.name}", "type": "stance", "stance": "strike|heavy|guard|evade|feint"}
{"actor": "${A.name}", "type": "skill", "skill": "<exact technique name>"}
{"actor": "${A.name}", "type": "finisher"}
{"actor": "${A.name}", "type": "item", "item": "<inventory item>"}
{"actor": "${A.name}", "type": "flee"}
{"actor": "${A.name}", "type": "improvise", "improv": {"desc": "", "stat": "pow|mag|spd|acc|luk", "difficulty": "trivial|easy|normal|hard|extreme|impossible", "effect": {"kind": "damage|status|debuff|yield|escape|none", "power": 0-130, "status": {"id": "", "turns": 2}}}}
Pick the stance the player's words describe (e.g. "I wait for his swing and turn it aside" = guard; "I pretend to lunge" = feint).`;
  },

  mapAux(actions, st) {
    const A = me(st);
    const a = (Array.isArray(actions) ? actions : [])[0];
    if (!a) return [];
    const type = String(a.type ?? '').toLowerCase();
    if (type === 'stance' && STANCES.includes(a.stance)) return [{ actor: A.id, type: 'stance', stance: a.stance }];
    if (type === 'skill') { const sk = E.findSkill(A, a.skill); return [sk ? { actor: A.id, type: 'skill', skill: sk.name } : { actor: A.id, type: 'stance', stance: 'strike' }]; }
    if (type === 'finisher') return [{ actor: A.id, type: 'finisher' }];
    if (type === 'item') return [{ actor: A.id, type: 'item', item: String(a.item ?? '') }];
    if (type === 'flee') return [{ actor: A.id, type: 'flee' }];
    if (type === 'improvise' && a.improv) return [{ actor: A.id, type: 'improvise', improv: a.improv, target: B_NAME(st) }];
    if (['attack', 'strike'].includes(type)) return [{ actor: A.id, type: 'stance', stance: 'strike' }];
    if (['defend', 'guard'].includes(type)) return [{ actor: A.id, type: 'stance', stance: 'guard' }];
    return [];
  },

  status(st, profile, { lang = 'en' } = {}) {
    const ko = lang === 'ko';
    const A = me(st), B = foe(st);
    const lvl = st.intel ?? 1;
    const bh = lvl >= 2 ? `${B.hp}/${B.maxHp}` : lvl === 1 ? `${pct(B.hp, B.maxHp)}%` : (B.hp / B.maxHp > 0.5 ? (ko ? '여유' : 'steady') : (ko ? '지침' : 'worn'));
    const flags = (side) => [st.broken[side] && (ko ? '체간 붕괴!' : 'POSTURE BROKEN'), st.opened[side] && (ko ? '빈틈' : 'opened up'), st.stunned[side] && (ko ? '경직' : 'stunned')].filter(Boolean).join(', ');
    return [
      ko ? '[결투]' : '[Duel]',
      `- ${A.name}: ${profile.hpLabel} ${A.hp}/${A.maxHp}, ${profile.spLabel} ${A.sp}/${A.maxSp}, ${ko ? '체간' : 'posture'} ${Math.round(st.posture.me)}/100${flags('me') ? ` | ${flags('me')}` : ''}`,
      `- ${B.name}${B.tier ? ` [${B.tier}]` : ''} (${ko ? STYLE_KO[st.style] : st.style}): ${profile.hpLabel} ${bh}, ${ko ? '체간' : 'posture'} ${lvl >= 1 ? Math.round(st.posture.foe) : '?'}/100${flags('foe') ? ` | ${flags('foe')}` : ''}`,
    ].join('\n');
  },

  nextHint(st, lang = 'en') {
    if (st.status !== 'active' || !st.tell) return '';
    if (st.broken.foe) return lang === 'ko' ? '상대의 자세가 무너졌다 — 결정타의 기회' : "The opponent's posture is broken — a finisher is possible.";
    return lang === 'ko' ? `상대 기색: ${TELL_KO[st.tell.stance]} (확신도 ${relKo(st.tell.rel)})` : `Opponent's tell: ${TELL_EN[st.tell.stance]}. (The tell may be a deception.)`;
  },

  timingPlan(st, cmd) {
    const A = me(st), B = foe(st);
    const mv = moveOf(st, A, cmd);
    if (mv.stance === 'open') return [];
    const ratio = ['strike', 'heavy', 'finisher'].includes(mv.stance) ? E.stat(A, 'acc') / Math.max(1, E.stat(B, 'eva'))
      : mv.stance === 'feint' ? Math.max(E.stat(A, 'luk'), E.stat(A, 'mag')) / Math.max(1, E.stat(B, 'acc')) : E.stat(A, 'spd') / Math.max(1, E.stat(B, 'spd'));
    const fast = mv.stance === 'guard' ? { perfect: 0.05 } : mv.stance === 'heavy' ? { speed: 1.2 } : {};
    return [{ key: 'action', label: `${mv.name ?? STANCE_KO[mv.stance]} 타이밍`, beats: 1, ...timingFor(ratio, fast) }];
  },

  applyGrades(cmd, grades) { return grades?.action ? { ...cmd, grades: [].concat(grades.action) } : cmd; },
  autoGrades(st, cmd) {
    const A = me(st), B = foe(st);
    return { action: [autoGrade(seededRng(st.seed, 'auto', st.turn), E.stat(A, 'spd') / Math.max(1, E.stat(B, 'spd')))] };
  },
  results: st => { const A = me(st); return [{ id: A.id, hp: A.hp, sp: A.sp, down: A.hp <= 0 }]; },
  enemiesOf: st => [foe(st)],
  threat: st => E.threatOf(st.b),

  render(st, profile, ctx) {
    const A = me(st), B = foe(st);
    const busy = ctx.busy;
    const lvl = st.intel ?? 1;
    const bar = (cur, max, cls, label, dim) => `<div class="bt-bar ${cls}"><div style="width:${dim ? 100 : pct(cur, max)}%;${dim ? 'opacity:.35' : ''}"></div><span>${label}</span></div>`;
    const card = (f, side) => `<div class="bt-fighter ${side === 'me' ? 'ally' : 'enemy'}">${fxHtml(ctx, f.name)}
      <div class="bt-fname">${h(f.name)} <small>[${h(f.tier || '?')}]</small>${side === 'foe' ? ` <small class="bt-intel">${STYLE_KO[st.style]}</small>` : ''}${st.broken[side] ? ' <small class="bt-state">체간 붕괴!</small>' : ''}${st.opened[side] ? ' <small class="bt-state">빈틈</small>' : ''}</div>
      ${bar(f.hp, f.maxHp, 'hp', side === 'me' || lvl >= 2 ? `${profile.hpLabel} ${f.hp}/${f.maxHp}` : lvl === 1 ? `${profile.hpLabel} ${pct(f.hp, f.maxHp)}%` : `${profile.hpLabel} ???`, side === 'foe' && lvl === 0)}
      ${side === 'me' ? bar(f.sp, f.maxSp, 'sp', `${profile.spLabel} ${f.sp}/${f.maxSp}`) : ''}
      ${bar(st.posture[side], 100, 'posture', `체간 ${side === 'foe' && lvl === 0 ? '?' : Math.round(st.posture[side])}/100`, side === 'foe' && lvl === 0)}
      <div class="bt-chips">${f.statuses.map(s => `<span class="bt-chip bad">${h(STATUS[s.id]?.ko)} ${s.turns}</span>`).join('')}</div></div>`;
    const tell = st.broken.foe ? '<div class="bt-intent release">상대의 자세가 무너졌다 — 결정타 기회!</div>'
      : st.tell ? `<div class="bt-intent">${h(TELL_KO[st.tell.stance])} <small>(확신도 ${relKo(st.tell.rel)})</small></div>` : '';
    const dis = busy ? 'disabled' : '';
    const stanceBtns = STANCES.map(s => `<button class="bt-skill bt-stance-${s}" data-act="m:stance" data-v="${s}" ${dis}><b>${STANCE_KO[s]}</b><small>${{ strike: '강공·페인트에 강함', heavy: '방어 파괴', guard: '빠른 공격 차단·패링', evade: '강공 회피', feint: '방어·회피 유인' }[s]}</small></button>`).join('');
    const techs = A.skills.filter(s => classOf(s)).map(s => {
      const off = s.cost > A.sp || (A.cds[s.name] ?? 0) > 0 || busy;
      return `<button class="bt-skill ${s.kind}" data-act="m:skill" data-v="${h(s.name)}" ${off ? 'disabled' : ''} title="${h(s.desc || '')}"><b>${h(s.name)}</b><small>${STANCE_KO[classOf(s)]}${s.power ? ` ${s.power}` : ''} · ${s.cost}${h(profile.spLabel)}</small></button>`;
    }).join('');
    const items = (ctx.inventory ?? []).filter(i => i.count > 0);
    return `<div class="bt-section">${card(B, 'foe')}${tell}${card(A, 'me')}</div>
      ${st.last ? `<div class="bt-note">지난 합: 나 ${STANCE_KO[st.last.a]} vs 상대 ${STANCE_KO[st.last.b]}</div>` : ''}
      <div class="bt-section bt-actions">
        ${st.broken.foe ? `<button class="menu_button bt-wide bt-finisher" data-act="m:finisher" ${dis}>결정타</button>` : ''}
        <div class="bt-skills">${stanceBtns}</div>
        ${techs ? `<div class="bt-sub">기술</div><div class="bt-skills">${techs}</div>` : ''}
        <div class="bt-row bt-wrap">${items.length ? `<select id="bt-item">${items.map(i => `<option value="${h(i.name)}">${h(i.name)} ×${i.count}</option>`).join('')}</select><button class="menu_button" data-act="m:item" ${dis}>가방</button>` : ''}
          <button class="menu_button" data-act="m:flee" ${busy || !st.flee ? 'disabled' : ''}>이탈</button></div>
        <div class="bt-row"><input type="text" class="text_pole" id="bt-free" data-enter="m:free" placeholder="즉흥 (예: 모래를 차올려 시야를 가린다)"><button class="menu_button" data-act="m:free" ${dis}>자유 행동</button></div>
      </div>`;
  },

  view(st, profile, ctx) {
    const A = me(st), B = foe(st), sys = st.b.typeSystem;
    const lvl = st.intel ?? 1;
    const tell = st.broken.foe ? '자세 붕괴 — 결정타 기회!' : st.tell ? `${STANCE_KO[st.tell.stance]} 기색 (확신도 ${relKo(st.tell.rel)})` : '';
    const foes = [vf(B, { side: 'enemy', intel: lvl, typeSystem: sys, note: tell, noteCls: st.broken.foe ? 'release' : 'tell', posture: lvl >= 1 ? st.posture.foe : null })];
    const allies = [vf(A, { side: 'ally', typeSystem: sys, posture: st.posture.me, note: st.broken.me ? '자세 붕괴!' : st.opened.me ? '빈틈!' : '' })];
    const idle = st.broken.foe ? `${josa(B.name, '의', '의')} 자세가 무너졌다! 지금이다!` : st.tell ? `${TELL_KO[st.tell.stance]}… ${josa(A.name, '은', '는')} 다음 수를 고른다.` : `${josa(A.name, '은', '는')} 다음 수를 고른다.`;
    return { foes, allies, idle: idle.replace('의의', '의'), sceneCls: 'duel' };
  },

  menu(st, page, ctx) {
    const A = me(st);
    const items = (ctx.inventory ?? []).filter(i => i.count > 0);
    const HINT = { strike: '강공·페인트를 이긴다', heavy: '방어를 부순다', guard: '빠른 공격 차단·패링', evade: '강공을 흘린다', feint: '방어·회피를 속인다' };
    if (page === 'stances') return [...STANCES.map(x => ({ label: STANCE_KO[x], sub: HINT[x], cls: `st-${x}`, act: 'm:stance', v: x })), { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    if (page === 'tech') return [...A.skills.filter(k => classOf(k)).map(k => ({ label: k.name, meta: `${ctx?.spLabel ?? 'SP'} ${k.cost}`, sub: `${STANCE_KO[classOf(k)]}${k.power ? ` ${k.power}` : ''}`, cls: `t-${typeIn(k.element, st.b.typeSystem) || 'normal'}`, disabled: k.cost > A.sp || (A.cds[k.name] ?? 0) > 0, act: 'm:skill', v: k.name })), { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    if (page === 'bag') return [...items.map(i => ({ label: i.name, meta: `×${i.count}`, cls: 'plain', act: 'm:item', v: i.name })), { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    const main = [{ label: '자세', cls: 'm-fight', page: 'stances' }, { label: '기술', cls: 'm-party', page: 'tech' }, { label: '가방', cls: 'm-bag', page: 'bag', disabled: !items.length }, { label: '이탈', cls: 'm-run', act: 'm:flee', disabled: !st.flee }];
    return st.broken.foe ? [{ label: '결정타', cls: 'finisher wide', act: 'm:finisher' }, ...main] : main;
  },

  onAct(act, v, st, ctx) {
    const A = me(st);
    switch (act) {
      case 'm:stance': return { body: STANCE_KO[v], cmd: { actor: A.id, type: 'stance', stance: v } };
      case 'm:skill': return { body: v, cmd: { actor: A.id, type: 'skill', skill: v } };
      case 'm:finisher': return { body: '결정타', cmd: { actor: A.id, type: 'finisher' } };
      case 'm:flee': return { body: '이탈', cmd: { actor: A.id, type: 'flee' } };
      case 'm:item': { const it = v || ctx.value('bt-item'); return it ? { body: `아이템 ${it}`, cmd: { actor: A.id, type: 'item', item: it } } : null; }
      case 'm:free': { const t = ctx.value('bt-free'); return t ? { body: t, cmd: { actor: A.id, type: 'improvise' }, freeText: t } : null; }
      default: return null;
    }
  },
};

const B_NAME = st => foe(st).name;
const relKo = r => (r >= 0.75 ? '높음' : r >= 0.5 ? '보통' : '낮음');

function planFoe(st) {
  if (st.status !== 'active') { st.intent = null; st.tell = null; return; }
  const rng = seededRng(st.seed, 'foe', st.turn);
  const A = me(st), B = foe(st);
  if (st.broken.foe || st.stunned.foe) { st.intent = { type: 'stance', stance: 'guard' }; st.tell = { stance: 'guard', rel: 1 }; return; }
  if (st.broken.me) { st.intent = { type: 'finisher' }; st.tell = { stance: 'heavy', rel: 0.95 }; return; }
  const w = { ...STYLE_W[st.style] };
  const adapt = { minion: 0.15, normal: 0.35, elite: 0.6, boss: 0.7 }[B.threat] ?? 0.35;
  const total = STANCES.reduce((a, s) => a + st.habits[s], 0);
  if (total > 0.5) for (const s of STANCES) for (const c of COUNTERS[s]) w[c] += adapt * (st.habits[s] / total) * 40;
  if (st.opened.me) w.heavy += 30;
  if (B.sp < B.maxSp * 0.08) { w.heavy *= 0.3; w.evade *= 0.3; }
  if (B.hp / B.maxHp < 0.3) { w.guard += 10; w.evade += 10; }
  const sum = STANCES.reduce((a, s) => a + w[s], 0);
  let x = rng.next() * sum, stance = 'strike';
  for (const s of STANCES) { x -= w[s]; if (x <= 0) { stance = s; break; } }
  // Sometimes use a technique of that stance class.
  const techs = B.skills.filter(s => classOf(s) === stance && s.cost <= B.sp && !(B.cds[s.name] > 0));
  const heals = B.skills.filter(s => s.kind === 'heal' && s.cost <= B.sp);
  if (heals.length && B.hp / B.maxHp < 0.35 && rng.chance(0.4)) st.intent = { type: 'skill', skill: heals[0].name };
  else st.intent = techs.length && rng.chance(0.55) ? { type: 'skill', skill: techs.sort((a, b) => b.power - a.power)[0].name } : { type: 'stance', stance };
  const trueStance = st.intent.type === 'skill' ? classOf(E.findSkill(B, st.intent.skill)) ?? 'strike' : stance;
  const deception = Math.max(E.stat(B, 'luk'), E.stat(B, 'mag'), E.stat(B, 'acc')) * (st.style === 'tricky' ? 1.4 : 1);
  const rel = clamp(0.55 + 0.25 * Math.log2(E.stat(A, 'acc') / Math.max(1, deception)) + (st.intel - 1) * 0.1, 0.25, 0.95);
  const shown = trueStance === 'open' ? 'guard' : rng.chance(rel) ? trueStance : rng.pick(STANCES.filter(s => s !== trueStance));
  st.tell = { stance: shown, rel: Math.round(rel * 100) / 100 };
}

function dmgOf(st, P, Q, mult, { crit = false } = {}) {
  if (mult <= 0) return 0;
  const skill = { kind: P.mv.kind ?? 'physical', power: Math.max(1, P.mv.power * mult), element: elementId(P.mv.element ?? 'none'), range: 'ranged' };
  let d = E.rawDamage(st.b, P.f, Q.f, skill, { rand: 0.92, crit }) * (G_DMG[P.g] ?? 1);
  if (Q.opened) d *= 1.5;
  return Math.max(1, Math.round(d));
}

function hit(st, P, Q, mult, ev, note) {
  const crit = P.g === 'perfect' && ['strike', 'heavy', 'finisher'].includes(P.mv.stance);
  const dmg = dmgOf(st, P, Q, mult, { crit });
  if (!dmg) return 0;
  const before = Q.f.hp;
  Q.f.hp = Math.max(0, Q.f.hp - dmg);
  ev.push({ t: 'hit', who: P.f.name, target: Q.f.name, dmg, crit, from: pct(before, Q.f.maxHp), to: pct(Q.f.hp, Q.f.maxHp), hp: Q.f.hp, maxHp: Q.f.maxHp, note });
  if (Q.f.hp > 0) posture(st, Q, 10 + 60 * dmg / Q.f.maxHp, ev);
  if (P.mv.status && Q.f.hp > 0 && seededRng(st.seed, 'st', st.turn, P.side).chance(P.mv.status.chance / 100)) addStatus(Q.f, P.mv.status, ev);
  if (Q.f.hp <= 0) ev.push({ t: 'down', who: Q.f.name, side: Q.f.side });
  return dmg;
}

function posture(st, Q, amount, ev) {
  if (st.broken[Q.side]) return;
  st.posture[Q.side] = clamp(st.posture[Q.side] + amount, 0, 100);
  if (st.posture[Q.side] >= 100) { st.broken[Q.side] = true; ev.push({ t: 'broken', who: Q.f.name }); }
}

function addStatus(f, s, ev) {
  if (!STATUS[s.id]) return;
  const have = f.statuses.find(x => x.id === s.id);
  if (have) have.turns = Math.max(have.turns, s.turns ?? 2); else f.statuses.push({ id: s.id, turns: Math.min(3, s.turns ?? 2) });
  ev.push({ t: 'status', who: f.name, status: s.id, turns: s.turns ?? 2 });
}

function heal(f, amount, ev) {
  const before = f.hp;
  f.hp = Math.min(f.maxHp, f.hp + amount);
  ev.push({ t: 'heal', who: f.name, amount: f.hp - before, from: pct(before, f.maxHp), to: pct(f.hp, f.maxHp) });
}

function evadeChance(st, Y, X) {
  if (Y.opened) return 0;
  return clamp(0.5 + 0.3 * Math.log2(E.stat(Y.f, 'spd') / Math.max(1, E.stat(X.f, 'acc'))) + (G_EVA[Y.g] ?? 0) + (X.mv.stance === 'heavy' ? 0.15 : 0), 0.05, 0.95);
}

/** The heart of the duel: resolve one exchange given both stances. */
function exchange(st, X, Y, rng, ev) {
  const sx = X.mv.stance, sy = Y.mv.stance;
  const out = (k) => ev.push({ t: 'clash', kind: k, a: X.f.name, b: Y.f.name });
  const swap = (fn) => fn(Y, X);
  const table = {
    'strike>strike': (P, Q) => {
      const sp = E.stat(P.f, 'spd') * (G_SPD[P.g] ?? 1), sq = E.stat(Q.f, 'spd') * (G_SPD[Q.g] ?? 1);
      if (Math.abs(sp - sq) / Math.max(sp, sq) < 0.1) { out('trade'); hit(st, P, Q, 0.75, ev); hit(st, Q, P, 0.75, ev); }
      else { const [F, S] = sp > sq ? [P, Q] : [Q, P]; out('faster'); hit(st, F, S, 1, ev, 'first'); if (S.f.hp > 0) hit(st, S, F, 0.5, ev); }
    },
    'strike>heavy': (P, Q) => { out('interrupt'); hit(st, P, Q, 1, ev, 'interrupt'); posture(st, Q, 20, ev); if (Q.f.threat === 'boss' && Q.f.hp > 0) { ev.push({ t: 'armor', who: Q.f.name }); hit(st, Q, P, 0.7, ev); } },
    'strike>guard': (P, Q) => {
      if (Q.g === 'perfect') { out('parry'); ev.push({ t: 'parry', who: Q.f.name, attacker: P.f.name }); posture(st, P, 40, ev); st.opened[P.side] = true; hit(st, { ...Q, mv: { ...Q.mv, power: 45 } }, P, 0.4, ev, 'counter'); }
      else { out('blocked'); hit(st, P, Q, 0.15, ev, 'chip'); posture(st, P, 15, ev); }
    },
    'strike>evade': (P, Q) => { if (rng.chance(evadeChance(st, Q, P))) { out('dodged'); st.opened[P.side] = true; if (Q.g === 'perfect') hit(st, { ...Q, mv: { ...Q.mv, power: 45 } }, P, 0.5, ev, 'counter'); } else { out('caught'); hit(st, P, Q, 0.8, ev); } },
    'strike>feint': (P, Q) => { out('feint-punished'); hit(st, P, Q, 1, ev); posture(st, Q, 10, ev); },
    'strike>open': (P, Q) => { out('free-hit'); hit(st, P, Q, 1.2, ev); },
    'heavy>heavy': (P, Q) => {
      const pp = E.stat(P.f, P.mv.kind === 'magic' ? 'mag' : 'pow') * P.mv.power * (G_SPD[P.g] ?? 1), pq = E.stat(Q.f, Q.mv.kind === 'magic' ? 'mag' : 'pow') * Q.mv.power * (G_SPD[Q.g] ?? 1);
      if (Math.abs(pp - pq) / Math.max(pp, pq) < 0.12) { out('power-clash'); hit(st, P, Q, 0.5, ev); hit(st, Q, P, 0.5, ev); posture(st, P, 20, ev); posture(st, Q, 20, ev); }
      else { const [W, L] = pp > pq ? [P, Q] : [Q, P]; out('overpower'); hit(st, W, L, 0.8, ev); posture(st, L, 30, ev); }
    },
    'heavy>guard': (P, Q) => { if (Q.g === 'perfect') { out('guard-held'); hit(st, P, Q, 0.3, ev); posture(st, Q, 25, ev); } else { out('guard-break'); hit(st, P, Q, 0.6, ev); posture(st, Q, 45, ev); } },
    'heavy>evade': (P, Q) => { if (rng.chance(evadeChance(st, Q, P))) { out('whiff'); st.opened[P.side] = true; hit(st, { ...Q, mv: { ...Q.mv, power: 50 } }, P, Q.g === 'perfect' ? 1.0 : 0.7, ev, 'counter'); } else { out('caught'); hit(st, P, Q, 0.9, ev); } },
    'heavy>feint': (P, Q) => { out('feint-crushed'); hit(st, P, Q, 1.3, ev); },
    'heavy>open': (P, Q) => { out('free-hit'); hit(st, P, Q, 1.4, ev); },
    'guard>guard': () => { out('standoff'); st.posture.me = Math.max(0, st.posture.me - 15); st.posture.foe = Math.max(0, st.posture.foe - 15); },
    'guard>evade': () => out('nothing'),
    'guard>feint': (P, Q) => { out('baited'); posture(st, P, Q.g === 'perfect' ? 40 : 30, ev); st.opened[P.side] = true; if (Q.mv.status) addStatus(P.f, Q.mv.status, ev); },
    'guard>open': () => out('nothing'),
    'evade>evade': () => out('nothing'),
    'evade>feint': (P, Q) => { out('baited'); posture(st, P, 20, ev); st.opened[P.side] = true; if (Q.mv.status) addStatus(P.f, Q.mv.status, ev); },
    'evade>open': () => out('nothing'),
    'feint>feint': () => out('nothing'),
    'feint>open': (P, Q) => { out('rattled'); posture(st, Q, 20, ev); },
    'open>open': () => out('nothing'),
    'finisher>strike': (P, Q) => fin(P, Q), 'finisher>heavy': (P, Q) => fin(P, Q), 'finisher>guard': (P, Q) => fin(P, Q),
    'finisher>evade': (P, Q) => fin(P, Q), 'finisher>feint': (P, Q) => fin(P, Q), 'finisher>open': (P, Q) => fin(P, Q),
  };
  const fin = (P, Q) => { out('finisher'); ev.push({ t: 'finisher', who: P.f.name, target: Q.f.name }); hit(st, { ...P, g: 'perfect' }, Q, 1, ev, 'finisher'); st.broken[Q.side] = false; st.posture[Q.side] = 30; };
  if (sx === 'finisher' && sy === 'finisher') { out('trade'); hit(st, X, Y, 0.6, ev); hit(st, Y, X, 0.6, ev); }
  else if (table[`${sx}>${sy}`]) table[`${sx}>${sy}`](X, Y);
  else if (table[`${sy}>${sx}`]) swap(table[`${sy}>${sx}`]);
  // Stance techniques add their buffs.
  for (const P of [X, Y]) if (P.mv.stages && P.mv.stance === 'guard') for (const [k, v] of Object.entries(P.mv.stages)) P.f.stages[k] = clamp((P.f.stages[k] ?? 0) + v, -4, 4);
}

function useItem(st, P, ev, inv) {
  const k = norm(P.mv.item);
  const idx = inv.findIndex(i => norm(i.name) === k || (k && norm(i.name).includes(k)));
  if (idx < 0) { ev.push({ t: 'noitem', who: P.f.name, item: P.mv.item }); return; }
  const it = inv[idx];
  const spec = it.spec ?? inferItem(it.name);
  if (!spec) { ev.push({ t: 'noitem', who: P.f.name, item: it.name, unusable: true }); return; }
  if (--it.count <= 0) inv.splice(idx, 1);
  ev.push({ t: 'item', who: P.f.name, item: it.name, kind: spec.kind });
  if (spec.kind === 'heal' || spec.kind === 'full') heal(P.f, Math.round(P.f.maxHp * (spec.kind === 'full' ? 100 : spec.amount) / 100), ev);
  if (spec.kind === 'sp') P.f.sp = Math.min(P.f.maxSp, P.f.sp + Math.round(P.f.maxSp * spec.amount / 100));
  if (spec.kind === 'cure') P.f.statuses = [];
}

function improv(st, P, Q, rng, ev) {
  const im = P.mv.improv ?? {};
  const DIFF = { trivial: 95, easy: 80, normal: 60, hard: 40, extreme: 20, impossible: 5 };
  let diff = DIFF[im.difficulty] != null ? im.difficulty : 'normal';
  const kind = im.effect?.kind ?? 'none';
  if (kind === 'yield' && !st.broken[Q.side] && Q.f.hp / Q.f.maxHp > 0.3) diff = Q.f.threat === 'boss' ? 'impossible' : 'extreme';
  const key = ['pow', 'mag', 'spd', 'acc', 'luk'].includes(im.stat) ? im.stat : 'pow';
  const ratio = E.stat(P.f, key) / Math.max(1, E.stat(Q.f, { pow: 'def', mag: 'res', spd: 'eva', acc: 'eva', luk: 'luk' }[key]));
  const chance = clamp(Math.round(DIFF[diff] * (1 + 0.35 * Math.log2(clamp(ratio, 0.05, 20)))) + ({ perfect: 15, miss: -15 }[P.g] ?? 0), 3, 97);
  const roll = rng.d100();
  const ok = roll <= chance;
  ev.push({ t: 'improv', who: P.f.name, desc: String(im.desc ?? '').slice(0, 160), difficulty: diff, chance, roll, result: ok ? 'success' : 'fail', kind });
  if (!ok) return;
  if (kind === 'damage') hit(st, { ...P, mv: { ...P.mv, power: Math.min(num(im.effect?.power, 60), 100) } }, Q, 1, ev);
  if ((kind === 'status' || kind === 'debuff') && im.effect?.status) addStatus(Q.f, { id: im.effect.status.id ?? im.effect.status, turns: 2 }, ev);
  if (kind === 'debuff' || kind === 'status') posture(st, Q, 20, ev);
  if (kind === 'yield') { Q.f.out = 'yield'; ev.push({ t: 'yield', who: Q.f.name }); }
  if (kind === 'escape' && st.flee) { st.status = 'fled'; ev.push({ t: 'flee', who: P.f.name, ok: true }); }
}

export { STANCE_EN, TELL_EN, TELL_KO, STYLE_KO };
