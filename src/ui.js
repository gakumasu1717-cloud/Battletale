// DOM: floating battle panel, in-chat turn cards, settings drawer.
import { escapeHtml as h, pct, norm } from './util.js';
import { STATUS, DERIVED_KO, ELEMENT_KO, THREAT_KO, ITEM_KIND_KO, inferItem, skillLine, normalizeSkill, typeName, POKE_KO, typeIn, typesFor, toPoke, elementId, TIER_PRESETS, TRAITS } from './catalog.js';
import { eventLines, pkLines, josa } from './narrate.js';
import { scene, menuGrid, barRow, animateBars, SHAPE_KO, inspectHtml, handHtml, orderHtml, TYPE_HEX, skillCard, skillDetailLines, skillSheet } from './pkui.js';
import { findFighter } from './engine.js';
import { THREAT_LABEL } from './engine.js';
import { msgKey, profileOf, MODES, modeOf, allowedModes } from './game.js';
import { keyMoments } from './prompts.js';
import { dangerScore } from './parse.js';

const KIND_KO = { physical: '물리', magic: '마법', heal: '회복', buff: '강화', debuff: '약화', guard: '방어', revive: '부활', cleanse: '정화' };
const TARGET_KO = { enemy: '적 1', enemies: '적 전체', ally: '아군 1', allies: '아군 전체', self: '자신' };

let api = null;   // callbacks from index.js
let tab = 'battle';
let editing = null;

export function mountPanel(callbacks) {
  api = callbacks;
  if (document.getElementById('bt-fab')) return;
  const fab = document.createElement('div');
  fab.id = 'bt-fab';
  fab.title = 'BattleTale';
  fab.innerHTML = '⚔️<span class="bt-badge"></span>';
  fab.addEventListener('click', () => togglePanel());
  fab.style.display = 'none'; // off by default; the wand menu is the main entry (setting: 떠 있는 버튼)
  document.body.appendChild(fab);
  mountWand();

  const panel = document.createElement('div');
  panel.id = 'bt-panel';
  panel.className = 'bt-hidden';
  document.body.appendChild(panel);
  try {
    api.ui.compact = localStorage.getItem('bt-compact') === '1';
    const w = Number(localStorage.getItem('bt-panel-w'));
    if (w >= 360 && w <= 900 && globalThis.innerWidth > 700) panel.style.width = `${w}px`;
    // Desktop: the panel can be resized from its corner; remember the width.
    if (globalThis.ResizeObserver) new ResizeObserver(([e]) => { const px = Math.round(e.contentRect.width); if (globalThis.innerWidth > 700 && px >= 360) localStorage.setItem('bt-panel-w', String(px)); }).observe(panel);
  } catch { /* storage or observer unavailable */ }
  panel.addEventListener('click', onClick);
  // Long-press a skill button to peek at its full effect card.
  let pressTimer = null, longPressed = false;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  panel.addEventListener('pointerdown', e => {
    // Long-press a fighter on the field (or a guard on the map) → details.
    const who = e.target.closest?.('.pk-mon[data-v], .pz-tok[data-v]');
    if (who) {
      cancelPress();
      pressTimer = setTimeout(() => { pressTimer = null; api.ui.inspect = who.dataset.v; longPressed = true; refreshPanel(); }, 420);
      return;
    }
    const el = e.target.closest?.('.pk-btn[data-act="pk:item"]');
    if (!el) return;
    const it = api.ui.menuItems?.[Number(el.dataset.i)];
    if (!it || !['m:skill', 'm:basic'].includes(it.act)) return;
    cancelPress();
    pressTimer = setTimeout(() => { pressTimer = null; api.ui.peek = Number(el.dataset.i); longPressed = true; refreshPanel(); }, 420);
  });
  panel.addEventListener('pointerup', () => { if (longPressed) { longPressed = false; api.ui.suppressUntil = Date.now() + 450; } }, true);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'scroll']) panel.addEventListener(ev, cancelPress, true);
  // Right-click (PC) = the same details a long-press opens on touch screens.
  panel.addEventListener('contextmenu', e => {
    const btn = e.target.closest?.('.pk-btn[data-act="pk:item"]');
    const who = e.target.closest?.('.pk-mon[data-v], .pz-tok[data-v], .pk-info[data-v]');
    if (!btn && !who) return;
    e.preventDefault();
    if (btn) { const it = api.ui.menuItems?.[Number(btn.dataset.i)]; if (it && ['m:skill', 'm:basic'].includes(it.act)) api.ui.peek = Number(btn.dataset.i); }
    else api.ui.inspect = who.dataset.v;
    refreshPanel();
  });
  panel.addEventListener('change', onChange);
  panel.addEventListener('toggle', e => { if (e.target?.hasAttribute?.('data-log')) api.ui.logOpen = e.target.open; }, true);
  panel.addEventListener('toggle', e => { const g = e.target?.dataset?.group; if (g && api.ui.sdOpen) api.ui.sdOpen[g] = e.target.open; }, true);
  panel.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-enter]')) { e.preventDefault(); panel.querySelector(`[data-act="${e.target.dataset.enter}"]`)?.click(); } });
}

export function togglePanel(force) {
  const p = document.getElementById('bt-panel');
  if (!p) return;
  const show = force ?? p.classList.contains('bt-hidden');
  p.classList.toggle('bt-hidden', !show);
  if (show) refreshPanel();
}

export function setFab(visible, inBattle) {
  const f = document.getElementById('bt-fab');
  if (f) {
    f.style.display = visible && api?.settings?.().showFab ? '' : 'none';
    f.classList.toggle('bt-live', !!inBattle);
  }
  mountWand();
  const w = document.getElementById('bt-wand-panel');
  if (w) { w.classList.toggle('bt-live', !!inBattle); w.style.display = visible ? '' : 'none'; }
  const d = document.getElementById('bt-wand-dock');
  if (d) d.style.display = visible ? '' : 'none';
}

/* ---------- Status dock (PokéTale-style side window: me, companions, bag, the fight) ---------- */
export function toggleDock(force) {
  let d = document.getElementById('bt-dock');
  if (!d) {
    d = document.createElement('div');
    d.id = 'bt-dock'; d.className = 'bt-hidden';
    document.body.appendChild(d);
    d.addEventListener('click', e => {
      const a = e.target.closest?.('[data-dock]')?.dataset.dock;
      if (a === 'close') toggleDock(false);
      else if (a === 'panel') { toggleDock(false); togglePanel(true); }
    });
  }
  const show = force ?? d.classList.contains('bt-hidden');
  d.classList.toggle('bt-hidden', !show);
  try { localStorage.setItem('bt-dock', show ? '1' : ''); } catch { /* ignore */ }
  if (show) refreshDock();
}

export function refreshDock() {
  const d = document.getElementById('bt-dock');
  if (!d || d.classList.contains('bt-hidden') || !api) return;
  const s = api.state();
  if (!s) { d.innerHTML = '<div class="bd-head"><b>📋 상태</b><button data-dock="close">✕</button></div><div class="bd-body bt-note">채팅을 열면 보여요.</div>'; return; }
  const p = profileOf(s);
  const b = s.battle?.status === 'active' ? s.battle : null;
  const live = b ? (b.st.fighters ?? b.st.b?.fighters ?? []) : [];
  const cur = f => live.find(x => x.name === f.name) ?? f;
  const bar = (v, m, cls) => `<div class="bd-bar ${cls}"><div style="width:${Math.max(0, Math.min(100, Math.round((v / Math.max(1, m)) * 100)))}%"></div><span>${v}/${m}</span></div>`;
  const pic = f => (f.portrait?.src ? `<img class="bd-pic ${f.portrait.pixel ? 'px' : ''}" src="${h(f.portrait.src)}" alt="" referrerpolicy="no-referrer">` : `<div class="bd-pic">${({ M: '🧑', F: '👩' })[f.gender] ?? '🧑'}</div>`);
  const types = f => typesFor(f, p.typeSystem).map(t => `<span class="pk-tdot t-${typeIn(t, p.typeSystem)}">${h(typeName(t, p.typeSystem))}</span>`).join('');
  const who = (f0, main) => { const f = cur(f0); return `<div class="bd-who ${main ? 'main' : ''} ${f.hp <= 0 ? 'down' : ''}">${pic(f0)}<div class="bd-info"><div><b>${h(f.name)}</b> <small>${h(f.tier ?? '')}</small> ${types(f0)}</div>
    ${bar(f.hp, f.maxHp, 'hp')}${f.maxSp ? bar(f.sp, f.maxSp, 'sp') : ''}${f.statuses?.length ? `<div class="bd-st">${f.statuses.map(x => `<span class="pk-st st-${x.id}">${STATUS[x.id]?.ko ?? x.id}</span>`).join('')}</div>` : ''}</div></div>`; };
  const me = s.player ? who(s.player, true) : '<div class="bt-note">아직 시트가 없어요 (캐릭터 탭).</div>';
  const comps = s.companions.map(c => who(c, false)).join('');
  const bag = s.inventory.filter(i => i.count > 0).map(i => `<li>${h(i.name)} <b>×${i.count}</b> <small>${h(ITEM_KIND_KO[(i.spec ?? inferItem(i.name))?.kind] ?? '')}</small></li>`).join('');
  const foes = b ? live.filter(f => f.side === 'enemy').map(f => `<li class="${f.hp <= 0 ? 'down' : ''}">${h(f.name)} <small>${(f.intel ?? 1) >= 1 ? `${Math.round((f.hp / Math.max(1, f.maxHp)) * 100)}%` : '?'}</small></li>`).join('') : '';
  const last = s.archive?.[0];
  d.innerHTML = `<div class="bd-head"><b>📋 상태</b>${b ? `<span class="bd-live">⚔️ ${b.st.turn}턴</span>` : ''}<button data-dock="panel" title="전투 패널">⚔️</button><button data-dock="close">✕</button></div>
    <div class="bd-body">${me}${comps ? `<div class="bd-sub">동료</div>${comps}` : ''}
      ${b ? `<div class="bd-sub">전투 중 · ${h(b.title || '')}</div><ul class="bd-list">${foes}</ul>` : last ? `<div class="bd-sub">최근 전투</div><div class="bt-note">${h(last.title)} — <b>${h(last.result)}</b> (${last.turns}턴)</div>` : ''}
      <div class="bd-sub">🎒 가방</div>${bag ? `<ul class="bd-list">${bag}</ul>` : '<div class="bt-note">비어 있어요</div>'}</div>`;
}

/** Entries in SillyTavern's wand (extensions) menu next to the chat box. */
let wandTries = 0;
export function mountWand() {
  if (document.getElementById('bt-wand-panel')) return;
  const menu = document.getElementById('extensionsMenu');
  if (!menu) { if (wandTries++ < 20) setTimeout(mountWand, 1000); return; }
  const item = (id, icon, label, fn) => {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.tabIndex = 0;
    el.innerHTML = `<div class="extensionsMenuExtensionButton">${icon}</div><span>${label}</span>`;
    el.addEventListener('click', fn);
    menu.appendChild(el);
  };
  item('bt-wand-panel', '⚔', 'BattleTale 전투 패널', () => togglePanel());
  item('bt-wand-dock', '≡', 'BattleTale 상태창', () => toggleDock());
}

function cheatBarHtml() {
  const set = api.settings();
  const deal = Number(set.dealMul ?? 1);
  const take = Number(set.takeMul ?? 1);
  const mkBtns = (key, cur, vals) => vals.map(([v, label]) => `<button class="bt-ch-b ${Math.abs(cur - v) < 0.01 ? 'on' : ''}" data-act="cheat-set" data-k="${key}" data-v="${v}">${label}</button>`).join('');
  return `<div class="bt-cheat-bar">
    <div class="bt-ch-head"><b>전투 배율 조정</b><button class="bt-mini" data-act="cheat-reset">기본값(1×)</button></div>
    <div class="bt-ch-row"><span>가하는 피해</span><div class="bt-ch-btns">${mkBtns('dealMul', deal, [[0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×'], [3, '3×'], [5, '5×']])}</div><input type="number" class="bt-ch-in" data-set="dealMul" data-kind="num" min="0.1" max="10" step="0.1" value="${deal}"></div>
    <div class="bt-ch-row"><span>받는 피해</span><div class="bt-ch-btns">${mkBtns('takeMul', take, [[0, '무적'], [0.25, '0.25×'], [0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']])}</div><input type="number" class="bt-ch-in" data-set="takeMul" data-kind="num" min="0" max="10" step="0.1" value="${take}"></div>
  </div>`;
}

export function refreshPanel() {
  const p = document.getElementById('bt-panel');
  if (!p || p.classList.contains('bt-hidden') || !api) return;
  const s = api.state();
  if (!s) { p.innerHTML = '<div class="bt-empty">채팅을 열어주세요.</div>'; return; }
  // Everyday tabs only; rules and the trace log live in the ⚙ drawer.
  if (tab === 'rules' || tab === 'trace') { api.ui.settingsOpen = true; api.ui.sdPage = tab; tab = 'battle'; }
  const tabs = [['battle', '전투'], ['sheet', '캐릭터'], ['codex', '도감']].map(([k, l]) => `<button class="bt-tab ${tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${l}</button>`).join('');
  const body = tab === 'sheet' ? sheetTab(s) : tab === 'codex' ? codexTab(s) : battleTab(s);
  const keep = p.querySelector('.sd-body')?.scrollTop ?? 0;
  p.classList.toggle('bt-compact', !!api.ui.compact && tab === 'battle');
  const set = api.settings();
  const deal = Number(set.dealMul ?? 1), take = Number(set.takeMul ?? 1);
  const cheatOn = Math.abs(deal - 1) >= 0.01 || Math.abs(take - 1) >= 0.01;
  p.innerHTML = `<div class="bt-head"><b>BattleTale</b><div class="bt-tabs">${tabs}</div><button class="bt-x bt-fold" data-act="compact" title="${api.ui.compact ? '전체 화면' : '접기 (채팅 보면서)'}">${api.ui.compact ? '⤢' : '⤡'}</button><button class="bt-x bt-gear ${cheatOn ? 'on' : ''}" data-act="settings-open" title="설정 · 룰 · 점검${cheatOn ? ` (피해 배율 ${deal}×/${take}× 적용 중)` : ''}">⚙</button><button class="bt-x" data-act="close">✕</button></div><div class="bt-body">${body}</div>${api.ui.settingsOpen ? drawerHtml(s) : ''}`;
  const sd = p.querySelector('.sd-body'); if (sd) sd.scrollTop = keep;
  animateBars(p);
  // Popups and HP slides play once per turn, not on every redraw.
  api.ui.fx = null; api.ui.anim = null; api.ui.atk = null;
  api.ui.prevHp = null;
  scheduleAuto();
}

/* Message window plays itself: each step (or two intro lines) stays up for a beat, longer when it has more
 * lines. Tapping still advances at once; ⓘ details, the settings drawer or another tab pause it. */
let autoTimer = null, autoKey = '';
function advanceTalk() {
  const ui = api.ui;
  if (ui.steps && (ui.stepPos ?? 0) < ui.steps.length) { ui.stepPos += 1; showStep(ui.stepPos); return; }
  ui.msgPos = (ui.msgPos ?? 0) + 2;
}
function scheduleAuto() {
  const ui = api.ui;
  const ms = Math.max(0, Number(api.settings?.().autoPlay ?? 1300) || 0);
  const stepping = !!ui.steps && (ui.stepPos ?? 0) < ui.steps.length;
  const talking = (ui.msgPos ?? 0) < (ui.msg?.length ?? 0);
  if (!ms || tab !== 'battle' || (!stepping && !talking) || ui.inspect || ui.peek != null || ui.settingsOpen || (!stepping && api.state?.()?.battle?.status !== 'active')) {
    clearTimeout(autoTimer); autoTimer = null; autoKey = ''; return;
  }
  const key = stepping ? `s${ui.stepPos}/${ui.steps.length}` : `m${ui.msgPos}/${ui.msg.length}`;
  if (key === autoKey && autoTimer) return;
  clearTimeout(autoTimer);
  autoKey = key;
  const lines = stepping ? Math.min(4, ui.steps[ui.stepPos]?.lines?.length ?? 1) : 2;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    if (autoKey !== key) return;
    autoKey = '';
    advanceTalk();
    refreshPanel();
  }, ms * (1 + 0.35 * Math.max(0, lines - 1)));
}

/* ---------- Settings drawer (inside the panel) ---------- */
const SETTINGS = [
  ['플레이', [
    { key: 'enabled', basic: true, type: 'check', label: '사용 (모든 채팅·모든 봇)' },
    { key: 'playMode', basic: true, type: 'select', label: '진행 방식', options: [['panel', '패널에서만 진행 → 결과만 이야기로'], ['chat', '턴마다 채팅으로 서술']] },
    { key: 'ruleSet', basic: true, type: 'select', label: '상성 체계 (새 채팅 기본값)', options: [['world', '세계관 속성'], ['pokemon', '포켓몬 18타입·공식 상성표']] },
    { key: 'mode.party', type: 'check', label: '파티전' }, { key: 'mode.duel', type: 'check', label: '1:1 대결 (싱글)' }, { key: 'mode.stealth', type: 'check', label: '잠입 (퍼즐)' },
    { key: 'resultDetail', type: 'select', label: '결과 전송 기본값', options: [['summary', '전투 요약'], ['result', '승패만'], ['full', '전체 로그']] },
    { key: 'difficulty', basic: true, type: 'select', label: '난이도', options: [['easy', '쉬움 — 공정한 전투, 기습 없음, AI 가끔 실수'], ['normal', '기본 — 유저 편향 없음, 기습·지형에 대비'], ['hard', '어려움 — 강한 적·연계, 전술 없으면 돌파 불가'], ['nightmare', '악몽 — 약점 저격·기습·불리한 지형, AI 최상']], hint: '적 구성(보조모델)과 적 AI, 기습·지형 확률이 같이 바뀌어요' },
    { key: 'spCostScale', type: 'select', label: '기력 소모 배율', options: [['1', '×1.0 (가볍게)'], ['1.3', '×1.3 (기본)'], ['1.6', '×1.6 (빡빡하게)'], ['2', '×2.0 (매 턴 신중하게)']], hint: '기술 비용에 곱해져요. 잡몹은 기력 없이 싸우고, 엘리트·보스·도감 캐릭터만 기력을 써요.' },
    { key: 'showThreat', type: 'check', label: '위협도 표시' },
    { key: 'autoPlay', type: 'select', label: '전투 메시지 자동 넘김', options: [['0', '끔 (탭해서 넘김)'], ['900', '빠르게'], ['1300', '보통 (기본)'], ['1900', '느리게']], hint: '탭하면 언제든 바로 다음으로' },
    { key: 'showFab', type: 'check', label: '화면에 떠 있는 패널 버튼도 쓰기', hint: '기본은 채팅창 옆 확장 메뉴에서 열어요' },
    { key: 'optIn', type: 'check', label: '새 채팅은 켜기 전까지 쉬기', hint: '켜면 처음 여는 채팅엔 아무것도 주입하지 않아요. 이미 시트·전투·기초 설정이 있는 채팅은 그대로 켜져 있어요.' },
    { key: 'exclude', type: 'text', label: '제외할 캐릭터 (쉼표)', ph: '예: 일상봇, 비서' },
  ]],
  ['보조모델', [
    { key: 'auxSource', basic: true, type: 'select', label: '연결 방식', options: [['profile', '실리태번 연결 프로필'], ['openai', '커스텀 (OpenAI 호환 API)'], ['main', '메인 API 그대로 (조용히 생성)'], ['none', '안 씀 (규칙 기반만)']] },
    { key: 'auxProfile', basic: true, type: 'profile', label: '연결 프로필', show: s => s.auxSource === 'profile' },
    { key: 'auxProfileModel', basic: true, type: 'text', label: '모델 이름 직접 입력 (커스텀)', ph: '비우면 프로필 모델 그대로 · 예: gemini-2.5-flash', hint: '프로필의 API·키는 그대로 쓰고 모델 이름만 바꿔서 요청해요', show: s => s.auxSource === 'profile' },
    { key: 'auxProfilePreset', type: 'check', label: '프로필의 프리셋·인스트럭트도 같이 보내기', hint: '보통 끄는 게 좋아요 (보조 작업엔 롤플 프롬프트가 방해돼요)', show: s => s.auxSource === 'profile' },
    { key: 'auxOverride', type: 'check', label: '아래 샘플링 값으로 프로필 값 덮어쓰기', show: s => s.auxSource === 'profile' },
    { key: 'auxUrl', basic: true, type: 'text', label: 'API 주소', ph: 'https://openrouter.ai/api/v1', show: s => s.auxSource === 'openai' },
    { key: 'auxKey', basic: true, type: 'password', label: 'API 키', show: s => s.auxSource === 'openai' },
    { key: 'auxModel', basic: true, type: 'model', label: '모델', ph: 'google/gemini-2.5-flash', show: s => s.auxSource === 'openai' },
    { key: 'auxTemp', type: 'number', label: '온도 (temperature)', min: 0, max: 2, step: 0.05, show: s => s.auxSource === 'openai' || (s.auxSource === 'profile' && s.auxOverride) },
    { key: 'auxTopP', type: 'number', label: 'Top P (비우면 기본값)', min: 0, max: 1, step: 0.05, show: s => s.auxSource === 'openai' || (s.auxSource === 'profile' && s.auxOverride) },
    { key: 'auxMaxTokens', type: 'number', label: '최대 응답 토큰 (권장 10000 — 추론 모델은 더)', min: 1000, max: 64000, step: 500, show: s => s.auxSource !== 'none' },
    { key: 'auxMaxInput', type: 'number', label: '최대 입력 토큰 (0 = 제한 없음)', min: 0, max: 200000, step: 1000, hint: '넘치면 대화 기록 → 로어북 → 카드·페르소나 순으로 줄여요. 룰·출력 형식은 안 잘려요. 실제 투입량은 위 🔍 점검에서 확인', show: s => s.auxSource !== 'none' },
    { key: 'auxReasoning', type: 'select', label: '추론 강도 (지원 모델만)', options: [['', '보내지 않음'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']], show: s => s.auxSource === 'openai' },
    { key: 'auxJsonMode', type: 'check', label: 'JSON 모드 강제 (response_format)', hint: '지원 안 하는 API면 끄세요', show: s => s.auxSource === 'openai' },
    { key: 'auxExtra', type: 'textarea', label: '추가 요청 본문 (JSON)', ph: '{"provider": {"order": ["Google"]}}', show: s => s.auxSource === 'openai' },
    { key: 'auxHeaders', type: 'textarea', label: '추가 헤더 (JSON)', ph: '{"HTTP-Referer": "https://sillytavern.app"}', show: s => s.auxSource === 'openai' },
    { key: 'auxCommands', type: 'check', label: '채팅 모드에서 유저 말 → 명령 해석에 사용', show: s => s.auxSource !== 'none' },
    { type: 'auxtools', basic: true, show: s => s.auxSource !== 'none' },
  ]],
  ['전투 시작 · 로어', [
    { key: 'previewBeforeStart', type: 'check', label: '전투 시작 전 출전 구성 확인 (프리뷰)', hint: '판별된 모드·적·아군을 한 번 보고 수정한 뒤 전투를 시작해요' },
    { key: 'startTrigger', type: 'select', label: '전투 신호가 오면', options: [['button', '메시지 아래 「전투 시작」 버튼 (추천)'], ['auto', '바로 자동 시작']] },
    { key: 'suggestStart', type: 'check', label: '신호가 없어도 위험한 장면이면 시작 버튼 제안', hint: '메인 모델이 태그를 빼먹거나, 첫 메시지부터 위기 상황일 때' },
    { key: 'startMode', type: 'select', label: '전투 감지', options: [['hybrid', '메인이 <bt-start> 표시 → 보조가 구성 (추천)'], ['main', '메인이 <bt-battle> 전체 작성'], ['manual', '수동 (버튼·/bt-start)']] },
    { key: 'fightGuard', type: 'check', label: '주요 전투는 메인 모델이 멋대로 끝내지 않게 (상시 주입)', hint: '네임드·위험한 적·생사가 걸린 싸움은 첫 타격 직전에 멈추고 엔진으로 넘기도록, 전투를 건너뛰는 요약도 금지해요' },
    { key: 'sceneSize', type: 'number', label: '적 구성 때 읽을 최근 메시지 수', min: 1, max: 15, step: 1 },
    { key: 'castScene', type: 'number', label: '인물 찾기 때 읽을 최근 메시지 수', min: 2, max: 60, step: 1 },
    { key: 'sheetScene', type: 'number', label: '내 시트 생성 때 읽을 최근 메시지 수', min: 0, max: 15, step: 1 },
    { key: 'forgeLore', type: 'select', label: '적 구성 때 월드인포', options: [['auto', '자동: 장면에 나온 주요 인물 항목만'], ['always', '키워드 걸린 항목은 항상'], ['never', '안 읽음 (대화만)']] },
    { key: 'castBatch', type: 'select', label: '인물 찾기 한 번에', options: [['2', '2명'], ['4', '4명 (기본)'], ['6', '6명']], hint: '많을수록 보조모델 답이 길어져서 잘릴 수 있어요' },
    { key: 'loreBooks', type: 'text', label: '추가 로어북 (쉼표)', ph: '캐릭터·채팅 로어북은 자동' },
    { key: 'loreBudget', type: 'number', label: '룰·시트 생성 때 로어 최대 글자수', min: 2000, max: 60000, step: 1000 },
  ]],
  ['세계관 연동', [
    { key: 'statTag', type: 'text', label: '상태창 태그', ph: 'stat (비우면 안 씀)' },
    { key: 'statSync', type: 'select', label: '상태창 → 시트', options: [['all', 'HP/SP + 스탯 + 스킬'], ['hpsp', 'HP/SP만'], ['off', '안 함']] },
    { key: 'trackChanges', type: 'check', label: '회복·아이템·성장 <bt-change> 추적' },
    { key: 'stateWatch', type: 'select', label: '보조모델 상태·성장 감시 (휴식·부상·각성·새 스킬)', options: [['auto', '자동: 휴식·부상·성장·습득 묘사가 있을 때만 (추천)'], ['always', '매 메시지마다'], ['off', '끔 (메인 모델의 <bt-change>만)']], hint: '메인 모델에 부담을 주지 않고, 스토리 중 휴식·부상·승급·새 기술·동료 변화를 보조모델이 읽어 플레이어와 도감 시트에 자동 반영해요', show: s => s.auxSource !== 'none' },
    { key: 'autoRegister', type: 'check', label: '네임드 NPC 자동 도감 등록' },
    { key: 'hideBlocks', type: 'check', label: '채팅에서 <bt-…> 블록 숨기기' },
    { key: 'reviveAfter', type: 'check', label: '전투 후 기절한 동료 HP 1로' },
    { key: 'attackName', type: 'text', label: '기본 공격 이름' },
    { key: 'depth', type: 'number', label: '프롬프트 주입 깊이', min: 0, max: 20, step: 1 },
  ]],
];
const DEFAULT_OPEN = {};
const BASIC_ORDER = ['enabled', 'playMode', 'difficulty', 'ruleSet', 'auxSource', 'auxProfile', 'auxProfileModel', 'auxUrl', 'auxKey', 'auxModel', undefined];

function settingValue(set, key) { return key.startsWith('mode.') ? set.modes?.[key.slice(5)] !== false : set[key]; }

function fieldHtml(f, set) {
  if (f.show && !f.show(set)) return '';
  if (f.type === 'auxtools') {
    const r = api.ui.auxTest;
    return `<div class="sd-tools"><button class="menu_button" data-act="aux-test">연결 테스트</button>${set.auxSource === 'openai' ? '<button class="menu_button" data-act="aux-models">모델 목록 불러오기</button>' : ''}</div>
      ${r ? `<div class="sd-test ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✕'} ${h(r.text)}</div>` : ''}`;
  }
  const v = settingValue(set, f.key);
  const id = `sd_${f.key.replace(/\W/g, '_')}`;
  const hint = f.hint ? `<small class="sd-hint">${h(f.hint)}</small>` : '';
  if (f.type === 'check') return `<label class="sd-row sd-check"><input type="checkbox" data-set="${f.key}" data-kind="check" ${v ? 'checked' : ''}><span>${h(f.label)}${hint}</span></label>`;
  let input;
  if (f.type === 'select') input = `<select class="text_pole" data-set="${f.key}">${f.options.map(([k, l]) => `<option value="${h(k)}" ${String(v ?? '') === k ? 'selected' : ''}>${h(l)}</option>`).join('')}</select>`;
  else if (f.type === 'profile') {
    const profiles = api.profiles?.() ?? [];
    input = profiles.length ? `<select class="text_pole" data-set="auxProfile"><option value="">— 선택 —</option>${profiles.map(p => `<option value="${h(p.id)}" ${p.id === v ? 'selected' : ''}>${h(p.name)}${p.model ? ` · ${h(p.model)}` : ''}</option>`).join('')}</select>${(() => { const cur = profiles.find(p => p.id === v); return cur ? `<small class="sd-hint">API: ${h(cur.api ?? '?')} · 프로필 모델: ${h(cur.model || '(없음)')}${set.auxProfileModel ? ` → <b>${h(set.auxProfileModel)}</b>로 요청` : ''}</small>` : ''; })()}`
      : '<div class="sd-hint">연결 프로필이 없어요. 실리태번 상단 🔌 Connection Profile에서 먼저 만들어주세요.</div>';
  } else if (f.type === 'model') input = `<input class="text_pole" data-set="auxModel" list="sd_models" value="${h(v ?? '')}" placeholder="${h(f.ph ?? '')}"><datalist id="sd_models">${(api.ui.auxModels ?? []).map(m => `<option value="${h(m)}">`).join('')}</datalist>`;
  else if (f.type === 'textarea') input = `<textarea class="text_pole" rows="2" data-set="${f.key}" data-kind="json" placeholder="${h(f.ph ?? '')}">${h(v ?? '')}</textarea>`;
  else input = `<input class="text_pole" type="${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}" data-set="${f.key}" ${f.type === 'number' ? `data-kind="num" min="${f.min}" max="${f.max}" step="${f.step}"` : ''} value="${h(v ?? '')}" placeholder="${h(f.ph ?? '')}">`;
  return `<label class="sd-row"><span>${h(f.label)}</span>${input}${hint}</label>`;
}

/** Settings drawer: ⚙ settings (essentials + collapsed advanced) | 📜 this chat's rules | 🔍 pipeline trace. */
function drawerHtml(s) {
  const set = api.settings();
  api.ui.sdOpen ??= { ...DEFAULT_OPEN };
  const page = ['set', 'rules', 'trace'].includes(api.ui.sdPage) ? api.ui.sdPage : 'set';
  const pages = [['set', '설정'], ['rules', '룰'], ['trace', '점검']].map(([k, l]) => `<button class="sd-tab ${page === k ? 'on' : ''}" data-act="sd-page" data-v="${k}">${l}</button>`).join('');
  let body;
  if (page === 'rules') body = s ? rulesTab(s) : '<div class="bt-empty">채팅을 열면 보여요.</div>';
  else if (page === 'trace') body = traceTab(s);
  else {
    const all = SETTINGS.flatMap(([, fields]) => fields);
    const basic = all.filter(f => f.basic).sort((a, b) => BASIC_ORDER.indexOf(a.key) - BASIC_ORDER.indexOf(b.key));
    const adv = SETTINGS.map(([g, fields]) => [g, fields.filter(f => !f.basic)]).filter(([, f]) => f.length);
    body = `<div class="sd-basic">${basic.map(f => fieldHtml(f, set)).join('')}</div>
      <details class="sd-adv" data-group="__adv" ${api.ui.sdOpen.__adv ? 'open' : ''}><summary>고급 설정</summary>
        ${adv.map(([g, fields]) => `<details class="sd-group" data-group="${h(g)}" ${api.ui.sdOpen[g] ? 'open' : ''}><summary>${g}</summary>${fields.map(f => fieldHtml(f, set)).join('')}</details>`).join('')}
      </details>`;
  }
  return `<div class="bt-drawer"><div class="sd-head"><div class="sd-tabs">${pages}</div><button class="sd-x" data-act="settings-close">✕</button></div>
    <div class="sd-body">${body}</div></div>`;
}

export function refreshTrace() { if (api?.ui?.settingsOpen && api.ui.sdPage === 'trace') refreshPanel(); }

const TRACE_ICON = { inject: '📤', detect: '🔎', start: '⚔️', setup: '🧭', aux: '🤖', change: '📝', stat: '📊', balance: '⚖️', error: '❗' };
const TRACE_KO = { inject: '주입', detect: '감지', start: '구성', setup: '기초', aux: '보조', change: '변수', stat: '상태창', balance: '밸런스', error: '오류' };
function traceTab(s) {
  const list = api.trace?.() ?? [];
  const set = api.settings();
  const filt = api.ui.traceFilter ?? '';
  const shown = filt ? list.filter(x => x.kind === filt) : list;
  const steps = [
    ['① 전투 감지', set.startMode === 'manual' ? '수동 (자동 감지 꺼짐)' : set.startMode === 'main' ? '메인 모델이 <bt-battle> 작성' : '메인 모델이 <bt-start> 표시', list.some(x => x.kind === 'detect' && /start|battle/.test(x.title))],
    ['② 전투 구성', api.settings().auxSource === 'main' ? '보조 = 메인 연결 (generateRaw)' : '별도 보조모델', list.some(x => x.kind === 'start')],
    ['③ 매 턴 변수', `${set.trackChanges ? '<bt-change> 안내 켬' : '<bt-change> 꺼짐'} · 상태창 <${set.statTag || '없음'}> ${set.statSync}`, list.some(x => x.kind === 'change' || (x.kind === 'stat' && x.title.includes('읽음')))],
  ];
  return `<div class="bt-section"><div class="bt-sub">파이프라인 점검</div>
    ${steps.map(([a, b, ok]) => `<div class="tr-step ${ok ? 'ok' : ''}"><b>${a}</b><span>${h(b)}</span><i>${ok ? '✔ 동작 확인' : '… 아직 기록 없음'}</i></div>`).join('')}
    <div class="sd-hint">주입·감지·보조모델 응답 최근 40개 (새로고침하면 지워짐)</div></div>
  <div class="tr-filter">${['', 'inject', 'detect', 'start', 'setup', 'aux', 'change', 'stat', 'balance', 'error'].map(k => `<button class="${filt === k ? 'on' : ''}" data-act="trace-filter" data-v="${k}">${k ? `${TRACE_ICON[k]} ${TRACE_KO[k]}` : '전체'}</button>`).join('')}<button data-act="trace-clear">지우기</button></div>
  ${shown.length ? shown.map(x => `<details class="tr-item k-${x.kind}"><summary>${TRACE_ICON[x.kind] ?? '•'} <b>${h(x.title)}</b> <small>${new Date(x.t).toLocaleTimeString()}</small></summary>${x.detail ? `<pre>${h(x.detail)}</pre>` : '<div class="bt-note">(내용 없음)</div>'}</details>`).join('') : '<div class="bt-empty">아직 기록이 없어요. 채팅을 한 번 보내보세요.</div>'}`;
}

/* ---------- turn bookkeeping for the game screen ---------- */
export function beginTurn() {
  const b = api?.state()?.battle;
  if (!b) return;
  const list = b.st.fighters ?? b.st.b?.fighters ?? [];
  api.ui.turnStart = Object.fromEntries(list.map(f => [f.name, {
    hp: f.hp, maxHp: f.maxHp,
    sp: f.sp ?? 0, maxSp: f.maxSp ?? 0,
    down: !!f.down, out: f.out ?? null,
    statuses: (f.statuses ?? []).map(x => ({ id: x.id, turns: x.turns })),
    stages: { ...(f.stages ?? {}) },
    row: f.row ?? 'front',
    charging: f.charging?.skill ?? null,
    side: f.side,
  }]));
  api.ui.prevHp = Object.fromEntries(list.map(f => [f.name, Math.round(f.hp / Math.max(1, f.maxHp) * 100)]));
}

// Events that begin one fighter's action: each becomes its own step on screen.
const STEP_START = new Set(['use', 'charge', 'switch', 'sendout', 'item', 'defend', 'rest', 'swap', 'scan', 'flee', 'skip', 'fallback', 'wait', 'stances', 'sact', 'surprised', 'staggered', 'confused', 'improv', 'overexert']);

/**
 * Split a turn into on-screen steps (Pokémon double-battle style): each action shows its lines,
 * then its HP/SP/status/stage/row changes and knock-outs, before the next actor's speed turn arrives.
 */
export function buildSteps(events, start = {}, { showRolls = null } = {}) {
  const hp = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.hp]));
  const maxHp = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.maxHp]));
  const sp = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.sp ?? 0]));
  const maxSp = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.maxSp ?? 0]));
  const down = new Set(Object.entries(start).filter(([, v]) => v.down).map(([n]) => n));
  const out = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.out ?? null]));
  const statuses = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, (v.statuses ?? []).map(x => ({ id: x.id, turns: x.turns }))]));
  const stages = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, { ...(v.stages ?? {}) }]));
  const row = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.row ?? 'front']));
  const charging = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.charging ?? null]));
  const side = Object.fromEntries(Object.entries(start).map(([n, v]) => [n, v.side ?? null]));
  const rolls = showRolls ?? (api?.settings?.()?.showRolls ?? false);
  const snap = () => ({
    hp: { ...hp },
    sp: { ...sp },
    down: [...down],
    out: { ...out },
    statuses: Object.fromEntries(Object.entries(statuses).map(([n, list]) => [n, list.map(x => ({ ...x }))])),
    stages: Object.fromEntries(Object.entries(stages).map(([n, st]) => [n, { ...st }])),
    row: { ...row },
    charging: { ...charging },
  });
  const steps = [];
  let cur = null;
  const close = () => {
    if (cur && cur.events.length) {
      cur.lines = pkLines(cur.events, { showRolls: rolls });
      Object.assign(cur, snap());
      if (cur.lines.length) steps.push(cur);
      else if (steps.length) Object.assign(steps.at(-1), snap());
    }
    cur = null;
  };
  for (const e of events) {
    if (e.t === 'turn') continue;
    const continuesFallback = e.t === 'use' && cur?.events.at(-1)?.t === 'fallback' && cur.events.at(-1).who === e.who;
    const isFollowupSwap = e.t === 'swap' && (e.pulled || e.fromSkill);
    const isPivotSwitch = e.t === 'switch' && e.pivot;
    const startsUpkeep = (e.t === 'dot' || e.t === 'expire') && cur && !cur.upkeep;
    if ((STEP_START.has(e.t) && !continuesFallback && !isFollowupSwap && !isPivotSwitch) || startsUpkeep) {
      close();
      cur = startsUpkeep ? { events: [], upkeep: true } : { events: [] };
    }
    if (!cur) cur = { events: [], upkeep: true };
    cur.events.push(e);
    if (e.t === 'use') {
      if (e.cost > 0 && sp[e.who] != null) sp[e.who] = Math.max(0, sp[e.who] - e.cost);
      if (e.released) charging[e.who] = null;
    }
    if ((e.t === 'hpcost' || e.t === 'overexert') && hp[e.who] != null) hp[e.who] = Math.max(0, hp[e.who] - (e.dmg ?? 0));
    if ((e.t === 'rest' || e.t === 'defend') && e.sp > 0 && sp[e.who] != null) sp[e.who] = Math.min(maxSp[e.who] || 9999, sp[e.who] + e.sp);
    if (e.t === 'sp' && e.amount && sp[e.who] != null) sp[e.who] = Math.min(maxSp[e.who] || 9999, sp[e.who] + e.amount);
    if (e.t === 'breakbonus' && e.sp && e.side) {
      for (const n of Object.keys(sp)) {
        if (side[n] === e.side && !down.has(n) && maxSp[n] > 0) sp[n] = Math.min(maxSp[n], sp[n] + Math.round(maxSp[n] * e.sp / 100));
      }
    }
    if ((e.t === 'hit' || e.t === 'heal') && e.hp != null) {
      hp[e.target ?? e.who] = e.hp;
      if (e.maxHp) maxHp[e.target ?? e.who] = e.maxHp;
    }
    if (e.t === 'dot' && hp[e.who] != null) hp[e.who] = Math.max(0, hp[e.who] - (e.dmg ?? 0));
    if (e.t === 'status' && e.who && e.status) {
      const list = (statuses[e.who] ??= []);
      const ex = list.find(x => x.id === e.status);
      if (ex) ex.turns = Math.max(ex.turns ?? 1, e.turns ?? 2);
      else list.push({ id: e.status, turns: e.turns ?? 2 });
    }
    if ((e.t === 'consume' || e.t === 'expire') && statuses[e.who]) {
      statuses[e.who] = statuses[e.who].filter(x => x.id !== e.status);
    }
    if (e.t === 'wake' && statuses[e.who]) {
      statuses[e.who] = statuses[e.who].filter(x => x.id !== 'sleep');
    }
    if (e.t === 'thaw' && statuses[e.who]) {
      statuses[e.who] = statuses[e.who].filter(x => x.id !== 'freeze');
    }
    if (e.t === 'cleanse' && e.who) {
      if (statuses[e.who]) statuses[e.who] = e.removed?.length ? statuses[e.who].filter(x => !e.removed.includes(x.id)) : statuses[e.who].filter(x => STATUS[x.id]?.good);
      if (stages[e.who]) for (const k of Object.keys(stages[e.who])) if (stages[e.who][k] < 0) delete stages[e.who][k];
    }
    if (e.t === 'stage' && e.who && e.stat && e.trait !== 'intimidate') {
      const st = (stages[e.who] ??= {});
      const nv = Math.max(-6, Math.min(6, (st[e.stat] ?? 0) + (e.delta ?? 0)));
      if (nv === 0) delete st[e.stat];
      else st[e.stat] = nv;
    }
    if (e.t === 'charge' && e.who) charging[e.who] = e.skill ?? '';
    if ((e.t === 'break' || e.t === 'skip') && e.who) charging[e.who] = null;
    if (e.t === 'swap' && e.who) {
      if (e.with && row[e.with] != null) { const prev = row[e.who]; row[e.who] = row[e.with]; row[e.with] = prev; }
      else if (e.row) row[e.who] = e.row;
    }
    if (e.t === 'down' && e.who) { down.add(e.who); statuses[e.who] = []; stages[e.who] = {}; charging[e.who] = null; }
    if (e.t === 'revive' && e.who) {
      down.delete(e.who); statuses[e.who] = [];
      if (e.hpVal != null) hp[e.who] = e.hpVal;
      else if (e.hp != null && maxHp[e.who]) hp[e.who] = Math.max(1, Math.round(maxHp[e.who] * e.hp / 100));
    }
    if ((e.t === 'yield' || e.t === 'rout') && e.who) out[e.who] = e.t === 'yield' ? 'yield' : 'fled';
  }
  close();
  return { steps, maxHp };
}

export function endTurn(events) {
  const ui = api.ui;
  clearTimeout(autoTimer); autoTimer = null; autoKey = '';
  ui.lastEvents = events;
  const { steps, maxHp } = buildSteps(events, ui.turnStart ?? {});
  ui.steps = steps; ui.stepPos = 0; ui.stepMax = maxHp;
  ui.msg = []; ui.msgPos = 0;
  ui.page = 'main';
  ui.pending = null;
  showStep(0);
}

/** Point the scene at step i: FX for that action only, bars sliding from the previous step. */
function showStep(i) {
  const ui = api.ui;
  const st = ui.steps?.[i];
  if (!st) { ui.lastEvents = []; ui.fx = null; return; }
  const prev = i > 0 ? ui.steps[i - 1].hp : Object.fromEntries(Object.entries(ui.turnStart ?? {}).map(([n, v]) => [n, v.hp]));
  ui.prevHp = Object.fromEntries(Object.entries(prev).map(([n, v]) => [n, Math.round(v / Math.max(1, ui.stepMax?.[n] ?? 1) * 100)]));
  ui.lastEvents = st.events;
  computeFx(ui);
}

function skipTalk() {
  const ui = api.ui;
  ui.msgPos = (ui.msg ?? []).length;
  if (ui.steps) ui.stepPos = ui.steps.length;
}

function personaBanner(busy) {
  if (!api.personaChanged?.()) return '';
  return `<div class="bt-section bt-pending"><div>페르소나 설명이 바뀌었어요. 바뀐 등급·설정을 시트에 반영할까요?</div><div class="bt-row bt-wrap"><button class="menu_button bt-send" data-act="persona-refresh" ${busy ? 'disabled' : ''}>시트 갱신</button><button class="menu_button" data-act="persona-dismiss">무시</button></div></div>`;
}

function previewCard(s, pv, busy) {
  const spec = pv.spec ?? {};
  const enemies = spec.enemies ?? [];
  const allies = spec.allies ?? [];
  const srcTag = x => x._src === 'major' ? '<span class="cx-badge">신규 도감</span>' : x._src === 'codex' ? '<small>[도감]</small>' : '<small>[잡병]</small>';
  const codexOpts = api.codex().filter(e => !allies.some(a => a.codexId === e.id || norm(a.name) === norm(e.name)) && !enemies.some(a => a.codexId === e.id || norm(a.name) === norm(e.name)));
  return `<div class="bt-section">
    <div class="bt-sub">출전 구성 확인 ${spec.title ? `· ${h(spec.title)}` : ''}</div>
    ${spec.place ? `<div class="bt-note">${h(spec.place)}${spec.why ? ` — ${h(spec.why)}` : ''}</div>` : (spec.why ? `<div class="bt-note">${h(spec.why)}</div>` : '')}
    <div class="bt-row" style="margin:6px 0"><label>형식 <select class="text_pole" data-act="preview-mode">${allowedModes(api.settings()).map(m => `<option value="${m}" ${pv.mode === m ? 'selected' : ''}>${MODES[m].ko}</option>`).join('')}</select></label></div>
    <div class="bt-sub" style="margin-top:8px">적 (${enemies.length})</div>
    ${enemies.length ? enemies.map((e, i) => `<div class="bt-skillrow"><span><b>${h(e.name)}</b> ${e.tier ? `<small>[${h(e.tier)}]</small> ` : ''}${srcTag(e)}</span><span class="bt-row"><button class="menu_button" data-act="pv-row" data-side="enemies" data-v="${i}" title="전열/후열 전환">${e.row === 'back' ? '후열' : '전열'}</button><button class="menu_button" data-act="pv-del" data-side="enemies" data-v="${i}" title="제외">✕</button></span></div>`).join('') : '<div class="bt-note">적이 없어요. 다시 판별하거나 취소해 주세요.</div>'}
    <div class="bt-sub" style="margin-top:8px">아군 (${1 + allies.length})</div>
    <div class="bt-skillrow"><span><b>${h(s.player?.name ?? '나')}</b> <small>[${h(s.player?.tier ?? '?')}] · 플레이어</small></span></div>
    ${allies.map((a, i) => `<div class="bt-skillrow"><span><b>${h(a.name)}</b> ${a.tier ? `<small>[${h(a.tier)}]</small> ` : ''}${srcTag(a)}</span><span class="bt-row"><button class="menu_button" data-act="pv-row" data-side="allies" data-v="${i}">${a.row === 'back' ? '후열' : '전열'}</button><button class="menu_button" data-act="pv-del" data-side="allies" data-v="${i}" title="제외">✕</button></span></div>`).join('')}
    ${codexOpts.length ? `<div class="bt-row" style="margin-top:6px"><select class="text_pole" id="bt-pv-add"><option value="">＋ 도감에서 아군 추가…</option>${codexOpts.map(e => `<option value="${h(e.id)}">${h(e.name)} [${h(api.rosterOf(e).tier || '?')}]</option>`).join('')}</select><button class="menu_button" data-act="pv-add-ally">추가</button></div>` : ''}
    <div class="bt-row bt-wrap" style="margin-top:10px">
      <button class="menu_button bt-send" data-act="preview-go" ${busy || !enemies.length ? 'disabled' : ''}>이 구성으로 전투 시작</button>
      <button class="menu_button" data-act="preview-reforge" ${busy ? 'disabled' : ''}>다시 판별</button>
      <button class="menu_button" data-act="preview-cancel" ${busy ? 'disabled' : ''}>취소</button>
    </div>
  </div>`;
}

/** First visit to a chat without a world brief: offer to turn BattleTale on and build it, right in the panel. */
function setupCard(s, busy) {
  if (s.brief || s.setupSkipped) return '';
  const on = !!api.enabledHere?.();
  return `<div class="bt-section bt-setup-card">
    <div class="bt-sub">${on ? '이 채팅의 기초 설정을 만들까요?' : '이 채팅에서 BattleTale을 활성화할까요?'}</div>
    <div class="bt-note">로어북 · 캐릭터 디스크립션 · 페르소나 · 최근 대화를 가볍게 읽고 <b>속성·상성표 · 등급/강함 체계 · 전투 방식</b>을 짧게 정리해 둬요. 이후 시트·전투 구성·상시 프롬프트가 이 요약을 같이 써서 더 가볍고 일관돼요.</div>
    <div class="bt-row"><button class="menu_button" data-act="setup" ${busy ? 'disabled' : ''}>${busy ? '읽는 중…' : on ? '기초 설정 만들기' : '활성화하고 기초 설정 만들기'}</button><button class="menu_button" data-act="setup-later" ${busy ? 'disabled' : ''}>나중에</button></div>
    <div class="sd-hint">나중에 ⚙ → 룰에서도 만들 수 있어요.</div>
  </div>`;
}

function battleTab(s) {
  const p = profileOf(s);
  const b = s.battle;
  const busy = api.busy();
  if (s.disabled) return '<div class="bt-empty">이 채팅에서는 꺼져 있어요. 설정 → 룰에서 다시 켤 수 있어요.</div>';
  const pBanner = personaBanner(busy);
  if (api.ui.preview && (!b || b.status !== 'active')) return `${pBanner}${previewCard(s, api.ui.preview, busy)}`;
  const panelMode = api.settings().playMode !== 'chat';
  const steppingNow = !!api.ui.steps && (api.ui.stepPos ?? 0) < api.ui.steps.length;
  // Let the final turn's step playback finish showing attacks & KOs before switching to the result screen.
  if (b && b.status !== 'active' && !steppingNow && panelMode && (b.resultPending || !b.resultKey) && b.resultKey !== 'dismissed') return resultScreen(s, b);
  if (!b || (b.status !== 'active' && !steppingNow)) {
    return `${setupCard(s, busy)}${pBanner}<div class="bt-section">
      <div class="bt-row"><input type="text" class="text_pole" id="bt-hint" data-enter="start" placeholder="(선택) 상황 힌트: 예) 고블린 3마리 / 검객과 결투 / 경비 몰래 잠입"></div>
      <div class="bt-row"><select id="bt-mode-pick"><option value="">형식: AI가 상황 보고 결정</option>${allowedModes(api.settings()).map(m => `<option value="${m}">${MODES[m].ko}</option>`).join('')}</select></div>
      <button class="menu_button bt-wide" data-act="start" ${busy ? 'disabled' : ''}>${busy ? '준비 중…' : '지금 장면에서 시작'}</button>
      <div class="bt-note">메인 모델이 <code>&lt;bt-start&gt;</code>를 쓰면 자동으로 시작돼요.</div>
    </div>
    ${s.archive.length ? `<div class="bt-section"><div class="bt-sub">최근 기록</div>${s.archive.slice(0, 6).map(a => `<div class="bt-arch">${h(a.title)} — <b>${h(a.result)}</b> (${a.turns}턴)</div>`).join('')}</div>` : ''}`;
  }
  const M = modeOf(b.mode);
  const ui = api.ui;
  ui.typeSystem = p.typeSystem;
  const threat = THREAT_LABEL[b.threat?.level];
  const ctx = { ui, busy, inventory: s.inventory, settings: api.settings(), spLabel: p.spLabel, value: id => document.getElementById(id)?.value?.trim() ?? '' };
  const V = M.view(b.st, p, ctx);
  const terr = b.st.terrain ?? [];
  const STG_KO = { pow: '공격', mag: '특공', def: '방어', res: '특방', spd: '스피드', acc: '명중', eva: '회피', luk: '운' };
  const terrChip = terr.filter(t => Object.keys(t.stages ?? {}).length).map(t => `<span class="pk-terr" title="${h(t.desc)}">🌫 ${h(t.desc.split(/[,.·]/)[0].slice(0, 10) || '지형')} ${Object.entries(t.stages).map(([k, v]) => `${STG_KO[k] ?? k}${v > 0 ? '▲' : '▼'}`).join('')}${t.side !== 'all' ? (t.side === 'ally' ? '(아군)' : '(적)') : ''}</span>`).join('');
  if (!b.history.length && ui.openingShown !== b.id) { ui.openingShown = b.id; ui.msg = [...(V.intro ?? []), ...(b.opening?.length ? pkLines(b.opening) : [])]; ui.msgPos = 0; ui.steps = null; ui.page = 'main'; }
  const msg = ui.msg ?? [];
  const pos = ui.msgPos ?? 0;
  const stepping = !!ui.steps && (ui.stepPos ?? 0) < ui.steps.length;
  const talking = stepping || pos < msg.length;
  // While a turn plays back, show HP, SP, statuses, stages, rows and knock-outs as of the current step,
  // not the end of the turn (so secondary effects from slower actors never appear before their speed turn).
  const stepSnap = stepping ? ui.steps[ui.stepPos] : null;
  if (stepSnap) {
    const downs = new Set(stepSnap.down);
    for (const F of [...(V.foes ?? []), ...(V.allies ?? [])]) {
      if (!F || stepSnap.hp[F.name] == null) continue;
      F.hp = stepSnap.hp[F.name];
      F.down = downs.has(F.name);
      if (stepSnap.sp?.[F.name] != null) F.sp = stepSnap.sp[F.name];
      if (stepSnap.statuses?.[F.name] != null) F.statuses = stepSnap.statuses[F.name].map(x => ({ ...x }));
      if (stepSnap.stages?.[F.name] != null) F.stages = { ...stepSnap.stages[F.name] };
      if (stepSnap.row?.[F.name] != null) F.row = stepSnap.row[F.name];
      if (stepSnap.out?.[F.name] !== undefined) F.out = stepSnap.out[F.name];
      if (stepSnap.charging && F.noteCls === 'charge') {
        const ch = stepSnap.charging[F.name];
        if (!ch) { F.note = ''; F.noteCls = ''; }
        else F.note = `⚡ ${ch}의 힘을 모으고 있다!`;
      }
    }
  }
  // Field-wide terrain shifts (darkness, fog…) show once in the header, not as a chip on every fighter.
  for (const F of [...(V.foes ?? []), ...(V.allies ?? [])]) {
    if (!F?.stages) continue;
    const st = { ...F.stages };
    for (const t of terr) if (t.side === 'all' || t.side === F.side) for (const [k, v] of Object.entries(t.stages ?? {})) st[k] = (st[k] ?? 0) - v;
    F.stages = st;
  }
  const modeSel = !b.history.length ? `<select data-act="switch-mode" class="pk-mode">${allowedModes(api.settings()).map(m => `<option value="${m}" ${m === b.mode ? 'selected' : ''}>${MODES[m].ko}</option>`).join('')}</select>` : '';
  const head = `<div class="pk-head"><span class="pk-title">${h(b.title || M.ko)}</span><span class="pk-turn">${b.st.turn}턴</span>
    ${threat ? `<span class="bt-chip threat-${b.threat.level}">${threat}</span>` : ''}${b.spec?.difficulty && b.spec.difficulty !== 'normal' ? `<span class="bt-chip diff-${b.spec.difficulty}">${{ easy: '쉬움', hard: '어려움', nightmare: '악몽' }[b.spec.difficulty]}</span>` : ''}<button class="pk-more" data-act="stop" title="중단">중단</button></div>
    ${terrChip || modeSel ? `<div class="pk-head2">${terrChip}${modeSel}</div>` : ''}`;
  const box = stepping
    ? `<div class="pk-msg talk" data-act="pk:next">${ui.steps[ui.stepPos].lines.slice(0, 4).map(l => `<div>${h(l)}</div>`).join('')}<span class="pk-arrow">▼</span><span class="pk-stepn">${ui.stepPos + 1}/${ui.steps.length}</span>${ui.steps.length - ui.stepPos > 1 ? '<button class="pk-skip" data-act="pk:skip">⏭</button>' : ''}</div>`
    : talking
    ? `<div class="pk-msg talk" data-act="pk:next">${msg.slice(pos, pos + 2).map(l => `<div>${h(l)}</div>`).join('')}<span class="pk-arrow">▼</span>${msg.length - pos > 2 ? '<button class="pk-skip" data-act="pk:skip">⏭</button>' : ''}</div>`
    : `<div class="pk-msg idle">${h(V.idle ?? '')}</div>`;
  let menu = '';
  const forced = M.forced?.(b.st);
  if (forced && ui.page !== forced) ui.page = forced;
  ui.hand = null; ui.targetable = null;
  if (b.status === 'active') {
    const page = ui.page ?? 'main';
    if (page === 'target') {
      ui.targetable = ui.pending?.target ?? null;
      const items = (ui.pending?.target ?? []).map(n => ({ label: n, cls: 'plain', act: 'pk:target', v: n }));
      items.push({ label: '돌아가기', cls: 'back', page: ui.pending?.from ?? 'main' });
      ui.menuItems = items;
      menu = `<div class="pk-hint">누구에게? <small>(전장의 캐릭터를 눌러도 돼요)</small></div>${menuGrid(items)}`;
    } else if (page === 'free') {
      ui.menuItems = [{ label: '돌아가기', cls: 'back', page: 'main' }];
      menu = `<div class="pk-free"><input type="text" class="text_pole" id="bt-free" data-enter="m:free" placeholder="예: 기둥을 무너뜨려 깔아뭉갠다"><button class="pk-btn m-fight" data-act="m:free">실행</button></div>${menuGrid(ui.menuItems)}`;
    } else {
      const items = M.menu(b.st, page, ctx);
      ui.menuItems = items;
      const mini = items.length && items.every(it => it.mini);
      const order = page === 'main' && M.order ? orderLine(M.order(b.st)) : '';
      const skillsMain = items.some(it => it.tags);
      menu = `${order}${menuGrid(items, { main: page === 'main' && !mini && !skillsMain, cols: mini ? (items.length > 4 ? 3 : items.length) : 2 })}${barRow(items)}`;
    }
  }
  const inspRaw = ui.inspect ? findFighter(b.st.b ?? b.st, ui.inspect, { includeDown: true }) : null;
  const insp = inspRaw && stepSnap && stepSnap.hp[inspRaw.name] != null
    ? {
      ...inspRaw,
      hp: stepSnap.hp[inspRaw.name],
      sp: stepSnap.sp?.[inspRaw.name] ?? inspRaw.sp,
      down: stepSnap.down.includes(inspRaw.name),
      statuses: stepSnap.statuses?.[inspRaw.name] ?? inspRaw.statuses,
      stages: stepSnap.stages?.[inspRaw.name] ?? inspRaw.stages,
      row: stepSnap.row?.[inspRaw.name] ?? inspRaw.row,
    }
    : inspRaw;
  const inspector = insp ? inspectHtml(insp, { b: b.st.b ?? b.st, profile: p, intel: insp.intel ?? 1, side: insp.side, intent: insp.side === 'enemy' && !insp.down ? M.intentText?.(b.st, insp) : '' }) : '';
  const mini = api.ui.compact ? miniStatus(V, b, p) : '';
  const showBox = talking || !V.custom; // the stealth map shows its own prompts
  V.place ??= b.place || '';
  // Cards layout: the message ticker sits between the enemy rows and the ally HUD.
  const inField = !api.ui.compact && !V.custom;
  const stage = api.ui.compact ? mini : V.custom ?? scene(V, ctx, { box: showBox ? box : '' });
  const peekIt = ui.peek != null ? ui.menuItems?.[ui.peek] : null;
  const peekCard = peekIt && M.peek ? M.peek(b.st, peekIt, ctx) : null;
  const est = peekIt?.tags?.find(t => String(t.text ?? t).startsWith('≈'));
  const peeker = peekCard ? skillSheet({ ...peekCard, est: est ? Number(String(est.text ?? est).replace(/\D/g, '')) : null }) : '';
  const recent = b.history.slice(-3).flatMap(e => [`— ${e.turn}턴 —`, ...pkLines(e.events)]);
  const log = recent.length ? `<details class="pk-log" ${ui.logOpen ? 'open' : ''} data-log><summary>전투 기록</summary><div>${recent.map(l => `<div class="${l.startsWith('—') ? 'pk-log-t' : ''}">${h(l)}</div>`).join('')}</div></details>` : '';
  return `<div class="pk-wrap lr ${busy ? 'busy' : ''}">${head}${stage}${showBox && !inField ? box : ''}<div class="pk-actions ${busy ? 'off' : ''}">${menu}</div>${log}${inspector}${peeker}
    ${api.settings().playMode === 'chat' ? '<div class="bt-note">채팅 모드: 버튼은 입력창에 명령을 넣어요.</div>' : ''}</div>`;
}

/** Folded panel: one line per side instead of the battlefield. */
function miniStatus(V, b, p) {
  const pctOf = f => Math.round((f.hp / Math.max(1, f.maxHp)) * 100);
  const one = F => `<span class="${F.down ? 'down' : ''}">${h(F.name.length > 6 ? `${F.name.slice(0, 5)}…` : F.name)} <b>${F.down ? '✕' : F.showNums ? `${F.hp}/${F.maxHp}` : `${pctOf(F)}%`}</b></span>`;
  if (V.custom) {
    const st = b.st;
    return `<div class="pk-mini"><div>👁 경계 <b>${Math.round(st.alert ?? 0)}</b>/100 · ${st.turn}턴 · 🚩까지 <b>${Math.abs(st.p.x - st.goalAt.x) + Math.abs(st.p.y - st.goalAt.y)}</b>칸 <small>(⤢ 누르면 맵)</small></div></div>`;
  }
  return `<div class="pk-mini"><div>🗡 ${(V.foes ?? []).map(one).join(' ')}</div><div>🛡 ${(V.allies ?? []).map(one).join(' ')}</div></div>`;
}

/** Speed order without scrolling: short names, wraps to a second line when crowded. */
function orderLine(order) {
  if (!order?.length || order.length < 2) return '';
  const short = n => (n.length > 5 ? `${n.slice(0, 4)}…` : n);
  return `<div class="pk-order">${order.map((o, i) => `<span class="${o.side}"><i>${i + 1}</i>${h(short(o.name))}</span>`).join('<b>›</b>')}</div>`;
}

/* Pokémon-style message window: the last turn, short. */
function messageBox(events) {
  if (!events?.length) return '';
  const lines = pkLines(events, { showRolls: api.settings().showRolls });
  if (!lines.length) return '';
  const short = lines.slice(0, 6);
  return `<div class="pk-msg">${short.map(l => `<div>${h(l)}</div>`).join('')}${lines.length > 6 ? `<details><summary>전체 보기 (${lines.length})</summary>${lines.slice(6).map(l => `<div>${h(l)}</div>`).join('')}</details>` : ''}</div>`;
}

function computeFx(ui) {
  const fx = {}, anim = {}, atk = {};
  let step = -1, cur = null;
  const STEP = 0.55;
  const add = (name, text, cls) => { (fx[name] ??= []).push({ text, cls, d: Math.max(0, step) * STEP + 0.2 }); };
  const burst = (name, k, extra = {}) => { (anim[name] ??= []).push({ k, c: cur?.color ?? '#fff', d: Math.max(0, step) * STEP + 0.12, ...extra }); };
  for (const e of ui.lastEvents ?? []) {
    if (e.t === 'use') {
      step++;
      if (e.cost > 0) (fx[e.who] ??= []).push({ text: `-${e.cost} SP`, cls: 'sp', d: Math.max(0, step) * STEP });
      const t = e.element && !['none', 'physical'].includes(e.element) ? typeIn(e.element, ui.typeSystem ?? 'world') : 'normal';
      cur = { kind: e.kind, color: TYPE_HEX[t] ?? '#e8e8e8' };
      if (['physical', 'magic'].includes(e.kind)) atk[e.who] = step * STEP;
      if (e.kind === 'buff' || e.kind === 'guard') burst(e.who, 'buff');
      continue;
    }
    if (e.t === 'hit') { burst(e.target, cur?.kind === 'magic' ? 'magic' : 'physical', { super: e.eff === 'super' || e.eff === 'weak' }); add(e.target, `-${e.dmg}${e.crit ? '!' : ''}`, e.eff === 'super' || e.eff === 'weak' ? 'super' : e.eff === 'resist' ? 'resist' : e.crit ? 'crit' : 'dmg'); }
    else if (e.t === 'heal' && e.amount > 0) { burst(e.who, 'heal'); add(e.who, `+${e.amount}`, 'heal'); }
    else if (e.t === 'miss') add(e.target, 'MISS', 'miss');
    else if (e.t === 'status') { burst(e.who, 'status'); add(e.who, STATUS[e.status]?.ko ?? e.status, 'crit'); }
    else if (e.t === 'stage') { burst(e.who, e.delta > 0 ? 'buff' : 'debuff', { c: e.delta > 0 ? '#ff7a4a' : '#5a8aff' }); }
    else if (e.t === 'parry') add(e.who, 'PARRY', 'super');
    else if (e.t === 'down') add(e.who, 'K.O.', 'ko');
    else if (e.t === 'break') add(e.who, 'BREAK', 'crit');
    else if (e.t === 'broken') add(e.who, '체간 붕괴', 'crit');
  }
  ui.fx = fx; ui.anim = anim; ui.atk = atk;
}

function resultScreen(s, b) {
  const M = modeOf(b.mode);
  const label = { win: '승리', success: '성공', lose: '패배', fled: '도주 성공', stopped: '중단' }[b.status] ?? b.status;
  const moments = keyMoments(b, 12);
  const ko = (b.history ?? []).flatMap(h => h.events).filter(e => ['down', 'finisher', 'transition', 'yield', 'rout', 'takedown', 'detected', 'parry', 'break'].includes(e.t) || (e.t === 'hit' && (e.crit || e.eff === 'super')));
  const lines = eventLines(ko, { lang: 'ko', showRolls: false }).map(l => l.trim()).slice(0, 12);
  const won = b.status === 'win' || b.status === 'success';
  const lootBox = won && b.loot?.length ? `<div class="bt-section"><div class="bt-sub">전리품</div><div class="bt-note">${b.loot.map(x => `<b>${h(x)}</b>`).join(', ')}</div><button class="menu_button" data-act="result-loot" ${b.lootClaimed ? 'disabled' : ''}>${b.lootClaimed ? '가방에 담음' : '가방에 담기'}</button></div>` : '';
  const needRest = [s.player, ...(s.companions ?? [])].filter(Boolean).some(m => m.hp < m.maxHp || m.sp < m.maxSp || m.statuses?.length);
  const restBox = needRest ? `<div class="bt-section"><div class="bt-sub">전투 후 정비</div><div class="bt-row bt-wrap"><button class="menu_button" data-act="result-rest" data-v="short">짧은 휴식 (+30%)</button><button class="menu_button" data-act="result-rest" data-v="full">완전 회복</button></div></div>` : '';
  return `<div class="pk-wrap"><div class="bt-section bt-result ${b.status}"><div class="bt-result-title">${label}</div>
      <div class="bt-note">${h(b.title || M.ko)} · ${Math.max(1, b.st.turn - 1)}턴${s.player ? ` · ${h(s.player.name)} HP ${s.player.hp}/${s.player.maxHp}` : ''}</div></div>
    ${messageBox(api.ui.lastEvents)}
    ${lines.length ? `<div class="bt-section"><div class="bt-sub">명장면</div>${lines.map(l => `<div class="bt-note">${h(l)}</div>`).join('')}</div>` : ''}
    ${lootBox}${restBox}
    <div class="bt-section">
      <div class="lr-detail">${[['result', '승패만', '결과와 최종 상태만'], ['summary', '전투 요약', '명장면 위주'], ['full', '전체 로그', '모든 행동']].map(([k, l, d]) => `<label class="lr-opt ${(b.resultDetail ?? api.settings().resultDetail ?? 'summary') === k ? 'on' : ''}"><input type="radio" name="bt-detail" value="${k}" data-act="result-detail" ${(b.resultDetail ?? api.settings().resultDetail ?? 'summary') === k ? 'checked' : ''}><b>${l}</b><small>${d}</small></label>`).join('')}</div>
      <input type="text" class="text_pole" id="bt-result-comment" data-enter="send-result" placeholder="(선택) 결과와 같이 보낼 한마디 · 예: 숨을 고르며 검을 거둔다">
      <button class="menu_button bt-wide bt-send" data-act="send-result">결과를 이야기로 보내기</button>
      <div class="bt-row bt-wrap"><button class="menu_button bt-retry" data-act="retry-battle" ${api.busy() ? 'disabled' : ''} title="전투 전 HP·기력·가방으로 되돌리고 같은 적과 다시 싸워요 (주사위는 새로)">다시하기${b.retries ? ` (${b.retries}회째)` : ''}</button>
        <button class="menu_button" data-act="dismiss-result">보내지 않고 닫기</button></div>
    </div></div>`;
}

/** Read-only skill rows: type chip, name, power and effect lines. */
function skillRows(skills, p, { del = false } = {}) {
  if (!skills?.length) return '<div class="bt-note">아직 기술이 없어요.</div>';
  return skills.map((k, i) => {
    const c = skillCard(k, { sys: p.typeSystem, spLabel: p.spLabel });
    const kind = { physical: '물리', magic: '특수', heal: '회복', buff: '강화', debuff: '방해', guard: '방어', revive: '부활', cleanse: '정화' }[k.kind] ?? k.kind;
    return `<div class="sk-row t-${c.type}"><span class="pk-tdot t-${c.type}">${h(c.typeLabel || '노말')}</span><b>${h(k.name)}</b><span class="sk-k">${kind}${c.power != null ? ` <b>${c.power}</b>` : ''}</span><span class="sk-c">${k.cost ? `${k.cost}${h(p.spLabel)}` : ''}</span>${del ? `<button class="bt-mini" data-act="del-skill" data-v="${i}">✕</button>` : ''}
      ${c.lines.length ? `<div class="sk-fx">${c.lines.map(l => `<span>${h(l)}</span>`).join('')}</div>` : ''}${k.desc ? `<div class="bt-note">${h(k.desc)}</div>` : ''}</div>`;
  }).join('');
}

/** Picture controls shared by the codex editor and the player sheet. */
function portraitControls(target, portrait) {
  const avatars = api.avatars?.() ?? [];
  return `<div class="cx-portrait"><div class="cx-prev">${portrait?.src ? `<img src="${h(portrait.src)}" class="${portrait.pixel ? 'px' : ''}" alt="" referrerpolicy="no-referrer">` : '<small>실루엣</small>'}</div>
    <div class="cx-pbtns">
      <label class="menu_button">파일<input type="file" accept="image/*" data-act="pt-file" data-v="${h(target)}" hidden></label>
      ${avatars.map((a, i) => `<button class="menu_button" data-act="pt-avatar" data-v="${h(target)}" data-i="${i}">${h(a.label)}</button>`).join('')}
      ${portrait?.src ? `<button class="menu_button" data-act="pt-pixel" data-v="${h(target)}">${portrait.pixel ? '원본 느낌' : '도트 느낌'}</button><button class="menu_button" data-act="pt-clear" data-v="${h(target)}">✕</button>` : ''}
      <input type="text" class="text_pole" data-act="pt-url" data-v="${h(target)}" placeholder="또는 이미지 주소 (https://…)" value="${portrait?.src?.startsWith('http') ? h(portrait.src) : ''}">
    </div></div>`;
}

/** Shrink an uploaded picture so it stays light in the settings file: 96px (or a 32px "dot" version). */
async function shrinkImage(file, pixel) {
  const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
  const max = pixel ? 32 : 96;
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
  const g = c.getContext('2d'); g.imageSmoothingEnabled = !pixel; g.drawImage(img, 0, 0, c.width, c.height);
  let out = c.toDataURL('image/webp', 0.86);
  if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/png');
  return out;
}

/** Help text that stays out of the way: a small ⓘ with a tooltip. */
const tip = text => `<span class="bt-tip" title="${h(text)}" tabindex="0" data-act="pk:tip" data-v="${h(text)}">ⓘ</span>`;

function statGrid(stats, p) {
  return `<div class="sk-stats">${p.stats.map(x => `<span><small>${h(x.label || x.key)}</small><b>${stats?.[x.key] ?? '-'}</b></span>`).join('')}</div>`;
}

/* ---------- Character / codex: a profile card to look at, edit and AI forms only on request ---------- */
const modeBtns = (cur, prefix, { busy = false } = {}) => `<div class="pc-btns">
  <button class="pc-mb ${cur === 'edit' ? 'on' : ''}" data-act="${prefix}-mode" data-v="${cur === 'edit' ? 'view' : 'edit'}" title="${cur === 'edit' ? '편집을 마치고 보기 화면으로' : '숫자·타입·초상화 직접 수정'}">${cur === 'edit' ? '완료' : '편집'}</button>
  <button class="pc-mb ${cur === 'ai' ? 'on' : ''}" data-act="${prefix}-mode" data-v="${cur === 'ai' ? 'view' : 'ai'}" ${busy ? 'disabled' : ''} title="${cur === 'ai' ? 'AI 수정 닫기' : 'AI로 다시 만들기·고치기'}">${cur === 'ai' ? '닫기' : 'AI'}</button></div>`;

function bar(cur, max, cls, label) {
  const w = Math.max(0, Math.min(100, Math.round((cur / Math.max(1, max)) * 100)));
  return `<div class="pc-bar ${cls}"><div style="width:${w}%"></div><span>${h(label)} ${cur}/${max}</span></div>`;
}

/** Card: picture (click to change) · name · rank · types · trait, HP/SP bars, stat chips. */
function profileCard(sh, p, { target, sub = '', btns = '', current = true }) {
  const sys = p.typeSystem;
  const altSys = sys === 'pokemon' ? 'world' : 'pokemon';
  const altTypes = typesFor(sh, altSys);
  const altChip = altTypes.length ? `<span class="pc-alttype" title="${altSys === 'pokemon' ? '포켓몬 속성 (상단 버튼으로 전환 가능)' : '세계관 속성 (상단 버튼으로 전환 가능)'}">${altSys === 'pokemon' ? '포켓몬' : '세계관'}: ${altTypes.map(t => h(typeName(t, altSys))).join('·')}</span>` : '';
  const pic = sh.portrait?.src ? `<img src="${h(sh.portrait.src)}" class="${sh.portrait.pixel ? 'px' : ''}" alt="" referrerpolicy="no-referrer">` : `<span class="pc-ph">${h((sh.name ?? '?').slice(0, 1))}</span>`;
  const trait = sh.trait && TRAITS[sh.trait] ? `<span class="pc-trait" title="전투 역할 특성: ${h(TRAITS[sh.trait].desc)}">특성:${h(TRAITS[sh.trait].ko)}</span>` : '';
  const open = api.ui.picOpen === target;
  return `<div class="bt-section pc-card">
    <div class="pc-head"><button class="pc-pic ${open ? 'on' : ''}" data-act="pc-pic" data-v="${h(target)}" title="초상화 바꾸기">${pic}</button>
      <div class="pc-id"><div class="pc-name"><b>${h(sh.name)}</b><span class="cx-tier">${h(sh.tier || '?')}</span>${typesFor(sh, sys).map(t => `<span class="pk-tdot t-${typeIn(t, sys)}">${h(typeName(t, sys))}</span>`).join('')}${altChip}${trait}</div>${sub ? `<div class="pc-sub">${sub}</div>` : ''}</div>
      ${btns}</div>
    ${open ? portraitControls(target, sh.portrait) : ''}
    ${bar(current ? sh.hp : sh.maxHp, sh.maxHp, 'hp', p.hpLabel)}${sh.maxSp ? bar(current ? sh.sp : sh.maxSp, sh.maxSp, 'sp', p.spLabel) : ''}
    ${statGrid(sh.stats, p)}
  </div>`;
}

/** Compact skill list for the card view: tap any skill to toggle full mechanical & flavor details. */
function skillView(skills, p, scope = 'view') {
  if (!skills?.length) return '<div class="bt-empty">아직 기술이 없어요.</div>';
  return skills.map((k, i) => {
    const key = `${scope}:${i}`;
    const open = api.ui.skOpen === key;
    const c = skillCard(k, { sys: p.typeSystem, spLabel: p.spLabel });
    const kindKo = { physical: '물리', magic: '특수', heal: '회복', buff: '강화', debuff: '방해', guard: '방어', revive: '부활', cleanse: '정화' }[k.kind] ?? k.kind;
    const pow = c.power != null ? `${kindKo} ${c.power}${k.hits > 1 ? `×${k.hits}` : ''}` : { heal: `회복 ${k.power}%`, buff: '강화', debuff: '방해', guard: '방어', revive: '부활', cleanse: '정화' }[k.kind] ?? kindKo;
    const detail = open ? `<div class="pc-sdetail">
      <div class="pc-sd-meta"><span class="pk-tdot t-${c.type}">${h(c.typeLabel || '노말')}</span><span>${h(pow)}</span><span>${k.cost ? `소모 ${k.cost} ${h(p.spLabel)}` : '자원 소모 없음'}</span></div>
      ${skillDetailLines(k, { verbose: true }).map(l => `<div class="pc-sd-line">· ${h(l)}</div>`).join('')}
      ${k.desc ? `<div class="pc-sd-desc">${h(k.desc)}</div>` : ''}
    </div>` : '';
    return `<div class="pc-skill ${open ? 'open' : ''}" style="--tc:${TYPE_HEX[c.type] ?? '#8a8c8a'}" data-act="sk-detail" data-v="${h(key)}">
      <div class="pc-sl1"><i class="sk-dot"></i><b>${h(k.name)}</b><span class="pc-pow">${h(pow)}</span><em>${k.cost ? `${k.cost}` : '무료'}</em><span class="pc-caret">${open ? '▾' : '▸'}</span></div>
      ${!open && c.lines.length ? `<div class="pc-sl2">${c.lines.slice(0, 3).map(l => `<span>${h(l)}</span>`).join('')}${c.lines.length > 3 ? `<span>+${c.lines.length - 3}</span>` : ''}</div>` : ''}${detail}</div>`;
  }).join('');
}

function sheetTab(s) {
  const p = profileOf(s);
  const me = s.player;
  const busy = api.busy();
  if (editing === 'player') {
    return `<div class="bt-section"><div class="bt-sub">캐릭터 시트 JSON 편집</div><textarea id="bt-json" class="text_pole bt-json">${h(JSON.stringify({ player: s.player, companions: s.companions, inventory: s.inventory }, null, 2))}</textarea>
      <div class="bt-row"><button class="menu_button" data-act="save-json" data-v="player">저장</button><button class="menu_button" data-act="cancel-json">취소</button></div></div>`;
  }
  const concept = s.playerConcept ?? '';
  const aiForm = `<div class="bt-section pc-form"><div class="bt-sub">AI로 ${me ? '다시 만들기' : '시트 만들기'} ${tip('숫자(위력·확률·스탯)는 AI가 세계관 등급에 맞춰 정하고, 등급을 넘는 건 자동으로 깎여요. 상태창이 있으면 그 수치를 그대로 써요.')}</div>
      <div class="bt-row"><label>등급<select class="text_pole" data-act="player-tier"><option value="">AI 판단 (페르소나·설명·로어의 등급 표기를 읽어요)</option>${p.tiers.map(t => `<option value="${h(t.name)}" ${s.playerTier === t.name ? 'selected' : ''} title="${h(t.desc ?? '')}">${h(t.name)} 고정</option>`).join('')}</select></label></div>
      <textarea class="text_pole" id="bt-sheet-extra" rows="3" placeholder="어떤 전투 스타일인지 자유롭게 적어주세요. 세계관 등급을 적으면(예: 3등급, 프로기오, B랭크) AI가 등급표에 맞춰 읽어요.&#10;예) 쌍검을 쓰는 속도형 검사. 번개를 두른 돌진기, 상대 방어를 깎는 연속베기 같은 느낌">${h(concept)}</textarea>
      <div class="bt-row bt-wrap"><button class="menu_button bt-send" data-act="gen-sheet" ${busy ? 'disabled' : ''}>${me ? '리롤' : 'AI로 시트 생성'}</button>
        <button class="menu_button" data-act="import-stat">상태창에서 불러오기</button></div>
      ${me ? `<div class="bt-sub" style="margin-top:8px">수정 지시</div>
      <textarea class="text_pole" id="bt-sheet-instr" rows="2" placeholder="예) 섬광 베기를 원거리기로 / 회복기 하나 넣어줘 / 기술 이름 더 멋있게"></textarea>
      <button class="menu_button" data-act="sheet-revise" ${busy ? 'disabled' : ''}>지시대로 고치기</button>` : ''}</div>`;
  if (!me) return `<div class="bt-section"><div class="bt-empty">아직 전투 시트가 없어요. 첫 전투 때 자동으로 만들어지거나, 지금 만들 수 있어요.</div></div>${aiForm}`;
  const mode = ['edit', 'ai'].includes(api.ui.sheetMode) ? api.ui.sheetMode : 'view';
  const comps = s.companions.map((c, i) => `<span class="pc-chip">${h(c.name)} <small>[${h(c.tier || '?')}] ${c.hp}/${c.maxHp}</small>${mode === 'edit' ? `<button class="bt-mini" data-act="del-comp" data-v="${i}">✕</button>` : ''}</span>`).join('');
  const bag = mode === 'edit'
    ? s.inventory.map((it, i) => `<div class="bt-skillrow">${h(it.name)} ×${it.count} <small>${h(ITEM_KIND_KO[(it.spec ?? inferItem(it.name))?.kind] ?? '전투 효과 없음')}</small><button class="bt-mini" data-act="inv" data-v="${i}" data-d="1">＋</button><button class="bt-mini" data-act="inv" data-v="${i}" data-d="-1">－</button></div>`).join('')
    : s.inventory.map(it => `<span class="pc-chip" title="${h(ITEM_KIND_KO[(it.spec ?? inferItem(it.name))?.kind] ?? '전투 효과 없음')}">${h(it.name)} ×${it.count}</span>`).join('');
  const card = profileCard(me, p, { target: 'player', btns: modeBtns(mode, 'sheet', { busy }), sub: me.weak?.length || me.resist?.length ? `약점 ${me.weak.map(e => ELEMENT_KO[e] ?? e).join(', ') || '-'} · 저항 ${me.resist.map(e => ELEMENT_KO[e] ?? e).join(', ') || '-'}` : '' });
  const editForm = mode !== 'edit' ? '' : `<div class="bt-section pc-form"><div class="bt-sub">직접 수정</div>
      <div class="bt-row"><input type="text" class="text_pole" id="bt-type-in" data-enter="set-type" placeholder="${p.typeSystem === 'pokemon' ? '타입 바꾸기 (예: 불꽃/격투)' : '속성 바꾸기 (예: 불/빛)'}"><button class="menu_button" data-act="set-type">타입 적용</button></div>
      <div class="bt-row"><label>${h(p.hpLabel)}<input type="number" data-act="num" data-v="hp" value="${me.hp}">/<input type="number" data-act="num" data-v="maxHp" value="${me.maxHp}"></label></div>
      <div class="bt-row"><label>${h(p.spLabel)}<input type="number" data-act="num" data-v="sp" value="${me.sp}">/<input type="number" data-act="num" data-v="maxSp" value="${me.maxSp}"></label></div>
      <div class="bt-stats">${p.stats.map(x => `<label class="bt-stat">${h(x.label || x.key)}<input type="number" data-act="stat" data-v="${h(x.key)}" value="${me.stats[x.key] ?? 0}"></label>`).join('')}</div>
      <button class="menu_button" data-act="edit-json" data-v="player" style="margin-top:6px">JSON</button></div>`;
  return `${personaBanner(busy)}${card}${editForm}${mode === 'ai' ? aiForm : ''}
    <div class="bt-section"><div class="bt-sub">기술 <small class="sd-hint">클릭하면 상세 보기</small></div>${mode === 'edit' ? skillRows(me.skills, p, { del: true }) : skillView(me.skills, p, 'player')}</div>
    <div class="bt-section"><div class="bt-sub">함께 다니는 인물 ${tip('따로 편입할 필요 없어요. 전투를 만들 때 보조모델이 대화를 보고 장면에 있는 도감 인물을 아군·적으로 넣어요. 여기 있는 사람은 「요즘 같이 다님」으로 참고만 해요.')}</div>${comps ? `<div class="pc-chips">${comps}</div>` : '<div class="bt-empty">없음</div>'}</div>
    <div class="bt-section"><div class="bt-sub">가방</div>${bag ? (mode === 'edit' ? bag : `<div class="pc-chips">${bag}</div>`) : '<div class="bt-empty">비어 있음</div>'}
      ${mode === 'edit' ? '<div class="bt-row"><input type="text" class="text_pole" id="bt-new-item" data-enter="add-item" placeholder="아이템 추가 (예: 하급 포션)"><button class="menu_button" data-act="add-item">추가</button></div>' : ''}</div>`;
}

function rulesTab(s) {
  const p = profileOf(s);
  const busy = api.busy();
  if (editing === 'rules') {
    return `<div class="bt-section"><div class="bt-sub">룰 프로필 JSON 편집</div><textarea id="bt-json" class="text_pole bt-json">${h(JSON.stringify(p, null, 2))}</textarea>
      <div class="bt-row"><button class="menu_button" data-act="save-json" data-v="rules">저장</button><button class="menu_button" data-act="cancel-json">취소</button></div></div>`;
  }
  const bf = s.brief?.parts;
  const chartRows = p.typeSystem === 'pokemon' ? [] : Object.entries(p.chart ?? {}).map(([a, row]) => {
    const by = m => Object.entries(row).filter(([, v]) => (m === 2 ? v > 1 : m === 0 ? v === 0 : v > 0 && v < 1)).map(([d]) => h(typeName(d)));
    const st = by(2), wk = by(0.5), no = by(0);
    return st.length || wk.length || no.length ? `<div>· <b>${h(typeName(a))}</b>${st.length ? ` → 강함: ${st.join(', ')}` : ''}${wk.length ? ` · 약함: ${wk.join(', ')}` : ''}${no.length ? ` · 무효: ${no.join(', ')}` : ''}</div>` : '';
  }).filter(Boolean);
  const briefBox = `<div class="bt-section"><div class="bt-sub">기초 설정 ${tip('로어북·디스크립션·페르소나·최근 대화를 한 번 읽어 속성·상성표·등급 체계·전투 방식을 요약해 둬요. 시트·전투 구성·상시 프롬프트가 이 요약을 같이 써요.')}</div>
      ${bf ? `${[['전투 방식', bf.combat], ['등급 체계', bf.ranks], ['속성·상성', bf.elements], ['나', bf.player]].filter(([, v]) => v).map(([k, v]) => `<div class="bt-note"><b>${k}</b> · ${h(v)}</div>`).join('')}
        ${bf.storyteller ? `<details class="bt-note"><summary>메인 모델에 상시로 주는 메모</summary><pre class="bt-pre">${h(bf.storyteller)}</pre></details>` : ''}
        <div class="sd-hint">만든 시각: ${new Date(s.brief.at).toLocaleString()}</div>`
        : '<div class="bt-note">아직 없어요. 만들어 두면 시트 등급·속성 판단이 정확해지고 상시 프롬프트가 가벼워져요.</div>'}
      <div class="bt-row"><button class="menu_button" data-act="setup" ${busy ? 'disabled' : ''}>${bf ? '기초 설정 다시 만들기' : '기초 설정 만들기'}</button></div></div>`;
  return `${briefBox}<div class="bt-section">
      <div class="bt-fname">${h(p.name)} ${s.profile ? '' : '<small>(기본값)</small>'}</div>
      <div class="bt-note">스탯: ${p.stats.map(x => h(x.label && x.label !== x.key ? `${x.key}(${x.label})` : x.key)).join(', ')} · 체력 ${h(p.hpLabel)} · 자원 ${h(p.spLabel)}</div>
      <div class="bt-note">계산: ${Object.entries(p.map).map(([k, v]) => `${DERIVED_KO[k]}=${h(v)}`).join(', ')}</div>
      <div class="bt-note">등급: ${p.tiers.map(t => `<span title="${h(t.desc ?? '')}">${h(t.name)}(${t.hp[0]}~${t.hp[1]})</span>`).join(' → ')}</div>
      ${p.tiers.some(t => t.desc) ? `<details class="bt-note"><summary>등급별 기준</summary>${p.tiers.map(t => `<div>· <b>${h(t.name)}</b>${t.aliases?.length ? ` <small>(= ${t.aliases.map(h).join(' / ')})</small>` : ''} — ${h(t.desc ?? '(설명 없음)')}</div>`).join('')}</details>` : ''}
      ${p.elements?.length ? `<div class="bt-note">속성: ${p.elements.map(h).join(', ')}</div>` : ''}
      ${chartRows.length ? `<details class="bt-note"><summary>상성표 (공격 → 방어)</summary>${chartRows.join('')}</details>` : ''}
      ${p.notes ? `<div class="bt-note">${h(p.notes)}</div>` : ''}
    </div>
    <div class="bt-section">${cheatBarHtml()}</div>
    <div class="bt-section"><div class="bt-sub">상성 체계</div>
      <div class="bt-row bt-wrap"><button class="menu_button ${p.typeSystem !== 'pokemon' ? 'bt-on' : ''}" data-act="rule-set" data-v="world">세계관 속성</button>
      <button class="menu_button ${p.typeSystem === 'pokemon' ? 'bt-on' : ''}" data-act="rule-set" data-v="pokemon">포켓몬식 상세 룰</button></div>
      <div class="bt-note">${p.typeSystem === 'pokemon' ? `18타입 (${Object.values(POKE_KO).join('·')}) · 공식 상성표 (압축 배율: 약점 ×1.5 / 이중약점 ×2 / 반감 ×0.75 / 이중반감 ×0.5 / 무효 ×0) · 자속 1.5배 · 물리/특수 분리 · 우선도` : '세계관 속성 + 상성표 (압축 배율: 약점 ×1.5 / 이중약점 ×2 / 반감 ×0.75 / 이중반감 ×0.5 / 무효 ×0) · 자속 1.2배'}</div></div>
    <div class="bt-section"><div class="bt-sub">등급 체계 ${tip('세계관에 고유 랭크(헌터 F~S, 무협 경지 등)가 있으면 AI 룰 분석이 그 이름을 그대로 써요. 프리셋을 바꾸면 등록된 캐릭터 등급도 같은 위치의 새 등급으로 옮겨요.')}</div>
      <div class="bt-row bt-wrap">${Object.entries(TIER_PRESETS).map(([k, v]) => `<button class="menu_button ${p.tiers.map(t => t.name).join('|') === v.tiers.map(t => t.name).join('|') ? 'bt-on' : ''}" data-act="tier-preset" data-v="${k}" ${busy ? 'disabled' : ''}>${h(v.ko)}</button>`).join('')}</div>
</div>
    <div class="bt-section bt-row bt-wrap">
      <button class="menu_button" data-act="gen-rules" ${busy ? 'disabled' : ''}>AI로 세계관 룰 분석</button>
      <button class="menu_button" data-act="edit-json" data-v="rules">JSON</button>
      <button class="menu_button" data-act="reset-rules">기본값</button>
    </div>
    <div class="bt-section">
      <label class="checkbox_label"><input type="checkbox" data-act="chat-off" ${s.disabled ? 'checked' : ''}> 이 채팅에서 BattleTale 끄기</label>
      <button class="menu_button bt-danger" data-act="reset-chat">이 채팅의 전투 데이터 초기화</button>
    </div>`;
}

function codexTab(s) {
  const p = profileOf(s);
  const list = api.codex();
  if (editing?.startsWith('codex:')) return codexEditor(s, p, editing.slice(6), list);
  const ROLE = { player: '나', companion: '동료', rival: '라이벌', enemy: '적', boss: '보스', npc: 'NPC' };
  const fresh = new Set(api.ui.castFresh ?? []);
  const busy = api.busy();
  const freshPlayer = fresh.has('player') && s.player ? `<div class="bt-section cx-fresh"><div class="bt-note">신규 시트: <b>${h(s.player.name)}</b> [${h(s.player.tier || '?')}] — 캐릭터 탭에서 확인·리롤</div></div>` : '';
  // Newly registered first, so a fresh batch can be reviewed (reroll / delete) at a glance.
  const ordered = [...list.filter(e => fresh.has(e.id)), ...list.filter(e => !fresh.has(e.id))];
  return `<div class="bt-section">
      <div class="bt-row bt-wrap"><button class="menu_button bt-send" data-act="cast-scan" ${busy ? 'disabled' : ''}>${list.length ? '주요 인물 더 찾아서 등록' : '세계관에서 주요 인물 찾아서 등록'}</button><button class="menu_button" data-act="codex-new">＋ 직접 등록</button>
      ${tip(`보조모델이 페르소나·캐릭터 카드·로어북 인물 항목·최근 대화 ${api.settings().castScene ?? 20}개를 읽고 한 번에 ${api.settings().castBatch ?? 4}명까지 찾아 시트까지 바로 등록해요. 한 번 등록한 캐릭터는 이름만 나와도 이 스킬셋 그대로 등장하고, 성장은 채팅별로 기록돼요.`)}</div></div>
    ${freshPlayer}
    <div class="bt-section">${ordered.length ? ordered.map(e => {
      const sh = api.rosterOf(e);
      const grown = api.hasRoster(e);
      const isNew = fresh.has(e.id);
      return `<div class="bt-skillrow cx-row ${isNew ? 'cx-new' : ''}"><div class="bt-click cx-main" data-act="codex-open" data-v="${h(e.id)}">${isNew ? '<span class="cx-badge">NEW</span> ' : ''}<b>${h(e.name)}</b>${e.role ? ` <span class="cx-role">${ROLE[e.role] ?? h(e.role)}</span>` : ''} <small>[${h(sh.tier || '?')}] ${typesFor(sh, p.typeSystem).map(x => h(typeName(x, p.typeSystem))).join('/')} · 스킬 ${sh.skills.length}${e.locked ? ' · 잠금' : ''}${grown ? ' · 성장' : ''}${s.companions.some(c => c.codexId === e.id) ? ' · 동행' : ''}</small>${isNew && e.why ? `<div class="bt-note">${h(e.why)}</div>` : ''}</div>
        <span class="cx-quick"><button class="menu_button" data-act="codex-reroll" data-v="${h(e.id)}" title="설명으로 다시 생성 (등급도 다시 판단)" ${busy || e.locked ? 'disabled' : ''}>리롤</button><button class="menu_button" data-act="codex-quickdel" data-v="${h(e.id)}" title="도감에서 삭제">✕</button></span></div>`;
    }).join('') : '<div class="bt-empty">아직 등록된 캐릭터가 없어요.</div>'}</div>`;
}

function codexEditor(s, p, id, list) {
  const entry = id === 'new' ? null : list.find(e => e.id === id);
  const sh = entry ? api.rosterOf(entry) : null;
  const grown = entry && api.hasRoster(entry);
  const busy = api.busy();
  const ROLE = { player: '나', companion: '동료', rival: '라이벌', enemy: '적', boss: '보스', npc: 'NPC' };
  const mode = !entry ? 'new' : ['edit', 'ai'].includes(api.ui.cxMode) ? api.ui.cxMode : 'view';
  const back = `<div class="bt-section"><button class="menu_button" data-act="codex-back">← 목록</button></div>`;
  const tierSel = (fixedLabel = 'AI가 세계관 보고 판단') => `<label>등급<select id="bt-cx-tier" class="text_pole"><option value="">${fixedLabel}</option>${p.tiers.map(t => `<option value="${h(t.name)}" ${sh?.tier === t.name && mode !== 'ai' ? 'selected' : ''} title="${h(t.desc ?? '')}">${h(t.name)}</option>`).join('')}</select></label>`;
  const descBox = `<label class="bt-f">어떤 캐릭터인지 (자유롭게) ${tip('스킬 이름이나 느낌만 적어도 돼요. 타입·위력·우선도·확률·스탯은 AI가 정하고, 세계관 등급을 넘는 건 자동으로 깎여요.')}</label>
      <textarea class="text_pole" id="bt-cx-desc" rows="4" placeholder="예) 총사. 바람을 두른 속사가 주특기고, 빠르게 쏘는 신속사격과 뒤로 빠지며 방어를 올리고 조금 회복하는 백스탭을 써요.">${h(entry?.concept ?? sh?.desc ?? '')}</textarea>`;
  const idFields = `<label class="bt-f">이름</label><input type="text" class="text_pole" id="bt-cx-name" value="${h(sh?.name ?? '')}">
      <div class="bt-row">${tierSel()}<label>외형<select id="bt-cx-shape" class="text_pole"><option value="">자동</option>${Object.entries(SHAPE_KO).map(([k, v]) => `<option value="${k}" ${sh?.shape === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
      <label class="bt-f">별칭 (쉼표)</label><input type="text" class="text_pole" id="bt-cx-alias" value="${h((sh?.aliases ?? []).join(', '))}" placeholder="예: 오스샷, Elias">`;
  if (mode === 'new') {
    return `${back}<div class="bt-section pc-form"><div class="bt-sub">새 캐릭터</div>${idFields}${descBox}
      <div class="bt-row bt-wrap"><button class="menu_button bt-send" data-act="codex-gen" data-v="" ${busy ? 'disabled' : ''}>AI로 생성해서 등록</button></div></div>`;
  }
  const sub = [entry.role ? ROLE[entry.role] ?? h(entry.role) : '', entry.locked ? '잠금' : '', grown ? '이 채팅에서 성장' : '', s.companions.some(c => c.codexId === entry.id) ? '같이 다님' : ''].filter(Boolean).join(' · ');
  const card = profileCard(sh, p, { target: `codex:${entry.id}`, sub, btns: modeBtns(mode, 'cx', { busy }), current: !!grown });
  // AI actions read name/shape/aliases from the page: keep them as hidden fields when the form is closed.
  const hidden = `<input type="hidden" id="bt-cx-name" value="${h(sh.name)}"><input type="hidden" id="bt-cx-shape" value="${h(sh.shape ?? '')}"><input type="hidden" id="bt-cx-alias" value="${h((sh.aliases ?? []).join(', '))}">`;
  const aiForm = mode !== 'ai' ? '' : `<div class="bt-section pc-form"><div class="bt-sub">AI로 다시 만들기</div>${hidden}
      <div class="bt-row">${tierSel('AI가 다시 판단')}</div>${descBox}
      <div class="bt-row bt-wrap"><button class="menu_button bt-send" data-act="codex-gen" data-v="${h(entry.id)}" ${busy ? 'disabled' : ''}>리롤 (설명으로 새로)</button><button class="menu_button" data-act="codex-sync" data-v="${h(entry.id)}" ${busy || entry.locked ? 'disabled' : ''} title="최근 대화에서 이 인물의 성장·새 기술·변화를 읽어 기존 시트에 반영해요">최근 대화 반영해 갱신</button></div>
      <div class="bt-sub" style="margin-top:8px">수정 지시 ${tip('등급 예산과 공정성 규칙이 지시보다 우선이라, 너무 센 요청은 깎여서 들어가요.')}</div>
      <textarea class="text_pole" id="bt-cx-instr" rows="2" placeholder="예) 원거리 위주로 바꿔줘 / 회복기 빼고 방어 버프 넣어줘 / 신속사격 위력 좀 올려줘"></textarea>
      <button class="menu_button" data-act="codex-revise" data-v="${h(entry.id)}" ${busy ? 'disabled' : ''}>지시대로 고치기</button>
      ${(entry.history ?? []).length ? `<div class="sd-hint">지난 지시: ${entry.history.slice(-3).map(x => h(x.instruction)).join(' · ')}</div>` : ''}</div>`;
  const editForm = mode !== 'edit' ? '' : `<div class="bt-section pc-form"><div class="bt-sub">직접 수정</div>${idFields}${descBox}
      <div class="bt-row bt-wrap"><button class="menu_button bt-send" data-act="codex-save" data-v="${h(entry.id)}">저장 (AI 없이)</button></div>
      <div class="bt-row bt-wrap pc-manage"><button class="menu_button" data-act="codex-lock" data-v="${h(entry.id)}" data-on="${entry.locked ? '0' : '1'}">${entry.locked ? '잠금 해제' : '잠금 (스토리 변경 차단)'}</button>
        ${grown ? `<button class="menu_button" data-act="codex-promote" data-v="${h(entry.id)}">성장 → 기본판</button><button class="menu_button" data-act="codex-reset" data-v="${h(entry.id)}">성장 초기화</button>` : ''}
        <button class="menu_button bt-danger" data-act="codex-del" data-v="${h(entry.id)}">삭제</button></div>
      <details><summary class="sd-hint">JSON 직접 수정</summary><textarea id="bt-cx-json" class="text_pole bt-json">${h(JSON.stringify(entry.sheet, null, 1))}</textarea><button class="menu_button" data-act="codex-json" data-v="${h(entry.id)}">저장</button></details></div>`;
  return `${back}${card}${editForm}${aiForm}
    <div class="bt-section"><div class="bt-sub">기술 <small class="sd-hint">클릭하면 상세 보기</small></div>${skillView(sh.skills, p, `cx:${entry.id}`)}</div>
    ${sh.desc && mode === 'view' ? `<div class="bt-section"><div class="sd-hint">${h(sh.desc)}</div></div>` : ''}`;
}

/** Save the codex form as typed (no AI): name, rank, look, aliases, description. */
function saveCodexForm(id) {
  const entry = api.codex().find(e => e.id === id);
  if (!entry) return;
  const val = k => document.getElementById(k)?.value?.trim() ?? '';
  const sh = api.rosterOf(entry);
  const name = val('bt-cx-name') || sh.name;
  const concept = document.getElementById('bt-cx-desc')?.value?.trim() ?? entry.concept ?? '';
  const raw = { ...entry.sheet, name, tier: val('bt-cx-tier') || entry.sheet.tier, shape: val('bt-cx-shape'), aliases: val('bt-cx-alias').split(',').map(x => x.trim()).filter(Boolean) };
  return api.saveCodex({ ...entry, concept }, raw).then(() => { api.ui.cxMode = 'view'; refreshPanel(); });
}

function saveSkillLines() {
  const text = document.getElementById('bt-skill-lines')?.value ?? '';
  api.edit(s => { if (s.player) s.player.skills = text.split('\n').map(x => x.trim()).filter(Boolean).map(l => normalizeSkill(l, { maxSp: s.player.maxSp })).filter(Boolean); });
  api.toast('스킬 저장');
}

function useCard() {
  const ui = api.ui;
  const c = ui.hand?.[ui.card];
  if (!c || c.disabled) return;
  ui.card = null;
  if (c.target?.length === 1) ui.target = c.target[0];
  return api.modeAct(c.act, c.v);
}

function onClick(e) {
  if (api.ui.suppressUntil && Date.now() < api.ui.suppressUntil) { api.ui.suppressUntil = 0; e.preventDefault(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'button')) return;
  const act = el.dataset.act, v = el.dataset.v;
  const val = id => document.getElementById(id)?.value?.trim() ?? '';
  if (act === 'm:target' || act === 'pk:pick') {
    const ui = api.ui;
    // Target page open: tapping a highlighted fighter picks it and acts.
    if (ui.page === 'target' && ui.pending?.target?.includes(v)) {
      ui.target = v; const pend = ui.pending; ui.pending = null; ui.page = 'main'; skipTalk();
      return api.modeAct(pend.act, pend.v);
    }
    const b = api.state()?.battle;
    const f = b && findFighter(b.st.b ?? b.st, v, { includeDown: true });
    // Tapping an enemy marks it as the target for the next skill; anyone else opens their details.
    if (f && f.side === 'enemy' && f.hp > 0 && act === 'pk:pick') { ui.target = ui.targetLocked && ui.target === v ? null : v; ui.targetLocked = !!ui.target; return refreshPanel(); }
    if (act === 'pk:pick') { ui.inspect = v; return refreshPanel(); }
    ui.target = v; return refreshPanel();
  }
  if (act === 'pk:card') {
    if (api.ui.peek != null) { api.ui.peek = null; return refreshPanel(); }
    const c = api.ui.hand?.[Number(el.dataset.i)];
    if (!c || c.disabled) return;
    if (api.ui.card === Number(el.dataset.i)) return useCard();
    api.ui.card = Number(el.dataset.i); return refreshPanel();
  }
  if (act === 'pk:peek-close') { api.ui.peek = null; return refreshPanel(); }
  // Tooltips don't exist on touch screens: tapping an intent badge or an ⓘ help mark shows the text as a toast.
  if (act === 'pk:tip') { e.stopPropagation(); if (v) api.toast(v); return; }
  if (act === 'pk:peekbtn') { e.stopPropagation(); e.preventDefault(); api.ui.peek = Number(el.dataset.i); return refreshPanel(); }
  if (act === 'pk:use') return useCard();
  if (act === 'pk:actor') { api.ui.actor = v; api.ui.card = null; return refreshPanel(); }
  if (act === 'pk:cancel') { api.ui.card = null; return refreshPanel(); }
  if (act === 'pk:inspect') { e.stopPropagation(); api.ui.inspect = v; return refreshPanel(); }
  if (act === 'pk:inspect-close') { api.ui.inspect = null; return refreshPanel(); }
  if (act === 'pk:next') {
    const ui = api.ui;
    if (ui.steps && (ui.stepPos ?? 0) < ui.steps.length) { ui.stepPos += 1; showStep(ui.stepPos); return refreshPanel(); }
    ui.msgPos = (ui.msgPos ?? 0) + 2; return refreshPanel();
  }
  if (act === 'pk:skip') { e.stopPropagation(); skipTalk(); api.ui.prevHp = null; return refreshPanel(); }
  if (act === 'pk:item') {
    const it = api.ui.menuItems?.[Number(el.dataset.i)];
    if (!it || it.disabled) return;
    if (it.page) { api.ui.page = it.page; return refreshPanel(); }
    if (it.act === 'pk:actor') { api.ui.actor = it.v; api.ui.page = 'main'; return refreshPanel(); }
    if (it.act === 'pk:uiset') { api.ui[it.k] = it.v == null || api.ui[it.k] === it.v ? null : it.v; return refreshPanel(); }
    if (it.act === 'pk:target') { api.ui.target = it.v; const pend = api.ui.pending; api.ui.pending = null; api.ui.page = 'main'; if (pend) { skipTalk(); return api.modeAct(pend.act, pend.v); } return refreshPanel(); }
    if (Array.isArray(it.target) && it.target.length > 1 && !(api.ui.targetLocked && it.target.includes(api.ui.target))) { api.ui.pending = { ...it, from: api.ui.page ?? 'main' }; api.ui.page = 'target'; return refreshPanel(); }
    if (Array.isArray(it.target) && it.target.length > 1 && api.ui.targetLocked && it.target.includes(api.ui.target)) { /* already picked on the field */ }
    else if (Array.isArray(it.target) && it.target.length === 1) api.ui.target = it.target[0];
    skipTalk(); // acting skips the rest of the playback
    api.ui.page = 'main';
    return api.modeAct(it.act, it.v);
  }
  if (act === 'pz:cancel') { api.ui.pzMode = null; return refreshPanel(); }
  if (act === 'pz:unpick') { api.ui.target = null; api.ui.targetLocked = false; return refreshPanel(); }
  if (act.startsWith('m:') && el.tagName !== 'SELECT') { skipTalk(); api.ui.page = 'main'; return api.modeAct(act, v); }
  switch (act) {
    case 'close': return togglePanel(false);
    case 'sk-detail': api.ui.skOpen = api.ui.skOpen === v ? null : v; return refreshPanel();
    case 'cheat-set': return api.setSetting(el.dataset.k, Number(v));
    case 'cheat-reset': api.setSetting('dealMul', 1); return api.setSetting('takeMul', 1);
    case 'pt-avatar': { const a = (api.avatars?.() ?? [])[Number(el.dataset.i)]; if (a) api.setPortrait(v, { src: a.src, pixel: false }); return; }
    case 'pt-pixel': return api.setPortrait(v, p0 => (p0 ? { ...p0, pixel: !p0.pixel } : null));
    case 'pt-clear': return api.setPortrait(v, null);
    case 'cast-scan': return api.scanCast();
    case 'codex-reroll': return api.rerollCodex(v);
    case 'codex-quickdel': {
      const e = api.codex().find(x => x.id === v);
      if (e && confirm(`「${e.name}」을(를) 도감에서 삭제할까요?`)) { api.ui.castFresh = (api.ui.castFresh ?? []).filter(x => x !== v); api.deleteCodex(v); }
      return;
    }
    case 'tier-preset': return api.setTierPreset(v);
    case 'codex-revise': {
      const instr = document.getElementById('bt-cx-instr')?.value?.trim();
      if (!instr) return api.toast('어떻게 고칠지 적어주세요.', 'warning');
      return api.genCodex({ id: v, name: val('bt-cx-name'), concept: document.getElementById('bt-cx-desc')?.value?.trim() ?? '', tier: val('bt-cx-tier'), shape: val('bt-cx-shape'), aliases: val('bt-cx-alias'), instruction: instr })
        .then(e => { if (e?.id) { editing = `codex:${e.id}`; api.ui.cxMode = 'view'; refreshPanel(); } });
    }
    case 'sheet-revise': {
      const instr = document.getElementById('bt-sheet-instr')?.value?.trim();
      if (!instr) return api.toast('어떻게 고칠지 적어주세요.', 'warning');
      return Promise.resolve(api.genSheet(document.getElementById('bt-sheet-extra')?.value?.trim() ?? '', instr)).then(() => { api.ui.sheetMode = 'view'; refreshPanel(); });
    }
    case 'compact': api.ui.compact = !api.ui.compact; try { localStorage.setItem('bt-compact', api.ui.compact ? '1' : ''); } catch { /* private mode */ } return refreshPanel();
    case 'settings-open': api.ui.settingsOpen = true; return refreshPanel();
    case 'settings-close': api.ui.settingsOpen = false; return refreshPanel();
    case 'sd-page': api.ui.sdPage = v; return refreshPanel();
    case 'aux-test': return api.auxTest?.();
    case 'aux-models': return api.auxModels?.();
    case 'trace-filter': api.ui.traceFilter = v; return refreshPanel();
    case 'trace-clear': return api.clearTrace?.();
    case 'tab': tab = v; editing = null; return refreshPanel();
    case 'start': return api.start(val('bt-hint'), val('bt-mode-pick') || null);
    case 'send-result': return api.sendResult(val('bt-result-comment'));
    case 'dismiss-result': return api.dismissResult();
    case 'retry-battle': return api.retryBattle?.();
    case 'codex-open': editing = `codex:${v}`; api.ui.cxMode = 'view'; api.ui.picOpen = null; return refreshPanel();
    case 'sheet-mode': api.ui.sheetMode = v; return refreshPanel();
    case 'cx-mode': api.ui.cxMode = v; return refreshPanel();
    case 'pc-pic': api.ui.picOpen = api.ui.picOpen === v ? null : v; return refreshPanel();
    case 'codex-new': editing = 'codex:new'; return refreshPanel();
    case 'codex-back': editing = null; return refreshPanel();
    case 'codex-save': return saveCodexForm(v);
    case 'codex-gen': {
      const name = val('bt-cx-name');
      if (!name) return api.toast('이름을 적어주세요.', 'warning');
      return api.genCodex({ id: v || null, name, concept: document.getElementById('bt-cx-desc')?.value?.trim() ?? '', tier: val('bt-cx-tier'), shape: val('bt-cx-shape'), aliases: val('bt-cx-alias') })
        .then(e => { if (e?.id) { editing = `codex:${e.id}`; api.ui.cxMode = 'view'; refreshPanel(); } });
    }
    case 'codex-json': {
      let j; try { j = JSON.parse(document.getElementById('bt-cx-json').value); } catch (err) { return api.toast(`JSON 오류: ${err.message}`, 'error'); }
      const entry = api.codex().find(e => e.id === v);
      return api.saveCodex(entry, j);
    }
    case 'codex-del': if (confirm('도감에서 삭제할까요?')) { editing = null; api.deleteCodex(v); } return;
    case 'codex-sync': return api.syncCodex(v);
    case 'codex-lock': return api.lockCodex(v, el.dataset.on === '1');
    case 'preview-go': return api.confirmPreview();
    case 'preview-cancel': return api.cancelPreview();
    case 'preview-reforge': return api.reforgePreview();
    case 'pv-del': { const pv = api.ui.preview; const arr = pv?.spec?.[el.dataset.side]; if (arr) { arr.splice(Number(v), 1); refreshPanel(); } return; }
    case 'pv-row': { const pv = api.ui.preview; const item = pv?.spec?.[el.dataset.side]?.[Number(v)]; if (item) { item.row = item.row === 'back' ? 'front' : 'back'; refreshPanel(); } return; }
    case 'pv-add-ally': {
      const pv = api.ui.preview; const cid = val('bt-pv-add');
      if (!pv?.spec || !cid) return;
      const e = api.codex().find(x => x.id === cid); if (!e) return;
      const sh = api.rosterOf(e);
      pv.spec.allies ??= [];
      pv.spec.allies.push({ ...sh, codexId: e.id, _src: 'codex' });
      return refreshPanel();
    }
    case 'persona-refresh': return api.genSheet('', '변경된 페르소나 설명의 등급·능력·장비·특징을 정확히 반영해 시트를 최신화해줘');
    case 'persona-dismiss': return api.dismissPersonaChange();
    case 'result-loot': return api.claimLoot();
    case 'result-rest': return api.restAfter(v);
    case 'codex-promote': return api.promote(v);
    case 'codex-reset': return api.resetRoster(v);
    case 'codex-join': return api.joinCodex(v);
    case 'skills-save': return saveSkillLines();
    case 'rule-set': return api.setRuleSet(v);
    case 'stop': return api.stop();
    case 'gen-sheet': return Promise.resolve(api.genSheet(document.getElementById('bt-sheet-extra')?.value?.trim() ?? '')).then(() => { api.ui.sheetMode = 'view'; refreshPanel(); });
    case 'import-stat': return api.importStat();
    case 'gen-rules': return api.genRules();
    case 'setup': return api.setup?.();
    case 'setup-later': return api.edit(st => { st.setupSkipped = true; });
    case 'reset-rules': return api.edit(s => { s.profile = null; });
    case 'edit-json': editing = v; return refreshPanel();
    case 'cancel-json': editing = null; return refreshPanel();
    case 'save-json': {
      let j; try { j = JSON.parse(document.getElementById('bt-json').value); } catch (err) { return api.toast(`JSON 오류: ${err.message}`, 'error'); }
      editing = null;
      return v === 'rules' ? api.saveRules(j) : api.saveSheets(j);
    }
    case 'del-skill': return api.edit(s => { s.player.skills.splice(Number(v), 1); });
    case 'set-type': {
      const raw = document.getElementById('bt-type-in')?.value ?? '';
      const ids = raw.split(/[\/,\s]+/).filter(Boolean).map(elementId).filter(x => x !== 'none').slice(0, 2);
      if (!ids.length) return;
      return api.edit(st => { const sys = profileOf(st).typeSystem; if (sys === 'pokemon') st.player.ptypes = [...new Set(ids.map(toPoke))]; else { st.player.elements = ids; st.player.element = ids[0]; } });
    }
    case 'del-comp': return api.edit(s => { s.companions.splice(Number(v), 1); });
    case 'add-skill': { const t = val('bt-new-skill'); if (t) api.addSkill(t); return; }
    case 'add-item': { const t = val('bt-new-item'); if (t) api.edit(s => { const it = s.inventory.find(i => norm(i.name) === norm(t)); if (it) it.count++; else s.inventory.push({ name: t, count: 1 }); }); return; }
    case 'inv': return api.edit(s => { const it = s.inventory[Number(v)]; if (it) it.count += Number(el.dataset.d); s.inventory = s.inventory.filter(i => i.count > 0); });
    case 'reset-chat': if (confirm('이 채팅의 시트·전투·룰 데이터를 모두 지울까요?')) api.resetChat(); return;
  }
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.set) {
    const k = el.dataset.kind;
    let v = k === 'check' ? el.checked : k === 'num' ? (el.value === '' ? null : Number(el.value)) : el.value;
    if (k === 'json' && v.trim()) { try { JSON.parse(v); el.classList.remove('bad'); } catch { el.classList.add('bad'); return api.toast('JSON 형식이 아니에요. 저장하지 않았어요.', 'warning'); } }
    return api.setSetting(el.dataset.set, v);
  }
  const act = el.dataset.act;
  if (act === 'player-tier') return api.edit(s => { s.playerTier = el.value || null; });
  if (act === 'cast-pick') { const c = api.ui.cast?.[Number(el.dataset.i)]; if (c) c.pick = el.checked; return refreshPanel(); }
  if (act === 'pt-url') { const u = el.value.trim(); if (!u) return; if (!/^https:\/\//.test(u)) return api.toast('https:// 로 시작하는 이미지 주소만 돼요.', 'warning'); return api.setPortrait(el.dataset.v, { src: u, pixel: false }); }
  if (act === 'pt-file') {
    const f = el.files?.[0]; if (!f) return;
    if (f.size > 8e6) return api.toast('이미지가 너무 커요 (8MB 이하).', 'warning');
    shrinkImage(f, false).then(src => api.setPortrait(el.dataset.v, { src, pixel: false })).catch(() => api.toast('이미지를 읽지 못했어요.', 'error'));
    return;
  }
  if (act === 'm:actor') { api.ui.actor = el.value; refreshPanel(); }
  else if (act === 'm:target-select') { api.ui.target = el.value; refreshPanel(); }
  else if (act === 'switch-mode') api.switchMode(el.value);
  else if (act === 'preview-mode') { if (api.ui.preview) { api.ui.preview.mode = el.value; refreshPanel(); } }
  else if (act === 'result-detail') { const b = api.state()?.battle; if (b) { b.resultDetail = el.value; refreshPanel(); } }
  else if (act === 'stat') api.edit(s => { if (s.player) s.player.stats[el.dataset.v] = Number(el.value) || 0; }, { quiet: true });
  else if (act === 'num') api.edit(s => { if (s.player) { s.player[el.dataset.v] = Math.max(0, Number(el.value) || 0); s.player.hp = Math.min(s.player.hp, s.player.maxHp); s.player.sp = Math.min(s.player.sp, s.player.maxSp); } }, { quiet: true });
  else if (act === 'chat-off') api.edit(s => { s.disabled = el.checked; });
}

/* ---------------- In-chat cards ---------------- */
const dismissed = new Set();
export function renderCards(s, chat, settings) {
  const root = document.getElementById('chat');
  if (!root) return;
  root.querySelectorAll('.bt-card').forEach(x => x.remove());
  if (!s || !settings.showCards) return;
  const map = new Map();
  for (const a of s.archive) for (const c of a.cards ?? []) map.set(c.key, c);
  for (const hEntry of s.battle?.history ?? []) map.set(hEntry.key, { key: hEntry.key, turn: hEntry.turn, events: hEntry.events, via: hEntry.via });
  const starts = new Map();
  if (s.battle && s.battle.originIndex >= 0) starts.set(s.battle.originIndex, s.battle);
  let lastAi = chat.length - 1;
  while (lastAi >= 0 && (chat[lastAi]?.is_user || chat[lastAi]?.is_system)) lastAi--;
  if (!root.dataset.btGo) {
    root.dataset.btGo = '1';
    root.addEventListener('click', e => {
      const go = e.target.closest?.('[data-btgo]');
      if (go) { e.stopPropagation(); go.disabled = true; go.textContent = '⏳ 전투 준비 중…'; api?.startFrom?.(Number(go.dataset.btgo), go.dataset.soft === '1'); return; }
      const x = e.target.closest?.('[data-btgo-x]');
      if (x) { dismissed.add(Number(x.dataset.btgoX)); x.closest('.bt-card')?.remove(); }
    });
  }
  for (const el of root.querySelectorAll('.mes')) {
    const i = Number(el.getAttribute('mesid'));
    const m = chat[i];
    if (!m) continue;
    const text = el.querySelector('.mes_text');
    if (!text) continue;
    if (m.is_user) {
      const c = map.get(msgKey(i, m.mes, m)) ?? map.get(msgKey(i, m.mes));
      if (!c) continue;
      const lines = eventLines(c.events, { lang: 'ko', showRolls: settings.showRolls });
      if (!lines.length) continue;
      const end = c.events.find(e => e.t === 'end');
      text.insertAdjacentHTML('afterend', `<details class="bt-card" ${settings.cardsOpen ? 'open' : ''}><summary>🎲 ${c.turn}턴 판정${end ? ` — ${h(lines.at(-1).replace('★ ', ''))}` : ''}${c.via === 'aux' ? ' <small>(보조모델 해석)</small>' : ''}</summary><pre>${h(lines.slice(1).join('\n'))}</pre></details>`);
    } else if (!starts.has(i) && !(s.battle?.status === 'active') && m.extra?.battletale?.pending && !m.extra?.battletale?.origin?.length) {
      text.insertAdjacentHTML('afterend', `<div class="bt-card bt-go"><button class="menu_button bt-go-btn" data-btgo="${i}">⚔️ 전투 시작</button><small>${h(m.extra.battletale.pending.hint || '메인 모델이 전투 신호를 보냈어요')}</small></div>`);
    } else if (!starts.has(i) && settings.suggestStart && !(s.battle?.status === 'active') && i === lastAi && !m.extra?.battletale?.origin?.length && !dismissed.has(i) && dangerScore(m.mes) >= 2) {
      text.insertAdjacentHTML('afterend', `<div class="bt-card bt-go soft"><button class="menu_button bt-go-btn" data-btgo="${i}" data-soft="1">⚔️ 여기서 전투 시작?</button><small>위험한 장면 같아요 (신호 없음)</small><button class="bt-go-x" data-btgo-x="${i}" title="숨기기">✕</button></div>`);
    } else if (starts.has(i)) {
      const b = starts.get(i);
      const M = modeOf(b.mode);
      const foes = M.enemiesOf(b.st).map(f => `${f.name}${f.tier ? `[${f.tier}]` : ''}${f.threat !== 'normal' ? ` ${THREAT_KO[f.threat]}` : ''}`).join(', ');
      const threat = THREAT_LABEL[b.threat?.level];
      text.insertAdjacentHTML('afterend', `<div class="bt-card bt-start">${M.icon} <b>${h(M.ko)} 개시</b> — ${h(foes)} <small>(${threat ? `위협도 ${threat}` : ''}${b.status !== 'active' ? ' · 종료' : ''})</small></div>`);
    }
  }
}

/* ---------------- Settings drawer ---------------- */
export function settingsHtml() {
  return `<div class="battletale-settings"><div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header"><b>⚔️ BattleTale — 턴제 전투 엔진</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="bt_enabled"> 사용 (모든 채팅·모든 봇)</label>
    <div class="bt-note">보조모델(연결 프로필·커스텀 모델)과 나머지 설정은 BattleTale 패널의 ⚙ 버튼에서 바꿔요.</div>
    <button class="menu_button" id="bt_open_settings">⚙️ BattleTale 설정 열기</button>
  </div></div></div>`;
}
