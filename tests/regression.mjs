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
  // Settings drawer: essentials + collapsed advanced, and rules / trace pages moved inside it.
  api.ui.tab = 'battle'; api.ui.settingsOpen = true;
  for (const [page, needle] of [['set', '고급 설정'], ['rules', '등급 체계'], ['trace', '파이프라인 점검']]) {
    api.ui.sdPage = page; ui.refreshPanel();
    assert.ok(panel.innerHTML.includes(needle), `drawer page ${page} missing "${needle}"`);
    // The rules page prints the (already de-tagged) profile name as text, so look for real tags/attributes.
    assert.ok(!/<[a-z]+\b[^>]*\son(error|load|mouseover)=|<script/i.test(panel.innerHTML), `unescaped markup in drawer ${page}`);
  }
  assert.ok(!/data-v="rules">룰</.test(panel.innerHTML), 'rules should no longer be a top tab');
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

/* 25 */ await test('다시하기: 전투 전 HP·가방으로 되돌리고 같은 적과 새 전투', async () => {
  const s = G.stateOf({}); s.profile = PROFILE; s.player = hero(); s.inventory = [{ name: '하급 포션', count: 2 }];
  const hp0 = s.player.hp;
  G.beginBattle(s, { mode: 'party', title: '재도전', enemies: [{ name: '오우거', hp: 99999, stats: { STR: 200, END: 80, AGI: 10 }, skills: ['몽둥이: 물리 90'] }] }, { originIndex: 0, originHash: 'h', settings: SET });
  const first = s.battle.id;
  s.player.hp = 1; s.inventory[0].count = 0;            // as if the fight went badly
  G.stopBattle(s, 'lose', { ...SET, playMode: 'panel' });
  const b = G.retryBattle(s, SET);
  assert.ok(b && b.id !== first && b.status === 'active', 'new battle started');
  assert.equal(s.player.hp, hp0); assert.equal(s.inventory[0].count, 2);
  assert.equal(b.st.fighters.find(f => f.side === 'enemy').name, '오우거');
  assert.equal(b.retries, 1);
  G.stopBattle(s, 'lose', SET); s.battle.resultKey = 'u5:sent';
  assert.equal(G.retryBattle(s, SET), null, 'no retry after the result went to the story');
});

/* 26 */ await test('등급 별칭: 세계관의 다른 등급 체계 이름으로도 같은 등급을 찾는다', () => {
  const w = C.normalizeProfile({ tiers: [{ name: 'E', aliases: ['인치오'] }, { name: 'C', aliases: ['프로기오'] }, { name: 'A', aliases: ['도미누스', 'Dominus'] }] });
  assert.equal(C.tierOf(w, '프로기오')?.name, 'C');
  assert.equal(C.tierOf(w, 'dominus')?.name, 'A');
  assert.deepEqual(w.tiers[2].aliases, ['도미누스', 'Dominus']);
  assert.equal(C.normalizeSheet({ name: 'x', tier: '프로기오', stats: {} }, w).tier, 'C');
});

/* 27 */ await test('상시 주입: 주요 전투를 메인 모델이 끝내지 못하게 한다 (끄기 가능)', async () => {
  const Pr = await import(here + 'prompts.js');
  for (const mode of ['hybrid', 'main', 'manual']) {
    const t = Pr.worldPrompt({ mode, profile: PROFILE, registered: [] });
    assert.match(t, /Combat discipline/); assert.match(t, /after a fierce battle/);
  }
  assert.doesNotMatch(Pr.worldPrompt({ mode: 'hybrid', profile: PROFILE, fightGuard: false }), /Combat discipline/);
});

/* 28 */ await test('위협도: 평범한 적은 내 실력 근처로, 캐논 근거가 있을 때만 압도적', () => {
  const mk = () => ({ name: '산적 두목', tier: '전설', hp: 6000, stats: { STR: 300, INT: 50, AGI: 200, END: 250, SEN: 150, LUK: 50 }, skills: ['대검: 물리 100'] });
  const start = (spec, difficulty = 'normal') => { const st = G.stateOf({}); st.profile = PROFILE; st.player = hero(); return G.beginBattle(st, { mode: 'party', ...spec }, { originIndex: 0, originHash: 'x', settings: { difficulty } }); };
  const b = start({ enemies: [mk()] });
  assert.ok(b.spec.threatFit, 'should have been toned down');
  assert.ok(b.threat.ratio < 2.5, `still overwhelming: ${b.threat.ratio}`);
  const hard = start({ enemies: [mk()] }, 'hard');
  assert.ok(hard.threat.ratio > b.threat.ratio, 'hard allows a stronger fight than normal');
  const canon = start({ enemies: [mk()], outmatched: true, outmatchedWhy: '로어상 최강 산적' });
  assert.ok(!canon.spec.threatFit && canon.threat.level === 'overwhelming', 'outmatched keeps the canon strength');
  const reg = start({ enemies: [{ ...mk(), codexId: 'c1' }] });
  assert.ok(!reg.spec.threatFit, 'registered characters are never scaled');
});

/* 29 */ await test('기초 설정: 룰·상성표·세계관 요약을 한 번에 만들고 시트까지', async () => {
  const calls = [];
  const fake = { ...deps, auxReady: () => true, persona: () => ({ name: '한결', text: '프로기오 등급의 화염 마도사. 기사단 소속 10년.' }),
    matchLore: async () => ({ text: '### 마력 등급\n인치오 < 프로기오 < 도미누스' }), mentions: () => '',
    auxJson: async msgs => {
      const u = msgs[1].content; calls.push(u);
      if (/"brief"/.test(u)) return { name: '마탑 세계', stats: ['STR', 'INT', 'AGI', 'END', 'SEN', 'LUK'], elements: ['화염', '빙결'],
        chart: { 화염: { 빙결: 2 }, 빙결: { 화염: 0.5 } },
        tiers: [{ name: '인치오', hp: [150, 300], sp: [20, 50], stat: [15, 28] }, { name: '프로기오', hp: [400, 800], sp: [60, 150], stat: [35, 65] }, { name: '도미누스', hp: [900, 1600], sp: [180, 400], stat: [70, 130] }],
        brief: { combat: '마법 중심', ranks: '마력 5등급', elements: '화염은 빙결에 강함', player: '한결은 프로기오', storyteller: ['등급 이름을 그대로 쓴다', '주문엔 영창이 필요'] } };
      return { name: '한결', tierReason: '"프로기오" → 프로기오', tier: '프로기오', hp: 600, sp: 100, stats: { STR: 40, INT: 60, AGI: 40, END: 40, SEN: 40, LUK: 30 }, elements: ['화염'], skills: [{ name: '화염구', kind: 'magic', power: 70, cost: 20, element: '화염' }] };
    } };
  const s = G.stateOf({});
  await G.setupChat(s, fake);
  assert.equal(s.profile.tiers[1].name, '프로기오');
  assert.ok(Object.keys(s.profile.chart).length, 'world chart kept');
  assert.equal(s.brief.parts.ranks, '마력 5등급');
  assert.equal(s.brief.parts.storyteller.split('\n').length, 2);
  assert.ok(s.activated && s.player && s.player.tier === '프로기오');
  assert.ok(s.player.elements.length, 'player got a type');
  const sheetPrompt = calls[1];
  assert.ok(sheetPrompt.indexOf('PRIMARY SOURCE') < sheetPrompt.indexOf('Fairness'), 'persona comes first');
  assert.match(sheetPrompt, /마력 등급/); assert.match(sheetPrompt, /World brief/); assert.match(sheetPrompt, /"elements" is REQUIRED/);
});

/* 30 */ await test('요약 사용: 상시 주입은 짧은 메모만, 입력 줄이기는 페르소나를 건드리지 않는다', async () => {
  const Pr = await import(here + 'prompts.js');
  const A = await import(here + 'assist.js').catch(() => null);
  const t = Pr.worldPrompt({ mode: 'hybrid', profile: PROFILE, brief: '등급 이름을 그대로 쓴다' });
  assert.match(t, /World combat notes/); assert.match(t, /등급 이름을/);
  assert.ok(t.length < 2600, `world prompt too long: ${t.length}`);
  if (A) {
    const persona = '페르소나 설명 '.repeat(300);
    const msgs = Pr.sheetMessages({ profile: PROFILE, persona, personaName: '한결', lore: '로어 '.repeat(6000), scene: '대화 '.repeat(3000) });
    const fit = A.fitInput(msgs, { auxMaxInput: 6000 });
    assert.ok(fit.cut.length, 'something was cut');
    assert.ok(fit.messages[1].content.includes(persona.trim()), 'persona kept whole');
  }
});

/* 31 */ await test('파티전: 콜론·대괄호 스킬명·동료가 있어도 유저 기술이 누락되지 않는다', async () => {
  const s = G.stateOf({});
  s.profile = PROFILE;
  s.player = { ...C.normalizeSheet({ name: '한결', isPlayer: true, tier: 'C', hp: 600, sp: 120, stats: { STR: 60, INT: 30, AGI: 30, END: 50, SEN: 45, LUK: 30 },
    skills: [{ name: '화염: 섬광참', kind: 'physical', power: 70, cost: 15 }, { name: '[고유] 뇌격', kind: 'magic', power: 75, cost: 15 }] }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  G.beginBattle(s, { mode: 'party', title: 't',
    allies: [{ name: '화염 정령', hp: 500, sp: 100, stats: { STR: 30, INT: 50, AGI: 70, END: 40, SEN: 40, LUK: 20 }, skills: ['불씨: 마법 45'] }],
    enemies: [{ name: '고속 고블린', hp: 3000, sp: 100, stats: { STR: 20, INT: 10, AGI: 90, END: 40, SEN: 30, LUK: 10 }, skills: ['할퀴기: 물리 35'] }] },
    { originIndex: 0, originHash: '', settings: SET });
  // Direct command (panel mode) with bracketed skill name
  const r1 = await G.playLocal(s, '⚔[[고유] 뇌격 → 고속 고블린]', deps, { commands: [{ actor: 'player', type: 'skill', skill: '[고유] 뇌격', target: '고속 고블린' }] });
  assert.ok(r1?.entry?.events.some(e => e.t === 'use' && e.who === '한결' && e.skill === '[고유] 뇌격'), 'bracket skill did not fire');
  assert.ok(r1.entry.events.some(e => e.t === 'use' && e.who === '고속 고블린'), 'fast enemy should also act');
  // Text quick parse (chat mode) with colon skill matching ally prefix ("화염: 섬광참" vs ally "화염 정령")
  const r2 = await G.playLocal(s, '⚔[화염: 섬광참 → 고속 고블린]', deps);
  assert.ok(r2?.entry?.events.some(e => e.t === 'use' && e.who === '한결' && e.skill === '화염: 섬광참'), 'colon skill hijacked or skipped');
});

/* 32 */ await test('파티전: 유저 충전이 끊기면 비틀거림 후 다음 턴에 정상 회복된다', () => {
  const me = { ...C.normalizeSheet({ name: '한결', isPlayer: true, tier: 'C', hp: 3000, sp: 200, stats: { STR: 60, INT: 60, AGI: 20, END: 50, SEN: 40, LUK: 20 },
    skills: [{ name: '메테오', kind: 'magic', power: 140, cost: 40, charge: true }, { name: '섬광 베기', kind: 'physical', power: 60, cost: 10 }] }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const foe = C.normalizeSheet({ name: '고속 기사', tier: 'C', hp: 5000, sp: 100, stats: { STR: 60, INT: 20, AGI: 95, END: 40, SEN: 80, LUK: 30 },
    skills: [{ name: '강타', kind: 'physical', power: 60, cost: 0 }] }, PROFILE, { side: 'enemy' });
  let b = E.createBattle({ party: [me], enemies: [foe], profile: PROFILE, seed: 'brk' });
  // Turn 1: player starts charging
  let r = E.resolveTurn(b, [{ actor: 'player', type: 'skill', skill: '메테오', target: '고속 기사' }]);
  assert.ok(r.battle.fighters.find(f => f.isPlayer).charging, 'player should be charging');
  // Turn 2: faster enemy breaks the charge before player releases
  r.battle.fighters.find(f => f.isPlayer).charging.threshold = 1;
  r = E.resolveTurn(r.battle, [{ actor: 'player', type: 'release', skill: '메테오' }]);
  assert.ok(r.events.some(e => e.t === 'break' && e.who === '한결'), 'charge should be broken');
  assert.ok(!r.events.some(e => e.t === 'use' && e.who === '한결' && e.skill === '메테오'), 'broken charge must not release');
  assert.ok(r.events.some(e => e.t === 'staggered' && e.who === '한결'), 'player should stagger this turn');
  assert.equal(r.battle.fighters.find(f => f.isPlayer).staggered, false, 'stagger must clear after taking effect');
  // Turn 3: player acts normally again
  r = E.resolveTurn(r.battle, [{ actor: 'player', type: 'skill', skill: '섬광 베기', target: '고속 기사' }]);
  assert.ok(r.events.some(e => e.t === 'use' && e.who === '한결' && e.skill === '섬광 베기'), 'player must be able to use skills next turn');
});

/* 33 */ await test('서술: blocked 이벤트가 전투 후열 차단과 잠입 불가(why)를 모두 정확히 출력한다', async () => {
  const N = await import(here + 'narrate.js');
  assert.match(N.eventLine({ t: 'blocked', who: '철수', target: '궁수' }), /후열.*궁수|궁수.*후열/);
  assert.match(N.eventLine({ t: 'blocked', who: '철수', why: 'sp' }), /숨이 차서/);
  assert.match(N.eventLine({ t: 'blocked', who: '철수', why: 'stones' }), /돌이 없다/);
  assert.match(N.pkLines([{ t: 'blocked', who: '철수', target: '궁수' }])[0], /궁수/);
  assert.match(N.pkLines([{ t: 'blocked', who: '철수', why: 'sp' }])[0], /숨이 차서/);
});

/* 34 */ await test('엔진: 다중 행동(actions:2) 전투원의 staggered는 1회만 발동하고 두 번째 행동은 정상 진행한다', () => {
  const me = { ...C.normalizeSheet({ name: '한결', isPlayer: true, tier: 'C', hp: 3000, sp: 100, stats: { STR: 40, AGI: 20, END: 50, INT: 30, SEN: 30, LUK: 20 } }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const boss = C.normalizeSheet({ name: '쌍두룡', tier: 'C', threat: 'boss', actions: 2, hp: 5000, sp: 100, stats: { STR: 40, AGI: 50, END: 40, INT: 40, SEN: 40, LUK: 20 }, skills: [{ name: '물어뜯기', kind: 'physical', power: 50, cost: 0 }] }, PROFILE, { side: 'enemy' });
  const b = E.createBattle({ party: [me], enemies: [boss], profile: PROFILE, seed: 'multi-stag' });
  b.fighters.find(f => f.name === '쌍두룡').staggered = true;
  const r = E.resolveTurn(b, [{ actor: 'player', type: 'defend' }]);
  const bossEv = r.events.filter(e => e.who === '쌍두룡');
  assert.equal(bossEv.filter(e => e.t === 'staggered').length, 1, `expected 1 stagger, got ${JSON.stringify(bossEv.map(e => e.t))}`);
  assert.equal(bossEv[0].t, 'staggered', 'stagger should occur on slot 0 before slot 1 acts');
  assert.ok(bossEv.some(e => e.t === 'use'), 'second action slot should still act');
});

/* 35 */ await test('채팅 퀵 파싱: 중첩 대괄호 스킬명과 1:1 대결 콜론 스킬명을 깨지지 않게 파싱한다', async () => {
  const Sh = await import(here + 'modes/shared.js');
  const Duel = (await import(here + 'modes/duel.js')).default;
  const blocks = Sh.quickBlocks('⚔[[고유] 뇌격 → 고속 고블린 #ab12] ⚔[화염: 섬광참 → 늑대]');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].body, '[고유] 뇌격 → 고속 고블린');
  assert.equal(blocks[0].nonce, 'ab12');
  assert.equal(blocks[1].body, '화염: 섬광참 → 늑대');
  const stDuel = Duel.create({
    spec: { flee: true }, profile: PROFILE, seed: 'duel-q', settings: SET,
    party: [{ id: 'player', isPlayer: true, name: '한결', hp: 500, sp: 100, skills: [{ name: '제1장: 일격', kind: 'physical', power: 60, cost: 10 }, { name: '제2장: 일격', kind: 'magic', power: 70, cost: 10 }] }],
    enemies: [{ name: '라이벌', hp: 500, sp: 100 }],
  });
  assert.equal(Duel.quick('제2장: 일격 → 라이벌', stDuel)?.skill, '제2장: 일격');
  assert.equal(Duel.quick('한결: 제1장: 일격 → 라이벌', stDuel)?.skill, '제1장: 일격');
});

/* 36 */ await test('페르소나 조회: ST의 persona_descriptions / chatMetadata / extensionPrompts를 폴백으로 정확히 읽는다', async () => {
  const A = await import(here + 'assist.js');
  // 1) legacy persona_description is empty, but chatMetadata.persona points to persona_descriptions entry
  const r1 = A.resolvePersona({
    name1: '아르테',
    chatMetadata: { persona: 'arte.png' },
    powerUserSettings: {
      persona_description: '',
      personas: { 'arte.png': '아르테', 'other.png': '초보' },
      persona_descriptions: {
        'arte.png': { description: 'S급 대마법사. 8서클 화염 마법을 구사한다.' },
        'other.png': { description: '하급 모험가' },
      },
    },
  }, null);
  assert.match(r1.text, /S급 대마법사/);
  assert.equal(r1.source, 'chatMetadata:arte.png');

  // 2) no chatMetadata lock, matched via name1 in personas
  const r2 = A.resolvePersona({
    name1: '아르테',
    powerUserSettings: {
      persona_description: '하급 모험가 (오래된 값)',
      personas: { 'arte.png': '아르테' },
      persona_descriptions: { 'arte.png': { description: '최상급 검사' } },
    },
  }, null);
  assert.equal(r2.text, '최상급 검사');
  assert.equal(r2.source, 'name1:arte.png');

  // 3) extensionPrompts['1_persona'] fallback
  const r3 = A.resolvePersona({
    name1: '유저',
    powerUserSettings: { persona_description: '' },
    extensionPrompts: { '1_persona': { value: 'A랭크 암살자' } },
  }, null);
  assert.equal(r3.text, 'A랭크 암살자');
  assert.equal(r3.source, 'extensionPrompts');
});

/* 37 */ await test('등급 매칭: tierOf가 긴 이름(최상급/SS)을 짧은 이름(상급/S)보다 우선 매칭한다', () => {
  const prof = C.normalizeProfile({
    name: '테스트',
    tiers: [
      { name: '하급', aliases: ['1서클'], stat: 20, hp: 200, sp: 100 },
      { name: '상급', aliases: ['5서클'], stat: 60, hp: 600, sp: 300 },
      { name: '최상급', aliases: ['8서클'], stat: 120, hp: 1200, sp: 600 },
    ],
  });
  assert.equal(C.tierOf(prof, '최상급 마법사')?.name, '최상급');
  assert.equal(C.tierOf(prof, '상급 기사')?.name, '상급');
  assert.equal(C.tierOf(prof, '8서클 대마법사')?.name, '최상급');
});

/* 38 */ await test('배틀 생성 2단계: 1단계는 로어북 미조회, 도감/잡병은 즉시 생성, 미등록 주요 인물만 로어 조회 후 도감 등록한다', async () => {
  const s = G.stateOf({});
  s.profile = PROFILE;
  s.player = { ...C.normalizeSheet({ name: '한결', isPlayer: true, tier: 'C', hp: 500, sp: 200, stats: { STR: 40, AGI: 40, END: 40, INT: 40, SEN: 40, LUK: 30 } }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const store = new Map();
  const codex = { list: () => [...store.values()], put: e => store.set(e.id, e) };
  // Pre-register companion '세라' in codex
  G.registerCharacter(s, { codex }, { name: '세라', tier: 'C', hp: 450, sp: 220, skills: [{ name: '치유의 빛', kind: 'heal', power: 70, cost: 20, target: 'ally' }] }, { side: 'ally' });

  const loreQueries = [];
  let auxCalls = 0;
  const deps = {
    settings: () => ({ ...SET, autoRegister: true, forgeLore: 'auto' }),
    auxReady: () => true,
    persona: () => ({ name: '한결', text: 'C급 검사' }),
    scene: () => '흑기사 발렌틴이 고블린 둘을 이끌고 나타났고, 세라가 옆에 섰다.',
    lore: async () => { throw new Error('forgeSpec must not dump full lorebook'); },
    matchLore: async q => {
      loreQueries.push(q);
      return { text: '발렌틴은 B급 암흑 기사단장이다. 흑염참을 사용한다.', names: ['발렌틴'], important: true };
    },
    mentions: () => '발렌틴이 검은 검을 뽑았다.',
    character: () => '',
    rosterBrief: () => '',
    codex,
    auxJson: async (msgs) => {
      auxCalls++;
      if (auxCalls === 1) {
        // Step 1 must NOT have called matchLore yet
        assert.equal(loreQueries.length, 0, 'Step 1 planner must not call matchLore before classifying');
        return {
          mode: 'party', title: '흑기사의 습격', place: '성문 앞', flee: true,
          enemies: [
            { kind: 'major', name: '발렌틴', aliases: ['흑기사'], threat: 'boss', row: 'front', concept: '암흑 기사단장' },
            { kind: 'mook', name: '고블린 병사', count: 2, threat: 'minion', tier: 'E', row: 'front', skills: [{ name: '창 찌르기', kind: 'physical', power: 55, cost: 10 }] },
          ],
          allies: [
            { kind: 'codex', ref: '세라', row: 'back' },
          ],
        };
      }
      // Step 2: only called for unregistered major character '발렌틴'
      const userMsg = msgs.find(m => m.role === 'user')?.content ?? '';
      assert.match(userMsg, /발렌틴/);
      assert.match(userMsg, /흑염참/);
      return {
        name: '발렌틴', tier: 'B', threat: 'boss', hp: 1400, sp: 400,
        stats: { STR: 70, AGI: 55, END: 65, INT: 50, SEN: 50, LUK: 30 },
        skills: [{ name: '흑염참', kind: 'physical', power: 110, cost: 30, element: 'dark' }],
      };
    },
  };

  const spec = await G.forgeSpec(s, deps, { hint: '' });
  assert.equal(auxCalls, 2, '1 planner call + 1 sheet call for unregistered major only');
  assert.equal(loreQueries.length, 1, 'matchLore should be called ONLY once for 발렌틴');
  assert.match(loreQueries[0], /발렌틴/);
  assert.equal(spec.enemies.length, 3, '1 major boss + 2 cloned mooks');
  assert.equal(spec.enemies[0].name, '발렌틴');
  assert.ok(spec.enemies[0].codexId, 'major character must be registered into codex and linked');
  assert.equal(spec.enemies[1].name, '고블린 병사 A');
  assert.equal(spec.enemies[2].name, '고블린 병사 B');
  assert.ok(!spec.enemies[1].codexId, 'mooks must NOT be registered into codex');
  assert.equal(spec.allies.length, 1);
  assert.equal(spec.allies[0].name, '세라');
  assert.ok(spec.allies[0].codexId, 'codex ally reused directly');
  assert.ok(G.codexFind({ codex }, '발렌틴'), '발렌틴 should now exist in codex for future battles');
});

/* 39 */ await test('고유 대사 + pkLines: 캐릭터 lines 보존, 큰 기술/KO 대사 및 dot/consume/finisher가 출력된다', async () => {
  const N = await import(here + 'narrate.js');
  const hero = { ...C.normalizeSheet({ name: '아르테', isPlayer: true, tier: 'C', hp: 1000, sp: 200, stats: { STR: 50, AGI: 50, END: 40, INT: 50, SEN: 40, LUK: 20 }, skills: [{ name: '유성 베기', kind: 'physical', power: 90, cost: 20 }], lines: { attack: '여기서 끝낸다!', ko: '아직… 안 돼…' } }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const foe = C.normalizeSheet({ name: '기사', tier: 'F', hp: 10, sp: 100, stats: { STR: 10, AGI: 10, END: 10, INT: 10, SEN: 10, LUK: 10 }, lines: { ko: '크윽… 분하다!' } }, PROFILE, { side: 'enemy' });
  assert.equal(hero.lines?.attack, '여기서 끝낸다!');
  assert.equal(foe.lines?.ko, '크윽… 분하다!');
  const b = E.createBattle({ party: [hero], enemies: [foe], profile: PROFILE, seed: 'lines-test' });
  const r = E.resolveTurn(b, [{ actor: 'player', type: 'skill', skill: '유성 베기', target: '기사' }]);
  const useEv = r.events.find(e => e.t === 'use' && e.who === '아르테');
  const downEv = r.events.find(e => e.t === 'down' && e.who === '기사');
  assert.equal(useEv?.line, '여기서 끝낸다!');
  assert.equal(downEv?.line, '크윽… 분하다!');
  const lines = N.pkLines([
    useEv,
    { t: 'dot', who: '기사', status: 'burn', dmg: 30 },
    { t: 'consume', who: '기사', status: 'mark' },
    { t: 'finisher', who: '아르테', target: '기사', line: '마무리다!' },
    downEv,
  ]);
  assert.ok(lines.some(l => l.includes('여기서 끝낸다!')), 'attack line shown');
  assert.ok(lines.some(l => l.includes('30의 피해')), 'dot line shown');
  assert.ok(lines.some(l => l.includes('표식') && l.includes('터졌다')), 'consume line shown');
  assert.ok(lines.some(l => l.includes('마무리다!')), 'finisher quote shown');
  assert.ok(lines.some(l => l.includes('끝장냈다')), 'finisher line shown');
  assert.ok(lines.some(l => l.includes('크윽… 분하다!')), 'ko line shown');
});

/* 40 */ await test('결과 정비: claimLoot(중복 방지/수량)와 restAfterBattle(단기/완전 회복)이 정상 반영된다', () => {
  const s = G.stateOf({});
  s.player = { id: 'player', isPlayer: true, name: '한결', hp: 100, maxHp: 500, sp: 20, maxSp: 200, statuses: [{ id: 'burn', turns: 2 }] };
  s.companions = [{ id: 'c1', codexId: 'cx1', name: '세라', hp: 0, maxHp: 400, sp: 50, maxSp: 200, statuses: [] }];
  s.roster = { cx1: { hp: 0, maxHp: 400, sp: 50, maxSp: 200, statuses: [] } };
  const b = { loot: ['하급 포션 ×2', '마석'], lootClaimed: false };
  const a1 = G.claimLoot(s, b);
  assert.equal(a1.length, 2);
  assert.equal(s.inventory.find(i => i.name === '하급 포션')?.count, 2);
  assert.equal(G.claimLoot(s, b).length, 0, 'second claim must be no-op');
  G.restAfterBattle(s, 'short');
  assert.equal(s.player.hp, 250);
  assert.ok(s.companions[0].hp > 0 && s.roster.cx1.hp === s.companions[0].hp);
  G.restAfterBattle(s, 'full');
  assert.equal(s.player.hp, 500);
  assert.equal(s.player.sp, 200);
  assert.equal(s.player.statuses.length, 0);
});

/* 41 */ await test('배틀 생성 병렬화: 미등록 주요 인물 4명이 동시성 상한(2) 내에서 처리되고 1명 실패해도 나머지가 유지된다', async () => {
  const s = G.stateOf({});
  s.profile = PROFILE;
  s.player = { ...C.normalizeSheet({ name: '한결', isPlayer: true, tier: 'C', hp: 500, sp: 200 }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const store = new Map();
  const codex = { list: () => [...store.values()], put: e => store.set(e.id, e) };
  let active = 0, peak = 0, calls = 0;
  const deps = {
    settings: () => ({ ...SET, autoRegister: true, forgeLore: 'auto' }),
    auxReady: () => true,
    persona: () => ({ name: '한결', text: 'C급 검사' }),
    scene: () => '사천왕 카인, 아벨, 루나, 드레이크가 나타났다.',
    lore: async () => '',
    matchLore: async () => ({ text: '', names: [] }),
    codex,
    auxJson: async (msgs) => {
      calls++;
      if (calls === 1) {
        return {
          mode: 'party', title: '사천왕 습격', place: '성채', flee: true,
          enemies: [
            { kind: 'major', name: '카인', threat: 'elite', concept: '단검' },
            { kind: 'major', name: '아벨', threat: 'elite', concept: '독침' },
            { kind: 'major', name: '루나', threat: 'elite', concept: '빙결' },
            { kind: 'major', name: '드레이크', threat: 'boss', concept: '화염' },
          ],
          allies: [],
        };
      }
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 15));
      active--;
      const txt = msgs.find(m => m.role === 'user')?.content ?? '';
      const name = ['카인', '아벨', '루나', '드레이크'].find(n => txt.includes(`"${n}"`)) ?? '카인';
      if (name === '아벨') throw new Error('429 rate limit');
      return { name, tier: 'C', hp: 600, sp: 200, skills: [{ name: `${name}의 일격`, kind: 'physical', power: 80, cost: 20 }] };
    },
  };
  const spec = await G.forgeSpec(s, deps);
  assert.equal(peak, 2, `concurrency limit should cap active calls at 2, got ${peak}`);
  assert.deepEqual(spec.enemies.map(e => e.name), ['카인', '아벨', '루나', '드레이크']);
  assert.equal(spec.enemies[0]._src, 'major');
  assert.equal(spec.enemies[1]._src, 'mook', 'failed major falls back cleanly without aborting others');
  assert.ok(G.codexFind({ codex }, '카인') && G.codexFind({ codex }, '루나') && G.codexFind({ codex }, '드레이크'));
});

/* 42 */ await test('스토리 중 도감 성장: stateMessages+parseChange+applyChanges가 미잠금 도감 인물을 갱신하고 잠금 인물은 보호한다', async () => {
  const Pr = await import(here + 'prompts.js');
  const s = G.stateOf({});
  s.profile = PROFILE;
  s.player = { ...C.normalizeSheet({ name: '한결', isPlayer: true, tier: 'C', hp: 500, sp: 200 }, PROFILE, { side: 'ally' }), id: 'player', isPlayer: true };
  const store = new Map();
  const codex = { list: () => [...store.values()], put: e => store.set(e.id, e) };
  const sera = G.registerCharacter(s, { codex }, { name: '세라', tier: 'D', hp: 350, sp: 180, skills: [{ name: '치유', kind: 'heal', power: 60, cost: 15 }] }, { side: 'ally' });
  const boss = G.registerCharacter(s, { codex }, { name: '발렌틴', tier: 'B', hp: 1200, sp: 300 }, { side: 'enemy', locked: true });
  const msgs = Pr.stateMessages({ status: '한결 [C]: HP 500/500', inventory: '', text: '세라가 성광의 방패를 깨우쳤다.', codex: '- 세라 [D]\n- 발렌틴 [B] (locked)', profile: PROFILE });
  assert.match(msgs[1].content, /Registered codex characters/);
  assert.match(msgs[1].content, /npc:/);
  const ops = P.parseChange('npc: 세라 | tier C | learn 성광의 방패: guard 0 light (아군 보호)\nnpc: 발렌틴 | tier S');
  G.applyChanges(s, ops, { codex });
  const seraSheet = G.rosterSheet(s, store.get(sera.id));
  const bossSheet = G.rosterSheet(s, store.get(boss.id));
  assert.equal(seraSheet.tier, 'C');
  assert.ok(seraSheet.skills.some(k => k.name === '성광의 방패'), '세라 should learn new skill');
  assert.equal(bossSheet.tier, 'B', 'locked codex character must not be overwritten');
});

for (const [mark, name, err] of results) console.log(`${mark} ${name}${err ? `\n    ${err}` : ''}`);
const failed = results.filter(r => r[0] === '✖').length;
console.log(failed ? `\n${failed}개 실패` : `\n전부 통과 (${results.length}개)`);
process.exit(failed ? 1 : 0);
