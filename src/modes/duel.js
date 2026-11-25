// Mode: 1:1 battle with Pokémon singles rules.
// One fighter per side on the field; teammates wait on the bench and can be switched in.
// When the active fighter faints the player chooses who comes out next (free action).
// The opponent's moves are not shown in advance — just like Pokémon.
import * as E from '../engine.js';
import { STATUS, inferItem, typeName, typeIn, typesFor } from '../catalog.js';
import { norm, hashStr } from '../util.js';
import { matchWord, aiLevelOf } from './shared.js';
import { vf, mapOf, skillCard, fxLine, skillItem } from '../pkui.js';
import { josa } from '../narrate.js';

const KIND_KO = { physical: '물리', magic: '특수', heal: '회복', buff: '변화', debuff: '변화', guard: '방어', revive: '부활', cleanse: '회복' };
const WORDS = { attack: ['attack', '공격', '기본공격'], flee: ['flee', 'run', '도주', '도망', '도망친다'], switch: ['switch', '교체'], rest: ['rest', '휴식', '숨고르기'], defend: ['defend', 'guard', '방어', '가드'] };

const field = (b, side) => b.fighters.find(f => f.side === side && E.onField(f));
const team = (b, side) => b.fighters.filter(f => f.side === side);

/**
 * Mind game: the opponent's next move is never shown, but its body language is — a vague, mostly
 * honest tell ("winding up something big", "playing it safe"). Unknown foes give nothing away,
 * and about one read in five is a bluff that reveals nothing.
 */
function tellOf(b, f, lang = 'ko') {
  if (!f || (f.intel ?? 1) === 0 || f.charging) return '';
  const it = b.intents?.[f.id];
  if (!it) return '';
  const roll = (parseInt(hashStr(`${b.seed}:tell:${b.turn}:${f.id}`).slice(-6), 36) % 100) / 100;
  const ko = lang === 'ko';
  if (roll < 0.2) return ko ? '속내를 읽을 수 없다…' : 'Their intent is impossible to read.';
  const me = field(b, 'ally');
  const sk = it.skill ? f.skills.find(k => k.name === it.skill) : null;
  let kind = 'poke';
  if (it.type === 'switch') kind = 'switch';
  else if (it.type === 'rest') kind = 'rest';
  else if (it.type === 'defend' || sk?.kind === 'guard') kind = 'guard';
  else if (sk && ['buff', 'debuff', 'heal', 'cleanse'].includes(sk.kind)) kind = 'setup';
  else if (sk && me && (sk.power >= 90 || sk.once || E.estimate(b, f, me, sk) >= me.hp * 0.45)) kind = 'big';
  const T = {
    big: ['큰 한 방을 노리는 기색이다!', 'They are clearly setting up a heavy blow.'],
    setup: ['무언가 꾸미는 기색이다…', 'They seem to be plotting something other than a straight attack.'],
    guard: ['몸을 사리며 틈을 본다.', 'They are playing it safe, guarding.'],
    switch: ['물러날 틈을 엿보는 것 같다.', 'They look ready to pull back and swap out.'],
    rest: ['숨을 고르려는 것 같다.', 'They look winded, about to catch their breath.'],
    poke: ['가볍게 견제할 생각인 듯하다.', 'They look ready to probe with a quick attack.'],
  }[kind];
  return ko ? T[0] : T[1];
}

export default {
  id: 'duel', ko: '1:1 대결', icon: '',

  create({ spec, profile, party, enemies, seed, settings }) {
    const b = E.createBattle({ party, enemies, profile, seed, place: spec.place, flee: spec.flee, length: Number(settings.length) || 1, aiLevel: aiLevelOf(settings), costScale: settings.spCostScale ?? 1.3, title: spec.title, terrain: spec.terrain, initiative: spec.initiative, format: 'singles', dealMul: settings.dealMul ?? 1, takeMul: settings.takeMul ?? 1, customPassives: settings.customPassives !== false });
    b.attackName = settings.attackName || '기본 공격';
    return b;
  },

  opening(b) {
    if (b.initiative !== 'enemy') return null;
    const r = E.resolveTurn(b, [], { ambush: true, attackName: b.attackName });
    return { st: r.battle, events: r.events };
  },

  resolve(b, commands, { inventory }) {
    const r = E.resolveTurn(b, commands, { inventory, attackName: b.attackName });
    return { st: r.battle, events: r.events, inventory: r.inventory };
  },

  controlled: b => team(b, 'ally').filter(f => f.persistent && E.active(f)),

  quick(body, b) {
    const [left, right] = String(body).split(/\s*(?:→|->|=>|>)\s*/);
    const me = field(b, 'ally');
    let what = left.trim();
    const target = right?.trim() || null;
    const cm = /^(.+?)\s*[:：]\s*(.+)$/.exec(what);
    if (cm && me && (norm(me.name) === norm(cm[1]) || norm(me.name).startsWith(norm(cm[1]))) && !E.findSkill(me, what)) {
      what = cm[2].trim();
    }
    if (b.needSwitch) {
      const to = E.findFighter(b, target ?? what.replace(/^교체\s*/, ''), { side: 'ally', bench: true });
      return { actor: me?.id ?? 'player', type: 'switch', target: to?.name ?? null };
    }
    if (!me) return null;
    const w = matchWord(what, WORDS);
    if (w === 'switch' || /^교체\s+/.test(what)) return { actor: me.id, type: 'switch', target: target ?? what.replace(/^교체\s*/, '') };
    if (w) return { actor: me.id, type: w };
    const item = /^(?:item|아이템|사용)\s+(.+)$/i.exec(what);
    if (item) return { actor: me.id, type: 'item', item: item[1].trim() };
    const sk = E.findSkill(me, what);
    return sk ? { actor: me.id, type: 'skill', skill: sk.name } : null;
  },

  local(text, b, inventory = []) {
    const me = field(b, 'ally');
    if (!me) return [];
    const k = norm(text);
    const sk = me.skills.slice().sort((a, c) => c.name.length - a.name.length).find(s => k.includes(norm(s.name)));
    if (sk) return [{ actor: me.id, type: 'skill', skill: sk.name }];
    const it = inventory.find(i => k.includes(norm(i.name)));
    if (it) return [{ actor: me.id, type: 'item', item: it.name }];
    const mate = b.fighters.find(f => f.side === 'ally' && f.bench && E.active(f) && k.includes(norm(f.name)));
    if (mate && /(교체|나와|가라|바꿔|switch)/i.test(text)) return [{ actor: me.id, type: 'switch', target: mate.name }];
    if (/(도망|도주|flee|run)/i.test(text)) return [{ actor: me.id, type: 'flee' }];
    if (/(공격|친다|때린|attack|hit)/i.test(text)) return [{ actor: me.id, type: 'attack' }];
    return [];
  },

  auxSchema(b, profile) {
    const me = field(b, 'ally');
    const bench = E.benchOf(b, 'ally');
    return `## 1-on-1 battle (Pokémon singles rules)
On the field: ${me?.name ?? '-'}. Bench: ${bench.map(f => f.name).join(', ') || 'none'}.
${me ? `Moves of ${me.name}: ${me.skills.map(k => `${k.name} [${k.kind}${k.power ? ` ${k.power}` : ''}, ${k.cost}${profile.spLabel}]`).join('; ')}` : ''}
## Action shapes (exactly one)
{"actor": "${me?.name ?? ''}", "type": "skill", "skill": "<exact move name>"}
{"actor": "${me?.name ?? ''}", "type": "attack"}
{"actor": "${me?.name ?? ''}", "type": "switch", "target": "<bench member>"}
{"actor": "${me?.name ?? ''}", "type": "item", "item": "<inventory item>"}
{"actor": "${me?.name ?? ''}", "type": "flee"}`;
  },

  mapAux(actions, b) {
    const me = field(b, 'ally');
    const a = (Array.isArray(actions) ? actions : [])[0];
    if (!a || !me) return [];
    const type = String(a.type ?? '').toLowerCase();
    if (type === 'skill') { const sk = E.findSkill(me, a.skill); return sk ? [{ actor: me.id, type: 'skill', skill: sk.name }] : []; }
    if (['attack', 'flee'].includes(type)) return [{ actor: me.id, type }];
    if (type === 'switch') return [{ actor: me.id, type: 'switch', target: String(a.target ?? '') }];
    if (type === 'item') return [{ actor: me.id, type: 'item', item: String(a.item ?? '') }];
    return [];
  },

  status(b, profile, { lang = 'en' } = {}) {
    const ko = lang === 'ko';
    const line = (f, exact) => `${f.name}${f.tier ? ` [${f.tier}]` : ''}${typesFor(f, b.typeSystem).length ? ` (${typesFor(f, b.typeSystem).map(t => typeName(t, b.typeSystem)).join('/')})` : ''}: ${f.down ? (ko ? '기절' : 'FAINTED') : exact ? `${profile.hpLabel} ${f.hp}/${f.maxHp}, ${profile.spLabel} ${f.sp}/${f.maxSp}` : `${profile.hpLabel} ${Math.round(f.hp / f.maxHp * 100)}%`}${f.statuses?.length ? ` | ${f.statuses.map(s => (ko ? STATUS[s.id]?.ko : STATUS[s.id]?.en)).join(' ')}` : ''}${f.bench && !f.down ? (ko ? ' (대기)' : ' (bench)') : ''}`;
    return [ko ? '[1:1 대결]' : '[1-on-1 battle, singles rules]',
      ...team(b, 'ally').map(f => `- ${line(f, true)}`), ...team(b, 'enemy').map(f => `- ${line(f, (f.intel ?? 1) >= 2)}`)].join('\n');
  },

  nextHint(b, lang = 'en') {
    const fo = field(b, 'enemy');
    const t = tellOf(b, fo, lang);
    return t ? `${fo.name}: ${t}` : '';
  },
  timingPlan: () => [],
  applyGrades: cmd => cmd,
  autoGrades: () => ({}),
  results: b => b.fighters.filter(f => f.persistent).map(f => ({ id: f.id, hp: f.hp, sp: f.sp, down: f.down })),
  enemiesOf: b => team(b, 'enemy'),
  threat: b => E.threatOf(b),

  view(b, profile, ctx) {
    const sys = b.typeSystem;
    const fo = field(b, 'enemy'), me = field(b, 'ally');
    const balls = side => team(b, side).map(f => (f.down ? 'x' : f.bench ? 'o' : '*'));
    const foes = fo ? [vf(fo, { side: 'enemy', intel: fo.intel ?? 1, typeSystem: sys, spLabel: profile.spLabel, note: fo.charging ? `${fo.charging.skill}의 힘을 모으고 있다!` : tellOf(b, fo, 'ko'), noteCls: fo.charging ? 'charge' : 'tell' })] : [];
    const allies = me ? [vf(me, { side: 'ally', typeSystem: sys, spLabel: profile.spLabel, note: me.charging ? '힘을 모으는 중' : '' })] : [];
    const intro = [];
    const lead = team(b, 'enemy')[0];
    if (lead) intro.push(`${josa(lead.name, '이', '가')} 승부를 걸어왔다!`);
    if (team(b, 'enemy').length > 1) intro.push(`상대는 ${team(b, 'enemy').length}명으로 맞선다!`);
    if (team(b, 'ally')[0]) intro.push(`가라! ${team(b, 'ally')[0].name}!`);
    const idle = b.needSwitch ? '다음은 누구를 내보낼까?' : me ? `${josa(me.name, '은', '는')} 무엇을 할까?` : '';
    return { foes, allies, idle, intro, foeBalls: balls('enemy'), allyBalls: balls('ally'), map: mapOf(b.place, 'duel') };
  },

  cards(b, ctx) {
    const me = field(b, 'ally');
    if (!me || b.needSwitch) return [];
    const sys = b.typeSystem, sp = ctx.spLabel ?? 'SP';
    const cards = me.skills.map(k => {
      const cd = me.cds?.[k.name] ?? 0;
      const why = k.once && me.used?.[k.name] ? '이번 전투에 이미 씀' : k.cost > me.sp ? `${sp} 부족` : cd ? `${cd}턴 후 사용` : '';
      return skillCard(k, { sys, spLabel: sp, disabled: !!why, why });
    });
    cards.push(skillCard({ ...E.basicAttack(me, b.attackName), basic: true, element: 'normal' }, { sys, spLabel: sp, act: 'm:basic', v: '' }));
    return cards;
  },

  side(b, ctx) {
    const items = (ctx.inventory ?? []).filter(i => i.count > 0);
    return [{ label: '가방', cls: 'm-bag', page: 'bag', disabled: !items.length }, { label: '교체', cls: 'm-party', page: 'switch', disabled: !E.benchOf(b, 'ally').length }, { label: '도망', cls: 'm-run', act: 'm:flee', disabled: !b.flee }];
  },

  forced: b => (b.needSwitch ? 'switch' : null),

  peek(b, item, ctx) {
    return this.cards(b, ctx).find(c => c.act === item.act && (item.act === 'm:basic' || c.v === item.v)) ?? null;
  },

  order(b) {
    return b.fighters.filter(f => E.onField(f)).map(f => ({ name: f.name, side: f.side, raw: E.stat(f, 'spd'), spd: f.side === 'enemy' && (f.intel ?? 1) === 0 ? '?' : Math.round(E.stat(f, 'spd')) })).sort((a, c) => c.raw - a.raw);
  },

  menu(b, page, ctx) {
    const me = field(b, 'ally');
    const bench = E.benchOf(b, 'ally');
    const items = (ctx.inventory ?? []).filter(i => i.count > 0);
    const sys = b.typeSystem;
    const mate = f => ({ label: f.name, meta: `${f.hp}/${f.maxHp}`, sub: `${typesFor(f, sys).map(t => typeName(t, sys)).join('/') || '-'}${f.statuses?.length ? ` · ${f.statuses.map(s => STATUS[s.id]?.ko).join(' ')}` : ''}`, cls: 'plain', act: 'm:switch', v: f.name });
    if (b.needSwitch) return bench.map(mate);
    if (!me) return [];
    const foe = field(b, 'enemy');
    const main = () => [
      ...me.skills.map(k => skillItem(k, { actor: me, b, sys, foe, cd: me.cds?.[k.name] ?? 0, used: !!(k.once && me.used?.[k.name]) })),
      { bar: true, label: '공격', act: 'm:basic', title: '노말 · 기본 공격 (무료)' },
      { bar: true, label: '방어', act: 'm:defend', title: '받는 피해 ½ · 기력 +5%' },
      { bar: true, label: '휴식', act: 'm:rest', title: `기력 +20% (${me.sp}/${me.maxSp})` },
      { bar: true, sep: true, label: '가방', page: 'bag', disabled: !items.length, title: '가방' },
      { bar: true, label: '교체', page: 'switch', disabled: !bench.length, title: '교체' },
      { bar: true, label: '도망', act: 'm:flee', disabled: !b.flee, title: '도망' },
    ];
    if (me?.charging) return [{ label: `${me.charging.skill} 발동`, sub: '충전 완료 · 이번 턴에 자동으로 나가요', cls: 'm-fight', act: 'm:release' }];
    if (page === 'main' || page === 'fight') return main();
    if (page === 'bag') return [...items.map(i => { const sp = i.spec ?? inferItem(i.name); return { label: i.name, meta: `×${i.count}`, sub: sp ? ({ heal: 'HP 회복', sp: '기력 회복', full: '완전 회복', cure: '상태이상 회복', revive: '부활', damage: '공격', buff: '강화' }[sp.kind]) : '효과 불명', cls: 'plain', act: 'm:item', v: i.name }; }), { label: '돌아가기', cls: 'back', page: 'main' }];
    if (page === 'switch') return [...bench.map(mate), { label: '돌아가기', cls: 'back', page: 'main' }];
    return main();
  },

  onAct(act, v, b) {
    const me = field(b, 'ally');
    const id = me?.id ?? team(b, 'ally')[0]?.id;
    switch (act) {
      case 'm:skill': return { body: v, cmd: { actor: id, type: 'skill', skill: v } };
      case 'm:basic': return { body: '공격', cmd: { actor: id, type: 'attack' } };
      case 'm:defend': return { body: '방어', cmd: { actor: id, type: 'defend' } };
      case 'm:release': return { body: '충전기 발동', cmd: { actor: id, type: 'release', skill: me?.charging?.skill } };
      case 'm:rest': return { body: '휴식', cmd: { actor: id, type: 'rest' } };
      case 'm:item': return v ? { body: `아이템 ${v}`, cmd: { actor: id, type: 'item', item: v, target: me?.name } } : null;
      case 'm:switch': return { body: `교체 → ${v}`, cmd: { actor: id, type: 'switch', target: v } };
      case 'm:flee': return { body: '도주', cmd: { actor: id, type: 'flee' } };
      default: return null;
    }
  },
};
