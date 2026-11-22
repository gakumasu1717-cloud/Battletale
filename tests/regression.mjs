// BattleTale regression tests — run with:  node tests/regression.mjs   (Node 18+, no dependencies)
// Covers the review checklist: SP-less dash, stable rollback keys, rollback past the snapshot window,
// odd status-tag names, malformed battle JSON, determinism, and markup in profile labels.
import assert from 'node:assert/strict';
const here = new URL('../src/', import.meta.url).href;
const G = await import(here + 'game.js');
const C = await import(here + 'catalog.js');
const P = await import(here + 'parse.js');
const stealth = (await import(here + 'modes/stealth.js')).default;
const E = await import(here + 'engine.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['✔', name]); }
  catch (e) { results.push(['✖', name, e.stack?.split('\n').slice(0, 3).join(' | ')]); }
}

const PROFILE = C.normalizeProfile({ stats: ['STR', 'INT', 'AGI', 'END', 'SEN', 'LUK'], tiers: [
  { name: 'D', hp: [300, 500], sp: [50, 100], stat: [25, 50] }, { name: 'C', hp: [500, 800], sp: [100, 200], stat: [40, 70] }] });
const hero = () => ({ ...C.normalizeSheet({ name: '한결', isPlayer: true, tier: 'C', hp: 600, sp: 120, stats: { STR: 60, INT: 30, AGI: 50, END: 50, SEN: 45, LUK: 30 },
  skills: ['섬광 베기: 물리 70', '질주: 강화 자신 스피드+1'] }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true });
const SET = { playMode: 'chat', modes: { party: true, duel: true, stealth: true }, length: 1, auxCommands: false };
const deps = { settings: () => SET, auxReady: () => false, toast: () => {}, trace: () => {}, cache: { get: () => null, set: () => {} },
  persona: () => ({ name: '한결', text: '' }), statFields: () => null, scene: () => '', lore: async () => '', character: () => '', codex: { list: () => [], put: () => {}, remove: () => {} } };

function freshParty(seed = 'seed-A') {
  const s = G.stateOf({});
  s.profile = PROFILE; s.player = hero();
  G.beginBattle(s, { mode: 'party', title: 't', enemies: [{ name: '허수아비 오우거', hp: 30000, sp: 100, stats: { STR: 8, INT: 5, AGI: 20, END: 70, SEN: 20, LUK: 10 }, skills: ['몽둥이: 물리 40'] }] },
    { originIndex: 0, originHash: '', settings: SET });
  // Fixed seed and ids so two separate battles can be compared value-for-value.
  s.battle.seed = seed; s.battle.st.seed = seed; s.battle.id = 'B'; s.battle.st.id = 'B';
  s.battle.st.fighters.forEach((f, i) => { f.id = f.isPlayer ? 'player' : `f${i}`; });
  E.planIntents(s.battle.st);
  return s;
}
const msg = (mes, id) => ({ is_user: true, mes, extra: { bt_id: id } });
async function play(s, chat, text, id) {
  const m = msg(text, id); chat.push(m); chat.push({ is_user: false, mes: '…' });
  const r = await G.playUserMessage(s, chat.length - 2, text, deps, m);
  assert.ok(r?.entry, `turn not played: ${text}`);
}
const snap = s => JSON.stringify({ st: s.battle.st, inv: s.inventory, n: s.battle.history.length });

/* 1 */ await test('잠입: 기력 0이면 달리기로 움직이지 않는다', () => {
  const st = stealth.create({ spec: { title: 't' }, profile: PROFILE, party: [hero()], enemies: [], seed: 'sp0', settings: {} });
  const me = st.b.fighters.find(f => f.isPlayer); me.sp = 0;
  const before = { ...st.p };
  for (const dir of ['up', 'left', 'right', 'down']) {
    const r = stealth.resolve(st, [{ actor: me.id, type: 'run', dir }]);
    assert.deepEqual(r.st.p, before, `moved while out of SP (${dir})`);
    assert.ok(r.events.some(e => e.t === 'blocked' && e.why === 'sp'));
  }
});

/* 2 */ await test('다른 메시지를 지워도 엉뚱한 턴이 되돌아가지 않는다', async () => {
  const s = freshParty();
  const chat = [{ is_user: false, mes: 'start', extra: { battletale: { origin: ['B'] } } }];
  await play(s, chat, '⚔[공격]', 'u1');
  await play(s, chat, '⚔[섬광 베기]', 'u2');
  const keep = snap(s);
  chat.unshift({ is_user: false, mes: 'greeting' }, { is_user: true, mes: 'hi' }); // insert older messages
  assert.equal(G.syncHistory(s, chat, SET).changed, false);
  chat.splice(0, 2);                                                               // delete them again
  assert.equal(G.syncHistory(s, chat, SET).changed, false);
  assert.equal(snap(s), keep);
  // Deleting the second action message rolls back exactly one turn.
  const afterFirst = (() => { const t = freshParty(); return t; })();
  const c2 = [{ is_user: false, mes: 'start', extra: { battletale: { origin: ['B'] } } }];
  await play(afterFirst, c2, '⚔[공격]', 'u1');
  const ref = snap(afterFirst);
  chat.splice(chat.findIndex(m => m.extra?.bt_id === 'u2'), 2);
  const r = G.syncHistory(s, chat, SET);
  assert.equal(r.rolledBack, 1);
  assert.equal(JSON.stringify(JSON.parse(snap(s)).st), JSON.stringify(JSON.parse(ref).st));
});

/* 3 */ await test('20턴이 넘은 뒤 옛 메시지를 고쳐도 기록과 상태가 일치한다', async () => {
  const s = freshParty('long');
  const chat = [{ is_user: false, mes: 'start', extra: { battletale: { origin: ['B'] } } }];
  for (let i = 0; i < 28 && s.battle.status === 'active'; i++) await play(s, chat, i % 3 ? '⚔[공격]' : '⚔[질주]', `m${i}`);
  assert.ok(s.battle.history.length >= 28, 'battle ended too early for this test');
  assert.ok(s.battle.history.slice(0, 5).some(h => !h.before), 'old snapshots should be compacted');
  // Reference: a separate battle with the same seed played only the first 4 turns.
  const ref = freshParty('long');
  const rc = [{ is_user: false, mes: 'start', extra: { battletale: { origin: ['B'] } } }];
  for (let i = 0; i < 4; i++) await play(ref, rc, i % 3 ? '⚔[공격]' : '⚔[질주]', `m${i}`);
  // Edit the 5th action message (index of m4).
  const k = chat.findIndex(m => m.extra?.bt_id === 'm4');
  chat[k] = { ...chat[k], mes: '⚔[질주] (수정됨)' };
  const r = G.syncHistory(s, chat, SET);
  assert.ok(r.changed && !r.desync, 'rollback failed');
  assert.ok(r.replayed > 0, 'expected a replay from an older checkpoint');
  assert.equal(s.battle.history.length, 4);
  assert.equal(JSON.stringify(s.battle.st), JSON.stringify(ref.battle.st), 'state differs from a clean replay');
});

/* 4 */ await test('특수문자 상태창 태그도 예외 없이 처리', () => {
  for (const tag of ['st(at)', '[[(', '.*', 'a|b', '', '스탯-창_1', '<script>']) {
    assert.doesNotThrow(() => P.readStatTag('<stat>HP: 10</stat>', tag));
  }
  assert.deepEqual(P.readStatTag('<스탯-창_1>HP: 10</스탯-창_1>', '스탯-창_1'), { HP: '10' });
  assert.equal(P.safeTag('st(at)'), 'stat');
});

/* 5 */ await test('잘못된 전투 JSON에도 멈추지 않는다', () => {
  for (const body of ['{"enemies":"Goblin","allies":{}}', '{"enemies":123}', '{"enemies":[null, 5, {"hp":3}]}', 'null', '[]', '{"enemies":{"name":"Ogre"}}', '{oops', '']) {
    assert.doesNotThrow(() => P.parseBattleBody(body), body);
  }
  assert.deepEqual(P.parseBattleBody('{"enemies":"Goblin"}').enemies, ['Goblin']);
  assert.equal(P.parseBattleBody('{"enemies":123}'), null);
});

/* 6 */ await test('같은 시드·같은 행동이면 판정이 같다', async () => {
  const run = async () => { const s = freshParty('det'); const chat = [{ is_user: false, mes: 'start', extra: { battletale: { origin: ['B'] } } }]; for (let i = 0; i < 6; i++) await play(s, chat, '⚔[섬광 베기]', `d${i}`); return JSON.stringify(s.battle.history.map(h => h.events)); };
  assert.equal(await run(), await run());
});

/* 7 */ await test('프로필 문자열 속 HTML이 화면에 들어가지 않는다', async () => {
  const bad = C.normalizeProfile({ name: '<img src=x onerror=alert(1)>', hpLabel: '<b onmouseover=x>HP</b>', spLabel: '"><script>1</script>', stats: [{ key: 'STR', label: '<i>힘</i>' }], tiers: [{ name: '<svg/onload=1>' }] });
  const all = JSON.stringify(bad);
  assert.ok(!/[<>]/.test(all), `markup survived: ${all.slice(0, 120)}`);
  // Render the real panel with a tiny DOM stub.
  const els = {};
  const mk = id => ({ id, innerHTML: '', style: {}, value: '', dataset: {}, classList: { s: new Set(), toggle(c, on) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }, add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], appendChild() {}, setAttribute() {} });
  globalThis.document = { getElementById: id => els[id] ?? null, createElement: () => mk('x'), body: { appendChild(e) { els[e.id] = e; } }, querySelector: () => null };
  const ui = await import(here + 'ui.js');
  const s = freshParty(); s.profile = bad; s.companions = [{ ...hero(), name: '동료', id: 'c1' }];
  const api = { state: () => s, settings: () => SET, busy: () => false, ui: {}, toast: () => {}, codex: () => [], rosterOf: e => e.sheet, hasRoster: () => false, trace: () => [] };
  ui.mountPanel(api); ui.togglePanel(true);
  const panel = Object.values(els).find(e => e.id === 'bt-panel');
  for (const tab of ['battle', 'sheet']) {
    api.ui.tab = tab;
    try { ui.refreshPanel(); } catch (e) { results.push(['✖', `render ${tab}`, e.message]); }
    assert.ok((panel?.innerHTML ?? '').length > 500, 'panel did not render');
    assert.ok(!/onerror|onmouseover|<script/i.test(panel.innerHTML), `unescaped markup in ${tab}`);
  }
});

/* 8 */ await test('아군 충전기는 모았다가 다음 턴에 반드시 발동한다', () => {
  const me = hero();
  const mage = { ...C.normalizeSheet({ name: '서윤', hp: 600, sp: 200, stats: { INT: 68, AGI: 40, END: 35 }, skills: [{ name: '메테오', kind: 'magic', power: 140, cost: 60, cooldown: 4 }] }, PROFILE, { side: 'ally' }), id: 'sy', persistent: true };
  let b = E.createBattle({ party: [me, mage], enemies: [C.normalizeSheet({ name: '바위', hp: 9000, stats: { STR: 5, END: 40 } }, PROFILE)], profile: PROFILE, seed: 'chg' });
  const sy = b.fighters.find(f => f.name === '서윤');
  let r = E.resolveTurn(b, [{ actor: 'player', type: 'attack' }, { actor: sy.id, type: 'skill', skill: '메테오' }]);
  assert.ok(r.events.some(e => e.t === 'charge' && e.who === '서윤'), 'should charge first');
  r = E.resolveTurn(r.battle, [{ actor: 'player', type: 'attack' }, { actor: sy.id, type: 'attack' }]);
  assert.ok(r.events.some(e => e.t === 'use' && e.who === '서윤' && e.skill === '메테오' && e.released), 'should release next turn even if another order was given');
});

/* 9 */ await test('잡몹은 기력 없이, 엘리트는 배율대로 기력을 쓴다', () => {
  const mk = threat => C.normalizeSheet({ name: threat, threat, hp: 300, sp: 60, stats: { INT: 30 }, skills: [{ name: '독안개', kind: 'magic', power: 40, cost: 15 }] }, PROFILE, { side: 'enemy' });
  const b = E.createBattle({ party: [hero()], enemies: [mk('normal'), mk('elite')], profile: PROFILE, seed: 'sp', costScale: 1.6 });
  const [minor, elite] = b.fighters.filter(f => f.side === 'enemy');
  assert.equal(minor.skills[0].cost, 0);
  assert.equal(elite.skills[0].cost, Math.round(elite.skills[0].baseCost * 1.6));
});

/* 10 */ await test('윈도우에서 못 만드는 파일 이름이 없다 (aux·con·nul 등)', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const bad = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(f) || /[<>:"|?*]/.test(f) || /[. ]$/.test(f)) bad.push(path.relative(root, p)); if (fs.statSync(p).isDirectory()) walk(p); } })(root);
  assert.deepEqual(bad, []);
});

/* 11 */ await test('잘린 ```json 답에서도 완성된 인물까지 건진다', async () => {
  const U = await import(here + 'util.js');
  const cut = '```json\n{"characters": [{"name": "은휘", "aliases": ["Eunhwi", "백린"], "role": "player", "tier": "하급"}, {"name": "서윤", "role": "ally", "co';
  const r = U.extractJson(cut);
  assert.equal(r.characters[0].name, '은휘');
  assert.equal(r.__truncated, true);
  assert.deepEqual(U.extractJson('<think>{x}</think>```json\n{"a":[1,2,],}\n```'), { a: [1, 2] });
  assert.equal(U.extractJson('그냥 글'), null);
});

/* 12 */ await test('전투 신호 태그를 여러 표기로 알아듣는다', () => {
  for (const t of ['…<bt-start>도적 습격</bt-start>', '…[bt-start]도적 습격[/bt-start]', '…<BT_START>도적 습격']) assert.equal(P.findBlocks(t).find(b => b.kind === 'start')?.body, '도적 습격', t);
  assert.ok(P.dangerScore('괴물이 달려들어 포위했다') >= 2);
  assert.equal(P.dangerScore('평화로운 오후, 차를 마셨다'), 0);
});

/* 13 */ await test('포켓몬 18타입 ↔ 세계관 속성 전환해도 타입이 유지된다', () => {
  const world = C.normalizeProfile({ elements: ['불', '물', '바람', '대지', '빛', '어둠', '성광'], pokeMap: { '성광': '페어리' } });
  const hero = C.normalizeSheet({ name: '은휘', elements: ['불', '성광'], hp: 300, stats: {}, skills: ['화염참: 물리 60 불'] }, world, { side: 'ally' });
  assert.deepEqual(C.typesFor(hero, 'world'), ['fire', '성광']);
  assert.deepEqual(C.typesFor(hero, 'pokemon'), ['fire', 'fairy']);
  const mon = C.normalizeSheet({ name: '골렘', elements: ['바위', '강철'], ptypes: ['바위', '강철'], hp: 300, stats: {}, skills: [] }, world, { side: 'enemy' });
  assert.deepEqual(C.typesFor(mon, 'pokemon'), ['rock', 'steel']);
  assert.deepEqual(C.typesFor(mon, 'world'), ['earth']);       // the world has no rock/steel → 대지
  assert.deepEqual(C.typesFor({ elements: [] }, 'pokemon'), ['normal']);
});

/* 14 */ await test('타입 없는 페르소나는 주력 기술 속성으로 타입이 잡힌다', () => {
  const pk = C.setTypeSystem(C.normalizeProfile({}), 'pokemon');
  const me = C.normalizeSheet({ name: '나', hp: 300, stats: {}, skills: ['번개창: 마법 80 전기', '찌르기: 물리 40'] }, pk, { side: 'ally' });
  assert.deepEqual(C.typesFor(me, 'pokemon'), ['electric']);
  assert.deepEqual(C.typesFor({ skills: me.skills }, 'pokemon'), ['electric']);   // old sheets without elements too
});

/* 15 */ await test('아군은 장면에서 정해진 사람만, 안 정했으면 같이 다니는 인물이 합류', () => {
  const st = G.stateOf({});
  st.player = C.normalizeSheet({ name: '나', isPlayer: true, hp: 300, stats: {}, skills: ['베기: 물리 60'] }, G.profileOf(st), { side: 'ally' });
  st.companions = [C.normalizeSheet({ name: '서윤', hp: 250, stats: {}, skills: ['화염: 마법 60 불'] }, G.profileOf(st), { side: 'ally' })];
  const foe = { name: '고블린', hp: 100, stats: {}, skills: ['찌르기: 물리 40'] };
  let b = G.beginBattle(st, { mode: 'party', enemies: [foe], allies: [], alliesDecided: true }, { originIndex: 0, settings: {} });
  assert.deepEqual(b.st.fighters.filter(f => f.side === 'ally').map(f => f.name), ['나']);
  st.battle = null;
  b = G.beginBattle(st, { mode: 'party', enemies: [foe], allies: [] }, { originIndex: 0, settings: {} });
  assert.deepEqual(b.st.fighters.filter(f => f.side === 'ally').map(f => f.name).sort(), ['나', '서윤'].sort());
});

/* ---------- v-next: combat identity, budgets, fairness ---------- */
const PK = C.setTypeSystem(C.normalizeProfile({}), 'pokemon');
const pkSheet = (o, side = 'enemy') => C.normalizeSheet({ hp: 500, sp: 200, stats: { STR: 50, INT: 50, AGI: 50, END: 50, SEN: 50, LUK: 20 }, ...o }, PK, { side });

/* 16 */ await test('포켓몬 룰: 동급 상대의 약점+자속 일격에 풀피에서 즉사하지 않는다', () => {
  for (let i = 0; i < 12; i++) {
    const me = { ...pkSheet({ name: '나', ptypes: ['에스퍼'], skills: [{ name: '사이코키네시스', kind: 'magic', power: 90, element: '에스퍼' }] }, 'ally'), id: 'player', isPlayer: true };
    const foe = pkSheet({ name: '자객', ptypes: ['악', '독'], stats: { STR: 55, INT: 60, AGI: 60, END: 50, SEN: 50, LUK: 40 }, skills: [{ name: '암흑참', kind: 'magic', power: 140, element: '악', cooldown: 4, charge: false, crit: 0.5 }] });
    const b = E.createBattle({ party: [me], enemies: [foe], profile: PK, seed: `oneshot${i}`, initiative: 'enemy', format: 'singles' });
    const r = E.resolveTurn(b, [], { ambush: true });
    const p = r.battle.fighters.find(f => f.isPlayer);
    assert.ok(!p.down && p.hp > 0, `seed ${i}: one-shot from full HP (${JSON.stringify(r.events.filter(e => e.t === 'hit'))})`);
  }
  // A huge power gap still kills outright.
  const weak = { ...pkSheet({ name: '나', ptypes: ['에스퍼'], stats: { STR: 10, INT: 10, AGI: 10, END: 10, SEN: 10, LUK: 10 }, hp: 120 }, 'ally'), id: 'player', isPlayer: true };
  const dragon = pkSheet({ name: '용', ptypes: ['악'], stats: { STR: 200, INT: 200, AGI: 200, END: 200, SEN: 200, LUK: 50 }, skills: [{ name: '파멸', kind: 'magic', power: 120, element: '악', charge: false }] });
  const r2 = E.resolveTurn(E.createBattle({ party: [weak], enemies: [dragon], profile: PK, seed: 'gap', initiative: 'enemy', format: 'singles' }), [], { ambush: true });
  assert.ok(r2.battle.fighters.find(f => f.isPlayer).down, 'overwhelming foe should still one-shot');
});

/* 17 */ await test('표식을 건 뒤 조건부 기술이 배율로 터지고 표식을 소모한다', () => {
  const me = { ...C.normalizeSheet({ name: '사냥꾼', hp: 600, sp: 300, stats: { STR: 50, INT: 20, AGI: 50, END: 40, SEN: 60, LUK: 20 }, skills: [
    { name: '표적 지정', kind: 'physical', power: 30, status: { id: 'mark', chance: 100, turns: 3 } },
    { name: '처형', kind: 'physical', power: 70, bonusIf: { status: 'mark', mul: 1.7, consume: true } }] }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const dummy = C.normalizeSheet({ name: '허수아비', hp: 50000, stats: { STR: 1, END: 40, AGI: 1 } }, PROFILE);
  let b = E.createBattle({ party: [me], enemies: [dummy], profile: PROFILE, seed: 'mark' });
  let r = E.resolveTurn(b, [{ actor: 'player', type: 'skill', skill: '표적 지정' }]);
  assert.ok(r.battle.fighters.find(f => f.name === '허수아비').statuses.some(s => s.id === 'mark'));
  r = E.resolveTurn(r.battle, [{ actor: 'player', type: 'skill', skill: '처형' }]);
  assert.ok(r.events.some(e => e.t === 'combo'), 'combo should fire');
  assert.ok(r.events.some(e => e.t === 'consume' && e.status === 'mark'), 'mark consumed');
  assert.ok(!r.battle.fighters.find(f => f.name === '허수아비').statuses.some(s => s.id === 'mark'));
});

/* 18 */ await test('반동·HP 소모·전투당 1회 기술', () => {
  const me = { ...C.normalizeSheet({ name: '광전사', hp: 600, sp: 300, stats: { STR: 60, END: 40, AGI: 40, SEN: 50 }, skills: [
    { name: '이판사판', kind: 'physical', power: 100, recoil: 0.33 }, { name: '피의 일격', kind: 'physical', power: 80, hpCost: 15 }, { name: '최후의 일섬', kind: 'physical', power: 120, once: true, charge: false }] }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const dummy = C.normalizeSheet({ name: '바위', hp: 90000, stats: { STR: 1, END: 40, AGI: 1 } }, PROFILE);
  let b = E.createBattle({ party: [me], enemies: [dummy], profile: PROFILE, seed: 'cost' });
  let r = E.resolveTurn(b, [{ actor: 'player', type: 'skill', skill: '이판사판' }]);
  assert.ok(r.events.some(e => e.t === 'hit' && e.label === '반동' && e.target === '광전사'), 'recoil');
  r = E.resolveTurn(r.battle, [{ actor: 'player', type: 'skill', skill: '피의 일격' }]);
  assert.ok(r.events.some(e => e.t === 'hpcost'), 'hp cost');
  r = E.resolveTurn(r.battle, [{ actor: 'player', type: 'skill', skill: '최후의 일섬' }]);
  assert.ok(r.events.some(e => e.t === 'use' && e.skill === '최후의 일섬'));
  r = E.resolveTurn(r.battle, [{ actor: 'player', type: 'skill', skill: '최후의 일섬' }]);
  assert.ok(r.events.some(e => e.t === 'fallback' && e.why === 'used'), 'second use blocked');
  // One-line notation round-trips.
  const k = C.normalizeSkill('폭발 돌진: 물리 90 반동25% 조건:화상×1.5 1회');
  assert.equal(k.recoil, 0.25); assert.equal(k.once, true); assert.deepEqual(k.bonusIf, { status: 'burn', mul: 1.5 });
  assert.match(C.skillLine(k), /반동25%.*조건:화상×1.5.*1회/);
});

/* 19 */ await test('프로텍트는 공격을 막고, 연속으로 쓰면 확률이 떨어진다', () => {
  const me = { ...pkSheet({ name: '나', ptypes: ['노말'], skills: [{ name: '방어', kind: 'guard', protect: true }] }, 'ally'), id: 'player', isPlayer: true };
  const foe = pkSheet({ name: '적', skills: [{ name: '몸통박치기', kind: 'physical', power: 60 }] });
  let b = E.createBattle({ party: [me], enemies: [foe], profile: PK, seed: 'prot', format: 'singles' });
  let r = E.resolveTurn(b, [{ actor: 'player', type: 'skill', skill: '방어' }]);
  assert.ok(r.events.some(e => e.t === 'protect' && e.ok));
  assert.ok(!r.events.some(e => e.t === 'hit' && e.target === '나'), 'no damage through protect');
  let fails = 0;
  for (let i = 0; i < 20; i++) {
    let x = E.createBattle({ party: [me], enemies: [foe], profile: PK, seed: `prot${i}`, format: 'singles' });
    x = E.resolveTurn(x, [{ actor: 'player', type: 'skill', skill: '방어' }]).battle;
    const r2 = E.resolveTurn(x, [{ actor: 'player', type: 'skill', skill: '방어' }]);
    if (r2.events.some(e => e.t === 'protect' && !e.ok)) fails++;
  }
  assert.ok(fails >= 4 && fails <= 16, `second protect should fail about half the time (${fails}/20)`);
});

/* 20 */ await test('유턴(교체기)은 쓰고 나서 대기 중인 동료와 바뀐다', () => {
  const me = { ...pkSheet({ name: '나', skills: [{ name: '유턴', kind: 'physical', power: 70, element: '벌레', pivot: true }] }, 'ally'), id: 'player', isPlayer: true };
  const mate = { ...pkSheet({ name: '동료' }, 'ally'), id: 'mate', persistent: true };
  const foe = pkSheet({ name: '적', hp: 9000 });
  const b = E.createBattle({ party: [me, mate], enemies: [foe], profile: PK, seed: 'piv', format: 'singles' });
  const r = E.resolveTurn(b, [{ actor: 'player', type: 'skill', skill: '유턴' }]);
  assert.ok(r.events.some(e => e.t === 'switch' && e.pivot && e.to === '동료'));
  assert.ok(r.battle.fighters.find(f => f.name === '동료' && !f.bench));
});

/* 21 */ await test('입력 토큰 예산: 대화 기록부터 줄이고 규칙·과제는 그대로', async () => {
  const A = await import(here + 'assist.js');
  const long = Array.from({ length: 400 }, (_, i) => `대화 ${i}: 고블린이 공격했다. 검을 휘둘렀다.`).join('\n');
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: `## Rule set\nRULES-KEEP\n\n## World info about people\n${'로어 '.repeat(800)}\n\n## Story so far (most recent last)\n${long}\n\n## Task\nTASK-KEEP` }];
  const r = A.fitInput(msgs, { auxMaxInput: 3000 });
  assert.ok(r.est <= 3000 || r.cut.length >= 2, `still too big: ${r.est}`);
  const u = r.messages[1].content;
  assert.ok(u.includes('RULES-KEEP') && u.includes('TASK-KEEP'));
  assert.ok(u.includes('대화 399'), 'newest story line kept');
  assert.ok(!u.includes('대화 0:'), 'oldest story line dropped');
  assert.equal(A.fitInput(msgs, { auxMaxInput: 0 }).cut.length, 0);
});

/* 22 */ await test('등급: 포켓몬 룰 전환 시 기본 등급 → 레벨대, 설명 유지, 프리셋 매핑', () => {
  const g = C.normalizeProfile({});
  assert.ok(g.tiers.every(t => t.desc), 'default tiers carry descriptions');
  const pk = C.setTypeSystem(g, 'pokemon');
  assert.equal(pk.tiers[0].name, 'Lv.10'); assert.equal(pk.tiers.at(-1).name, 'Lv.100');
  assert.equal(C.setTypeSystem(pk, 'world').tiers[0].name, '일반인');
  const custom = C.normalizeProfile({ tiers: [{ name: '삼류' }, { name: '일류' }, { name: '화경' }] });
  assert.equal(C.setTypeSystem(custom, 'pokemon').tiers[0].name, '삼류', 'world ranks stay');
  const { profile, map } = C.applyTierPreset(g, 'hunter');
  assert.equal(profile.tiers.length, 7); assert.equal(map('전설'), 'S'); assert.equal(map('일반인'), 'F');
});

/* 23 */ await test('피해 있는 약화기는 공격기로, 무상 부가효과는 공격기 절반까지만', () => {
  const k = C.normalizeSkill({ name: '독침', kind: 'debuff', power: 60, status: { id: 'poison', chance: 40 } });
  assert.equal(k.kind, 'magic');
  const sh = C.normalizeSheet({ name: '마녀', tier: '중급', hp: 500, stats: {}, skills: [
    { name: 'A', kind: 'magic', power: 60, status: { id: 'burn', chance: 30 } }, { name: 'B', kind: 'magic', power: 60, status: { id: 'poison', chance: 30 } },
    { name: 'C', kind: 'magic', power: 60, status: { id: 'blind', chance: 30 } }, { name: 'D', kind: 'magic', power: 60, status: { id: 'bleed', chance: 30 } }] }, C.normalizeProfile({}));
  C.auditSheet(sh, C.normalizeProfile({}));
  assert.equal(sh.skills.filter(x => x.status).length, 2, 'half of 4 attacks keep their effect (was 1 under the old ¼ rule)');
});

/* 24 */ await test('어려움은 이야기에 없는 기습을 넣지 않는다', () => {
  for (let i = 0; i < 20; i++) {
    const st = G.stateOf({}); st.profile = PROFILE; st.player = hero();
    const b = G.beginBattle(st, { mode: 'party', enemies: [{ name: '고블린', hp: 100, stats: {}, skills: [] }], initiative: 'normal' }, { originIndex: 0, originHash: `h${i}`, settings: { difficulty: 'hard' } });
    assert.ok(!b.opening?.length, 'hard added an ambush');
  }
});

for (const [mark, name, err] of results) console.log(`${mark} ${name}${err ? `\n    ${err}` : ''}`);
const failed = results.filter(r => r[0] === '✖').length;
console.log(failed ? `\n${failed}개 실패` : `\n전부 통과 (${results.length}개)`);
process.exit(failed ? 1 : 0);
