// Mode: 1:1 battle with Pokémon singles rules.
// One fighter per side on the field; teammates wait on the bench and can be switched in.
// When the active fighter faints the player chooses who comes out next (free action).
// The opponent's moves are not shown in advance — just like Pokémon.
import * as E from '../engine.js';
import { STATUS, inferItem, typeName, typeIn, typesFor } from '../catalog.js';
import { norm } from '../util.js';
import { splitBody, matchWord, aiLevelOf } from './shared.js';
import { vf, mapOf, skillCard, fxLine } from '../pkui.js';
import { josa } from '../narrate.js';

const KIND_KO = { physical: '물리', magic: '특수', heal: '회복', buff: '변화', debuff: '변화', guard: '방어', revive: '부활', cleanse: '회복' };
const WORDS = { attack: ['attack', '공격', '기본공격'], flee: ['flee', 'run', '도주', '도망', '도망친다'], switch: ['switch', '교체'] };

const field = (b, side) => b.fighters.find(f => f.side === side && E.onField(f));
const team = (b, side) => b.fighters.filter(f => f.side === side);

export default {
  id: 'duel', ko: '1:1 대결', icon: '🤺',

  create({ spec, profile, party, enemies, seed, settings }) {
    const b = E.createBattle({ party, enemies, profile, seed, place: spec.place, flee: spec.flee, length: Number(settings.length) || 1, aiLevel: aiLevelOf(settings), costScale: settings.spCostScale ?? 1.3, title: spec.title, terrain: spec.terrain, initiative: spec.initiative, format: 'singles' });
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
    const { what, target } = splitBody(body);
    const me = field(b, 'ally');
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

  nextHint: () => '',
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
    const foes = fo ? [vf(fo, { side: 'enemy', intel: fo.intel ?? 1, typeSystem: sys, note: fo.charging ? `⚡ ${fo.charging.skill}의 힘을 모으고 있다!` : '', noteCls: fo.charging ? 'charge' : '' })] : [];
    const allies = me ? [vf(me, { side: 'ally', typeSystem: sys, note: me.charging ? '힘을 모으는 중' : '' })] : [];
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
      const why = k.cost > me.sp ? `${sp} 부족` : cd ? `${cd}턴 후 사용` : '';
      return skillCard(k, { sys, spLabel: sp, disabled: !!why, why });
    });
    cards.push(skillCard({ ...E.basicAttack(me, b.attackName), basic: true, element: 'normal' }, { sys, spLabel: sp, act: 'm:basic', v: '' }));
    return cards;
  },

  side(b, ctx) {
    const items = (ctx.inventory ?? []).filter(i => i.count > 0);
    return [{ label: '🎒 가방', cls: 'm-bag', page: 'bag', disabled: !items.length }, { label: '🔄 교체', cls: 'm-party', page: 'switch', disabled: !E.benchOf(b, 'ally').length }, { label: '🏃 도망', cls: 'm-run', act: 'm:flee', disabled: !b.flee }];
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
    if (page === 'fight') {
      return [...me.skills.map(k => {
        const t = k.element && !['none', 'physical'].includes(k.element) ? typeIn(k.element, sys) : 'normal';
        const cd = me.cds?.[k.name] ?? 0;
        const foe = field(b, 'enemy');
        const dmg = ['physical', 'magic'].includes(k.kind) && foe ? E.elementMul(foe, k.element, b).mul : null;
        const effTxt = dmg == null ? '' : dmg === 0 ? '효과 없음' : dmg >= 2 ? `효과 굉장 ×${dmg}` : dmg < 1 ? `별로 ×${dmg}` : '';
        const est = dmg && foe ? Math.min(100, Math.round((E.estimate(b, me, foe, k) / Math.max(1, foe.hp)) * 100)) : null;
        return { fx: k.cost > me.sp ? '⚠ 기력 부족 → 과로 (HP 소모·다음 턴 탈진)' : [est != null ? `≈${est}%` : '', effTxt, fxLine(k, sys)].filter(Boolean).join(' · '), label: k.name, meta: k.cost ? `${ctx?.spLabel ?? 'SP'} ${k.cost} · ${Math.round((k.cost / Math.max(1, me.maxSp)) * 100)}%` : '무료', sub: `${typeName(k.element && !['physical', 'none'].includes(k.element) ? k.element : 'normal', sys)} · ${KIND_KO[k.kind] ?? k.kind}${k.power ? ` ${k.power}` : ''}${k.hits > 1 ? `×${k.hits}` : ''}${k.priority ? ` · 우선${k.priority > 0 ? '+' : ''}${k.priority}` : ''}${cd ? ` · ⏳${cd}` : ''}`, cls: `t-${t}`, disabled: cd > 0, act: 'm:skill', v: k.name };
      }), { label: '공격', sub: '노말 · 기본 공격', cls: 't-normal', act: 'm:basic' }, { label: '휴식', sub: `기력 +20% (${me.sp}/${me.maxSp})`, cls: 'plain', act: 'm:rest' }, { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    }
    if (page === 'bag') return [...items.map(i => { const sp = i.spec ?? inferItem(i.name); return { label: i.name, meta: `×${i.count}`, sub: sp ? ({ heal: 'HP 회복', sp: '기력 회복', full: '완전 회복', cure: '상태이상 회복', revive: '부활', damage: '공격', buff: '강화' }[sp.kind]) : '효과 불명', cls: 'plain', act: 'm:item', v: i.name }; }), { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    if (page === 'switch') return [...bench.map(mate), { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    if (me?.charging) return [{ label: `⚡ ${me.charging.skill} 발동!`, sub: '충전 완료 · 이번 턴에 자동으로 나가요', cls: 'm-fight', act: 'm:release' }];
    return [{ label: '싸운다', cls: 'm-fight', page: 'fight' }, { label: '가방', cls: 'm-bag', page: 'bag', disabled: !items.length },
      { label: '교체', cls: 'm-party', page: 'switch', disabled: !bench.length }, { label: '도망친다', cls: 'm-run', act: 'm:flee', disabled: !b.flee }];
  },

  onAct(act, v, b) {
    const me = field(b, 'ally');
    const id = me?.id ?? team(b, 'ally')[0]?.id;
    switch (act) {
      case 'm:skill': return { body: v, cmd: { actor: id, type: 'skill', skill: v } };
      case 'm:basic': return { body: '공격', cmd: { actor: id, type: 'attack' } };
      case 'm:release': return { body: '충전기 발동', cmd: { actor: id, type: 'release' } };
      case 'm:rest': return { body: '휴식', cmd: { actor: id, type: 'rest' } };
      case 'm:item': return v ? { body: `아이템 ${v}`, cmd: { actor: id, type: 'item', item: v, target: me?.name } } : null;
      case 'm:switch': return { body: `교체 → ${v}`, cmd: { actor: id, type: 'switch', target: v } };
      case 'm:flee': return { body: '도주', cmd: { actor: id, type: 'flee' } };
      default: return null;
    }
  },
};
