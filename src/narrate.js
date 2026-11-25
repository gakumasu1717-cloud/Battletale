// Turns engine events into text: Korean for the on-screen cards, English for prompts.
import { STATUS, DERIVED_KO, ELEMENT_KO } from './catalog.js';
import { DIFF_KO, active } from './engine.js';

const stName = (id, lang) => STATUS[id]?.[lang === 'ko' ? 'ko' : 'en'] ?? id;
const STAT_EN = { pow: 'physical attack', mag: 'magic attack', def: 'defense', res: 'resistance', spd: 'speed', acc: 'accuracy', eva: 'evasion', luk: 'luck' };
const effKo = { super: '상성 우위', weak: '약점', resist: '상성 열세', immune: '통하지 않음' };
const effEn = { super: "super effective", weak: 'weakness hit', resist: 'not very effective', immune: 'no effect' };
const RESULT_KO = { win: '승리', lose: '패배', fled: '도주 성공', stopped: '전투 중단', success: '성공' };
const RESULT_EN = { win: 'VICTORY', lose: 'DEFEAT', fled: 'ESCAPED', stopped: 'STOPPED', success: 'SUCCESS' };
const WHY_KO = { sp: 'SP 부족', cooldown: '재사용 대기 중', silence: '침묵 상태', unknown: '없는 기술', used: '이번 전투에서 이미 씀' };
const WHY_EN = { sp: 'not enough SP', cooldown: 'still on cooldown', silence: 'silenced', unknown: 'no such skill', used: 'already used this battle' };
const IMPROV_KO = { crit: '대성공', success: '성공', fail: '실패', fumble: '대실패' };

export function eventLine(e, { lang = 'ko', showRolls = true, hp = true } = {}) {
  const ko = lang === 'ko';
  switch (e.t) {
    case 'turn': return e.ambush ? (ko ? '── 기습! (적 선공) ──' : '[Ambush round: the enemy strikes first]') : ko ? `── 턴 ${e.n} ──` : `[Turn ${e.n}]`;
    case 'use':
      if (ko) return `▶ ${e.who}: ${e.basic ? '기본 공격' : `「${e.skill}」`}${e.targets?.length ? ` → ${e.targets.join(', ')}` : ''}`;
      return `${e.who} uses ${e.basic ? 'a basic attack' : `"${e.skill}"`}${e.targets?.length ? ` on ${e.targets.join(', ')}` : ''}.`;
    case 'hit': {
      if (e.guarded === 'block') return ko ? `  · ${e.target} 막아냄! ${e.dmg} 피해만 (${e.from}%→${e.to}%)` : `  ${e.target} blocks in time and takes only ${e.dmg} damage (HP ${e.from}% → ${e.to}%).`;
      if (e.guarded === 'flinch') return ko ? `  · ${e.target} 대응 실패, ${e.dmg} 피해 (${e.from}%→${e.to}%)` : `  ${e.target} mistimes the defense and takes ${e.dmg} damage (HP ${e.from}% → ${e.to}%).`;
      if (e.note === 'counter') return ko ? `  ↺ ${e.who}의 반격! ${e.target}에게 ${e.dmg} 피해 (${e.from}%→${e.to}%)` : `  ${e.who} COUNTERS: ${e.dmg} damage to ${e.target} (HP ${e.from}% → ${e.to}%).`;
      if (e.note === 'finisher') return ko ? `  결정타! ${e.target}에게 ${e.dmg} 피해 (${e.from}%→${e.to}%)` : `  FINISHING BLOW on ${e.target}: ${e.dmg} damage (HP ${e.from}% → ${e.to}%).`;
      if (e.note === 'chip') return ko ? `  · 막혔지만 ${e.target}에게 ${e.dmg} 피해가 스밈` : `  Blocked, but ${e.dmg} damage seeps through to ${e.target}.`;
      if (e.label === '반격') return ko ? `  ↺ ${e.who}의 반격! ${e.target}에게 ${e.dmg} 피해 (${e.from}%→${e.to}%)` : `  ${e.who} counters: ${e.dmg} damage to ${e.target} (HP ${e.from}% → ${e.to}%).`;
      if (e.label) return ko ? `  · ${e.target} ${e.label}(으)로 ${e.dmg} 피해 (${e.from}%→${e.to}%)` : `  ${e.target} takes ${e.dmg} damage from ${({ 혼란: 'confusion', 반동: 'recoil', 역효과: 'a backfire' })[e.label] ?? e.label} (HP ${e.from}%→${e.to}%).`;
      const tags = [e.crit && (ko ? '치명타!' : 'CRITICAL'), e.eff && (ko ? effKo[e.eff] : effEn[e.eff])].filter(Boolean);
      if (ko) return `  · ${e.target}에게 ${e.dmg} 피해${tags.length ? ` [${tags.join(' ')}]` : ''}${hp ? ` (${e.from}%→${e.to}%)` : ''}`;
      return `  Hit ${e.target} for ${e.dmg} damage${tags.length ? ` (${tags.join(', ')})` : ''}${hp ? `; ${e.target} HP ${e.from}% → ${e.to}%` : ''}.`;
    }
    case 'miss': return ko ? `  · ${e.target}에게 빗나감` : `  Missed ${e.target}.`;
    case 'heal': return e.amount > 0 ? (ko ? `  · ${e.who} ${e.drain ? '흡수 ' : ''}HP +${e.amount} (${e.from}%→${e.to}%)` : `  ${e.who} ${e.drain ? 'drains' : 'recovers'} ${e.amount} HP (${e.from}% → ${e.to}%).`) : null;
    case 'sp': return ko ? `  · ${e.who} SP +${e.amount}` : `  ${e.who} restores ${e.amount} SP.`;
    case 'status': return ko ? `  · ${e.who}: ${stName(e.status, 'ko')} (${e.turns}턴)` : `  ${e.who} is afflicted with ${stName(e.status, 'en')} (${e.turns} turns).`;
    case 'resist': return ko ? `  · ${e.who}: ${stName(e.status, 'ko')} 저항` : `  ${e.who} resists ${stName(e.status, 'en')}.`;
    case 'stage': {
      const up = e.delta > 0;
      const why = e.trait === 'intimidate' ? (ko ? ` (${e.src}의 위협)` : ` (intimidated by ${e.src})`) : e.trait === 'avenger' ? (ko ? ' (복수심)' : ' (fired up by a fallen ally)') : '';
      if (ko) return `  · ${e.who} ${DERIVED_KO[e.stat] ?? e.stat} ${up ? '▲' : '▼'}${Math.abs(e.delta)}${why}`;
      return `  ${e.who}'s ${STAT_EN[e.stat] ?? e.stat} ${up ? 'rises' : 'falls'}${Math.abs(e.delta) > 1 ? ' sharply' : ''}${why}.`;
    }
    case 'hpcost': return ko ? `  · ${e.who} 「${e.skill}」에 HP ${e.dmg}를 바침 (${e.from}%→${e.to}%)` : `  ${e.who} pays ${e.dmg} HP to use "${e.skill}" (HP ${e.from}% → ${e.to}%).`;
    case 'combo': return ko ? `  ✦ 연계 발동! ${e.target} 상대로 위력 ×${e.mul}` : `  COMBO: the condition is met against ${e.target}, power ×${e.mul}.`;
    case 'consume': return ko ? `  · ${e.who}의 ${stName(e.status, 'ko')}이(가) 터지며 사라짐` : `  ${e.who}'s ${stName(e.status, 'en')} is consumed by the blow.`;
    case 'endure': return ko ? `  · ${e.who} 간신히 버텨냄!` : `  ${e.who} barely holds on!`;
    case 'passive': return ko ? `  ✦ ${e.who}의 고유 특성 「${e.name}」 발동!${e.msg ? ` (${e.msg})` : ''}` : `  [Passive] ${e.who}'s signature trait "${e.name}" triggers!${e.msg ? ` (${e.msg})` : ''}`;
    case 'protect': return ko ? `▶ ${e.who}: 방어 자세 ${e.ok ? '— 이번 턴 공격을 모두 막는다' : `실패${showRolls && e.chance != null ? ` (${e.chance}%)` : ''}`}` : `${e.who} ${e.ok ? 'braces to block every attack this turn' : 'tries to brace again, but fails'}.`;
    case 'protected': return ko ? `  · ${e.who} 「${e.skill}」을(를) 완벽히 막아냄` : `  ${e.who} completely blocks "${e.skill}".`;
    case 'breakbonus': return ko ? `  ✦ 충전을 끊은 쪽 전원 기력 +${e.sp}%` : `  Breaking the charge lets ${e.who}'s side catch its breath.`;
    case 'down': return ko ? `  ${e.who} 쓰러짐!` : `  ${e.who} is DOWN (knocked out / defeated).`;
    case 'wake': return ko ? `  · ${e.who} 잠에서 깸` : `  ${e.who} wakes up.`;
    case 'thaw': return ko ? `  · ${e.who} ${e.byFire ? '화염에 빙결이 녹아 풀림' : '빙결이 풀림'}` : `  ${e.who} thaws out${e.byFire ? ' from the fire' : ''}.`;
    case 'enrage': return ko ? `  ${e.who} 격노! (공격 ▲)` : `  ${e.who} becomes ENRAGED (attack up).`;
    case 'skip': return ko ? `▷ ${e.who}: ${stName(e.status, 'ko')}(으)로 행동 불가` : `${e.who} cannot act (${stName(e.status, 'en')}).`;
    case 'confused': return ko ? `▷ ${e.who}: 혼란 상태로 자신을 공격` : `${e.who} is confused and hurts themself.`;
    case 'defend': return ko ? `▶ ${e.who}: 방어 태세${e.sp ? ` (SP +${e.sp})` : ''}${e.auto ? ' (명령 없음)' : ''}` : `${e.who} takes a defensive stance${e.auto ? ' (no order given)' : ''}.`;
    case 'wait': return ko ? `▶ ${e.who}: 대기` : `${e.who} waits.`;
    case 'fallback': return ko ? `  ! ${e.who}: 「${e.skill ?? '?'}」 사용 불가 (${WHY_KO[e.why] ?? e.why}) → 기본 공격` : `  ${e.who} could not use "${e.skill ?? '?'}" (${WHY_EN[e.why] ?? e.why}) and attacks normally instead.`;
    case 'notarget': return ko ? '  · 대상 없음' : '  No valid target.';
    case 'flee':
      if (e.blocked) return ko ? `▶ ${e.who}: 도주 시도 — 이 전투는 도망칠 수 없다!` : `${e.who} tries to flee, but there is no escape from this battle.`;
      return ko ? `▶ ${e.who}: 도주 ${e.ok ? '성공' : '실패'}${showRolls && e.chance != null ? ` (확률 ${e.chance}%)` : ''}` : `${e.who} tries to flee: ${e.ok ? 'SUCCESS' : 'FAILED'}.`;
    case 'item': return ko ? `▶ ${e.who}: 아이템 「${e.item}」 사용` : `${e.who} uses the item "${e.item}".`;
    case 'noitem': return ko ? `▶ ${e.who}: 「${e.item}」 ${e.unusable ? '전투 중 사용할 수 없음' : '가지고 있지 않음'}` : `${e.who} reaches for "${e.item}" but ${e.unusable ? 'it is useless in combat' : "doesn't have it"}.`;
    case 'improv': {
      if (ko) {
        const roll = showRolls ? ` ${e.roll}/${e.chance}%` : '';
        return `▶ ${e.who}: 즉흥 행동 — ${e.desc || '?'} [${DIFF_KO[e.difficulty]}]${roll} → ${e.blocked ? '불가능(규칙상)' : IMPROV_KO[e.result]}`;
      }
      return `${e.who} attempts a free action: "${e.desc}" (difficulty ${e.difficulty}) → ${e.blocked ? 'IMPOSSIBLE (not allowed in this situation)' : e.result.toUpperCase()}.`;
    }
    case 'yield': return ko ? `  ${e.who} 전의 상실 — 항복/이탈` : `  ${e.who} YIELDS and stops fighting.`;
    case 'revive': return ko ? `  ✚ ${e.who} 부활 (HP ${e.hp}%)` : `  ${e.who} is revived (HP ${e.hp}%).`;
    case 'cleanse': return ko ? `  · ${e.who} 상태이상 해제` : `  ${e.who}'s ailments are cleansed.`;
    case 'dot': return null;
    case 'expire': return ko ? `  · ${e.who}: ${stName(e.status, 'ko')} 해제` : `  ${e.who}'s ${stName(e.status, 'en')} wears off.`;
    case 'surprised': return ko ? `▷ ${e.who}: 기습당해 대응하지 못함` : `${e.who} is caught off guard and cannot act.`;
    case 'staggered': return ko ? `▷ ${e.who}: 비틀거리며 행동 불가` : `${e.who} is staggered and cannot act.`;
    case 'charge': return ko ? `${e.who}: 「${e.skill}」 충전 시작! (다음 턴 발동)` : `${e.who} begins charging "${e.skill}" (it will fire next turn unless broken).`;
    case 'break': return ko ? `  ${e.who}의 「${e.skill}」 충전이 끊김! 비틀거림` : `  ${e.who}'s charge of "${e.skill}" is BROKEN; they stagger.`;
    case 'parry': return ko ? `  ✦ ${e.who} 완벽한 패링! ${e.attacker}의 공격을 튕겨냄` : `  ${e.who} PARRIES ${e.attacker}'s attack perfectly.`;
    case 'blocked':
      if (e.why) return ko ? `  · ${{ stones: '던질 돌이 없다', sp: '숨이 차서 달릴 수 없다', reach: '손이 닿지 않는다' }[e.why] ?? '할 수 없다'}` : `  Can't do that (${e.why}).`;
      return ko ? `  ! ${e.target}은(는) 후열이라 근접 공격이 닿지 않음 → 앞줄 공격` : `  ${e.target} is behind the front line; ${e.who}'s melee attack hits the front instead.`;
    case 'swap': return ko ? `▶ ${e.who}: ${e.with ? `${e.with}와(과) 자리 교대` : e.row === 'back' ? '후열로 이동' : '전열로 이동'}` : `${e.who} ${e.with ? `swaps places with ${e.with}` : `moves to the ${e.row} row`}.`;
    case 'scan': return ko ? `▶ ${e.who}: ${e.target} 관찰 — ${e.ok ? `정보 획득 (${['없음', '관찰', '분석 완료'][e.to]})` : '파악 실패'}` : `${e.who} studies ${e.target}: ${e.ok ? 'learns its strengths and weaknesses' : 'fails to read it'}.`;
    case 'rout': return ko ? `  ${e.who} 대장이 쓰러지자 도망침` : `  With their leader down, ${e.who} breaks and flees.`;
    case 'stances': {
      const K = { strike: '빠른 공격', heavy: '강공', guard: '방어', evade: '회피', feint: '페인트', finisher: '결정타', open: '무방비' };
      const N = { strike: 'quick strike', heavy: 'heavy attack', guard: 'guard', evade: 'evade', feint: 'feint', finisher: 'finisher', open: 'no defense' };
      if (ko) return `▶ ${e.me}: ${e.an ? `「${e.an}」(${K[e.a]})` : K[e.a]}${e.ga ? ` [${e.ga}]` : ''}  vs  ${e.foe}: ${e.bn ? `「${e.bn}」(${K[e.b]})` : K[e.b]}${e.fallback ? ` (${e.fallback} 불가)` : ''}`;
      return `${e.me}: ${e.an ? `"${e.an}" (${N[e.a]})` : N[e.a]} vs ${e.foe}: ${e.bn ? `"${e.bn}" (${N[e.b]})` : N[e.b]}${e.tell && e.tell !== e.b ? ` (their tell suggested ${N[e.tell]} — it was a deception)` : ''}.`;
    }
    case 'clash': {
      const KO = { trade: '서로 맞교환', faster: '더 빠른 쪽이 먼저 꽂음', interrupt: '강공을 끊어냄', parry: '패링!', blocked: '막힘', dodged: '회피 성공', caught: '피하지 못함', 'feint-punished': '페인트를 읽고 찔러넣음', 'free-hit': '무방비에 적중', 'power-clash': '힘과 힘의 충돌', overpower: '힘으로 압도', 'guard-held': '방어를 버텨냄', 'guard-break': '방어 붕괴!', whiff: '헛침 — 빈틈', 'feint-crushed': '페인트째로 박살', standoff: '대치', nothing: '서로 탐색', baited: '페인트에 걸림!', rattled: '흔들림', finisher: '결정타!' };
      const EN = { trade: 'they trade blows', faster: 'the faster one lands first', interrupt: 'the heavy attack is interrupted', parry: 'a perfect parry', blocked: 'the strike is blocked', dodged: 'dodged cleanly', caught: 'the dodge fails', 'feint-punished': 'the feint is punished', 'free-hit': 'a free hit on an open target', 'power-clash': 'power meets power', overpower: 'one overpowers the other', 'guard-held': 'the guard holds', 'guard-break': 'the guard is smashed', whiff: 'the heavy swing whiffs, leaving an opening', 'feint-crushed': 'the feint is crushed', standoff: 'a tense standoff', nothing: 'both probe without contact', baited: 'the feint lands; the defender is thrown off balance', rattled: 'the feint rattles them', finisher: 'a finishing blow' };
      return ko ? `  ⚔ ${KO[e.kind] ?? e.kind}` : `  Result: ${EN[e.kind] ?? e.kind}.`;
    }
    case 'broken': return ko ? `  ${e.who}의 체간 붕괴!` : `  ${e.who}'s POSTURE BREAKS — wide open for a finishing blow.`;
    case 'armor': return ko ? `  ${e.who}: 강인한 몸으로 버티며 밀어붙임` : `  ${e.who} shrugs it off and pushes through.`;
    case 'finisher': return null;
    case 'sact': {
      const A = { sneak: '신중히 전진', dash: '빠르게 돌파', hide: '숨기', distract: '주의 돌리기', observe: '관찰', takedown: '제압', fight: '정면 돌파', retreat: '철수', run: '전력 질주', obstacle: '지형 이용', item: '아이템', skill: '기술', improvise: '즉흥' };
      if (ko) return `▶ ${e.who}: ${A[e.action] ?? e.action}${e.desc ? ` 「${e.desc}」` : ''}${e.target ? ` → ${e.target}` : ''}${e.grade ? ` [${e.grade}]` : ''}`;
      return `${e.who}: ${e.action}${e.desc ? ` ("${e.desc}")` : ''}${e.target ? ` targeting ${e.target}` : ''}.`;
    }
    case 'overexert': return ko ? `  ${e.who} 과로! 「${e.skill}」에 HP ${e.dmg}를 쏟아부음 (다음 턴 탈진)` : `  ${e.who} overexerts for "${e.skill}", paying ${e.dmg} HP and losing the next turn.`;
    case 'rest': return ko ? `▶ ${e.who}: 휴식 (기력 +${e.sp})` : `▶ ${e.who} rests (+${e.sp}).`;
    case 'glance': return ko ? `  · ${e.who}의 시야 끝에 걸렸지만 눈치채지 못함 (운)` : `  ${e.who} glances this way but doesn't register anything.`;
    case 'calm': return ko ? `  · ${e.who}: 별일 아니라며 원래 자리로` : `  ${e.who} shrugs it off and returns to their post.`;
    case 'observe': return ko ? '  · 경비들의 움직임을 파악함 (3턴)' : '  The guards\' patterns are now known for a few turns.';
    case 'distract': return ko ? `  · ${e.target}의 주의가 다른 곳으로 쏠림` : `  ${e.target} is distracted and turns away.`;
    case 'takedown': return ko ? `  ${e.ok ? '' : ''} ${e.target} 제압 ${e.ok ? '성공 — 소리 없이 쓰러뜨림' : '실패 — 상대가 알아챔!'}${showRolls ? ` (${e.chance}%)` : ''}` : `  Takedown on ${e.target}: ${e.ok ? 'SUCCESS, silently subdued' : 'FAILED, they notice'}.`;
    case 'alert': return ko ? `  · 경계도 ${e.from}→${e.to} · 진행도 ${e.progress}` : `  Alert ${e.from} → ${e.to}/100; progress ${e.progress}/100.`;
    case 'spotted': return ko ? `  ${e.who}의 시야에 걸렸다!` : `  ${e.who} catches a glimpse of {{user}}!`;
    case 'suspicious': return ko ? `  ${e.who ? `${e.who}: ${e.why === 'body' ? '쓰러진 동료 발견!' : '소리를 듣고 다가옴'}` : '경비들이 수상함을 느끼기 시작함'}` : `  ${e.who ? `${e.who} ${e.why === 'body' ? 'finds a subdued comrade!' : 'hears something and comes to check'}` : 'The guards grow suspicious.'}`;
    case 'detected': return ko ? `  ${e.why === 'caught' ? '붙잡혔다!' : e.why === 'fight' ? '전투 돌입!' : '발각됐다!'} → 전투 시작${e.initiative === 'enemy' ? ' (적 선공)' : e.initiative === 'player' ? ' (내가 선공)' : ''}` : `  ${e.why === 'caught' ? 'CAUGHT!' : e.why === 'fight' ? 'The player chooses to fight!' : 'DISCOVERED!'} A battle begins${e.initiative === 'enemy' ? ' with the enemy striking first' : e.initiative === 'player' ? ' with the player striking first' : ''}.`;
    case 'obstacle': return ko ? `  ${e.ok ? '지형을 타고 넘어 거리를 벌림' : '장애물에 걸려 지체'}${showRolls ? ` (${e.chance}%)` : ''}` : `  Uses the terrain: ${e.ok ? 'SUCCESS, gains ground and slows the pursuers' : 'FAILS and loses time'}.`;
    case 'hidefail': return ko ? '  너무 가까워서 숨을 수 없음' : '  Too close to hide.';
    case 'hideroll': return ko ? `  ${e.ok ? '숨는 데 성공' : '숨을 곳을 들킴'}${showRolls ? ` (${e.chance}%)` : ''}` : `  Tries to hide: ${e.ok ? 'SUCCESS' : 'FAILED'}.`;
    case 'lost': return ko ? '  ★ 추격자를 따돌렸다!' : '  The pursuers lose the trail.';
    case 'winded': return ko ? `  · ${e.who} 숨이 차서 속도가 떨어짐` : `  ${e.who} is winded and slows down.`;
    case 'distance': return ko ? `  · 거리 ${e.from}→${e.to}` : `  Distance ${e.from} → ${e.to}/100.`;
    case 'sbuff': return ko ? `  · 「${e.skill}」로 몸놀림 강화` : `  "${e.skill}" sharpens their movement.`;
    case 'switch': return ko ? `▶ ${e.who} ↔ ${e.to} 교체` : `${e.who} withdraws and ${e.to} steps in.`;
    case 'sendout': return ko ? `▶ ${e.who} 등장` : `${e.who} enters the fight.`;
    case 'choose': return ko ? '  · 다음 주자를 고르는 중' : null;
    case 'transition': return ko ? `══ 전투로 전환 ══` : `[The scene turns into a battle]`;
    case 'end': return ko ? `★ 전투 종료: ${RESULT_KO[e.result] ?? e.result}` : `>>> BATTLE OVER: ${RESULT_EN[e.result] ?? e.result}`;
    default: return null;
  }
}

export const eventLines = (events, opts) => (events ?? []).map(e => eventLine(e, opts)).filter(Boolean);

const stagesText = (f, lang) => Object.entries(f.stages ?? {}).filter(([, v]) => v).map(([k, v]) => `${lang === 'ko' ? DERIVED_KO[k] ?? k : k}${v > 0 ? '+' : ''}${v}`).join(' ');

export function fighterLine(f, profile, { lang = 'en', skills = false, exact = true } = {}) {
  const ko = lang === 'ko';
  const state = f.out ? (ko ? (f.out === 'yield' ? '항복' : '이탈') : f.out === 'yield' ? 'YIELDED' : 'FLED') : f.down ? (ko ? '전투불능' : 'DOWN') : null;
  const hp = exact ? `${profile.hpLabel} ${f.hp}/${f.maxHp}` : `${profile.hpLabel} ${Math.round(f.hp / f.maxHp * 100)}%`;
  const sp = `${profile.spLabel} ${f.sp}/${f.maxSp}`;
  const sts = f.statuses?.map(s => `${stName(s.id, lang)}(${s.turns})`).join(' ');
  const stg = stagesText(f, lang);
  let line = `${f.name}${f.tier ? ` [${f.tier}]` : ''}: ${state ?? `${hp}, ${sp}`}${sts ? ` | ${sts}` : ''}${stg ? ` | ${stg}` : ''}`;
  if (skills && !state) line += ` | ${ko ? '기술' : 'skills'}: ${f.skills.map(s => `${s.name}(${s.cost}${profile.spLabel})`).join(', ') || '-'}`;
  return line;
}

export function battleStatus(b, profile, { lang = 'en', skills = true } = {}) {
  const ko = lang === 'ko';
  const allies = b.fighters.filter(f => f.side === 'ally');
  const enemies = b.fighters.filter(f => f.side === 'enemy');
  return [
    ko ? '[아군]' : "[{{user}}'s side]",
    ...allies.map(f => `- ${fighterLine(f, profile, { lang, skills: skills && active(f), exact: true })}`),
    ko ? '[적]' : '[Enemies]',
    ...enemies.map(f => `- ${fighterLine(f, profile, { lang, skills: skills && active(f), exact: false })}`),
  ].join('\n');
}

export { RESULT_KO, RESULT_EN, ELEMENT_KO };

/* ---------- Pokémon-style message window text ---------- */
const hasBatchim = w => { const c = String(w ?? '').trim().slice(-1).charCodeAt(0); return c >= 0xAC00 && c <= 0xD7A3 ? (c - 0xAC00) % 28 !== 0 : false; };
const j = (w, a, b) => `${w}${hasBatchim(w) ? a : b}`;
const STAT_KO = { pow: '공격', mag: '특수공격', def: '방어', res: '특수방어', spd: '스피드', acc: '명중률', eva: '회피율', luk: '운' };
const STANCE = { strike: '빠른 공격', heavy: '강공', guard: '방어', evade: '회피', feint: '페인트', finisher: '결정타', open: '무방비' };
const CLASH = { trade: '서로의 공격이 교차했다!', faster: '한발 앞서 꽂혔다!', interrupt: '강공을 끊어냈다!', parry: '완벽하게 받아쳤다!', blocked: '공격이 막혔다!', dodged: '가볍게 피했다!', caught: '피하지 못했다!', 'feint-punished': '페인트를 꿰뚫어 봤다!', 'free-hit': '무방비한 틈을 찔렀다!', 'power-clash': '힘과 힘이 정면으로 부딪쳤다!', overpower: '힘으로 밀어붙였다!', 'guard-held': '가드가 버텨냈다!', 'guard-break': '가드가 부서졌다!', whiff: '공격이 허공을 갈랐다!', 'feint-crushed': '페인트째로 박살 났다!', standoff: '서로 노려보며 대치했다…', nothing: '서로 거리를 쟀다…', baited: '페인트에 걸려들었다!', rattled: '흔들렸다!', finisher: '결정타!' };
const SACT = { sneak: '조심스럽게 나아갔다', dash: '빠르게 내달렸다', hide: '숨을 죽이고 몸을 숨겼다', distract: '다른 곳으로 주의를 돌렸다', observe: '주변을 살폈다', takedown: '뒤를 노렸다', fight: '정면으로 뛰어들었다', retreat: '물러났다', run: '전력으로 달렸다', obstacle: '지형을 이용했다', item: '도구를 꺼냈다', skill: '기술을 썼다', improvise: '임기응변을 시도했다' };

export function pkLines(events, { showRolls = true } = {}) {
  const out = [];
  for (const e of events ?? []) {
    const L = (...xs) => out.push(...xs.filter(Boolean));
    switch (e.t) {
      case 'turn': if (e.ambush) L('기습이다!'); break;
      case 'use': L(e.basic ? `${j(e.who, '이', '가')} 달려들었다.` : `${j(e.who, '이', '가')} ${j(e.skill, '을', '를')} 펼쳤다.`, e.line ? `${e.who}: 「${e.line}」` : ''); break;
      case 'hit':
        if (e.label === '반격') { L(`${e.who}의 반격!`); break; }
        if (e.label) { L(`${j(e.target, '은', '는')} ${e.label}${hasBatchim(e.label) ? '으로' : '로'} 피해를 입었다!`); break; }
        if (e.note === 'counter') L(`${e.who}의 반격!`);
        if (e.note === 'finisher') L('결정타가 꽂혔다!');
        if (e.guarded === 'block') L(`${j(e.target, '은', '는')} 공격을 막아냈다!`);
        if (e.guarded === 'flinch') L(`${j(e.target, '은', '는')} 대응이 늦었다!`);
        if (e.crit) L('빈틈을 정확히 꿰뚫었다.');
        if (e.eff === 'super') L('상성이 맞아떨어져 깊이 파고들었다.');
        else if (e.eff === 'weak') L('약점을 찔렀다.');
        else if (e.eff === 'resist') L('상성이 나빠 위력이 꺾였다.');
        else if (e.eff === 'immune') L(`${e.target}에게는 전혀 통하지 않았다.`);
        break;
      case 'miss': L(`${j(e.target, '은', '는')} 공격을 흘려 피했다.`); break;
      case 'down': L(e.line ? `${e.who}: 「${e.line}」` : '', `${j(e.who, '은', '는')} 무너져 내렸다.`); break;
      case 'dot': L(`${j(e.who, '은', '는')} ${STATUS[e.status]?.ko ?? e.status} 때문에 ${e.dmg}의 피해를 입었다!`); break;
      case 'consume': { const nm = STATUS[e.status]?.ko ?? e.status ?? '표식'; L(`${e.who}에게 걸린 ${j(nm, '이', '가')} 터졌다!`); break; }
      case 'finisher': L(e.line ? `${e.who}: 「${e.line}」` : '', `${j(e.who, '이', '가')} ${j(e.target, '을', '를')} 끝장냈다!`); break;
      case 'status': L(`${j(e.who, '은', '는')} ${STATUS[e.status]?.ko ?? e.status} 상태가 되었다!`); break;
      case 'resist': L(`${e.who}에게는 통하지 않았다!`); break;
      case 'stage': L(`${e.who}의 ${j(STAT_KO[e.stat] ?? e.stat, '이', '가')} ${Math.abs(e.delta) > 1 ? '크게 ' : ''}${e.delta > 0 ? '올라갔다!' : '떨어졌다!'}`); break;
      case 'heal': if (e.amount > 0) L(e.drain ? `${j(e.who, '은', '는')} 체력을 흡수했다!` : `${e.who}의 체력이 회복되었다!`); break;
      case 'sp': L(`${e.who}의 기력이 회복되었다!`); break;
      case 'skip': L(`${j(e.who, '은', '는')} ${STATUS[e.status]?.ko ?? ''} 때문에 움직일 수 없다!`); break;
      case 'confused': L(`${j(e.who, '은', '는')} 혼란에 빠져 자신을 공격했다!`); break;
      case 'defend': L(e.auto ? `${j(e.who, '은', '는')} 몸을 사리며 방어 태세를 취했다!` : `${j(e.who, '은', '는')} 방어 태세를 취했다!`); break;
      case 'wait': L(`${j(e.who, '은', '는')} 잠시 숨을 고르며 기다렸다.`); break;
      case 'notarget': L('겨눌 상대가 남아 있지 않았다.'); break;
      case 'flee': L(e.blocked ? '이 싸움에서는 도망칠 수 없다!' : e.ok ? '무사히 도망쳤다!' : '도망칠 수 없었다!'); break;
      case 'item': L(`${j(e.who, '은', '는')} ${j(e.item, '을', '를')} 사용했다!`); break;
      case 'noitem': L(e.unusable ? `${e.item}${hasBatchim(e.item) ? '은' : '는'} 지금 쓸 수 없다!` : `${e.item}이(가) 없다!`); break;
      case 'charge': L(`${j(e.who, '은', '는')} ${e.skill}의 힘을 모으기 시작했다!`); break;
      case 'break': L(`${e.who}의 ${e.skill}${hasBatchim(e.skill) ? '이' : '가'} 끊겼다!`, `${j(e.who, '은', '는')} 비틀거린다!`); break;
      case 'parry': L(`${j(e.who, '은', '는')} 공격을 완벽하게 받아넘겼다!`); break;
      case 'surprised': L(`${j(e.who, '은', '는')} 기습에 대응하지 못했다!`); break;
      case 'staggered': L(`${j(e.who, '은', '는')} 비틀거려 움직일 수 없다!`); break;
      case 'enrage': L(`${j(e.who, '은', '는')} 분노로 힘이 끓어오른다!`); break;
      case 'rout': L(`${j(e.who, '은', '는')} 겁을 먹고 도망쳤다!`); break;
      case 'scan': L(e.ok ? `${j(e.who, '은', '는')} ${e.target}의 정보를 파악했다!` : `${e.target}의 정보를 읽어내지 못했다…`); break;
      case 'swap': L(e.with ? `${j(e.who, '은', '는')} ${j(e.with, '과', '와')} 자리를 바꿨다!` : `${j(e.who, '은', '는')} ${e.row === 'back' ? '후열' : '전열'}로 이동했다!`); break;
      case 'wake': L(`${j(e.who, '은', '는')} 잠에서 깨어났다!`); break;
      case 'thaw': L(e.byFire ? `${e.who}의 빙결이 화염에 녹아 풀렸다!` : `${e.who}의 빙결이 풀렸다!`); break;
      case 'expire': L(`${e.who}의 ${STATUS[e.status]?.ko ?? ''} 상태가 풀렸다!`); break;
      case 'revive': L(`${j(e.who, '이', '가')} 다시 일어섰다!`); break;
      case 'cleanse': L(`${e.who}의 상태이상이 깨끗이 나았다!`); break;
      case 'fallback': L(`${e.skill ? `${e.skill}${hasBatchim(e.skill) ? '은' : '는'}` : '그 기술은'} 지금 쓸 수 없다!`); break;
      case 'blocked': L(e.why ? ({ stones: '던질 돌이 없다!', sp: '숨이 차서 달릴 수 없다!', reach: '손이 닿지 않는다!' }[e.why] ?? '할 수 없었다.') : `앞을 막는 적 때문에 ${e.target}에게 닿지 않는다!`); break;
      case 'improv': L(`${e.who}의 ${e.desc || '임기응변'}!`, `${e.blocked ? '그건 불가능하다!' : { crit: '대성공!', success: '성공했다!', fail: '실패했다…', fumble: '대실패! 역효과가 났다!' }[e.result]}${showRolls && e.roll ? ` (${e.roll} / ${e.chance}%)` : ''}`); break;
      case 'yield': L(`${j(e.who, '은', '는')} 싸울 의지를 잃었다!`); break;
      case 'stances': L(`${e.me}의 ${e.an ?? STANCE[e.a]}!`, `${e.foe}의 ${e.bn ?? STANCE[e.b]}!`); break;
      case 'clash': if (CLASH[e.kind]) L(CLASH[e.kind]); break;
      case 'broken': L(`${e.who}의 자세가 무너졌다!`); break;
      case 'armor': L(`${j(e.who, '은', '는')} 아랑곳하지 않고 밀어붙였다!`); break;
      case 'sact': L(`${j(e.who, '은', '는')} ${e.desc && ['improvise', 'skill', 'item'].includes(e.action) ? `${e.desc}… ` : ''}${SACT[e.action] ?? e.action}.`); break;
      case 'observe': L('경비들의 움직임이 보이기 시작했다.'); break;
      case 'distract': L(`${e.target}의 주의가 다른 곳으로 쏠렸다!`); break;
      case 'takedown': L(e.ok ? `${j(e.target, '을', '를')} 소리 없이 쓰러뜨렸다!` : `${j(e.target, '이', '가')} 눈치챘다!`); break;
      case 'spotted': L(`${e.who}의 시선이 이쪽을 스쳤다! "…뭐지?"`); break;
      case 'overexert': L(`${j(e.who, '은', '는')} 무리해서 「${e.skill}」을 썼다! 반동으로 ${e.dmg} 피해!`); break;
      case 'rest': L(`${j(e.who, '은', '는')} 숨을 고르며 기력을 회복했다!`); break;
      case 'hpcost': L(`${j(e.who, '은', '는')} 몸을 깎아 힘을 끌어냈다!`); break;
      case 'combo': L('연계가 터졌다!'); break;
      case 'endure': L(`${j(e.who, '은', '는')} 간신히 버텼다!`); break;
      case 'passive': L(`${e.who}의 「${e.name}」${e.msg ? ` — ${e.msg}` : ''}`); break;
      case 'protect': L(e.ok ? `${j(e.who, '은', '는')} 방어 태세를 굳혔다.` : '자세를 잡기도 전에 틈을 내줬다.'); break;
      case 'protected': L(`${j(e.who, '은', '는')} 공격을 막아냈다!`); break;
      case 'breakbonus': L('기세를 탔다! 기력이 돌아온다!'); break;
      case 'glance': L(`${j(e.who, '이', '가')} 이쪽을 봤지만… 눈치채지 못했다.`); break;
      case 'calm': L(`${j(e.who, '은', '는')} 의심을 풀고 돌아갔다.`); break;
      case 'suspicious': L(e.who ? (e.why === 'body' ? `${j(e.who, '이', '가')} 쓰러진 동료를 발견했다!` : `${j(e.who, '이', '가')} 소리를 듣고 다가온다…`) : '경비들이 수상함을 느끼기 시작했다…'); break;
      case 'detected': L(e.why === 'caught' ? '붙잡혔다!' : e.why === 'fight' ? '정면으로 맞선다!' : '들켰다!'); break;
      case 'transition': L('전투가 시작됐다!'); break;
      case 'obstacle': L(e.ok ? '지형을 타고 넘어 거리를 벌렸다!' : '장애물에 걸려 주춤했다!'); break;
      case 'hidefail': L('너무 가까워서 숨을 수 없다!'); break;
      case 'hideroll': L(e.ok ? '숨는 데 성공했다!' : '숨을 곳이 들통났다!'); break;
      case 'lost': L('추격자를 따돌렸다!'); break;
      case 'winded': L(`${j(e.who, '은', '는')} 숨이 차올랐다!`); break;
      case 'switch': L(`${j(e.who, '이', '가')} 뒤로 물러나고 ${j(e.to, '이', '가')} 앞으로 나섰다.`); break;
      case 'sendout': L(`${j(e.who, '이', '가')} 앞으로 나섰다.`); break;
      case 'choose': L('다음에 누가 나설지 고르자.'); break;
      case 'end': L({ win: '싸움이 끝났다. 이겼다.', success: '해냈다.', lose: '더는 버티지 못했다. 패배다.', fled: '무사히 빠져나왔다.', stopped: '대치가 끝났다.' }[e.result]); break;
      default: break;
    }
  }
  return out;
}
export { hasBatchim, j as josa };
