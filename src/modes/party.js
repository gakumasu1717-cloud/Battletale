// Mode: party turn-based battle (JRPG / Darkest Dungeon / Slay the Spire flavored).
import * as E from '../engine.js';
import { STATUS, DERIVED_KO, ELEMENT_KO, THREAT_KO, inferItem, typeName, typeIn, typesFor } from '../catalog.js';
import { escapeHtml as h, pct, norm, clamp } from '../util.js';
import { splitBody, autoGrade, seededRng, timingFor, matchWord, fxHtml, aiLevelOf } from './shared.js';
import { vf, mapOf, skillCard, fxLine } from '../pkui.js';
import { josa } from '../narrate.js';

const profile_sp = ctx => ctx?.spLabel ?? 'SP';
const KIND_KO = { physical: '물리', magic: '마법', heal: '회복', buff: '강화', debuff: '약화', guard: '방어', revive: '부활', cleanse: '정화' };
const TARGET_KO = { enemy: '적 1', enemies: '적 전체', ally: '아군 1', allies: '아군 전체', self: '자신' };
const WORDS = {
  attack: ['attack', 'basic', '공격', '기본공격', '평타'], defend: ['defend', 'guard', 'block', '방어', '막기', '가드'], rest: ['rest', '휴식', '쉰다', '숨고르기'],
  flee: ['flee', 'run', 'escape', '도주', '도망', '후퇴'], wait: ['wait', 'pass', '대기'],
  swap: ['swap', 'move', 'switch', '위치변경', '자리바꾸기', '이동', '전열', '후열'], scan: ['scan', 'analyze', 'observe', '관찰', '분석', '간파', '정찰'],
};

export const playerOf = b => b.fighters.find(f => f.isPlayer) ?? b.fighters.find(f => f.side === 'ally' && f.persistent);

function intentOf(b, f, lang = 'ko') {
  const it = b.intents?.[f.id];
  if (!it) return null;
  const ko = lang === 'ko';
  const tgt = it.target ? E.byId(b, it.target) : null;
  const sk = it.skill ? E.findSkill(f, it.skill) : null;
  const est = sk && tgt ? Math.round(E.estimate(b, f, tgt, sk)) : it.type === 'attack' && tgt ? Math.round(E.estimate(b, f, tgt, E.basicAttack(f))) : null;
  const lvl = f.intel ?? 1;
  const to = tgt && lvl >= 1 ? (ko ? ` → ${tgt.name}` : ` at ${tgt.name}`) : '';
  const num = lvl >= 2 && est ? (ko ? ` (~${est})` : ` (~${est} dmg)`) : '';
  switch (it.type) {
    case 'surprised': return ko ? '😵 기습당해 대응 불가' : 'caught off guard, cannot act this turn';
    case 'stagger': return ko ? '💫 비틀거림 (행동 불가)' : 'staggered, cannot act this turn';
    case 'charge': return ko ? `⚡ 충전 시작: ${lvl >= 1 ? `「${it.skill}」` : '강력한 기술'}${to} — 다음 턴 발동` : `begins charging ${lvl >= 1 ? `"${it.skill}"` : 'a powerful technique'}${to}; it fires next turn unless broken`;
    case 'release': {
      const thr = f.charging ? f.charging.threshold - f.charging.taken : null;
      return ko ? `⚡⚡ 「${it.skill}」 발동!${to}${num}${thr ? ` · ${thr} 이상 피해/기절로 차단` : ''}` : `UNLEASHES the charged "${it.skill}"${to}${num}${thr ? `; dealing ${thr}+ damage or stunning it first will break it` : ''}`;
    }
    case 'defend': return ko ? '🛡️ 방어 태세' : 'will defend';
    case 'swap': return ko ? '↔ 위치 이동' : 'will change position';
    case 'attack': return lvl >= 1 ? (ko ? `🗡️ 공격${to}${num}` : `basic attack${to}${num}`) : (ko ? '🗡️ 공격 준비' : 'preparing to attack');
    case 'skill': {
      const k = sk?.kind ?? 'physical';
      if (lvl === 0) return ko ? ({ heal: '✚ 회복 준비', buff: '✨ 무언가 준비', debuff: '☠ 방해 준비', guard: '🛡️ 방어 준비' }[k] ?? '🗡️ 공격 준비') : ({ heal: 'preparing to heal', buff: 'preparing something', debuff: 'preparing a hindrance' }[k] ?? 'preparing to attack');
      return ko ? `${{ heal: '✚', buff: '✨', debuff: '☠', guard: '🛡️' }[k] ?? '🗡️'} 「${it.skill}」${to}${num}` : `"${it.skill}"${to}${num}`;
    }
    default: return null;
  }
}

function statusLine(f, profile, lang) {
  const ko = lang === 'ko';
  const state = f.out ? (ko ? (f.out === 'yield' ? '항복' : '도주') : f.out === 'yield' ? 'YIELDED' : 'FLED') : f.down ? (ko ? '전투불능' : 'DOWN') : null;
  const lvl = f.side === 'ally' ? 2 : f.intel ?? 1;
  const hp = lvl >= 2 ? `${profile.hpLabel} ${f.hp}/${f.maxHp}` : lvl === 1 ? `${profile.hpLabel} ${pct(f.hp, f.maxHp)}%` : `${profile.hpLabel} ${f.hp / f.maxHp > 0.66 ? (ko ? '멀쩡함' : 'healthy') : f.hp / f.maxHp > 0.33 ? (ko ? '다침' : 'wounded') : (ko ? '빈사' : 'near death')}`;
  const sp = f.side === 'ally' ? `, ${profile.spLabel} ${f.sp}/${f.maxSp}` : '';
  const sts = f.statuses?.map(s => `${ko ? STATUS[s.id]?.ko : STATUS[s.id]?.en}(${s.turns})`).join(' ');
  const row = ko ? (f.row === 'back' ? '후열' : '전열') : f.row;
  return `${f.name}${f.tier ? ` [${f.tier}]` : ''} <${row}>: ${state ?? `${hp}${sp}`}${sts ? ` | ${sts}` : ''}${f.charging ? (ko ? ' | ⚡충전 중' : ' | CHARGING') : ''}`;
}

export default {
  id: 'party', ko: '파티 턴제', icon: '⚔️',

  create({ spec, profile, party, allies, enemies, seed, settings }) {
    const b = E.createBattle({ party, allies, enemies, profile, seed, place: spec.place, flee: spec.flee, length: Number(settings.length) || 1, aiLevel: aiLevelOf(settings), costScale: settings.spCostScale ?? 1.3, title: spec.title, terrain: spec.terrain, initiative: spec.initiative });
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

  controlled: b => b.fighters.filter(f => f.side === 'ally' && f.persistent && E.active(f)),

  quick(body, b) {
    const { who, what, target } = splitBody(body);
    const me = playerOf(b);
    const actor = (who && E.findFighter(b, who, { side: 'ally' })) || me;
    if (!actor) return null;
    const base = { actor: actor.id, target };
    const w = matchWord(what, WORDS);
    if (w) return { ...base, type: w };
    const item = /^(?:item|아이템|사용)\s+(.+)$/i.exec(what);
    if (item) return { ...base, type: 'item', item: item[1].trim() };
    const sk = E.findSkill(actor, what);
    if (sk) return { ...base, type: 'skill', skill: sk.name };
    return { ...base, type: 'improvise', improv: { desc: what, stat: 'pow', difficulty: 'normal', effect: { kind: 'damage', power: 50 } } };
  },

  local(text, b, inventory = []) {
    const t = String(text ?? ''), k = norm(t);
    const me = playerOf(b);
    if (!me || !E.active(me)) return [];
    const foes = b.fighters.filter(f => f.side === 'enemy' && E.active(f));
    const target = foes.find(f => k.includes(norm(f.name)) || (f.name.split(/\s+/)[0].length >= 2 && k.includes(norm(f.name.split(/\s+/)[0]))));
    const skill = me.skills.slice().sort((a, c) => c.name.length - a.name.length).find(s => k.includes(norm(s.name)));
    if (skill) return [{ actor: me.id, type: 'skill', skill: skill.name, target: target?.name ?? null }];
    const item = inventory.find(i => k.includes(norm(i.name)));
    if (item && /(사용|먹|마시|던지|꺼내|use|drink|throw)/i.test(t)) return [{ actor: me.id, type: 'item', item: item.name }];
    if (/(도망|도주|후퇴|퇴각|달아나|flee|run away|escape|retreat)/i.test(t)) return [{ actor: me.id, type: 'flee' }];
    if (/(관찰|분석|살핀|간파|약점을 찾|observe|analy[sz]e|scan)/i.test(t)) return [{ actor: me.id, type: 'scan', target: target?.name ?? null }];
    if (/(뒤로 물러|후열|앞으로 나서|전열|자리를 바꾸|swap|step back|step forward)/i.test(t)) return [{ actor: me.id, type: 'swap' }];
    if (/(휴식|쉰다|숨을 고|숨고르|rest)/i.test(t)) return [{ actor: me.id, type: 'rest' }];
    if (/(방어|막는|막아|가드|버틴|defend|guard|block|brace)/i.test(t)) return [{ actor: me.id, type: 'defend' }];
    if (/(공격|친다|때린|벤다|베어|찌른|쏜다|쏘|휘두|내리찍|attack|strike|hit|slash|shoot|stab|punch|kick)/i.test(t)) return [{ actor: me.id, type: 'attack', target: target?.name ?? null }];
    return [];
  },

  auxSchema(b, profile) {
    const actors = this.controlled(b).map(f => `- ${f.name} <${f.row}>: skills ${f.skills.map(k => `${k.name} [${k.kind}${k.power ? ` ${k.power}` : ''}, ${k.range}, ${k.cost}${profile.spLabel}${k.desc ? `, ${k.desc}` : ''}]`).join('; ') || 'none'}`).join('\n');
    return `## Player-controlled characters
${actors}

## Action shapes (one per character)
{"actor": "<name>", "type": "skill", "skill": "<exact skill name>", "target": "<name or empty>"}
{"actor": "<name>", "type": "attack", "target": "<name>"}
{"actor": "<name>", "type": "defend"}
{"actor": "<name>", "type": "rest"}   // skip the turn to recover resource (+20%)
{"actor": "<name>", "type": "scan", "target": "<enemy>"}        // study an enemy to learn its HP, skills and weaknesses
{"actor": "<name>", "type": "swap", "target": "<ally or empty>"}  // switch between front and back row
{"actor": "<name>", "type": "item", "item": "<inventory item>", "target": "<name>"}
{"actor": "<name>", "type": "flee"}
{"actor": "<name>", "type": "improvise", "target": "<name or empty>", "improv": {"desc": "", "stat": "pow|mag|spd|acc|def|res|luk", "difficulty": "trivial|easy|normal|hard|extreme|impossible", "effect": {"kind": "damage|status|debuff|buff|advantage|heal|cleanse|yield|escape|interrupt|none", "power": 0-130, "element": "", "status": {"id": "", "turns": 2}, "stages": {}}}}
Melee skills only reach the enemy front row while it stands. "interrupt" = an attempt to stop an enemy's charging technique.`;
  },

  mapAux(actions, b) {
    const me = playerOf(b);
    const out = [], used = new Set();
    for (const a of Array.isArray(actions) ? actions : []) {
      if (!a || typeof a !== 'object') continue;
      const who = (a.actor && E.findFighter(b, a.actor, { side: 'ally' })) || me;
      if (!who?.persistent || used.has(who.id)) continue;
      const type = String(a.type ?? '').toLowerCase();
      const base = { actor: who.id, target: a.target ? String(a.target) : null };
      if (type === 'skill') {
        const sk = E.findSkill(who, a.skill);
        out.push(sk ? { ...base, type: 'skill', skill: sk.name } : { ...base, type: 'improvise', improv: { desc: String(a.skill ?? ''), stat: 'pow', difficulty: 'hard', effect: { kind: 'damage', power: 60 } } });
      } else if (['attack', 'defend', 'rest', 'flee', 'wait', 'scan', 'swap'].includes(type)) out.push({ ...base, type });
      else if (type === 'item') out.push({ ...base, type: 'item', item: String(a.item ?? '') });
      else if (type === 'improvise' && a.improv) out.push({ ...base, type: 'improvise', improv: a.improv });
      else continue;
      used.add(who.id);
    }
    return out;
  },

  status(b, profile, { lang = 'en' } = {}) {
    const ko = lang === 'ko';
    const lines = [ko ? '[아군]' : "[{{user}}'s side]"];
    for (const f of b.fighters.filter(x => x.side === 'ally')) {
      lines.push(`- ${statusLine(f, profile, lang)}${E.active(f) && f.persistent ? ` | ${ko ? '기술' : 'skills'}: ${f.skills.map(s => `${s.name}(${s.cost})`).join(', ')}` : ''}`);
    }
    lines.push(ko ? '[적]' : '[Enemies]');
    for (const f of b.fighters.filter(x => x.side === 'enemy')) {
      const known = (f.intel ?? 1) >= 2 ? f.skills.map(s => s.name) : f.revealed ?? [];
      lines.push(`- ${statusLine(f, profile, lang)}${known.length && E.active(f) ? ` | ${ko ? '알려진 기술' : 'known skills'}: ${known.join(', ')}` : ''}${(f.intel ?? 1) >= 2 && f.weak?.length ? ` | ${ko ? '약점' : 'weak to'}: ${f.weak.join(', ')}` : ''}`);
    }
    if (b.terrain?.length) lines.push(`${ko ? '[지형]' : '[Terrain]'} ${b.terrain.map(t => t.desc).filter(Boolean).join(', ')}`);
    return lines.join('\n');
  },

  /** What enemies are about to do — the narration should foreshadow it. */
  nextHint(b, lang = 'en') {
    if (b.status !== 'active') return '';
    const lines = b.fighters.filter(f => f.side === 'enemy' && E.active(f)).map(f => { const t = intentOf(b, f, lang); return t ? `- ${f.name}: ${t}` : null; }).filter(Boolean);
    return lines.join('\n');
  },

  /** Minigames the panel should run for this command. */
  timingPlan(b, cmd) {
    const steps = [];
    const actor = E.byId(b, cmd.actor);
    if (!actor) return steps;
    const sk = cmd.type === 'skill' ? E.findSkill(actor, cmd.skill) : cmd.type === 'attack' ? E.basicAttack(actor) : null;
    if (sk && ['physical', 'magic'].includes(sk.kind)) {
      const foe = E.findFighter(b, cmd.target, { side: 'enemy' }) ?? b.fighters.find(f => f.side === 'enemy' && E.active(f));
      const ratio = foe ? E.stat(actor, 'acc') / Math.max(1, E.stat(foe, 'eva')) : 1;
      steps.push({ key: 'attack', label: `🗡️ 「${sk.name}」 공격 타이밍`, beats: clamp(sk.hits, 1, 4), ...timingFor(ratio) });
    } else if (cmd.type === 'improvise') steps.push({ key: 'attack', label: '✨ 즉흥 행동 타이밍', beats: 1, ...timingFor(1) });
    // React to every announced attack aimed at this character (max 3).
    let n = 0;
    for (const f of b.fighters.filter(x => x.side === 'enemy' && E.active(x))) {
      const it = b.intents?.[f.id];
      if (!it || !['attack', 'skill', 'release'].includes(it.type)) continue;
      const s2 = it.type === 'attack' ? E.basicAttack(f) : E.findSkill(f, it.skill);
      if (!s2 || !['physical', 'magic'].includes(s2.kind)) continue;
      if (!(it.target === actor.id || s2.target === 'enemies')) continue;
      if (n++ >= 3) break;
      const ratio = E.stat(actor, 'spd') / Math.max(1, E.stat(f, 'spd'));
      const fast = it.type === 'release' ? { speed: 0.75, zone: 0.16 } : {};
      steps.push({ key: `def:${f.id}`, label: `🛡️ ${f.name}의 ${it.type === 'attack' ? '공격' : `「${it.skill}」`} 패링`, beats: 1, ...timingFor(ratio, fast) });
    }
    return steps;
  },

  applyGrades(cmd, grades) {
    if (!grades) return cmd;
    const out = { ...cmd };
    if (grades.attack) out.grades = [].concat(grades.attack);
    const def = {};
    for (const [k, v] of Object.entries(grades)) if (k.startsWith('def:')) def[k.slice(4)] = Array.isArray(v) ? v[0] : v;
    if (Object.keys(def).length) out.defense = def;
    return out;
  },

  autoGrades(b, cmd) {
    const steps = this.timingPlan(b, cmd);
    const rng = seededRng(b.seed, 'auto', b.turn, cmd.actor);
    const out = {};
    const actor = E.byId(b, cmd.actor);
    for (const s of steps) {
      const foeId = s.key.startsWith('def:') ? s.key.slice(4) : null;
      const foe = foeId ? E.byId(b, foeId) : null;
      const ratio = foe ? E.stat(actor, 'spd') / Math.max(1, E.stat(foe, 'spd')) : 1;
      const g = Array.from({ length: s.beats }, () => autoGrade(rng, ratio));
      out[s.key] = s.key === 'attack' ? g : g[0];
    }
    return out;
  },

  results: b => b.fighters.filter(f => f.persistent).map(f => ({ id: f.id, hp: f.hp, sp: f.sp, down: f.down })),
  enemiesOf: b => b.fighters.filter(f => f.side === 'enemy'),
  threat: b => E.threatOf(b),

  render(b, profile, ctx) {
    const { ui, busy, inventory } = ctx;
    const allies = b.fighters.filter(f => f.side === 'ally');
    const enemies = b.fighters.filter(f => f.side === 'enemy');
    const controlled = this.controlled(b);
    const actorId = ui.actor && controlled.some(f => f.id === ui.actor) ? ui.actor : (playerOf(b)?.id ?? controlled[0]?.id);
    const actor = E.byId(b, actorId);
    const foes = enemies.filter(E.active);
    const target = ui.target && b.fighters.some(f => f.name === ui.target && E.active(f)) ? ui.target : foes[0]?.name;
    const card = (f) => {
      const lvl = f.side === 'ally' ? 2 : f.intel ?? 1;
      const state = f.out ? (f.out === 'yield' ? '항복' : '도주') : f.down ? '전투불능' : '';
      const hpLabel = lvl >= 2 ? `${profile.hpLabel} ${f.hp}/${f.maxHp}` : lvl === 1 ? `${profile.hpLabel} ${pct(f.hp, f.maxHp)}%` : `${profile.hpLabel} ???`;
      const intent = f.side === 'enemy' && E.active(f) ? intentOf(b, f, 'ko') : null;
      const known = f.side === 'enemy' ? (lvl >= 2 ? f.skills.map(s => s.name) : f.revealed ?? []) : [];
      return `<div class="bt-fighter ${E.active(f) ? '' : 'bt-dead'} ${f.side} ${f.name === target && f.side === 'enemy' ? 'bt-targeted' : ''}" data-act="m:target" data-v="${h(f.name)}">${fxHtml(ctx, f.name)}
        <div class="bt-fname">${h(f.name)} <small>[${h(f.tier || '?')}]</small> <small class="bt-row-tag">${f.row === 'back' ? '후열' : '전열'}</small>${typesFor(f, b.typeSystem).map(e => `<small class="bt-type t-${typeIn(e, b.typeSystem)}">${h(typeName(e, b.typeSystem))}</small>`).join('')}${f.threat && f.threat !== 'normal' ? ` <small class="bt-threat ${f.threat}">${THREAT_KO[f.threat]}</small>` : ''}${state ? ` <small class="bt-state">${state}</small>` : ''}${f.side === 'enemy' ? ` <small class="bt-intel">${['정보 없음', '관찰됨', '분석 완료'][lvl]}</small>` : ''}</div>
        <div class="bt-bar hp"><div style="width:${lvl === 0 ? 100 : pct(f.hp, f.maxHp)}%;${lvl === 0 ? 'opacity:.35' : ''}"></div><span>${h(hpLabel)}</span></div>
        ${f.side === 'ally' ? `<div class="bt-bar sp"><div style="width:${pct(f.sp, f.maxSp)}%"></div><span>${h(profile.spLabel)} ${f.sp}/${f.maxSp}</span></div>` : ''}
        <div class="bt-chips">${(f.statuses ?? []).map(s => `<span class="bt-chip ${STATUS[s.id]?.good ? 'good' : 'bad'}">${h(STATUS[s.id]?.ko)} ${s.turns}</span>`).join('')}${Object.entries(f.stages ?? {}).filter(([, v]) => v).map(([k, v]) => `<span class="bt-chip ${v > 0 ? 'good' : 'bad'}">${h(DERIVED_KO[k] ?? k)}${v > 0 ? '▲' : '▼'}${Math.abs(v)}</span>`).join('')}${lvl >= 2 && f.side === 'enemy' && f.weak?.length ? `<span class="bt-chip info">약점 ${f.weak.map(e => ELEMENT_KO[e] ?? e).join('/')}</span>` : ''}</div>
        ${intent ? `<div class="bt-intent ${b.intents[f.id]?.type}">${h(intent)}</div>` : ''}
        ${known.length && E.active(f) ? `<div class="bt-note">기술: ${known.map(h).join(', ')}</div>` : ''}
      </div>`;
    };
    const skills = actor && E.active(actor) ? actor.skills.map(k => {
      const cd = actor.cds?.[k.name] ?? 0;
      const off = k.cost > actor.sp || cd > 0 || busy;
      return `<button class="bt-skill ${k.kind}" data-act="m:skill" data-v="${h(k.name)}" ${off ? 'disabled' : ''} title="${h(k.desc || '')}"><b>${h(k.name)}</b><small>${k.element && !['none', 'physical'].includes(k.element) ? `${h(typeName(k.element, b.typeSystem))} · ` : ''}${KIND_KO[k.kind] ?? k.kind}${k.power ? ` ${k.power}` : ''}${k.hits > 1 ? `×${k.hits}` : ''}${k.priority ? ` · 우선${k.priority > 0 ? '+' : ''}${k.priority}` : ''} · ${k.range === 'melee' ? '근접' : '원거리'} · ${TARGET_KO[k.target] ?? ''} · ${k.cost}${h(profile.spLabel)}${cd ? ` · ⏳${cd}` : ''}</small></button>`;
    }).join('') : '<div class="bt-note">행동할 수 있는 캐릭터가 없어요.</div>';
    const items = (inventory ?? []).filter(i => i.count > 0);
    const dis = busy ? 'disabled' : '';
    return `<div class="bt-section"><div class="bt-sub">적 <small>(카드를 눌러 대상 지정)</small></div>${enemies.map(card).join('')}</div>
      <div class="bt-section"><div class="bt-sub">아군</div>${allies.map(card).join('')}</div>
      <div class="bt-section bt-actions">
        <div class="bt-row">${controlled.length > 1 ? `<label>행동<select data-act="m:actor">${controlled.map(f => `<option value="${h(f.id)}" ${f.id === actorId ? 'selected' : ''}>${h(f.name)}</option>`).join('')}</select></label>` : ''}
          <label>대상<select data-act="m:target-select">${b.fighters.filter(E.active).map(f => `<option ${f.name === target ? 'selected' : ''}>${h(f.name)}</option>`).join('')}</select></label></div>
        <div class="bt-skills">${skills}</div>
        <div class="bt-row bt-wrap">
          <button class="menu_button" data-act="m:basic" ${dis}>🗡️ 공격</button>
          <button class="menu_button" data-act="m:defend" ${dis}>🛡️ 방어</button>
          <button class="menu_button" data-act="m:scan" ${dis}>🔍 관찰</button>
          <button class="menu_button" data-act="m:swap" ${dis}>↔ ${actor?.row === 'back' ? '전열로' : '후열로'}</button>
          <button class="menu_button" data-act="m:flee" ${busy || !b.flee ? 'disabled' : ''}>🏃 도주</button>
        </div>
        ${items.length ? `<div class="bt-row"><select id="bt-item">${items.map(i => `<option value="${h(i.name)}">${h(i.name)} ×${i.count}${inferItem(i.name) || i.spec ? '' : ' (?)'}</option>`).join('')}</select><button class="menu_button" data-act="m:item" ${dis}>🎒 사용</button></div>` : ''}
        <div class="bt-row"><input type="text" class="text_pole" id="bt-free" data-enter="m:free" placeholder="즉흥 행동 (예: 기둥을 무너뜨려 깔아뭉갠다)"><button class="menu_button" data-act="m:free" ${dis}>✨</button></div>
      </div>`;
  },

  /** Pokémon-style scene description. */
  view(b, profile, ctx) {
    const sys = b.typeSystem;
    const actor = this.actorOf(b, ctx.ui);
    const tgt = ctx.ui.target;
    const foes = b.fighters.filter(f => f.side === 'enemy').map(f => {
      const it = E.active(f) ? intentOf(b, f, 'ko') : '';
      return vf(f, { side: 'enemy', intel: f.intel ?? 1, typeSystem: sys, note: it, noteCls: b.intents?.[f.id]?.type ?? '', selected: f.name === tgt });
    });
    const allies = b.fighters.filter(f => f.side === 'ally').map(f => vf(f, { side: 'ally', typeSystem: sys, selected: actor?.id === f.id && this.controlled(b).length > 1, note: f.row === 'back' ? '후열' : '' }));
    const names = b.fighters.filter(f => f.side === 'enemy').map(f => f.name);
    const intro = [names.length === 1 ? `${josa(names[0], '이', '가')} 나타났다!` : names.length === 2 ? `${josa(names[0], '과', '와')} ${josa(names[1], '이', '가')} 나타났다!` : `${names[0]} 외 ${names.length - 1}명이 나타났다!`];
    return { foes, allies, intro, map: mapOf(b.place, 'party'), idle: actor ? `${josa(actor.name, '은', '는')} 무엇을 할까?` : '행동할 수 있는 동료가 없다…' };
  },

  /** LoR-style hand for the acting character. */
  cards(b, ctx) {
    const actor = this.actorOf(b, ctx.ui);
    if (!actor) return [];
    const sys = b.typeSystem, sp = ctx.spLabel ?? 'SP';
    const reach = k => E.reachable(b, actor, k).map(f => f.name);
    const allies = b.fighters.filter(f => f.side === 'ally' && E.onField(f)).map(f => f.name);
    const silenced = actor.statuses.some(x => x.id === 'silence');
    const cards = actor.skills.map(k => {
      const cd = actor.cds?.[k.name] ?? 0;
      const why = k.cost > actor.sp ? `${sp} 부족` : cd ? `${cd}턴 후 사용` : silenced && k.kind === 'magic' ? '침묵' : '';
      return skillCard(k, { sys, spLabel: sp, targets: k.target === 'enemy' ? reach(k) : k.target === 'ally' ? allies : null, disabled: !!why, why, extra: k.kind === 'physical' && k.range === 'melee' && b.fighters.some(f => f.side === 'enemy' && E.onField(f) && f.row === 'back') ? ['근접 (전열만)'] : [] });
    });
    const basic = E.basicAttack(actor, b.attackName);
    cards.push(skillCard({ ...basic, basic: true }, { sys, spLabel: sp, targets: reach(basic), act: 'm:basic', v: '' }));
    cards.push({ name: '방어', cost: 0, type: 'normal', typeLabel: '', kind: 'guard', icon: '⛨', kindLabel: '방어', power: null, lines: ['받는 피해 ½', `${sp} +10%`], rarity: 'paper', act: 'm:defend', v: '', target: null });
    return cards;
  },

  side(b, ctx) {
    const items = (ctx.inventory ?? []).filter(i => i.count > 0);
    return [{ label: '🎒 가방', cls: 'm-bag', page: 'bag', disabled: !items.length }, { label: '👥 동료·위치', cls: 'm-party', page: 'party' }, { label: '🏃 도망', cls: 'm-run', act: 'm:flee', disabled: !b.flee }];
  },

  actors(b, ctx) {
    const c = this.controlled(b).filter(E.active);
    if (c.length < 2) return '';
    const cur = this.actorOf(b, ctx.ui);
    return `<div class="lr-actors">${c.map(f => `<button class="lr-actor ${f.id === cur?.id ? 'on' : ''}" data-act="pk:actor" data-v="${h(f.id)}">${h(f.name)} <small>${f.hp}/${f.maxHp}</small></button>`).join('')}</div>`;
  },

  peek(b, item, ctx) {
    return this.cards(b, ctx).find(c => c.act === item.act && (item.act === 'm:basic' || c.v === item.v)) ?? null;
  },

  order(b) {
    return b.fighters.filter(f => E.onField(f)).map(f => ({ name: f.name, side: f.side, raw: E.stat(f, 'spd'), spd: f.side === 'enemy' && (f.intel ?? 1) === 0 ? '?' : Math.round(E.stat(f, 'spd')) }))
      .sort((a, c) => c.raw - a.raw);
  },

  actorOf(b, ui) {
    const c = this.controlled(b);
    return c.find(f => f.id === ui?.actor) ?? c.find(f => f.isPlayer) ?? c[0] ?? null;
  },

  menu(b, page, ctx) {
    const actor = this.actorOf(b, ctx.ui);
    if (!actor) return [];
    const sys = b.typeSystem;
    const foes = s => E.reachable(b, actor, s).map(f => f.name);
    const allyNames = b.fighters.filter(f => f.side === 'ally' && E.active(f)).map(f => f.name);
    const items = (ctx.inventory ?? []).filter(i => i.count > 0);
    if (page === 'fight') {
      const list = actor.skills.map(k => {
        const cd = actor.cds?.[k.name] ?? 0;
        const single = k.target === 'enemy' ? foes(k) : k.target === 'ally' ? allyNames : null;
        const t = k.element && !['none', 'physical'].includes(k.element) ? typeIn(k.element, sys) : 'normal';
        const pctCost = Math.round((k.cost / Math.max(1, actor.maxSp)) * 100);
        const tgtF = ['physical', 'magic'].includes(k.kind) ? (b.fighters.find(f => f.name === ctx.ui.target && E.active(f) && f.side === 'enemy' && E.reachable(b, actor, k).includes(f)) ?? E.reachable(b, actor, k)[0]) : null;
        const est = tgtF ? Math.min(100, Math.round((E.estimate(b, actor, tgtF, k) / Math.max(1, tgtF.hp)) * 100)) : null;
        return { label: k.name, meta: k.cost ? `${profile_sp(ctx)} ${k.cost} · ${pctCost}%` : '무료', sub: `${t !== 'normal' || k.element === 'normal' ? typeName(k.element, sys) + ' · ' : ''}${KIND_KO[k.kind] ?? k.kind}${k.power ? ` ${k.power}` : ''}${k.hits > 1 ? `×${k.hits}` : ''}${k.priority ? ` · 우선${k.priority > 0 ? '+' : ''}${k.priority}` : ''}${cd ? ` · ⏳${cd}` : ''}`,
          fx: k.cost > actor.sp ? `⚠ 기력 부족 → 과로 (HP 소모·다음 턴 탈진)` : [est != null ? `${tgtF.name.slice(0, 6)} 체력의 ≈${est}%` : '', fxLine(k, sys)].filter(Boolean).join(' · '), cls: `t-${t}${k.cost > actor.sp ? ' over' : ''}`, disabled: cd > 0, act: 'm:skill', v: k.name, target: single };
      });
      return [...list, { label: '공격', sub: '기본 공격', cls: 't-normal', act: 'm:basic', target: foes(E.basicAttack(actor)) },
        { label: '방어', sub: '피해 반감 · 기력 +5%', cls: 'plain', act: 'm:defend' }, { label: '휴식', sub: `기력 +20% (${actor.sp}/${actor.maxSp})`, cls: 'plain', act: 'm:rest' }, { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    }
    if (page === 'bag') {
      return [...items.map(i => { const sp = i.spec ?? inferItem(i.name); const friendly = !sp || ['heal', 'sp', 'full', 'cure', 'revive', 'buff'].includes(sp.kind);
        return { label: i.name, meta: `×${i.count}`, sub: sp ? ({ heal: 'HP 회복', sp: '기력 회복', full: '완전 회복', cure: '상태이상 회복', revive: '부활', damage: '공격', buff: '강화' }[sp.kind]) : '효과 불명', cls: 'plain', act: 'm:item', v: i.name, target: friendly ? (allyNames.length > 1 ? allyNames : null) : foes({ range: 'ranged' }) }; }),
        { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    }
    if (page === 'party') {
      return [...this.controlled(b).map(f => ({ label: `${f.name}${f.id === actor.id ? ' ✔' : ''}`, sub: `${f.id === actor.id ? '지금 명령 중' : '이 동료에게 명령'} · HP ${f.hp}/${f.maxHp}`, cls: 'plain', act: 'pk:actor', v: f.id })),
        { label: `↔ ${actor.row === 'back' ? '전열로' : '후열로'}`, sub: '자리 이동 (행동 소모)', cls: 'plain', act: 'm:swap' },
        { label: '🔍 관찰', sub: '적 정보 파악', cls: 'plain', act: 'm:scan', target: b.fighters.filter(f => f.side === 'enemy' && E.active(f)).map(f => f.name) },
        { label: '◀ 돌아가기', cls: 'back', page: 'main' }];
    }
    if (actor.charging) {
      return [{ label: `⚡ ${actor.charging.skill} 발동!`, sub: '충전 완료 · 이번 턴에 자동으로 나가요', cls: 'm-fight', act: 'm:release' },
        { label: '동료', sub: '다른 동료에게 명령', cls: 'm-party', page: 'party' }];
    }
    return [{ label: '싸운다', cls: 'm-fight', page: 'fight' }, { label: '가방', cls: 'm-bag', page: 'bag', disabled: !items.length },
      { label: '동료', cls: 'm-party', page: 'party' }, { label: '도망친다', cls: 'm-run', act: 'm:flee', disabled: !b.flee }];
  },

  /** Panel action → { body, cmd } (cmd is the parsed command, used for timing). */
  onAct(act, v, b, ctx) {
    const actor = this.actorOf(b, ctx.ui);
    if (!actor) return null;
    const tgt = ctx.ui.target && b.fighters.some(f => f.name === ctx.ui.target && E.active(f)) ? ctx.ui.target : b.fighters.find(f => f.side === 'enemy' && E.active(f))?.name ?? '';
    const pre = actor.isPlayer ? '' : `${actor.name}: `;
    const mk = (what, type, extra = {}, withTarget = true) => ({ body: `${pre}${what}${withTarget && tgt ? ` → ${tgt}` : ''}`, cmd: { actor: actor.id, type, target: withTarget ? tgt : null, ...extra } });
    switch (act) {
      case 'm:skill': { const sk = E.findSkill(actor, v); return mk(v, 'skill', { skill: v }, !['self', 'allies'].includes(sk?.target)); }
      case 'm:basic': return mk('공격', 'attack');
      case 'm:release': return mk(`${actor.charging?.skill ?? '충전기'} 발동`, 'release', { skill: actor.charging?.skill }, false);
      case 'm:defend': return mk('방어', 'defend', {}, false);
      case 'm:rest': return mk('휴식', 'rest', {}, false);
      case 'm:scan': return mk('관찰', 'scan');
      case 'm:swap': return mk('위치변경', 'swap', {}, false);
      case 'm:flee': return mk('도주', 'flee', {}, false);
      case 'm:item': { const it = v || ctx.value('bt-item'); return it ? mk(`아이템 ${it}`, 'item', { item: it }) : null; }
      case 'm:free': { const t = ctx.value('bt-free'); return t ? { body: `${pre}${t}${tgt ? ` → ${tgt}` : ''}`, cmd: { actor: actor.id, type: 'improvise', target: tgt }, freeText: t } : null; }
      default: return null;
    }
  },
};
