// Helpers shared by all game modes.
import { clamp, makeRng, norm } from '../util.js';

export const GRADES = ['perfect', 'good', 'miss'];
export const GRADE_KO = { perfect: '퍼펙트', good: '굿', miss: '미스' };

/** "⚔[섬광 베기 → 늑대 A #k3j9]" → [{ body: '섬광 베기 → 늑대 A', nonce: 'k3j9' }] */
export function quickBlocks(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /⚔\s*\[/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    let i = m.index + m[0].length, depth = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '[') depth++;
      else if (s[i] === ']') depth--;
      i++;
    }
    if (depth !== 0) break;
    let body = s.slice(m.index + m[0].length, i - 1).trim();
    const n = /\s*#([a-z0-9]{4,10})\s*$/i.exec(body);
    const nonce = n ? n[1].toLowerCase() : null;
    if (n) body = body.slice(0, n.index).trim();
    out.push({ body, nonce });
    re.lastIndex = i;
  }
  return out;
}

/** "Name: action → target" pieces. */
export function splitBody(body) {
  const [left, right] = String(body).split(/\s*(?:→|->|=>|>)\s*/);
  let who = null, what = left.trim();
  const m = /^(.+?)\s*[:：]\s*(.+)$/.exec(what);
  if (m) { who = m[1].trim(); what = m[2].trim(); }
  return { who, what, target: right?.trim() || null };
}

export const matchWord = (text, map) => {
  const k = norm(text);
  for (const [id, words] of Object.entries(map)) if (words.some(w => norm(w) === k)) return id;
  return null;
};

/**
 * Stat-based grades for players who skip the minigame ("auto" timing mode).
 * ratio > 1 means the player's stat beats the opposing one.
 */
export function autoGrade(rng, ratio = 1) {
  const r = clamp(Math.log2(Math.max(0.05, ratio)), -2, 2);
  const perfect = clamp(0.08 + 0.06 * r, 0.02, 0.25);
  const miss = clamp(0.35 - 0.12 * r, 0.08, 0.7);
  const x = rng.next();
  return x < perfect ? 'perfect' : x < perfect + (1 - perfect - miss) ? 'good' : 'miss';
}

export const seededRng = (seed, ...parts) => makeRng([seed, ...parts].join(':'));

/** Minigame difficulty from a stat ratio: better stats → wider zone, slower cursor. */
export function timingFor(ratio = 1, base = {}) {
  const q = clamp(Math.sqrt(Math.max(0.05, ratio)), 0.6, 1.6);
  return {
    zone: clamp((base.zone ?? 0.22) * q, 0.08, 0.45),
    perfect: clamp((base.perfect ?? 0.07) * q, 0.025, 0.14),
    speed: clamp((base.speed ?? 1.0) / q, 0.55, 1.8),   // seconds per sweep
  };
}

/** Floating numbers on a fighter card for the last turn (game feel instead of a text log). */
export function fxHtml(ctx, name) {
  const list = ctx?.ui?.fx?.[name];
  if (!list?.length) return '';
  return `<div class="bt-fx-wrap">${list.slice(0, 4).map((f, i) => `<span class="bt-fx ${f.cls}" style="animation-delay:${i * 0.18}s">${f.text}</span>`).join('')}</div>`;
}

/** Enemy AI level from the difficulty setting (an explicit aiLevel still wins). */
export const aiLevelOf = settings => settings?.aiLevel ?? ({ easy: 'normal', normal: 'hard', hard: 'hard', nightmare: 'brutal' })[settings?.difficulty ?? 'normal'] ?? 'hard';
