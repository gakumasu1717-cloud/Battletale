// BattleTale — objective turn-based combat for any roleplay, in any chat.
import { normalizeProfile, normalizeSheet, normalizeSkill, inferSkill, setTypeSystem, safePortrait, applyTierPreset, requestedSkillCap } from './src/catalog.js';
import { hashStr, clone } from './src/util.js';
import { findBlocks, stripBlocks, parseBattleBody, parseChange, readStatTag, safeTag } from './src/parse.js';
import { auxReady, callAux, auxJson, listModels, gatherLore, matchLore, personEntries, characterText, personaInfo, recentScene, mentions, fitInput, rememberActivated, forgetActivated } from './src/assist.js';
import {
  stateOf, profileOf, ensureProfile, ensurePlayer, forgeSpec, beginBattle, syncHistory, playUserMessage,
  stopBattle, applyChanges, syncFromStatus, promptFor, msgKey, stampId, switchMode, storeTiming, modeOf, MODES,
  playLocal, setupChat, resolveRegistered, registerCharacter, codexFind, rosterSheet, applyNpcOps, promoteToCodex, joinParty, applyPlayerSheet, retryBattle,
  claimLoot, restAfterBattle,
} from './src/game.js';
import { sheetMessages, castMessages, stateMessages, briefText } from './src/prompts.js';
// 타이밍 리듬게임은 보류 중 (요청에 따라 비활성화). 다시 켜려면 아래 import와 modeAct의 타이밍 블록 주석을 해제.
// import { runTiming } from './src/timing.js';
import { mountPanel, togglePanel, refreshPanel, refreshTrace, renderCards, settingsHtml, setFab, beginTurn, endTurn, toggleDock, refreshDock } from './src/ui.js';

const NAME = 'battletale';
const PROMPT_KEY = 'BATTLETALE';
const DEFAULTS = {
  enabled: true, exclude: '', optIn: false,
  auxSource: 'main', auxProfile: '', auxUrl: '', auxKey: '', auxModel: '', auxMaxTokens: 10000, auxTemp: 0.4, auxTopP: null, auxReasoning: '', auxJsonMode: false, auxExtra: '', auxHeaders: '', auxProfilePreset: false, auxOverride: false, auxProfileModel: '', auxMaxInput: 16000, castScene: 20, sheetScene: 4, castBatch: 4, difficulty: 'normal', spCostScale: '1.3', auxCommands: true, sceneSize: 3, forgeLore: 'auto',
  startMode: 'hybrid', startTrigger: 'button', suggestStart: true, statTag: 'stat', statSync: 'all', trackChanges: true, loreBooks: '', loreBudget: 14000,
  length: 1, dealMul: 1, takeMul: 1, reviveAfter: true, autoSend: false, showCards: true, cardsOpen: false, showRolls: true, hideBlocks: true,
  depth: 0, attackName: '기본 공격', profileCache: {},
  timingMode: 'off', modes: { party: true, duel: true, stealth: true }, showThreat: true,
  playMode: 'panel', autoPlay: '1300', fightGuard: true, stateWatch: 'auto', ruleSet: 'world', autoRegister: true, codex: {}, resultDetail: 'summary', previewBeforeStart: true,
};

const ctx = () => SillyTavern.getContext();
const settings = () => {
  const es = ctx().extensionSettings;
  es[NAME] ??= {};
  // v0.8 had a bare AI level; fold it into the difficulty setting once.
  if (es[NAME] && es[NAME].aiLevel && !es[NAME].difficulty) { es[NAME].difficulty = { normal: 'easy', hard: 'normal', brutal: 'nightmare' }[es[NAME].aiLevel] ?? 'normal'; delete es[NAME].aiLevel; }
  // Old default (3000) was too small for sheets/cast lists from reasoning models.
  if (es[NAME] && Number(es[NAME].auxMaxTokens) === 3000 && !es[NAME].tokensMigrated) { es[NAME].auxMaxTokens = 10000; es[NAME].tokensMigrated = true; }
  for (const [k, v] of Object.entries(DEFAULTS)) if (es[NAME][k] === undefined) es[NAME][k] = clone(v);
  return es[NAME];
};
const saveSettings = () => ctx().saveSettingsDebounced();
const state = () => { const m = ctx().chatMetadata; return m && ctx().chatId ? stateOf(m) : null; };
const saveState = async () => { try { await ctx().saveMetadata(); } catch (e) { console.warn('[BattleTale] saveMetadata', e); } };
const toast = (msg, type = 'info') => globalThis.toastr?.[type]?.(msg, 'BattleTale', { timeOut: type === 'error' ? 8000 : 3500 });

let busyCount = 0;
let forging = null;
const ui = { actor: null, target: null };
const busy = () => busyCount > 0;
async function work(fn) {
  busyCount++; refreshPanel();
  try { return await fn(); } finally { busyCount--; refreshPanel(); }
}

function enabledHere() {
  const s = settings();
  if (!s.enabled) return false;
  const c = ctx();
  if (!c.chatId) return false;
  const st = state();
  if (st?.disabled) return false;
  // Opt-in: new chats stay untouched until the user turns BattleTale on (wand menu); chats already in use count as on.
  if (s.optIn && !(st?.activated || st?.brief || st?.player || st?.battle)) return false;
  const names = String(s.exclude ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const ch = c.characters?.[c.characterId];
  if (ch && names.includes(String(ch.name).toLowerCase())) return false;
  return true;
}

const effectiveAuxReady = () => settings().auxSource !== 'none' && auxReady(settings());

function cacheKey() {
  const c = ctx();
  const ch = c.characters?.[c.characterId];
  return [ch?.avatar ?? c.groupId ?? 'none', ch?.data?.extensions?.world ?? '', c.chatMetadata?.world_info ?? '', settings().loreBooks].join('|');
}

function lastStatFields() {
  const tag = settings().statTag;
  if (!tag) return null;
  const chat = ctx().chat ?? [];
  // Newest value of each field across recent status windows (some replies omit fields).
  let out = null;
  for (let i = chat.length - 1; i >= 0 && i >= chat.length - 40; i--) {
    const m = chat[i];
    if (m?.is_user || m?.is_system) continue;
    const f = readStatTag(m.mes, tag);
    if (!f) continue;
    out ??= {};
    for (const [k, v] of Object.entries(f)) if (!(k in out) && String(v).trim()) out[k] = v;
  }
  return out;
}

/** World-level character codex, shared by every chat with the same bot/lorebooks. */
function worldKey() {
  const c = ctx();
  const ch = c.characters?.[c.characterId];
  return [ch?.avatar ?? c.groupId ?? 'none', ch?.data?.extensions?.world ?? ''].join('|');
}
function codexStore() {
  const set = settings();
  set.codex ??= {};
  const key = worldKey();
  const book = () => (set.codex[key] ??= {});
  return {
    list: () => Object.values(book()).sort((a, b) => a.name.localeCompare(b.name)),
    put: entry => { book()[entry.id] = entry; saveSettings(); },
    remove: id => { delete book()[id]; saveSettings(); },
  };
}

/* ---------------- Trace log (점검 tab) ---------------- */
const TRACE = [];
function trace(kind, title, detail = '') {
  TRACE.unshift({ t: Date.now(), kind, title, detail: typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1) });
  if (TRACE.length > 40) TRACE.length = 40;
  try { refreshTrace(); } catch { /* panel not mounted */ }
}

function deps() {
  return {
    settings,
    auxReady: effectiveAuxReady,
    auxJson: async (messages, opts) => {
      const label = String(messages?.[0]?.content ?? '').split('\n')[0].slice(0, 70);
      const fit = fitInput(messages, settings());
      const size = `[입력 ~${fit.est.toLocaleString()} tok${fit.limit ? ` / 한도 ${fit.limit.toLocaleString()}` : ''}${fit.cut.length ? ` · 줄임: ${fit.cut.join(', ')} (원래 ~${fit.before.toLocaleString()})` : ''}]`;
      try {
        const r = await auxJson(fit.messages, settings(), opts);
        trace('aux', `보조모델 응답 · ${label} ${size}`, `${size}\n── 요청 ──\n${fit.messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n')}\n\n── 응답 ──\n${JSON.stringify(r, null, 1)}`);
        return r;
      } catch (e) { trace('error', `보조모델 실패 · ${label}`, String(e?.message ?? e)); throw e; }
    },
    lore: () => gatherLore(settings()),
    matchLore: text => matchLore(settings(), text),
    trace: (...a) => trace(...a),
    character: characterText,
    mentions: names => mentions(ctx().chat, names, { strip: stripBlocks, lookback: 60 }),
    rosterBrief: except => rosterBrief(except),
    persona: () => { const info = personaInfo(); return { name: ctx().name1 || 'User', text: info.text, source: info.source }; },
    statFields: lastStatFields,
    scene: (n = settings().sceneSize ?? 3) => recentScene(ctx().chat, n, stripBlocks),
    toast,
    codex: codexStore(),
    cache: {
      get: () => { const p = settings().profileCache?.[cacheKey()]; return p ? normalizeProfile(p) : null; },
      set: p => { settings().profileCache[cacheKey()] = clone(p); const keys = Object.keys(settings().profileCache); if (keys.length > 30) delete settings().profileCache[keys[0]]; saveSettings(); },
    },
  };
}

/* ---------------- Main-model prompt ---------------- */
function setPrompt(text) {
  const c = ctx();
  const s = settings();
  try { c.setExtensionPrompt(PROMPT_KEY, text ?? '', 1 /* IN_CHAT */, Number(s.depth) || 0, false, 0 /* SYSTEM */); }
  catch (e) { console.warn('[BattleTale] setExtensionPrompt', e); }
}

function lastUserOf(list) {
  const chat = ctx().chat ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.is_user && !m.is_system) {
      let index = chat.indexOf(m);
      if (index < 0) index = m.extra?.bt_id ? chat.findIndex(x => x?.extra?.bt_id === m.extra.bt_id) : chat.findLastIndex(x => x.is_user && x.mes === m.mes);
      return { index, mes: m.mes, m: chat[index] ?? m };
    }
  }
  return null;
}

/** Generation interceptor: runs before every prompt build. */
globalThis.battleTaleInterceptor = async function (chat, contextSize, abort, type) {
  try {
    if (!enabledHere()) { setPrompt(''); return; }
    if (type === 'quiet') return;
    if (forging) { try { await forging; } catch { /* reported */ } }
    const s = state();
    if (!s) return;
    const synced = syncHistory(s, ctx().chat, settings());
    if (synced.rolledBack) toast(`메시지가 지워지거나 수정되어 ${synced.rolledBack}턴을 되돌렸어요.`, 'warning');
    if (synced.desync) toast('되돌릴 기록이 없어 전투 기록과 상태가 다를 수 있어요. /bt-end 후 다시 시작을 추천해요.', 'error');
    if (synced.cancelled) toast('전투를 시작한 메시지가 바뀌어서 전투를 취소했어요.', 'warning');
    const lastUser = lastUserOf(chat);
    let s2 = s;
    if (settings().playMode === 'chat' && type !== 'impersonate' && s.battle?.status === 'active' && lastUser && lastUser.index > s.battle.originIndex) {
      // Give the message a stable id first so later deletions elsewhere never shift its turn.
      if (stampId(lastUser.m)) { try { await ctx().saveChat?.(); } catch { /* saved later */ } }
      await work(async () => {
        const r = await playUserMessage(s, lastUser.index, lastUser.mes, deps(), lastUser.m);
        if (r && !r.reused) {
          if (r.idle) toast('이번 메시지엔 전투 행동이 없어서 턴을 넘기지 않았어요.');
          if (r.entry && s.battle.status !== 'active') toast(`종료: ${{ win: '승리!', lose: '패배…', fled: '도주 성공', stopped: '중단', success: '성공!' }[s.battle.status] ?? s.battle.status}`, ['win', 'success'].includes(s.battle.status) ? 'success' : 'info');
          else if (r.entry?.events?.some(e => e.t === 'transition')) toast('🚨 들켰어요! 전투로 전환됩니다.', 'warning');
        }
      });
      s2 = state();
    }
    // Generating the battle's opening message again (swipe/regenerate) → back to world prompt.
    let text;
    if (s2.battle && !s2.battle.history.length && lastUser && lastUser.index < s2.battle.originIndex && ['swipe', 'regenerate'].includes(type)) {
      text = promptFor({ ...s2, battle: null }, { lastUser, settings: settings(), deps: deps() });
    } else {
      text = promptFor(s2, { lastUser, settings: settings(), deps: deps() });
    }
    setPrompt(text);
    trace('inject', `메인 모델에 주입 (${type || 'normal'})${s2.battle?.status === 'active' ? ' · 전투 중' : ''}`, text || '(없음)');
    await saveState();
    afterChange();
  } catch (e) {
    console.error('[BattleTale] interceptor', e);
    toast(`턴 처리 중 오류: ${e.message}`, 'error');
  }
};

/* ---------------- Reading character messages ---------------- */
async function processMessage(index) {
  if (!enabledHere()) return;
  const c = ctx();
  const m = c.chat?.[index];
  const s = state();
  if (!m || m.is_user || m.is_system || !s) return;
  const seenKey = hashStr(m.mes);
  if (m.extra?.battletale?.seen === seenKey) return;
  const set = settings();
  let dirtyChat = false;

  // A new swipe replaced the message that opened a battle no one has played yet.
  if (s.battle && s.battle.originIndex === index && !s.battle.history.length && s.battle.originHash !== seenKey) s.battle = null;

  if (set.statTag && set.statSync !== 'off' && s.player) {
    const fields = readStatTag(m.mes, set.statTag);
    const before = { hp: s.player.hp, sp: s.player.sp, stats: { ...(s.player.stats ?? {}) } };
    syncFromStatus(s, fields, set.statSync);
    trace('stat', fields ? `<${set.statTag}> 상태창 읽음 · 메시지 #${index}` : `<${set.statTag}> 상태창 없음 · 메시지 #${index}`, fields ? `읽은 값: ${JSON.stringify(fields)}\n전: HP ${before.hp} SP ${before.sp}\n후: HP ${s.player.hp} SP ${s.player.sp}` : '');
  }

  const blocks = findBlocks(m.mes);
  trace('detect', blocks.length ? `블록 발견: ${blocks.map(b => b.kind).join(', ')} · 메시지 #${index}` : `블록 없음 (전투 신호 X) · 메시지 #${index}`, blocks.map(b => `<bt-${b.kind}>\n${b.body}`).join('\n\n'));
  let startHint = null, spec = null;
  for (const b of blocks) {
    if (b.kind === 'change') { const ops = parseChange(b.body); const done = applyChanges(s, ops, deps()); trace('change', `변수 변경 ${done.length}건 적용`, `해석: ${JSON.stringify(ops)}\n적용: ${done.join(', ') || '(없음)'}`); if (done.length) toast(`📝 ${done.join(', ')}`); }
    else if (b.kind === 'end') { const r = /(win|lose|loss|fled|stop)/i.exec(b.body)?.[1]?.toLowerCase(); if (stopBattle(s, r === 'loss' ? 'lose' : r === 'stop' ? 'stopped' : r ?? 'stopped', set)) toast('스토리가 전투를 끝냈어요.'); }
    else if (b.kind === 'battle') spec = parseBattleBody(b.body) ?? spec;
    else if (b.kind === 'start') startHint = b.body || startHint || '';
  }
  // No <bt-change> from the main model: let the aux model read the passage and keep HP/SP/items in step.
  if (!blocks.some(b => b.kind === 'change')) await watchState(s, m, index);
  if (blocks.length && set.hideBlocks) {
    m.mes = stripBlocks(m.mes);
    if (Array.isArray(m.swipes)) m.swipes[m.swipe_id ?? 0] = m.mes;
    dirtyChat = true;
  }
  m.extra = { ...(m.extra ?? {}), battletale: { ...(m.extra?.battletale ?? {}), seen: hashStr(m.mes) } };

  const live = s.battle?.status === 'active';
  if (!live && (spec || startHint !== null)) {
    if (set.startTrigger === 'auto') await startFrom(index, { hint: startHint, spec }, s);
    else {
      // Button mode: remember the signal; the "⚔️ 전투 시작" button under this message starts it.
      m.extra.battletale.pending = { hint: startHint ?? '', spec: spec ?? null };
      trace('start', `전투 신호 대기 · 메시지 #${index}`, `신호: ${spec ? '<bt-battle>' : `<bt-start> ${startHint}`}\n메시지 아래 버튼을 누르면 시작해요.`);
      toast('⚔️ 전투 신호! 메시지 아래 「전투 시작」을 눌러요.');
    }
  }
  if (dirtyChat) { try { c.updateMessageBlock(index, m); } catch { /* older ST */ } }
  await c.saveChat?.();
  await saveState();
  afterChange();
}

const STATE_CUES = /쉬[었었고며자]|휴식|잠[을이에들]|잠든|잤|자고|눈을 떴|아침이|하룻밤|숙소|여관|야영|노숙|식사|밥을|먹[었고으]|치료|치유|회복|붕대|포션|물약|약을|상처|부상|다쳤|다친|피를|출혈|쓰러|기절|독에|중독|지쳤|탈진|녹초|마나|마력을|기력|체력|숨을 고|각성|승급|돌파|깨달|익혔|습득|배웠|전수|레벨|서클|등급|진화|합류|동료|무기|장비|강해|단련|수련|rest|sleep|slept|heal|potion|wound|injur|bandage|meal|camp|exhaust|awaken|rank|level|learn|skill|master|join|equip|upgrade/i;
/**
 * State & growth watcher (outside battles): the aux model reads a story message and returns <bt-change>-style lines,
 * so resting, treatment, wounds, rank-ups, new skills, companion joins or codex NPC growth update automatically.
 * "auto" asks only when the passage mentions such cues; "always" reads every message.
 */
async function watchState(s, m, index) {
  const set = settings();
  const mode = set.stateWatch ?? 'auto';
  if (mode === 'off' || !set.trackChanges || !s.player || s.battle?.status === 'active' || !effectiveAuxReady()) return;
  const text = stripBlocks(String(m.mes ?? ''));
  if (text.length < 40 || (mode === 'auto' && !STATE_CUES.test(text))) return;
  const p = profileOf(s);
  const line = x => `- ${x.name}${x.isPlayer ? ' ({{user}})' : ''}${x.tier ? ` [${x.tier}]` : ''}: ${p.hpLabel} ${x.hp}/${x.maxHp}, ${p.spLabel} ${x.sp}/${x.maxSp}${x.statuses?.length ? `, status: ${x.statuses.map(st => st.id).join(' ')}` : ''}`;
  const codex = deps().codex.list().slice(0, 30).map(e => {
    const sh = rosterSheet(s, e);
    return `- ${e.name}${sh.tier ? ` [${sh.tier}]` : ''}${sh.skills?.length ? ` · ${sh.skills.slice(0, 4).map(k => k.name).join(', ')}` : ''}${e.locked ? ' (locked)' : ''}`;
  }).join('\n');
  try {
    const r = await deps().auxJson(stateMessages({
      status: [s.player, ...s.companions].map(line).join('\n'),
      inventory: s.inventory.filter(i => i.count > 0).map(i => `${i.name} ×${i.count}`).join(', '),
      text: text.slice(-3500), recent: recentScene(ctx().chat.slice(0, index), 2, stripBlocks).slice(-1200),
      codex, profile: p,
    }), { maxTokens: 900 });
    const lines = (Array.isArray(r?.changes) ? r.changes : []).map(String).filter(Boolean).slice(0, 12);
    if (!lines.length) return;
    const ops = parseChange(lines.join('\n'));
    const done = applyChanges(s, ops, deps());
    trace('change', `상태·성장 감시 · 변경 ${done.length}건 (메시지 #${index})`, `이유: ${r?.why ?? ''}\n줄: ${lines.join(' / ')}\n적용: ${done.join(', ') || '(없음)'}`);
    if (done.length) toast(`📝 ${done.join(', ')}`);
  } catch (e) { trace('error', '상태 감시 실패', String(e?.message ?? e)); }
}

/** Forge (or resolve) the fight signalled by message #index and open the panel. */
async function startFrom(index, { hint = '', spec = null } = {}, s = state()) {
  if (forging) return toast('이미 준비 중이에요…', 'warning');
  if (s.battle?.status === 'active') return toast('이미 진행 중이에요.', 'warning');
  const c = ctx(), m = c.chat[index], set = settings();
  if (!m) return;
  forging = work(async () => {
    try {
      await ensurePlayer(s, deps());
      const finalSpec = spec ? resolveRegistered(s, spec, deps(), set) : await forgeSpec(s, deps(), { hint: hint ?? '' });
      m.extra = { ...(m.extra ?? {}), battletale: { ...(m.extra?.battletale ?? {}) } };
      delete m.extra.battletale.pending;
      if (set.previewBeforeStart !== false && set.playMode !== 'chat') {
        ui.preview = { spec: finalSpec, index, mode: finalSpec.mode ?? 'party', hint: hint ?? '' };
        toast('⚔️ 출전 구성을 확인하고 전투를 시작하세요!', 'info');
        setTimeout(() => togglePanel(true), 50);
      } else {
        ui.preview = null;
        const b = beginBattle(s, finalSpec, { originIndex: index, originHash: hashStr(m.mes), settings: set });
        trace('start', `전투 시작: ${b.mode} · ${b.title || ''}`, `신호: ${spec ? '<bt-battle> 직접 작성' : `<bt-start> ${hint}`}\n적: ${finalSpec.enemies.map(e => `${e.name}${e.tier ? ` [${e.tier}]` : ''}`).join(', ')}\n위협도: ${b.threat?.level ?? '?'}${b.spec?.threatFit ? `\n⚖️ 실력에 맞게 적 조정: 전력비 ${b.spec.threatFit.from} → ${b.spec.threatFit.to} (난이도 상한 ${b.spec.threatFit.cap})` : b.spec?.outmatched ? `\n⚠ 압도적 허용: ${b.spec.outmatchedWhy || '(이유 없음)'}` : ''}`);
        m.extra.battletale.origin = [...(m.extra.battletale.origin ?? []), b.id];
        announce(b);
        ui.msg = null; ui.page = 'main'; ui.openingShown = null;
        if (set.playMode !== 'chat') setTimeout(() => togglePanel(true), 50);
      }
    } catch (e) {
      console.error('[BattleTale] start', e);
      toast(`전투를 준비하지 못했어요: ${e.message}`, 'error');
    }
  });
  await forging;
  forging = null;
  await c.saveChat?.();
  await saveState();
  afterChange();
}

/* ---------------- Manual actions (panel / slash) ---------------- */
function announce(b) {
  const M = modeOf(b.mode);
  const foes = M.enemiesOf(b.st).map(f => f.name).join(', ');
  const threat = { overwhelming: '압도적', dangerous: '위험', even: '대등', favorable: '우세', trivial: '쉬움' }[b.threat?.level];
  toast(`${M.icon} ${M.ko} 개시! ${foes}${threat && settings().showThreat ? ` · 위협도 ${threat}` : ''}${b.spec?.threatFit ? ' · ⚖️ 실력에 맞게 조정됨' : ''}${b.opening?.length ? ' · 기습당함!' : ''}`, b.threat?.level === 'overwhelming' ? 'warning' : 'success');
}

async function commitBattle(s, spec, { index, mode = null } = {}) {
  const chat = ctx().chat;
  const b = beginBattle(s, spec, { originIndex: index, originHash: hashStr(chat[index]?.mes ?? ''), settings: settings(), mode });
  if (chat[index]) chat[index].extra = { ...(chat[index].extra ?? {}), battletale: { ...(chat[index].extra?.battletale ?? {}), origin: [b.id], seen: hashStr(chat[index].mes) } };
  announce(b);
  await ctx().saveChat?.();
  return b;
}

async function manualStart(hint = '', mode = null, { skipPreview = false } = {}) {
  if (!enabledHere()) return toast('이 채팅에선 꺼져 있어요.', 'warning');
  const s = state();
  if (s.battle?.status === 'active') return toast('이미 진행 중이에요.', 'warning');
  const chat = ctx().chat;
  let index = chat.length - 1;
  while (index > 0 && (chat[index]?.is_user || chat[index]?.is_system)) index--;
  if (index < 0) index = chat.length - 1;
  await work(async () => {
    try {
      await ensurePlayer(s, deps());
      const spec = await forgeSpec(s, deps(), { hint });
      if (!skipPreview && settings().previewBeforeStart !== false) {
        ui.preview = { spec, index, mode: mode ?? spec.mode ?? 'party', hint };
        toast('⚔️ 출전 구성을 확인하고 전투를 시작하세요!', 'info');
      } else {
        ui.preview = null;
        await commitBattle(s, spec, { index, mode });
      }
    } catch (e) { toast(`준비하지 못했어요: ${e.message}`, 'error'); }
  });
  await saveState();
  afterChange();
  togglePanel(true);
}

function putCommand(text) {
  const ta = document.getElementById('send_textarea');
  if (!ta) return;
  ta.value = ta.value.trim() ? `${ta.value.trim()} ${text}` : text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  if (settings().autoSend) document.getElementById('send_but')?.click();
  else ta.focus();
}

async function modeAct(act, v) {
  const s = state();
  const b = s?.battle;
  if (!b || b.status !== 'active' || busy()) return;
  const M = modeOf(b.mode);
  const r = M.onAct(act, v, b.st, { ui, busy: busy(), inventory: s.inventory, settings: settings(), value: id => document.getElementById(id)?.value?.trim() ?? '' });
  if (!r) return;
  const nonce = null;
  /* 타이밍 리듬게임 (보류)
  if (settings().timingMode === 'minigame' && r.cmd) {
    const steps = M.timingPlan(b.st, r.cmd);
    if (steps.length) {
      const grades = await runTiming(steps);
      if (grades === null) return;
      nonce = storeTiming(s, grades);
      await saveState();
    }
  }
  */
  const text = r.freeText && effectiveAuxReady() ? r.freeText : `⚔[${r.body}${nonce ? ` #${nonce}` : ''}]`;
  if (settings().playMode === 'chat') return putCommand(text);
  const direct = !r.freeText && r.cmd ? [{ ...r.cmd, ...(nonce ? { nonce } : {}) }] : null;
  await work(async () => {
    try {
      beginTurn();
      const res = await playLocal(s, text, deps(), { commands: direct });
      if (res?.idle) toast('행동으로 해석되지 않았어요. 버튼을 쓰거나 다르게 적어주세요.', 'warning');
      if (res?.entry) {
        endTurn(res.entry.events);
        if (res.entry.events.some(e => e.t === 'transition')) toast('🚨 들켰어요! 전투로 전환됩니다.', 'warning');
        if (s.battle.status !== 'active') toast(`종료: ${{ win: '승리!', lose: '패배…', fled: '도주 성공', stopped: '중단', success: '성공!' }[s.battle.status] ?? s.battle.status} — 결과를 이야기로 보내주세요.`, ['win', 'success'].includes(s.battle.status) ? 'success' : 'info');
      }
    } catch (e) { console.error(e); toast(`턴 처리 오류: ${e.message}`, 'error'); }
  });
  await saveState();
  afterChange();
}

function sendResult(comment = '') {
  const s = state();
  if (!s?.battle || s.battle.status === 'active') return;
  s.battle.resultPending = true;
  s.battle.resultKey = null;
  const ta = document.getElementById('send_textarea');
  if (!ta) return;
  ta.value = `⚔[전투 결과]${comment ? ` ${comment}` : ''}`;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  saveState().then(() => document.getElementById('send_but')?.click());
}

async function prepDefense() { toast('타이밍 기능은 현재 보류 중이에요.'); }

const panelApi = {
  state, settings, busy, ui, toast,
  start: manualStart,
  startFrom: (index, soft) => {
    const m = ctx().chat[index];
    const p = m?.extra?.battletale?.pending;
    if (!soft && p) return startFrom(index, p);
    trace('start', `위험 장면 제안 버튼으로 시작 · 메시지 #${index}`, '');
    return startFrom(index, { hint: '' });
  },
  command: putCommand,
  modeAct, prepDefense, sendResult, setSetting, avatars: avatarChoices, setPortrait, profiles: connectionProfiles, auxTest: auxTestRun, auxModels: auxModelList, trace: () => TRACE, clearTrace: () => { TRACE.length = 0; refreshPanel(); },
  // Same encounter again from the pre-battle state (only before the result went to the story).
  retryBattle: async () => {
    const s = state();
    const old = s?.battle;
    if (!old || old.status === 'active') return;
    const b = retryBattle(s, settings());
    if (!b) return toast('이미 이야기로 보낸 전투는 다시 할 수 없어요.', 'warning');
    const m = ctx().chat?.[b.originIndex];
    if (m) { m.extra = { ...(m.extra ?? {}), battletale: { ...(m.extra?.battletale ?? {}) } }; m.extra.battletale.origin = [...(m.extra.battletale.origin ?? []), b.id]; try { await ctx().saveChat?.(); } catch { /* saved later */ } }
    ui.msg = null; ui.page = 'main'; ui.openingShown = null; ui.steps = null; ui.lastEvents = null; ui.target = null; ui.targetLocked = false;
    trace('start', `🔁 다시하기 (${b.retries}회째) · ${b.title || b.mode}`, '');
    await saveState(); afterChange();
    toast(`🔁 다시 도전! (${b.retries}회째)`, 'info');
  },
  dismissResult: async () => { const s = state(); if (s?.battle) { s.battle.resultPending = false; s.battle.resultKey = 'dismissed'; await saveState(); afterChange(); } },
  codex: () => deps().codex.list(),
  rosterOf: entry => rosterSheet(state(), entry),
  hasRoster: entry => { const s = state(); return !!(s?.roster?.[entry.id] || s?.companions?.some(c => c.codexId === entry.id)); },
  saveCodex: async (entry, sheetRaw) => {
    const s = state();
    const p = profileOf(s);
    const sheet = normalizeSheet({ ...sheetRaw }, p, { side: 'enemy', seed: sheetRaw.name });
    const e = { ...(entry ?? { id: `c${Math.random().toString(36).slice(2, 10)}` }), name: sheet.name, updated: Date.now() };
    sheet.codexId = e.id; delete sheet.side;
    e.sheet = sheet;
    deps().codex.put(e);
    if (s?.roster?.[e.id]) delete s.roster[e.id];
    await saveState(); afterChange(); toast(`📖 저장: ${e.name}`);
    return e;
  },
  deleteCodex: async id => { deps().codex.remove(id); afterChange(); },
  lockCodex: async (id, on) => { const c = deps().codex; const e = c.list().find(x => x.id === id); if (e) { c.put({ ...e, locked: on }); afterChange(); } },
  promote: async id => { if (promoteToCodex(state(), deps(), id)) { toast('이 채팅의 성장 상태를 기본판에 반영했어요.'); afterChange(); } },
  resetRoster: async id => { const s = state(); delete s.roster[id]; await saveState(); afterChange(); toast('이 채팅의 성장 기록을 지웠어요.'); },
  joinCodex: async id => { const s = state(); const e = deps().codex.list().find(x => x.id === id); const j = e && joinParty(s, deps(), e.name); if (j) { await saveState(); afterChange(); toast(`🤝 ${j.name} 동료 합류`); } else toast('이미 동료이거나 찾을 수 없어요.', 'warning'); },
  genCodex: ({ id = null, name, concept = '', tier = '', shape = '', aliases = '', instruction = '' }) => work(async () => {
    if (!effectiveAuxReady()) { toast('보조모델이 필요해요. ⚙ 설정에서 연결해주세요.', 'warning'); return null; }
    const s = state();
    try {
      const profile = await ensureProfile(s, deps());
      // Read only this character's own world-info entries (if any), not the whole lorebook.
      const lore = (await matchLore(settings(), [name, aliases, concept].join('\n'))).text;
      toast(`🤖 ${name} 시트 생성 중…${lore ? ' (월드인포 참고)' : ''}`);
      const prev = id ? deps().codex.list().find(x => x.id === id) : null;
      const current = instruction && prev ? rosterSheet(s, prev) : null;
      // Canon for rank judgement: the card (the bot may BE this character, or describe them) and story lines that mention them.
      const names = [name, ...String(aliases ?? '').split(',')].map(x => x.trim()).filter(Boolean);
      const seen = mentions(ctx().chat, names, { strip: stripBlocks, lookback: Math.max(10, Number(settings().castScene) || 20) * 3 });
      const maxSkills = requestedSkillCap([concept, instruction].join('\n'), { current });
      const raw = await deps().auxJson(sheetMessages({ profile, own: lore, persona: concept, personaName: name, npc: true, tier, current, instruction, roster: rosterBrief(name), card: characterText(), story: seen, brief: briefText(s.brief), maxSkills }), { maxTokens: 2400 });
      if (raw.__truncated) toast('⚠ 보조모델 답이 중간에 잘렸어요. 받은 부분까지만 반영했어요 (⚙ 최대 응답 토큰을 늘려보세요).', 'warning');
      Object.assign(raw, { name, desc: raw.desc || concept.slice(0, 200) });
      if (tier) raw.tier = tier;
      if (shape) raw.shape = shape;
      if (aliases) raw.aliases = aliases;
      const old = prev ?? deps().codex.list().find(x => x.name === name);
      if (old?.sheet?.portrait && !raw.portrait) raw.portrait = old.sheet.portrait;
      const e = registerCharacter(s, deps(), raw, { side: 'enemy', locked: old?.locked ?? false, maxSkills });
      if (old && old.id !== e.id) deps().codex.remove(old.id);
      deps().codex.put({ ...e, concept, history: [...(old?.history ?? []), ...(instruction ? [{ at: Date.now(), instruction }] : [])].slice(-8) });
      if (s.roster?.[e.id]) delete s.roster[e.id];
      await saveState();
      toast(`📖 ${e.name} 등록 완료`, 'success');
      afterChange();
      return e;
    } catch (err) { toast(`생성 실패: ${err.message}`, 'error'); afterChange(); return null; }
  }),
  // One shot: find the cast AND build their sheets in the same aux call, register them right away.
  // Unwanted ones are rerolled or deleted from the codex list afterwards.
  scanCast: () => work(async () => {
    if (!effectiveAuxReady()) return toast('보조모델이 필요해요. ⚙ 설정에서 연결해주세요.', 'warning');
    const s = state();
    try {
      const profile = await ensureProfile(s, deps());
      const persona = deps().persona();
      const n = Math.max(2, Math.min(60, Number(settings().castScene) || 20));
      const history = recentScene(ctx().chat, n, stripBlocks);
      const lore = await personEntries(settings());
      const existing = rosterBrief('') || '';
      const limit = Math.max(1, Math.min(8, Number(settings().castBatch) || 4));
      const includePlayer = !s.player;
      toast(`🧭 인물을 찾아 바로 시트까지 만드는 중… (최대 ${limit}명${includePlayer ? ' + 나' : ''})`);
      const r = await deps().auxJson(castMessages({ profile, personaName: persona.name, persona: persona.text, character: characterText(), lore, history, existing: existing ? existing.split('\n') : [], limit, includePlayer, brief: briefText(s.brief) }), { maxTokens: 9000 });
      const known = new Set(deps().codex.list().flatMap(e => [e.name, ...(Array.isArray(e.sheet?.aliases) ? e.sheet.aliases : [])]).map(x => String(x).trim()));
      const list = (Array.isArray(r?.characters) ? r.characters : []).filter(c => c?.name && !known.has(String(c.name).trim()) && (includePlayer || c.role !== 'player')).slice(0, limit + (includePlayer ? 1 : 0));
      const fresh = [];
      for (const c of list) {
        const concept = String(c.concept ?? '').slice(0, 400);
        if (c.role === 'player') {
          s.playerConcept = s.playerConcept || concept;
          applyPlayerSheet(s, deps(), { ...c, desc: c.desc || concept.slice(0, 200) });
          fresh.push('player');
          continue;
        }
        const raw = { ...c, name: String(c.name).slice(0, 40), desc: c.desc || concept.slice(0, 200), aliases: Array.isArray(c.aliases) ? c.aliases.map(String).slice(0, 4) : [] };
        if (!raw.skills?.length) { raw.skills = []; }   // a bare entry still registers; reroll fills it
        const e = registerCharacter(s, deps(), raw, { side: 'enemy' });
        deps().codex.put({ ...e, concept, role: String(c.role ?? 'npc'), why: String(c.why ?? '').slice(0, 120) });
        fresh.push(e.id);
      }
      ui.castFresh = fresh;
      ui.castMore = !!r?.more || !!r?.__truncated;
      ui.cast = null;
      await saveState();
      if (r?.__truncated) toast('⚠ 답이 길어서 잘렸어요. 완성된 인물까지만 등록했어요 — 나머지는 "더 찾기"로 (⚙ 최대 응답 토큰을 늘리거나 "인물 찾기 한 번에"를 줄여도 돼요).', 'warning');
      if (!fresh.length) toast('찾은 인물이 없어요. 대화가 조금 더 진행된 뒤 다시 해보세요.', 'warning');
      else toast(`📖 ${fresh.length}명 등록! 마음에 안 드는 인물은 목록의 🎲 리롤 / ✕ 삭제로 정리하세요.${ui.castMore ? ' 남은 인물은 "더 찾기"로.' : ''}`, 'success');
    } catch (e) { toast(`인물 찾기 실패: ${e.message}`, 'error'); }
    afterChange();
  }),
  rerollCodex: async id => {
    const e = deps().codex.list().find(x => x.id === id);
    if (!e) return;
    const sh = e.sheet ?? {};
    return panelApi.genCodex({ id, name: e.name, concept: e.concept ?? sh.desc ?? '', tier: '', shape: sh.shape ?? '', aliases: (sh.aliases ?? []).join(', ') });
  },
  syncCodex: id => work(async () => {
    const s = state();
    const e = deps().codex.list().find(x => x.id === id);
    if (!e) return;
    if (!effectiveAuxReady()) return toast('먼저 ⚙ 설정에서 보조모델을 연결해 주세요.', 'warning');
    const profile = profileOf(s);
    const sh = rosterSheet(s, e);
    const names = [e.name, ...(Array.isArray(sh.aliases) ? sh.aliases : [])];
    const story = mentions(ctx().chat, names, { strip: stripBlocks, lookback: Math.max(15, Number(settings().castScene) || 20) * 3 });
    const scene = recentScene(ctx().chat, Math.max(6, Number(settings().sheetScene) || 6), { strip: stripBlocks });
    if (!story && !scene) return toast('최근 대화에서 반영할 내용을 찾지 못했어요.', 'warning');
    toast(`📖 "${e.name}" 최근 대화 반영해 갱신 중…`);
    try {
      const own = (await matchLore(settings(), names.join('\n')).catch(() => null))?.text ?? '';
      const raw = await deps().auxJson(sheetMessages({
        profile, lore: '', own, story, brief: briefText(s.brief),
        persona: e.concept || sh.desc || e.name, personaName: e.name, npc: true,
        card: characterText(), scene, roster: rosterBrief(e.name),
        current: sh,
        instruction: '기존 시트의 정체성과 핵심 스킬을 유지하되, 최근 대화에서 드러난 성장·등급 변화·새 기술 습득·장비 변경·현재 상태를 반영해 시트를 업데이트해줘.',
      }), { maxTokens: 2400 });
      if (!raw || typeof raw !== 'object') throw new Error('응답이 비어 있음');
      const next = normalizeSheet({ ...raw, name: e.name, aliases: sh.aliases ?? raw.aliases }, profile, { side: e.side ?? 'enemy', seed: e.name });
      deps().codex.put({ ...e, sheet: next, updatedAt: Date.now() });
      if (s.roster?.[e.id]) s.roster[e.id] = { ...s.roster[e.id], hp: Math.min(s.roster[e.id].hp ?? next.maxHp, next.maxHp), maxHp: next.maxHp, sp: Math.min(s.roster[e.id].sp ?? next.maxSp, next.maxSp), maxSp: next.maxSp, tier: next.tier, stats: clone(next.stats), skills: clone(next.skills), lines: clone(next.lines) };
      toast(`✨ "${e.name}" 최신 대화 반영 완료!`, 'success');
      trace('change', `도감 대화 동기화 · ${e.name}`, `등급: ${sh.tier ?? '?'} → ${next.tier ?? '?'}\n스킬: ${next.skills.map(k => k.name).join(', ')}`);
      await saveState();
    } catch (err) { toast(`도감 갱신 실패: ${err.message}`, 'error'); }
    afterChange();
  }),
  confirmPreview: () => work(async () => {
    const s = state();
    const pv = ui.preview;
    if (!pv?.spec) return;
    if (!pv.spec.enemies?.length) return toast('적이 최소 1명은 있어야 해요.', 'warning');
    ui.preview = null;
    try {
      await commitBattle(s, pv.spec, { index: pv.index, mode: pv.mode });
      await saveState();
    } catch (e) { toast(`전투 시작 실패: ${e.message}`, 'error'); }
    afterChange();
  }),
  cancelPreview: () => { ui.preview = null; refreshPanel(); },
  reforgePreview: () => { const hint = ui.preview?.hint ?? ''; const mode = ui.preview?.mode ?? null; ui.preview = null; return manualStart(hint, mode); },
  personaChanged: () => {
    const s = state();
    if (!s?.player) return false;
    const info = personaInfo();
    if (!info.text) return false;
    const h = hashStr(info.text);
    if (!s.playerPersonaHash) { s.playerPersonaHash = h; return false; }
    return s.playerPersonaHash !== h;
  },
  dismissPersonaChange: async () => {
    const s = state();
    const info = personaInfo();
    if (s && info.text) { s.playerPersonaHash = hashStr(info.text); await saveState(); }
    refreshPanel();
  },
  claimLoot: async () => {
    const s = state();
    const added = claimLoot(s, s?.battle);
    if (!added.length) return toast('이미 가방에 담았거나 전리품이 없어요.', 'info');
    await saveState(); afterChange();
    toast(`🎒 가방에 담음: ${added.join(', ')}`, 'success');
  },
  restAfter: async (kind = 'short') => {
    const s = state();
    const done = restAfterBattle(s, kind);
    if (!done.length) return toast('이미 최상의 컨디션이에요.', 'info');
    await saveState(); afterChange();
    toast(kind === 'full' ? `🛏 완전 회복 완료 (${done.join(', ')})` : `🏕 짧은 휴식 +30% (${done.join(', ')})`, 'success');
  },
  setRuleSet: async sys => {
    const s = state();
    const before = profileOf(s);
    s.profile = setTypeSystem(before, sys);
    remapTiers(s, before.tiers, s.profile.tiers);
    // Live-sync active battle so switching between world elements and Pokémon types works even mid-battle.
    const b = s.battle?.st?.b ?? s.battle?.st;
    if (b && 'typeSystem' in b) {
      b.typeSystem = s.profile.typeSystem;
      b.chart = s.profile.chart;
      b.stab = s.profile.stab;
    }
    settings().ruleSet = s.profile.typeSystem;
    saveSettings();
    deps().cache.set(s.profile); await saveState(); afterChange();
    toast(sys === 'pokemon' ? '🎮 포켓몬 속성 체계로 전환 (18타입·공식 상성표)' : '🌍 세계관 속성 체계로 전환');
  },
  setTierPreset: async key => {
    const s = state();
    const before = profileOf(s);
    const { profile } = applyTierPreset(before, key);
    s.profile = profile;
    remapTiers(s, before.tiers, profile.tiers);
    deps().cache.set(s.profile); await saveState(); afterChange();
    toast(`🏷 등급 체계: ${profile.tiers.map(t => t.name).join(' → ')}`);
  },
  switchMode: async mode => { const s = state(); if (switchMode(s, mode, settings())) { await saveState(); afterChange(); toast(`${MODES[mode].icon} ${MODES[mode].ko}(으)로 바꿨어요.`); } else { toast('이 형식으로는 바꿀 수 없어요 (결투는 적이 1명일 때만).', 'warning'); afterChange(); } },
  stop: async (result = 'stopped') => {
    const s = state();
    const r = String(result ?? '').trim();
    const res = ['win', 'lose', 'fled', 'success', 'stopped'].includes(r) ? r : 'stopped';
    if (stopBattle(s, res, settings())) { await saveState(); afterChange(); toast(res === 'stopped' ? '전투를 중단했어요.' : `전투를 종료했어요 (${res}).`); }
  },
  genSheet: (extra, instruction = '') => work(async () => {
    const s = state();
    s.playerConcept = extra || s.playerConcept || '';
    try { await ensurePlayer(s, deps(), { force: true, extra: s.playerConcept, instruction }); toast(instruction ? '✍️ 지시대로 고쳤어요!' : '🧬 시트 완성!', 'success'); } catch (e) { toast(`시트 생성 실패: ${e.message}`, 'error'); }
    await saveState(); afterChange();
  }),
  importStat: async () => {
    const s = state();
    const f = lastStatFields();
    if (!f) return toast(`최근 메시지에서 <${settings().statTag || 'stat'}> 태그를 찾지 못했어요.`, 'warning');
    if (!s.player) { await work(() => ensurePlayer(s, deps()).catch(e => toast(e.message, 'error'))); }
    else syncFromStatus(s, f, 'all');
    await saveState(); afterChange(); toast('📥 상태창 값을 가져왔어요.');
  },
  setup: () => runSetup({ ask: false }),
  brief: () => state()?.brief ?? null,
  genRules: () => work(async () => {
    const s = state();
    try { await ensureProfile(s, deps(), { force: true }); toast('📜 룰 분석 완료! 시트도 새 룰로 다시 만들면 좋아요.', 'success'); } catch (e) { toast(`룰 분석 실패: ${e.message}`, 'error'); }
    await saveState(); afterChange();
  }),
  saveRules: async j => { const s = state(); s.profile = normalizeProfile(j); deps().cache.set(s.profile); await saveState(); afterChange(); },
  saveSheets: async j => {
    const s = state();
    const p = profileOf(s);
    if (j.player) { s.player = normalizeSheet({ ...j.player, isPlayer: true, id: 'player' }, p, { side: 'ally' }); s.player.id = 'player'; }
    if (Array.isArray(j.companions)) s.companions = j.companions.map(c => normalizeSheet(c, p, { side: 'ally', seed: c.name }));
    if (Array.isArray(j.inventory)) s.inventory = j.inventory.filter(i => i?.name).map(i => ({ name: String(i.name), count: Math.max(0, Number(i.count) || 1), ...(i.spec ? { spec: i.spec } : {}) }));
    await saveState(); afterChange();
  },
  addSkill: async text => { const s = state(); if (!s.player) return toast('먼저 시트를 만들어 주세요.', 'warning'); const sk = normalizeSkill(text, { maxSp: s.player.maxSp }); if (sk) s.player.skills.push(sk); await saveState(); afterChange(); },
  edit: async (fn, { quiet = false } = {}) => { const s = state(); if (!s) return; fn(s); await saveState(); if (!quiet) afterChange(); else renderAll(); },
  resetChat: async () => { const m = ctx().chatMetadata; delete m.battletale; stateOf(m); await saveState(); afterChange(); },
};

/* ---------------- Rendering ---------------- */
let renderTimer = null;
function renderAll() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const s = enabledHere() ? state() : null;
    renderCards(s, ctx().chat ?? [], settings());
    setFab(settings().enabled && !!ctx().chatId, s?.battle?.status === 'active');
  }, 60);
}
function afterChange() { renderAll(); refreshPanel(); try { refreshDock(); } catch { /* dock not open */ } }

/* ---------------- Settings UI ---------------- */
function bindSettings() {
  const root = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
  if (!root || document.querySelector('.battletale-settings')) return;
  root.insertAdjacentHTML('beforeend', settingsHtml());
  const el = document.getElementById('bt_enabled');
  if (el) { el.checked = !!settings().enabled; el.addEventListener('change', () => { settings().enabled = el.checked; saveSettings(); afterChange(); }); }
  document.getElementById('bt_open_settings')?.addEventListener('click', () => { ui.settingsOpen = true; togglePanel(true); });
}

function setSetting(key, value) {
  const s = settings();
  if (key === 'statTag') value = safeTag(value);
  if (key.startsWith('mode.')) s.modes = { ...(s.modes ?? {}), [key.slice(5)]: !!value };
  else s[key] = value;
  saveSettings();
  if (key === 'ruleSet') { panelApi.setRuleSet(value); return; }
  if (key === 'dealMul' || key === 'takeMul') {
    const b = state()?.battle?.st?.b ?? state()?.battle?.st;
    if (b) {
      if (key === 'dealMul') b.dealMul = Math.max(0.1, Math.min(10, Number(value) || 1));
      if (key === 'takeMul') b.takeMul = Math.max(0, Math.min(10, Number(value) ?? 1));
    }
  }
  if (key === 'enabled') { const el = document.getElementById('bt_enabled'); if (el) el.checked = !!value; }
  if (key.startsWith('aux')) ui.auxTest = null;
  afterChange();
}

/** SillyTavern's own avatars (served by ST itself, nothing to store): current persona + this chat's characters. */
function avatarChoices() {
  const c = ctx(), out = [];
  const thumb = (type, file) => (c.getThumbnailUrl ? c.getThumbnailUrl(type, file) : `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`);
  const lastUser = [...(c.chat ?? [])].reverse().find(m => m.is_user && m.force_avatar);
  if (lastUser) out.push({ label: '내 페르소나', src: lastUser.force_avatar.startsWith('/') || lastUser.force_avatar.startsWith('http') ? lastUser.force_avatar : `/${lastUser.force_avatar}` });
  const ids = c.groupId ? (c.groups?.find(g => g.id === c.groupId)?.members ?? []).map(av => c.characters.findIndex(ch => ch.avatar === av)) : [c.characterId];
  for (const i of ids) { const ch = c.characters?.[i]; if (ch?.avatar && ch.avatar !== 'none') out.push({ label: ch.name, src: thumb('avatar', ch.avatar) }); }
  return out.filter(a => safePortrait(a.src)).slice(0, 6);
}

/** Rank names changed (preset / rule set): move every stored sheet to the rank at the same relative position. */
function remapTiers(s, oldTiers = [], newTiers = []) {
  const same = oldTiers.length === newTiers.length && oldTiers.every((t, i) => t.name === newTiers[i]?.name);
  if (same || !newTiers.length) return;
  const map = name => {
    const i = oldTiers.findIndex(t => t.name === name);
    if (i < 0) return name;
    const r = oldTiers.length > 1 ? i / (oldTiers.length - 1) : 0;
    return newTiers[Math.round(r * (newTiers.length - 1))].name;
  };
  const fix = sh => { if (sh?.tier) sh.tier = map(sh.tier); };
  fix(s.player);
  for (const c of s.companions ?? []) fix(c);
  for (const r of Object.values(s.roster ?? {})) fix(r);
  const c = deps().codex;
  for (const e of c.list()) if (e.sheet?.tier && map(e.sheet.tier) !== e.sheet.tier) c.put({ ...e, sheet: { ...e.sheet, tier: map(e.sheet.tier) } });
}

/** Short lines describing registered characters, used as the yardstick for new ones. */
function rosterBrief(exceptName = '') {
  const list = deps().codex.list().filter(e => e.name !== exceptName).slice(-10);
  return list.map(e => {
    const sh = e.sheet ?? {};
    const st = Object.entries(sh.stats ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
    const top = (sh.skills ?? []).filter(k => k.power).sort((a, b) => b.power - a.power).slice(0, 2).map(k => `${k.name} ${k.power}`).join(', ');
    return `- ${e.name} [${sh.tier ?? '?'}] HP ${sh.maxHp ?? '?'} · ${st}${top ? ` · strongest: ${top}` : ''}`;
  }).join('\n');
}

/** Set (or transform) the picture of the player or a codex entry, everywhere it is used. */
async function setPortrait(target, value) {
  const s = state();
  const apply = cur => safePortrait(typeof value === 'function' ? value(cur) : value);
  if (target === 'player') { if (!s?.player) return; s.player.portrait = apply(s.player.portrait); }
  else if (String(target).startsWith('codex:')) {
    const id = target.slice(6);
    const c = deps().codex; const e = c.list().find(x => x.id === id); if (!e) return;
    const p = apply(e.sheet.portrait);
    c.put({ ...e, sheet: { ...e.sheet, portrait: p } });
    if (s?.roster?.[id]) s.roster[id].portrait = p;
    for (const comp of s?.companions ?? []) if (comp.codexId === id) comp.portrait = p;
  }
  await saveState(); afterChange();
}

function connectionProfiles() {
  return (ctx().extensionSettings?.connectionManager?.profiles ?? []).map(p => ({ id: p.id, name: p.name, model: p.model ?? '', api: p.api ?? p.mode ?? '' }));
}

async function auxTestRun() {
  if (!effectiveAuxReady()) { ui.auxTest = { ok: false, text: '보조모델 설정이 비어 있어요.' }; return refreshPanel(); }
  ui.auxTest = { ok: true, text: '테스트 중…' }; refreshPanel();
  const t0 = Date.now();
  try {
    const t = await callAux([{ role: 'system', content: 'Reply with JSON only.' }, { role: 'user', content: 'Answer exactly: {"ok": true, "model": "<your model name>"}' }], settings(), { maxTokens: 80 });
    ui.auxTest = { ok: true, text: `연결 성공 (${((Date.now() - t0) / 1000).toFixed(1)}초): ${String(t).replace(/\s+/g, ' ').slice(0, 120)}` };
  } catch (e) { ui.auxTest = { ok: false, text: `연결 실패: ${e.message}` }; }
  refreshPanel();
}

async function auxModelList() {
  try {
    const list = await listModels(settings());
    ui.auxModels = list;
    ui.auxTest = { ok: true, text: `모델 ${list.length}개를 불러왔어요. 모델 칸을 눌러 고르세요.` };
  } catch (e) { ui.auxTest = { ok: false, text: `모델 목록 실패: ${e.message}` }; }
  refreshPanel();
}

/* ---------------- One-time setup (wand menu) ---------------- */
async function askYesNo(html, ok, no) {
  const c = ctx();
  try {
    if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE) {
      const r = await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM, '', { okButton: ok, cancelButton: no });
      return r === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1) || r === true;
    }
  } catch (e) { console.warn('[BattleTale] popup', e); }
  return window.confirm(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

const SETUP_WHAT = '세계관 로어북 · 캐릭터 디스크립션 · 페르소나 · 최근 대화를 가볍게 읽고<br><b>속성·상성표 · 등급/강함 체계 · 전투 방식</b>을 짧은 기초 설정으로 정리해 둬요.<br>이후 시트·전투·상시 프롬프트는 이 요약을 써서 더 가볍고 일관되게 돌아가요.';

/** Turn BattleTale on for this chat and build the world brief (rules, ranks, elements + chart, how fights work). */
async function runSetup({ ask = true } = {}) {
  if (!ctx().chatId) return toast('채팅을 먼저 열어주세요.', 'warning');
  const s = state();
  if (ask) {
    const on = enabledHere();
    const html = s.brief ? `<h3>⚔ BattleTale 기초 설정 다시 만들기</h3><p>세계관을 다시 읽어 정리해요. 지금 룰(등급·속성·상성)은 새 분석으로 바뀌고, 캐릭터 시트는 그대로예요.</p>`
      : on ? `<h3>⚔ 이 채팅의 BattleTale 기초 설정을 만들까요?</h3><p>${SETUP_WHAT}</p>`
        : `<h3>⚔ 이 채팅에서 BattleTale을 활성화할까요?</h3><p>${SETUP_WHAT}</p>`;
    if (!await askYesNo(html, s.brief ? '다시 만들기' : on ? '만들기' : '활성화', '취소')) return;
  }
  s.disabled = false;
  s.activated = true;
  if (!settings().enabled) setSetting('enabled', true);
  await saveState(); afterChange();
  if (!effectiveAuxReady()) { toast('활성화했어요. 기초 설정은 ⚙ 설정에서 보조모델을 연결한 뒤 룰 탭의 "🧭 기초 설정"으로 만들 수 있어요.', 'warning'); togglePanel(true); return; }
  await work(async () => {
    const hadPlayer = !!s.player;
    try {
      toast('🧭 세계관을 읽고 기초 설정을 만드는 중…');
      await setupChat(s, deps());
      const p = s.profile;
      toast(`📜 기초 설정 완료 — ${p.name} · 등급 ${p.tiers.length}단계${p.elements?.length ? ` · 속성 ${p.elements.length}종` : ''}${!hadPlayer && s.player ? ` · ${s.player.name} 시트 (${s.player.tier})` : ''}`, 'success');
      if (hadPlayer) toast('기존 캐릭터 시트는 그대로 뒀어요. 새 기준으로 다시 만들려면 캐릭터 탭에서 🤖 다시 만들기를 눌러주세요.');
    } catch (e) { toast(`기초 설정 실패: ${e.message}`, 'error'); }
  });
  await saveState(); afterChange(); togglePanel(true);
}

/* ---------------- Slash commands ---------------- */
function registerCommands() {
  const c = ctx();
  const reg = (name, fn, help) => {
    try {
      if (c.SlashCommandParser && c.SlashCommand) {
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
          name, callback: async (_args, value) => (await fn(String(value ?? '').trim())) ?? '', helpString: help,
          unnamedArgumentList: c.SlashCommandArgument ? [c.SlashCommandArgument.fromProps({ description: 'text', typeList: [c.ARGUMENT_TYPE?.STRING ?? 'string'], isRequired: false })] : [],
        }));
      } else c.registerSlashCommand?.(name, (_a, v) => fn(String(v ?? '').trim()), [], help, true, true);
    } catch (e) { console.warn('[BattleTale] slash', name, e); }
  };
  reg('bt-start', hint => manualStart(hint), '지금 장면에서 시작. 예: /bt-start 고블린 3마리 · /bt-start 검객과 결투 · /bt-start 경비 몰래 잠입');
  reg('bt-register', async text => {
    // /bt-register 엘리어스 | 비행/강철 | A | 신속사격: 물리 40 우선도2 비행 / 백스탭: 우선도-1 자신 방어+1 저항+1 회복25%
    const [name, types, tier, ...rest] = String(text).split('|').map(x => x.trim());
    if (!name) return toast('형식: /bt-register 이름 | 타입 | 등급 | 스킬1 / 스킬2', 'warning');
    const s = state();
    await ensureProfile(s, deps());
    const skills = rest.join('|').split(/\s+\/\s+|\n/).map(x => x.trim()).filter(Boolean);
    const e = registerCharacter(s, deps(), { name, elements: types, tier, skills }, { side: 'enemy' });
    await saveState(); afterChange();
    toast(`📖 ${e.name} 등록 (스킬 ${e.sheet.skills.length}개)`, 'success');
    return '';
  }, '도감에 캐릭터 등록: /bt-register 이름 | 타입 | 등급 | 스킬1 / 스킬2');
  reg('bt-mode', m => panelApi.switchMode(({ 파티: 'party', 결투: 'duel', 잠입: 'stealth', 추격: 'stealth' })[m] ?? m), '첫 턴 전에 형식 변경: party | duel | stealth');
  reg('bt-end', r => panelApi.stop(r), '진행 중인 전투 중단');
  reg('bt-panel', () => togglePanel(), 'BattleTale 패널 열기/닫기');
  reg('bt-sheet', extra => panelApi.genSheet(extra), '보조모델로 내 캐릭터 시트 (재)생성');
  reg('bt-setup', () => runSetup(), '이 채팅에서 BattleTale 켜기 + 기초 설정 (속성·상성·등급·전투 방식) 만들기');
  reg('bt-rules', () => panelApi.genRules(), '보조모델로 세계관 룰 (재)분석');
  reg('bt-status', () => {
    const s = state(); const b = s?.battle;
    if (b) {
      const list = b.st?.fighters ?? b.st?.b?.fighters;
      return list ? JSON.stringify(list.map(f => ({ name: f.name, hp: `${f.hp}/${f.maxHp}`, sp: `${f.sp}/${f.maxSp}` }))) : modeOf(b.mode).status(b.st, profileOf(s));
    }
    return s?.player ? `${s.player.name} HP ${s.player.hp}/${s.player.maxHp}` : 'no data';
  }, '현재 전투/시트 상태 반환');
}

/* ---------------- Boot ---------------- */
(function boot() {
  const c = ctx();
  settings();
  const ev = c.eventSource, T = c.eventTypes ?? c.event_types;
  let booted = false;
  const onReady = () => {
    if (booted) return;
    booted = true;
    document.getElementById('bt-wand')?.remove();
    for (const step of [bindSettings, () => mountPanel(panelApi), registerCommands, () => { try { if (localStorage.getItem('bt-dock') === '1') toggleDock(true); } catch { /* ignore */ } }, afterChange]) {
      try { step(); } catch (e) { console.error('[BattleTale] boot step failed', e); }
    }
  };
  if (document.readyState === 'complete' && document.getElementById('extensions_settings2')) onReady();
  else ev.on(T.APP_READY, onReady);
  setTimeout(() => { if (!document.getElementById('bt-fab')) onReady(); }, 4000);

  ev.on(T.MESSAGE_RECEIVED, idx => processMessage(typeof idx === 'number' ? idx : ctx().chat.length - 1));
  if (T.GENERATION_ENDED) ev.on(T.GENERATION_ENDED, () => setTimeout(() => processMessage(ctx().chat.length - 1), 100));
  ev.on(T.MESSAGE_SWIPED, () => setTimeout(() => processMessage(ctx().chat.length - 1), 50));
  ev.on(T.MESSAGE_EDITED, idx => { const m = ctx().chat?.[idx]; if (m && !m.is_user) processMessage(idx); else { const s = state(); if (s && syncHistory(s, ctx().chat, settings()).changed) { saveState(); afterChange(); } } });
  ev.on(T.MESSAGE_DELETED, () => { const s = state(); if (s && syncHistory(s, ctx().chat, settings()).changed) { toast('메시지 삭제에 맞춰 전투를 되돌렸어요.', 'warning'); saveState(); } afterChange(); });
  ev.on(T.CHAT_CHANGED, () => { forgetActivated(); ui.actor = null; ui.target = null; setPrompt(''); afterChange(); });
  for (const t of [T.CHARACTER_MESSAGE_RENDERED, T.USER_MESSAGE_RENDERED, T.MORE_MESSAGES_LOADED, T.MESSAGE_UPDATED]) if (t) ev.on(t, renderAll);
  if (T.WORLD_INFO_ACTIVATED) ev.on(T.WORLD_INFO_ACTIVATED, rememberActivated);
  console.log('[BattleTale] loaded');
})();
