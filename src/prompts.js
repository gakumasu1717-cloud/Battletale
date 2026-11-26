// Every text the extension sends to a model lives here.
import { STATUS, POKE_KO, skillLine } from './catalog.js';
import { eventLines, fighterLine } from './narrate.js';
import { modeOf } from './modes/index.js';
import { THREAT_LABEL } from './engine.js';

const STATUS_IDS = Object.keys(STATUS).join('|');

/* ====================== Aux model: rule analysis ====================== */
export function ruleMessages({ lore, character, persona, statTag }) {
  const system = `You are a game-systems designer. You read a roleplay world's lore and extract the rules a turn-based combat engine needs. Output only JSON.`;
  const user = `## World lore / rules (excerpts)
${lore || '(none)'}

## Character card
${character || '(none)'}

## Player persona
${persona || '(none)'}
${statTag ? `\n## The story's current status window for the player\n${statTag}\n` : ''}
## Task
Work out how this world measures combat power and answer with ONE JSON object:
${RULE_SCHEMA}
}
${RULE_NOTES}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: one-time setup of a chat (rules + world brief) ====================== */
/**
 * Read the world once (lore, card, persona, recent story) and keep (1) the engine's rule set and
 * (2) a compressed brief that later prompts reuse instead of re-reading everything.
 */
export function setupMessages({ lore, character, persona, personaName = '{{user}}', history = '', statTag = '' }) {
  const system = `You set up a turn-based combat engine for a roleplay chat. You read the world once and write (1) the rules the engine needs and (2) a compressed brief that later prompts reuse instead of rereading everything. Be faithful to the lore: use its own names, ranks and numbers. Output only JSON.`;
  const user = `## World lore / rules (excerpts)
${lore || '(none)'}

## Character card
${character || '(none)'}

## PRIMARY SOURCE — Player persona ("${personaName}" = {{user}})
${persona || '(none)'}
${statTag ? `\n## The story's current status window for the player\n${statTag}\n` : ''}${history ? `\n## Story so far (most recent last)\n${history}\n` : ''}
## Task
Answer with ONE JSON object:
${RULE_SCHEMA},
  "brief": {
    "combat": "2-4 sentences: how fights actually work in this world (magic / tech / martial arts / monsters, what decides a fight, how lethal it is, typical tactics)",
    "ranks": "1-3 sentences: the rank ladder(s), how they line up with each other, how big a one-rank gap is",
    "elements": "1-2 sentences: the element/attribute system and its key matchups — or 'none'",
    "player": "1-2 sentences: the standing of {{user}} per the Player persona above — ALWAYS quote any explicitly stated rank/grade/level/circle/power verbatim and NEVER downgrade it; include role, fighting style and element. Only describe them as low-rank when the persona truly states no rank or strength.",
    "storyteller": "at most 4 short lines for the storyteller model: world-specific combat vocabulary and conventions to keep consistent (rank names, how powers look and cost). No generic writing advice."
  }
}
${RULE_NOTES}
- "chart" and "elements" describe THIS world. If the lore has no element system, invent none: "elements": [] and "chart": {}.
- The brief is reused for every later fight: dense facts, no filler. Write it in the language the lore uses.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** The stored world brief as compact text for aux prompts. */
export function briefText(brief) {
  if (!brief) return '';
  const b = brief.parts ?? brief;
  return [['Combat', b.combat], ['Ranks', b.ranks], ['Elements', b.elements], ['{{user}}', b.player]]
    .filter(([, v]) => v && String(v).trim() && !/^none$/i.test(String(v).trim())).map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n');
}

const RULE_SCHEMA = `{
  "name": "short name of this rule set",
  "stats": [{"key": "STR", "label": "힘"}, ...],     // the world's own attribute names (4-8). If the world has none, invent fitting ones.
  "hpLabel": "HP", "spLabel": "SP",                  // names of health and of the resource skills spend (mana, stamina, aether…)
  "map": {                                            // how each engine stat is computed from the world's stats. Simple arithmetic on keys only.
    "pow": "STR", "mag": "INT", "def": "END", "res": "(END+INT)/2", "spd": "AGI", "acc": "SEN", "luk": "LUK"
  },
  "tiers": [ {"name": "F", "aliases": ["the same rank in the world's OTHER rank systems"], "desc": "who sits at this rank in THIS world, one short line (e.g. 'fresh guild recruits, street thugs')", "hp": [150, 250], "sp": [10, 30], "stat": [12, 20]}, ... ],  // power tiers from weakest to strongest with typical ranges. Use the world's OWN rank names when it has them (hunter F~S, martial-arts realms, guild ranks, named magic-power grades…). Worlds often have SEVERAL ladders at once (e.g. a hunter grade AND a mana grade with its own names like Inchio < Progio < Dominus < Arcanum < Exceedus): pick the main one for "name" and line the others up in "aliases" by what the lore says they correspond to. Use the lore's numbers when it has them; otherwise design a sensible scale (ordinary person ≈ HP 100, stat 10). "desc" is required: it is how later sheets decide who belongs where.
  "elements": ["불", "물", ...],                        // elements/attributes that exist in this world (may be empty)
  "colors": {"<each world element>": "<one of: 홍염 주황 황금 노랑 연두 초록 청록 하늘 파랑 남색 보라 자주 분홍 핏빛 갈색 모래 은색 백광 회색 먹색>"},   // the colour that fits what the element IS in this world (its look, mood, the lore's imagery); different elements get different colours where possible
  "pokeMap": {"<each world element>": "<closest of the 18 Pokémon types>"},   // so the Pokémon rule set can be switched on without losing types
  "chart": {"<attacking element>": {"<defending element>": 2}},   // matchups between the elements above: 2 = strong, 0.5 = weak, 0 = no effect. Only non-neutral pairs. From the lore when it states them, otherwise sensible from what each element is. {} when there are no elements.
  "notes": "1-3 sentences on how fights work in this world (rank gaps, magic vs. tech, lethality)"`;
const RULE_NOTES = `pow=physical attack, mag=magical/special attack, def=physical defense, res=magical/mental resistance, spd=speed & evasion, acc=accuracy/perception, luk=luck & criticals.
Write names and labels in the language the lore uses.`;

/* ====================== Aux model: character sheets ====================== */
export const SHEET_SCHEMA = `{
  "name": "", "tierReason": "FIRST, one line: quote any rank the persona/card/lore/story states for them (in whatever ladder the world uses) and how it maps to the tier list — or 'no stated rank, judged from <evidence>'",
  "tier": "<one of the tier names>", "threat": "minion|normal|elite|boss",
  "hp": <max HP>, "sp": <max resource>, "stats": {<every stat key>: <number>},
  "elements": ["ALWAYS 1-2 of this world's elements (세계관 속성, from the world profile)"],
  "ptypes": ["ALWAYS 1-2 of the 18 Pokémon types (포켓몬 속성: 불꽃, 물, 풀, 전기, 얼음, 격투, 독, 땅, 비행, 에스퍼, 벌레, 바위, 고스트, 드래곤, 악, 강철, 페어리, 노말) — always fill separately from elements so the user can freely switch systems"], "weak": [], "resist": [], "immune": [],
  "archetype": "burst|combo|tank|support|trickster — the ONE plan their kit is built around",
  "trait": "intimidate|vanguard|opportunist|medic|avenger|null — at most one fixed role passive, only if it clearly fits",
  "kit": {"passive": "ONE line: the signature passive that defines how they fight (from who they are; the engine codes it)", "twists": {"<exact name of one of the skills below>": "ONE line: the extra effect that makes this skill theirs"}},   // design the kit as a whole: decide the passive FIRST, then build the skills to play into it (feed its stacks or condition, exploit it, pay it off); up to 2 twists, on signature skills only; give coefficients (scale) to skills that should use their standout stats
  "skills": [{
    "name": "", "desc": "one line: what it looks like",
    "kind": "physical|magic|heal|buff|debuff|guard|revive|cleanse",
    "power": 60, "cost": 20, "target": "enemy|enemies|ally|allies|self",
    "element": "", "hits": 1, "acc": 95, "priority": 0, "cooldown": 0,
    "status": {"id": "${STATUS_IDS}", "chance": 30, "turns": 2},
    "stages": {"pow": 1, "def": -1}, "selfStages": {"def": 1}, "selfHeal": 0,
    "recoil": 0.25, "hpCost": 10, "once": true,
    "bonusIf": {"status": "mark|burn|poison|…|any", "mul": 1.6, "consume": true} | {"selfHpBelow": 0.5, "mul": 1.4} | {"targetFullHp": true, "mul": 1.3} | {"targetCharging": true, "mul": 1.5},
    "scale": {"atk": {"pow": 0.6, "spd": 0.4}, "def": "def"} — optional coefficients, like Pokémon's Body Press / Foul Play: which of pow|mag|def|res|spd|acc|luk the skill hits with (1-2, weights sum to 1) and which target stat blocks it. Omit for a plain physical (pow vs def) or magic (mag vs res) move. Use it to make the character's distinctive stats matter: a speed-based flurry (pow+spd), a lucky shot (luk vs spd), a shield bash (def), a mental assault (mag vs res→mag vs luk)…,
    "scaleStages": "self|target|ally — optional: +12% dmg per self buff stage / target debuff stage / +8% per ally team buff stage (use sparingly on 1 signature/combo skill)",
    "pivot": true, "protect": true, "move": "front|back", "pull": true
  }],
  "passives": ["short text"], "desc": "one line",
  "lines": {"attack": "short in-character battle shout/line when using a big move (story language, <=25 chars)", "ko": "short defeat/collapse line (story language, <=25 chars)"}
}`;

const SKILL_GUIDE = `Skill design guide — rank sets the budget, the archetype sets the identity:
- Pick ONE archetype and build the kit so its skills interlock, instead of one generic damage/buff/debuff move each:
  · burst — hard hitters that PAY for it (recoil, hpCost, a self stat drop like def -1, or once per battle).
  · combo — one move APPLIES a trigger (status "mark" which lowers evasion, "blind" which lowers accuracy, "vulnerable", burn, poison, freeze…), another EXPLOITS it via bonusIf (e.g. mark → bonusIf {"status":"mark","mul":1.7,"consume":true}) or scaleStages ("self"|"target"|"ally", dmg scales with buff/debuff count — use sparingly!).
  · tank — guard/protect, shields ("shield" status = -40% dmg taken), taunt, a hit that is stronger when they are hurt (bonusIf selfHpBelow).
  · support — heals, cleanse, team buffs (target "allies" with stages/shield/regen); only weak attacks.
  · trickster — priority pokes, debuffs (blind/mark/burn/poison/freeze), pivot (hit then switch out in 1v1, or step to back row in party), pull/move (rows — party only).
- Every non-basic move needs a reason to press it NOW: a cost, a condition, a cooldown, or a setup. Avoid "same move, different number".
- Rank budget (by position in the tier list, weakest → strongest): normal attack power ≈ 60 at the lowest rank up to ≈ 105 at the highest. ONE signature move may exceed that by up to +35 and must have cooldown 3-5, a charge turn, or "once". A real price (recoil ≥ 0.25, hpCost ≥ 10, self def/res -1 or more) buys up to +15-30 power. Multi-hit: ≤3 hits, low power per hit. Area attacks ≈ 80% power. pivot moves ≈ 75% power.
- bonusIf multipliers: ≤1.6 (≤1.8 when it consumes the status, ≤1.4 for selfHpBelow/targetFullHp). "mark" lowers evasion and sets up combos; "blind" lowers accuracy; "burn" deals DoT and reduces physical dmg by 20%; "freeze" freezes (thaws on fire hit or 25%/turn); "vulnerable" = +35% dmg taken. Persistent statuses (burn/poison/bleed/freeze/sleep/regen) stay on switch; tactical/volatile ones (mark/blind/stun/taunt/shield/stages) clear on switch. Don't overload kits with too many mechanics.
- Priority moves: +1 (+2 only for upper ranks), power ≤ 50. Hard control (sleep/stun/freeze): ≤20% chance on attacks, ≤75% accuracy as a pure status move.
- At most one secondary effect per attack, on at most half of the attacks (priced effects and mark/vulnerable setups don't count). Buff/debuff skills change at most 2 stages in total. Heals ≤ 35% of max HP (≤ 50% for upper ranks). Status moves that should deal damage are kind "physical"/"magic" with a status — a "debuff" has power 0.
- Type coverage: with 3+ attacking moves, at least one uses a DIFFERENT type (or is normal/untyped) so one immunity never leaves them helpless.
- cost (Temtem-like economy): standard ≈ 15-25% of max resource, strong ≈ 30%, signature ≈ 40-45%; hpCost moves cost little resource. Regen is ~5% per turn; resting gives +20%. Basic attacks are free and automatic — do not list one.
- status ids: ${STATUS_IDS}. "stages" hit the target (or allies for buffs); "selfStages"/"selfHeal" (% of max HP) apply to the user. Omit unused fields.
- Create 2-${'${maxSkills}'} skills by default (fit the character's rank, fighting style, class, gear and the world's tropes — simpler/lower-rank fighters 2-3, seasoned/versatile fighters 4-6). Only exceed 6 skills (up to 10) if the user's description, wish list, revision instruction, or status window explicitly asks for more skills or lists more. Names in the story's language.
- The engine clamps anything over budget, so over-designing only wastes the character's slots.`;

const FAIRNESS = `Fairness rules (strict, two sides):
- CANON WINS. If the character card, the world info or the story states a character's standing (a famous assassin, a guild master, a dragon, a top-ranked hunter, "the strongest in the city"), place them at the rank that standing means in this world's tier list — read each tier's description. Do not shrink canon characters to a "safe" low rank; when evidence is thin, judge from their role in the story and pick the middle, not the bottom.
- STATED RANK IS CANON. A rank written for a character in ANY of the world's rank systems — numbered grades ("3등급"), guild/hunter ranks ("B랭크"), named magic-power grades (e.g. "프로기오", "Dominus"), realms, levels, a status window's rank field — is a fact of the world, even for the player character. Read the persona, card, description and lore for such wording, then find the tier it corresponds to by tier names, aliases, descriptions and the order of that ladder in the lore. If the tier list lacks that ladder, place the rank by its relative position (e.g. the 2nd of 5 mana grades ≈ the 2nd fifth of the tier list) and explain the mapping in tierReason.
- THE DESCRIPTION IS CANON, TOO. The persona / character description and the lorebook are the world's facts, not wishes — also for the player. Concrete facts in them set the rank: a stated rank, a title or post (captain, guild master, court mage), achievements (defeated X, survived Y), years of training or service, named powers and what they can do, how others in the world treat them.
- WISHES DON'T. Only vague praise with no concrete fact behind it ("a genius", "the strongest", "can beat anyone") and the user's wish list buy nothing: without a stated rank or concrete canon facts, a rookie is a rookie however cool the concept sounds.
- NO LOWBALLING. The bottom two tiers are only for characters the sources show as untrained, new, weak or ordinary. A trained, professional or notable fighter is at least the middle tier, higher when the facts say so. When unsure between two tiers, take the one the concrete facts support — not the lower one by default.
- STAT PERSONALITY (CRITICAL — avoid monotonous, identical numbers across same-rank characters!): Treat the tier's stat range [low–high] as the AVERAGE baseline, NOT a flat box for every stat. Give every character distinct specialization peaks (+15% to +35% above tier high on 1–2 signature stats, or +10–25% HP for tanks) balanced by genuine weak stats (-15% to -35% below tier low on 1–2 dump stats, staying above ~65% of tier low) so their OVERALL stat average stays inside the tier range. Never give same-rank characters flat, near-identical numbers (e.g. 225/235/240/245 across the board): an archmage spikes MAG/RES with visibly lower STR/DEF; a speed assassin spikes SPD with lower DEF/HP; a heavy tank spikes DEF/HP with low SPD; a bruiser spikes STR/HP with low MAG.
- Skills stay inside the rank budget.
- Nobody gets an answer to every situation (no "counters everything", no free full heals, no instant wins). Real characters have gaps: a fragile caster, a slow bruiser, a melee fighter with no ranged option.
- If the user listed skills, treat them as a WISH LIST: keep their names and flavor, but set power, priority, accuracy and effects by the rank budget, and drop or weaken anything above it.`;

/** Always separate and populate BOTH world elements and Pokémon 18 types from creation so the user can freely switch rule sets. */
const typeRule = profile => {
  const worldEl = profile.elements?.length ? profile.elements.join(', ') : '불, 물, 얼음, 전기, 바람, 대지, 어둠, 빛';
  const pokeEl = Object.values(POKE_KO).join(', ');
  return `- BOTH "elements" and "ptypes" are REQUIRED for every character (the player too), separated from creation so world elements and Pokémon types can be switched freely:
  · "elements" is REQUIRED (세계관 속성): 1-2 of THIS world's elements (${worldEl}) that fit their powers, magic, weapon or nature. Leave empty only if they truly have no attribute.
  · "ptypes" is REQUIRED (포켓몬 속성): 1-2 of the 18 Pokémon types (${pokeEl}) that fit their nature/fighting style. Only a plain human with no powers or gear is 노말.
  · Each skill's "element": ${profile.typeSystem === 'pokemon' ? `one of the 18 Pokémon types (${pokeEl}; untyped = 노말)` : `one of this world's elements (${worldEl}), or "none" for plain physical attacks`}.`;
};

export function sheetMessages({ profile, lore, persona, personaName, statFields, scene, extra, npc = false, keepSkills = '', tier = '', statedRank = '', current = null, instruction = '', feedback = '', previous = null, roster = '', card = '', own = '', brief = '', story = '', maxSkills = 6 }) {
  const skillCap = Math.max(6, Math.min(12, Number(maxSkills) || 6));
  const system = `You build combat character sheets for a turn-based engine, faithful to a roleplay world's rules and its power ranks. You are strict about balance in both directions: you neither inflate nor shrink anyone. What the character's description and the lorebook say about them is canon. Output only JSON.`;
  const who = npc ? `the character "${personaName}"` : `the player character "${personaName}" ({{user}})`;
  const user = `## Rule set
${profileText(profile)}
${brief ? `\n## World brief (this world's combat basics)\n${brief}\n` : ''}
## PRIMARY SOURCE — who ${who} is. Canon: read every line before judging rank, type and skills${tier ? `\nRank: ${tier} (FIXED by the user/world — use exactly this tier, its stat/HP ranges and its skill budget)` : ''}
${persona || '(no description)'}${statedRank ? `\n\n## STATED RANK (from the status window / story — canon, never downgrade)\n{{user}}'s rank is written as "${statedRank}". Find where this rank sits in the world (lore, brief, description) and set "tier" to the step of the tier list that matches it; quote it in "tierReason". If the lore says nothing, judge from how the world treats that title — a title the world treats as top-ranked maps to the top steps.` : ''}${own ? `\n\n### Lorebook entries about them, their abilities and their ranks (canon)\n${own}` : ''}${story ? `\n\n### What the story so far shows them doing\n${story}` : ''}
${statFields ? `\n## Their current status window (authoritative numbers — copy them)\n${JSON.stringify(statFields)}\n` : ''}${keepSkills ? `\n## The user's wished-for concept and skills (a WISH LIST — keep names and flavor, but every number follows the rank budget)\n${keepSkills}\n` : ''}${lore ? `\n## World info (general rules, ranks, places — for context)\n${lore}\n` : ''}${card ? `\n## Character card (${npc ? 'canon setting — may describe this character' : 'the world and the other main character — may mention {{user}}'})\n${card}\n` : ''}${scene ? `\n## Recent story\n${scene}\n` : ''}${extra ? `\n## Extra instructions\n${extra}\n` : ''}${roster ? `\n## Characters already registered in this world (keep strength consistent: same rank ≈ similar HP, stats and skill power; higher rank clearly stronger)\n${roster}\n` : ''}${current ? `\n## Current sheet — revise it; keep everything the request does not mention\n${sheetText(current, profile)}\n` : ''}${feedback ? `\n## The user's feedback on the last version — it came out wrong. Build a NEW sheet from the sources above that fixes this (the rank budget and fairness rules still apply)\n${feedback}${previous ? `\nLast version (for reference only, do not copy it):\n${sheetText(previous, profile)}` : ''}\n` : ''}${instruction ? `\n## Revision request from the user (follow it, but the rank budget and fairness rules still apply)\n${instruction}\n` : ''}
## Task
Answer with ONE JSON object in this shape:
${SHEET_SCHEMA}
- Use the status window's numbers when given. Otherwise write "tierReason" first: quote the lines of the PRIMARY SOURCE (description, their lorebook entries, the story) that show their rank or strength, map them to the tier list, then pick values inside that tier's ranges.
- The PRIMARY SOURCE outranks everything else in this prompt. Skills, type and fighting style come from what it describes (named techniques, magic, weapons, training), not from generic tropes.
${!npc ? '- CRITICAL FOR {{user}}: If the Player persona above explicitly states a rank, grade, tier, circle, level, or standing, you MUST match "tier" and stats to that exact rank — NEVER downgrade an explicitly stated rank to a lower/beginner tier.' : ''}
- If the status window lists skills, turn each into a skill entry with fitting mechanics (keep its name).
${typeRule(profile)}
${FAIRNESS}
${SKILL_GUIDE.replace('${maxSkills}', skillCap)}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: finding the main cast ====================== */
export function castMessages({ profile, personaName, persona, character, lore, history, existing = [], limit = 4, includePlayer = true, brief = '' }) {
  const system = 'You read a roleplay setup and its story so far, find the characters who matter in fights, and build a fair combat sheet for each, faithful to the world\'s ranks. Output only JSON.';
  const user = `## Rule set (ranks)
${profileText(profile)}
${brief ? `\n## World brief (this world's combat basics)\n${brief}\n` : ''}
## PRIMARY SOURCE — the player ({{user}} = "${personaName}"), canon description
${persona || '(no description)'}

## Character card(s)
${character || '(none)'}

${lore ? `## World info about people\n${lore}\n` : ''}
## Story so far (most recent last)
${history || '(no messages yet)'}

## Already registered (skip these; use them as the scale for everyone else's rank)
${existing.length ? existing.join('\n') : '(none)'}

## Task
Find ${includePlayer ? 'the player and ' : ''}up to ${limit} other named characters who are likely to fight with or against {{user}}: companions, rivals, recurring enemies, bosses — the most important first. Skip background extras and anyone already registered.
For EACH of them write a complete combat sheet right away (they are registered directly; the user can reroll or delete any of them afterwards).
Answer with ONE JSON object:
{"more": true/false (are there more important characters left after these?), "characters": [
  {"role": "player|companion|rival|enemy|boss|npc", "aliases": ["other names"],
   "concept": "2-3 sentences in the story's language: fighting style, weapon/element, notable techniques actually shown or stated",
   "why": "one short line: where they matter",
   ...<sheet fields>}
]}
<sheet> = ${SHEET_SCHEMA}
${includePlayer ? '- The player entry comes first with role "player".' : '- The player is already done; do not list them.'}
- "name" is the exact name used in the story. Write "tierReason" before "tier" for every character.
- Keep sheets compact: 2-6 skills each (fit each character's complexity and rank), short descs.
${typeRule(profile)}
${FAIRNESS}
${SKILL_GUIDE.replace('${maxSkills}', 6)}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: forging an encounter ====================== */
export const DIFFICULTY = {
  easy: { ko: '쉬움', ai: 'normal', stance: 'Difficulty EASY: encounters are fair and readable, a little below the strength of {{user}}. No ambush on the player unless the story clearly demands it; no stacked hostile terrain.' },
  normal: { ko: '기본', ai: 'hard', stance: 'Difficulty NORMAL: an even fight for the strength of {{user}} — winnable with sensible play, with real risk. Enemies ambush or set traps when it fits the scene, and places give hostile terrain when they would have it.' },
  hard: { ko: '어려움', ai: 'hard', stance: 'Difficulty HARD: dangerous for the strength of {{user}} but winnable with tactics: enemies at the upper end of the range of {{user}} (a leader may be one rank higher), coordinated (attackers plus a support/healer, rows used well, a charger to interrupt). Use ambush or hostile terrain when plausible.' },
  nightmare: { ko: '악몽', ai: 'brutal', stance: 'Difficulty NIGHTMARE: the fight is stacked against {{user}}. Enemies exploit the party\'s weaknesses — choose enemy types and skills that hit the party\'s weak types and resist its main attack types, target its fragile members, and disable its healer. Prefer ambushes ("initiative": "enemy") and terrain that hurts the party. Enemies are as strong as the setting can justify; bosses one rank higher.' },
};

export function forgeMessages({ profile, lore, scene, party, hint, inventory, modes = ['party', 'duel', 'stealth'], codex = '', difficulty = 'normal', brief = '' }) {
  const system = `You are the game master's referee. You turn the story's situation into an honest game encounter for a rules engine. You do not care whether the player wins. Output only JSON.`;
  const modeGuide = {
    party: '"party": a group fight or any fight against monsters/several enemies; turn-based with skills, rows and enemy intents.',
    duel: '"duel": a 1-on-1 battle with Pokémon singles rules: one fighter per side at a time, others wait and can be switched in (rival match, duel, sparring, a trainer/summoner with a team, a boss fight against one foe). "enemies" is their team in send-out order.',
    stealth: '"stealth": a grid puzzle — the player is sneaking past guards to a goal ("variant": "sneak") or fleeing pursuers to an exit ("variant": "chase"). Up to 4 guards walk the map; extra enemies wait elsewhere and join if the alarm goes off. Being caught turns it into a party fight.',
  };
  const user = `## Rule set
${profileText(profile)}
${brief ? `\n## World brief (this world's combat basics)\n${brief}\n` : ''}
${lore ? `## World info for the named characters/places in this scene — read carefully, they keep this canonical strength\n${lore}\n` : ''}
## The player's side (the yardstick for ordinary enemies)
${party}
Inventory: ${inventory || '(empty)'}

## Recent story (oldest first)
${scene || '(none)'}
${hint ? `\n## Encounter hint from the story\n${hint}\n` : ''}
## Task
A confrontation is starting in the latest scene. Answer with ONE JSON object:
{
  "mode": "${modes.join('|')}",
  "variant": "sneak|chase",            // stealth only
  "why": "one line: why this mode",
  "title": "short name", "place": "where", "flee": true,
  "initiative": "player|enemy|normal",
  "outmatched": false,                 // true only with a canon reason the foe outclasses {{user}} (see rules)
  "outmatchedWhy": "",
  "terrain": [{"desc": "short description", "side": "all|ally|enemy", "stages": {"acc": -1}}],
  "enemies": [ <sheet> + {"row": "front|back", "intel": 0|1|2, "style": "aggressive|defensive|tricky|balanced|berserker"} ],   // AT MOST 8 — a bigger crowd is described in "why" and fielded as its 8 most dangerous members (or one "swarm" entry)
  "allies": [ <sheet> or {"ref": "<registered name>"} ],   // AT MOST 4 besides {{user}}   // who REALLY fights beside the player right now (party mode). Read the recent story: only characters present in the scene and on the player's side. Registered characters → {"ref"}. Nobody there → []
  "goal": "stealth: what the player must reach or do",
  "stones": 2,                         // stealth: pebbles to throw as distractions (0-5)
  "loot": ["what could really be gained"]
}
<sheet> = ${SHEET_SCHEMA}

## Modes
${modes.map(m => `- ${modeGuide[m]}`).join('\n')}
${codex ? `\n## Registered characters (stats and skills are already stored)\n${codex}\nIf one of them takes part, write only {"ref": "<name>", "row": "front|back"} for them instead of a sheet. Decide each one's side from the story (an ally in the scene goes in "allies", a rival or villain in "enemies"); characters not in the scene do not appear. "travelling with {{user}} lately" means they usually join if the story has them nearby. Knocked-out characters cannot fight.\nFor a NEW important named character who may appear again, write a full sheet and add "named": true so it gets registered.\n` : 'For an important named character who may appear again, add "named": true to their sheet so it gets registered.'}

## Honesty rules — the most important part
- ${(DIFFICULTY[difficulty] ?? DIFFICULTY.normal).stance}
- SCALE ORDINARY ENEMIES TO {{user}}. Thugs, guards, wild monsters, rivals and unnamed foes use ranks around {{user}}'s own: mooks one rank lower or equal, regulars equal, a leader at most one higher — adjusted by the difficulty above. Numbers come from that rank, not from how scary the scene sounds.
- Go clearly beyond {{user}}'s strength ONLY when the scene or lore SPECIFICALLY establishes it: a named character whose canon rank is higher, a place the lore says holds higher-rank monsters, or the story stating {{user}} is outmatched. Then add "outmatched": true and "outmatchedWhy": "<the canon fact>". Without such a fact, never build an overwhelming fight — "it felt dramatic" is not a reason.
- Weaker-than-{{user}} fights are fine when the scene is clearly minor (a drunk, a pickpocket).
- Named characters keep their canonical strength from their world info. Nameless mooks and wild monsters: judge from the scene and the rule set's tiers.
- Enemies fight intelligently with what they really have: real skill sets, sensible rows (fragile casters/archers in the back), real weaknesses only if they make sense.
- initiative: "player" only if the player prepared an ambush, approached unseen or struck first; "enemy" if the player walked into a trap, ignored warnings or was careless; otherwise "normal".
- intel per enemy: 2 = the player scouted/analysed it or it is famous in the lore; 1 = seen clearly; 0 = unknown, hidden, never seen before.
- terrain: real environmental factors from the scene (darkness, rain, high ground, narrow corridor, cover). stages are -1..+1 on pow, mag, def, res, spd, acc, eva for the side that benefits or suffers. Usually 0-2 entries.
- Preparation counts: traps the player set, buffs taken, intel gathered, allies brought — reflect them in initiative, terrain, intel and allies.
${SKILL_GUIDE.replace('${maxSkills}', 6)}
- Enemies follow the same rank budget (a boss may use one rank higher). Their rank comes from what they are in this world, not from the player's rank.
- Mode flavor: in "duel" give the opponent mind-game tools (a protect/guard move, a pivot move if it has teammates, a big move that needs reading); in "party" make the group play as a unit — a front-row tank (trait vanguard or a taunt), a back-row damage dealer or healer, and moves that combo (one applies mark/vulnerable/burn, another exploits it), or a charger the player can break.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * Lightweight Step-1 encounter planner: reads ONLY recent chat history + short codex names
 * (NO lorebook dump!) and classifies each participant into:
 * - "codex": already registered in codex → reuse stored sheet immediately
 * - "mook": generic minion/monster/unnamed enemy → build compact sheet directly here
 * - "major": important named character NOT yet in codex → return name/aliases/concept only;
 *            Step 2 will look up only their lorebook entries, generate a proper sheet, and register them in codex.
 */
export function planMessages({ profile, scene, party, hint, inventory, modes = ['party', 'duel', 'stealth'], codex = '', difficulty = 'normal', brief = '' }) {
  const system = 'You are the game master\'s referee. Read ONLY the latest scene and plan who enters the fight right now. Reuse registered characters, build generic mobs inline, and flag any unregistered important named characters so the engine can fetch their lore and register them in the codex. Output only JSON.';
  const modeGuide = {
    party: '"party": a group fight or any fight against monsters/several enemies; turn-based with skills, rows and enemy intents.',
    duel: '"duel": a 1-on-1 battle with Pokémon singles rules: one fighter per side at a time, others wait and can be switched in (rival match, duel, sparring, boss fight against one foe). "enemies" is their team in send-out order.',
    stealth: '"stealth": a grid puzzle — sneaking past guards ("variant": "sneak") or fleeing pursuers ("variant": "chase"). Up to 4 guards walk the map; extra enemies join if caught.',
  };
  const mookSchema = `{"kind": "mook", "name": "generic name", "count": 1, "threat": "minion|normal|elite", "tier": "<tier name>", "hp": <num>, "sp": <num>, "stats": {<stat keys>}, "elements": ["1-2 world elements"], "ptypes": ["1-2 Pokémon types"], "row": "front|back", "intel": 0|1|2, "style": "aggressive|defensive|tricky|balanced|berserker", "skills": [{"name": "", "desc": "short", "kind": "physical|magic|heal|buff|debuff|guard", "power": 60, "cost": 20, "target": "enemy|enemies|ally|allies|self", "element": "", "acc": 95, "status": {"id": "${STATUS_IDS}", "chance": 30, "turns": 2}, "stages": {"pow": 1}}], "desc": "one short line"}`;
  const user = `## Rule set
${profileText(profile)}
${brief ? `\n## World brief\n${brief}\n` : ''}
## The player's side
${party}
Inventory: ${inventory || '(empty)'}
${codex ? `\n## Registered codex characters (stats/skills already saved — NEVER rewrite their sheet!)\n${codex}\n` : ''}
## Recent story (oldest first)
${scene || '(none)'}
${hint ? `\n## Encounter hint\n${hint}\n` : ''}
## Task
Read the latest scene and decide who is actually fighting right now. Answer with ONE JSON object:
{
  "mode": "${modes.join('|')}",
  "variant": "sneak|chase",
  "why": "one line: why this mode",
  "title": "short name", "place": "where", "flee": true,
  "initiative": "player|enemy|normal",
  "outmatched": false, "outmatchedWhy": "",
  "terrain": [{"desc": "short description", "side": "all|ally|enemy", "stages": {"acc": -1}}],
  "enemies": [ <codexRef> | <mookSheet> | <majorRef> ],   // AT MOST 8
  "allies": [ <codexRef> | <mookSheet> | <majorRef> ],    // AT MOST 4 besides {{user}}
  "goal": "stealth only",
  "stones": 2,
  "loot": ["what could really be gained"]
}

## Participant formats — pick the RIGHT kind for each person/enemy in the scene
1. Already in the Registered codex list above → <codexRef>:
   {"kind": "codex", "ref": "<exact registered name>", "row": "front|back"}
   (Do NOT include stats or skills. Only include characters physically present in this scene; knocked-out characters cannot fight.)
2. Generic mob / unnamed soldier / wild monster / minor extra → <mookSheet>:
   ${mookSchema}
   (Use "count": 2..5 for identical mobs instead of repeating entries. Give 2-4 fitting skills; basic attack is automatic.)
3. Unregistered IMPORTANT NAMED character (named rival, named boss, recurring NPC, named companion who matters to the story and is NOT in the codex list above) → <majorRef>:
   {"kind": "major", "name": "<exact name>", "aliases": ["other names/titles"], "threat": "normal|elite|boss", "row": "front|back", "intel": 1|2, "style": "aggressive|defensive|tricky|balanced|berserker", "concept": "1-2 sentences: what the scene shows about their role, weapons, powers and apparent strength"}
   (Do NOT invent full stats/skills for "major" — the engine will look up their lorebook entry and register them into the codex next!)

## Modes
${modes.map(m => `- ${modeGuide[m]}`).join('\n')}

## Rules
- ${(DIFFICULTY[difficulty] ?? DIFFICULTY.normal).stance}
- Scale ordinary mooks/monsters to {{user}} per the difficulty above. Do NOT mark unnamed mobs as "major".
- Put only characters actually fighting alongside {{user}} in "allies" (empty [] when alone).
- ${typeRule(profile)}
- Keep mook skill counts compact (2-4 skills, power within tier budget).`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: tracking condition & growth between fights ====================== */
export function stateMessages({ status, inventory, text, recent = '', codex = '', profile = null }) {
  const system = 'You keep a roleplay party and registered characters up to date, like a fair game master. Read one story passage and output only the concrete state or growth changes it implies. Output only JSON.';
  const tiers = profile?.tiers?.length ? `Tiers: ${profile.tiers.map(t => t.name).join(' < ')}` : '';
  const stats = profile?.stats?.length ? `Stats: ${profile.stats.map(s => s.key).join(', ')}` : '';
  const user = `## Party now (authoritative numbers)
${status}
Bag: ${inventory || '(empty)'}
${codex ? `\n## Registered codex characters (may grow/change in the story)\n${codex}\n` : ''}${tiers || stats ? `\n## Rule set\n${[tiers, stats].filter(Boolean).join(' · ')}\n` : ''}${recent ? `\n## Just before\n${recent}\n` : ''}
## New story passage
${text}

## Task
Did this passage change anyone's HP, resource, status, items, stats, rank, skills, or companions OUTSIDE a battle? Answer with ONE JSON object:
{"changes": ["<lines in this syntax>"], "why": "one short line"}
Line syntax (who defaults to {{user}}; put a companion's name first to target them):
  hp: full | +30% | -15% | +120 | Name +40%
  sp: full | +40% | -30% | Name full
  status: clear | Name clear
  item: Item name -1 | Item name +2
  stat: STR +2 | AGI +1
  skill: Skill name: physical 70 fire (short desc)
  upgrade: Skill name power +10 | Companion Skill name power +5 cost -2
  join: Name | tier <tier>
  leave: Name
  npc: RegisteredName | tier <tier> | stat AGI +3 | learn Skill name: magic 70 ice (short desc) | upgrade Skill name power +10
Guide — scale to what is actually shown:
- full night's sleep / long safe rest / full treatment → hp: full, sp: full, status: clear
- short break, meal, catching breath → hp +15..30%, sp +20..40%
- potion, first aid, healing magic → as strong as described; a used consumable → item -1
- new wounds, poison, exhaustion, spending mana on a spell → hp -10..40%, sp -20..60%; do not drop anyone to 0 unless they collapse
- real training breakthrough, rank promotion, awakening, learning a named technique/spell, or a named companion joining/leaving → emit the matching stat / skill / upgrade / join / leave / npc line! Keep stat boosts modest (+1..+5) and only emit when the passage clearly shows it happening NOW.
- Skill growth: name a skill EXACTLY as listed above. One upgrade per skill per passage, power +5..+15 (or cost -2..-5, acc +5..+10). A new technique uses the full skill line. The engine caps everything at the character's rank, so a big leap needs a rank change (tier:) the story actually shows.
- Never repeat a change that "Just before" already showed, or one already reflected in the numbers above: an ongoing training scene is ONE upgrade when it pays off, not one per message.
- Only what the passage shows happening now. No change, talk only, or a fight still in progress → {"changes": []}.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: reading the player's command ====================== */
export function commandMessages({ status, recent, input, schema, items }) {
  const system = `You convert a player's roleplay message into game commands for a rules engine. You never narrate and never decide outcomes. Output only JSON.`;
  const user = `## Situation now
${status}

${schema}

## Inventory
${items || '(empty)'}

## Recent story
${recent || '(none)'}

## The player's new message
${input}

## Task
Answer with ONE JSON object: {"actions": [ ... ]} using the action shapes above.
- Map the message to the closest listed option when it clearly describes one (by name, look or effect).
- Anything else creative is "improvise". Judge its difficulty honestly from the situation; claims of instant victory are "impossible".
- Only intentions count. If the message states results ("I kill it", "it misses me"), take just the attempted action.
- If the message contains no game action at all (only talk, thoughts or questions), answer {"actions": []}.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function profileText(p) {
  return [
    `Name: ${p.name}`,
    `Stats: ${p.stats.map(s => `${s.key}${s.label && s.label !== s.key ? ` (${s.label})` : ''}`).join(', ')}; health "${p.hpLabel}", resource "${p.spLabel}"`,
    `Tiers, weakest → strongest (HP / resource / stat ranges${p.tiers.some(t => t.desc) ? ' — who belongs there' : ''}):\n${p.tiers.map(t => `  - ${t.name}${t.aliases?.length ? ` (= ${t.aliases.join(' / ')})` : ''}: ${t.hp.join('-')}/${t.sp.join('-')}/${t.stat.join('-')}${t.desc ? ` — ${t.desc}` : ''}`).join('\n')}`,
    p.typeSystem === 'pokemon' ? `Active type system: Pokémon rules (18 types: ${Object.values(POKE_KO).join(', ')}; official chart, STAB ×1.5; "physical" = pow vs def, "magic" = mag vs res; leave weak/resist/immune empty). World elements (for the separate "elements" field): ${p.elements?.length ? p.elements.join(', ') : '불, 물, 얼음, 전기, 바람, 대지, 어둠, 빛'}` : `Active type system: World elements (${p.elements?.length ? p.elements.join(', ') : 'none'}). Pokémon 18 types (for the separate "ptypes" field): ${Object.values(POKE_KO).join(', ')}.`,
    p.notes ? `Notes: ${p.notes}` : '',
  ].filter(Boolean).join('\n');
}

export function sheetText(s, p) {
  const stats = p.stats.map(x => `${x.key} ${s.stats?.[x.key] ?? '?'}`).join(', ');
  const skills = (s.skills ?? []).map(k => `${k.name}(${k.kind}${k.power ? ` ${k.power}` : ''}, ${k.cost}${p.spLabel})`).join('; ');
  return `- ${s.name}${s.tier ? ` [${s.tier}]` : ''}: ${p.hpLabel} ${s.hp}/${s.maxHp}, ${p.spLabel} ${s.sp}/${s.maxSp}, ${stats}${skills ? ` | skills: ${skills}` : ''}`;
}

/* ====================== Main model injections ====================== */
const COMMON_RULES = (opts) => [
  '- These results are FINAL. Do not add, remove, soften or change any hit, miss, damage, knockout, status effect, detection or escape. Invent no extra actions or turns.',
  '- Write them as one continuous, vivid scene in the story\'s language and style. Add sensory detail, emotion, dialogue and cries; keep exact numbers out of the prose.',
  opts.statusWindow ? '- If your format includes a status window, use the exact HP/SP values listed below for {{user}}.' : '',
  '- Do not decide {{user}}\'s next move.',
].filter(Boolean);

const MODE_RULES = {
  party: ['- Match the force of each hit to the damage dealt. Show weaknesses, resistances, critical hits, parries and broken charges in how they land.'],
  duel: ['- This is a 1-on-1 battle: only one fighter per side on the field at a time. Show switches and send-outs clearly.'],
  stealth: ['- Keep the tension of sneaking or fleeing. Show how close {{user}} came to being noticed or caught, without numbers.'],
};
const HINT_RULE = {
  party: '- End by foreshadowing what the enemies are visibly preparing, as listed under [Next], so {{user}} can react. Hidden details stay hidden.',
  duel: '- End with both fighters squaring off, waiting for the next command. If [Next] gives the opponent\'s body language, show it as a subtle tell — never name the move.',
  stealth: '- End by showing what the guards or pursuers appear to be doing next, as listed under [Next] (if known).',
};

function statusBlock(b, profile) {
  const M = modeOf(b.mode);
  return M.status(b.st, profile, { lang: 'en' });
}

export function turnPrompt(entry, b, profile, opts = {}) {
  const ended = b.status !== 'active';
  const M = modeOf(b.mode);
  const lines = eventLines(entry.events, { lang: 'en', showRolls: false });
  const next = ended ? '' : M.nextHint(b.st, 'en');
  return [
    '<battle_engine>',
    `[An external rules engine resolves this encounter (${M.id}). This turn has ALREADY been decided:]`,
    ...lines,
    '',
    '[State after this turn]',
    statusBlock(b, profile),
    ...(next ? ['', '[Next]', next] : []),
    '',
    '[How to write this response]',
    ...COMMON_RULES(opts),
    ...(MODE_RULES[b.mode] ?? []),
    ended ? endRule(b) : HINT_RULE[b.mode] ?? HINT_RULE.party,
    '</battle_engine>',
  ].join('\n');
}

function endRule(b) {
  const r = {
    win: 'The encounter is WON. Show the final moment, then the aftermath.',
    success: b.mode === 'stealth' ? 'The player SUCCEEDED: reached the goal or lost the pursuers unseen. Show it.' : 'The encounter is won.',
    lose: 'The encounter is LOST: {{user}}\'s side has fallen. Show the defeat and its consequence (capture, rescue, retreat, waking up later…) without killing {{user}}.',
    fled: 'The party ESCAPED or withdrew. Show the getaway.',
    stopped: 'The confrontation stops here.',
  }[b.status] ?? 'The encounter is over.';
  const loot = b.loot?.length && ['win', 'success'].includes(b.status) ? ` Possible spoils: ${b.loot.join(', ')}.` : '';
  return `- ${r}${loot} After this, the story continues normally.`;
}

export function startPrompt(b, profile, opts = {}) {
  const M = modeOf(b.mode);
  const threat = b.threat?.level ? THREAT_LABEL[b.threat.level] : null;
  const threatEn = { overwhelming: 'overwhelming — the enemy far outclasses {{user}}', dangerous: 'dangerous', even: 'an even match', favorable: 'in {{user}}\'s favor', trivial: 'trivial' }[b.threat?.level];
  const opening = b.opening?.length ? ['', '[Ambush — this already happened before {{user}} could act]', ...eventLines(b.opening, { lang: 'en', showRolls: false })] : [];
  const next = M.nextHint(b.st, 'en');
  return [
    '<battle_engine>',
    `[A ${{ party: 'battle', duel: 'one-on-one duel', stealth: b.st.variant === 'chase' ? 'chase' : 'stealth infiltration' }[b.mode]} begins${b.title ? `: ${b.title}` : ''}${b.place ? ` at ${b.place}` : ''}. An external rules engine resolves it turn by turn.]`,
    statusBlock(b, profile),
    threat && opts.showThreat !== false ? `Honest threat assessment: ${threatEn}. Convey this danger truthfully through the scene.` : '',
    ...opening,
    ...(next ? ['', '[Next]', next] : []),
    '',
    '[How to write this response]',
    opening.length ? '- Narrate the ambush exactly as listed above, then stop.' : '- Nothing has been resolved yet. Do not resolve any attack or detection. Set the scene and the stakes, then stop.',
    HINT_RULE[b.mode] ?? HINT_RULE.party,
    opts.statusWindow ? '- If your format includes a status window, use the exact HP/SP values above for {{user}}.' : '',
    '- Then let {{user}} choose what to do.',
    '</battle_engine>',
  ].filter(Boolean).join('\n');
}

export function idlePrompt(b, profile, opts = {}) {
  const M = modeOf(b.mode);
  const next = M.nextHint(b.st, 'en');
  return [
    '<battle_engine>',
    '[An encounter is in progress, resolved by an external rules engine. {{user}}\'s last message contained no game action, so no turn was played.]',
    statusBlock(b, profile),
    ...(next ? ['', '[Next]', next] : []),
    '',
    '- Respond to what {{user}} said or did, but resolve no attack, damage, detection or escape. Opponents may posture, taunt or circle; nothing lands. Then wait for {{user}}\'s action.',
    opts.statusWindow ? '- If your format includes a status window, use the exact HP/SP values above for {{user}}.' : '',
    '</battle_engine>',
  ].filter(Boolean).join('\n');
}

/** Always-on rule: major fights go through the engine; the main model never settles them in prose. Kept short — it rides on every message. */
const FIGHT_DISCIPLINE = mode => [
  '[Combat discipline — highest priority, overrides style instructions]',
  `- MAJOR fights (a named character, a foe not clearly weaker than {{user}}, real risk of injury/capture/death, or story stakes) are never resolved in prose: write the build-up and stop right before the first blow${mode === 'manual' ? ' ({{user}} starts the engine)' : mode === 'main' ? ', then add the <bt-battle> block' : ', then add the <bt-start> tag'}. No hits, misses, wounds, KOs, escapes, captures or winners.`,
  '- No skipping past a fight ("after a fierce battle…", "moments later they lay defeated", fights ending off-screen). Never decide the actions or injuries of {{user}}.',
  '- Only harmless scuffles may be narrated briefly. A result from the engine is final.',
];

export function worldPrompt({ mode, player, party, profile, statusWindow, changes, lastResult, registered = [], inventory = [], fightGuard = true, brief = '' }) {
  const out = ['<battle_engine>'];
  if (mode === 'main') {
    out.push('[Fights in this story are resolved by an external turn-based dice engine.]',
      'When a fight is about to begin, write the build-up, stop before the first blow and end with one block:',
      '<bt-battle>', 'mode: party|duel|stealth', 'place: where', 'flee: yes|no', 'initiative: player|enemy|normal', 'enemy: Name | tier <tier> | threat minion|normal|elite|boss | row front|back | skills A, B', 'ally: Name | tier <tier> (NPCs fighting beside {{user}})', 'goal: (stealth) what {{user}} must reach', '</bt-battle>',
      `Enemies come from the scene and the lore. Tiers: ${profile.tiers.map(t => t.name).join(', ')}. One enemy line per combatant — at most 8 enemies and 4 allies.`);
  } else if (mode === 'hybrid') {
    out.push('[Fights in this story are resolved by an external turn-based dice engine.]',
      'When a confrontation is about to begin (fight, ambush, duel, sneaking past enemies, a chase) — or the scene is ALREADY dangerous — write the build-up, stop before the first blow or step, and end the response with its own line:',
      '<bt-start>who is involved and what kind of confrontation, in a few words</bt-start>',
      'e.g. …the bandits draw their blades.\n<bt-start>3 bandits ambush {{user}} at the cart</bt-start>');
  } else if (mode === 'manual' && fightGuard) {
    out.push('[Fights in this story are resolved by an external turn-based dice engine that {{user}} starts by hand.]');
  }
  if (fightGuard) out.push('', ...FIGHT_DISCIPLINE(mode));
  if (brief) out.push('', '[World combat notes — keep consistent]', String(brief).trim().slice(0, 700));
  if (player) {
    out.push('', `[{{user}}'s condition — authoritative${statusWindow ? '; use these exact HP/SP values in any status window' : ''}]`, fighterLine(player, profile, { lang: 'en' }));
    for (const c of party ?? []) out.push(fighterLine(c, profile, { lang: 'en' }));
    out.push(`Bag: ${inventory.filter(i => i.count > 0).map(i => `${i.name} ×${i.count}`).join(', ') || '(empty)'}`);
  }
  if (changes) {
    out.push('', 'Outside battle, when the story changes HP/SP, status, items, stats or skills, end with a <bt-change> block (only new changes, amounts matching the scene: long rest → hp/sp full + status: clear; short break +15..30%; potion/healing as described; wounds/exhaustion -10..40%, never 0 unless they collapse; companions: hp: Name +30%):',
      '<bt-change>', 'hp: +30% | -50 | full', 'sp: full | -40%', 'status: clear', 'item: Name +1', 'stat: STR +2', 'skill: Name: physical 60 <type> (what it does)', 'upgrade: Name power +10', 'join: Name | tier <tier>', 'leave: Name',
      'npc: Name | stat AGI +5 | learn Skill: magic 70 <type> | tier B', '</bt-change>');
  }
  if (registered.length) out.push('', `[Registered characters (stats kept by the engine): ${registered.join(', ')}]`);
  if (lastResult) out.push('', `[Last battle: ${lastResult}]`);
  out.push('</battle_engine>');
  return out.length > 2 ? out.join('\n') : '';
}

/* ====================== Panel-mode prompts ====================== */
const KEY_EVENTS = new Set(['down', 'parry', 'break', 'charge', 'finisher', 'broken', 'rout', 'yield', 'flee', 'takedown', 'detected', 'transition', 'improv', 'revive', 'enrage', 'lost', 'surprised', 'end', 'scan', 'swap', 'combo', 'protected', 'endure', 'switch', 'passive']);
const GUIDE_AMOUNT = [
  { upTo: 3, text: 'Show every action in order: the move, the impact, and how everyone reacts.' },
  { upTo: 10, text: 'In each clash, show the one or two actions that decided it in full; keep the exchanges between to a line or two. Give every knockout at least a sentence.' },
  { upTo: Infinity, text: 'Pick the two or three most dramatic moments and show only those in full. Cover the rest in order, a sentence or two per phase, letting the highlights carry the fatigue and wounds of the long fight.' },
];

/** Decisive moments of a finished panel battle, compact enough for one prompt. */
export function keyMoments(b, max = 28) {
  // Short fights: hand over everything (the player's own moves matter). Long fights: decisive moments only.
  const full = (b.history ?? []).map(h => {
    const lines = eventLines(h.events.filter(e => !['turn', 'dot', 'expire', 'alert', 'distance'].includes(e.t)), { lang: 'en', showRolls: false }).map(l => l.trim());
    return lines.length ? `Turn ${h.turn}: ${lines.join(' ')}` : null;
  }).filter(Boolean);
  if (full.join(' ').length <= 3500) return full;
  const out = [];
  for (const h of b.history ?? []) {
    const lines = [];
    let lastUse = null;
    for (const e of h.events) {
      if (e.t === 'use' || e.t === 'stances' || e.t === 'sact') { lastUse = e; continue; }
      const big = e.t === 'hit' && (e.crit || ['super', 'weak', 'immune'].includes(e.eff) || e.from - e.to >= 30 || e.note === 'finisher' || e.guarded === 'block');
      const st = e.t === 'status';
      if (!(KEY_EVENTS.has(e.t) || big || st || (e.t === 'clash' && !['nothing', 'standoff'].includes(e.kind)))) continue;
      if (lastUse) { const l = eventLine(lastUse); if (l) lines.push(l.trim()); lastUse = null; }
      const l = eventLine(e);
      if (l) lines.push(l.trim());
    }
    if (lines.length) out.push(`Turn ${h.turn}: ${lines.join(' ')}`);
  }
  if (out.length <= max) return out;
  const keep = out.filter((l, i) => i === 0 || i === out.length - 1 || /DOWN|BROKEN|FINISH|DISCOVERED|CAUGHT|BATTLE OVER|YIELDS/.test(l));
  return keep.length <= max ? keep : [...keep.slice(0, max - 1), keep.at(-1)];
}
const eventLine = e => eventLines([e], { lang: 'en', showRolls: false })[0] ?? '';

/** Full turn-by-turn log for the "full" detail level. */
export function fullLog(b) {
  return (b.history ?? []).map(h => {
    const lines = eventLines(h.events.filter(e => !['turn', 'expire'].includes(e.t)), { lang: 'en', showRolls: false }).map(l => l.trim());
    return lines.length ? `Turn ${h.turn}:\n  ${lines.join('\n  ')}` : null;
  }).filter(Boolean);
}

/**
 * detail: 'result' (outcome + final state only) | 'summary' (key moments) | 'full' (every event).
 */
export function summaryPrompt(b, profile, opts = {}) {
  const M = modeOf(b.mode);
  const detail = ['result', 'summary', 'full'].includes(b.resultDetail) ? b.resultDetail : opts.detail ?? 'summary';
  const turns = Math.max(1, (b.st.turn ?? 2) - 1);
  const amount = GUIDE_AMOUNT.find(g => turns <= g.upTo).text;
  const kind = { party: 'battle', duel: '1-on-1 battle', stealth: b.st.variant === 'chase' ? 'chase' : 'infiltration' }[b.mode];
  const outcome = ({ win: 'VICTORY', success: 'SUCCESS', lose: 'DEFEAT', fled: 'ESCAPED', stopped: 'STOPPED' })[b.status] ?? b.status;
  const body = detail === 'result' ? [] : detail === 'full'
    ? ['', '[Full battle log, in order]', ...fullLog(b)]
    : ['', '[Key moments, in order]', ...(keyMoments(b).length ? keyMoments(b) : ['(no decisive moments recorded)'])];
  const howMuch = detail === 'result'
    ? '- Only the outcome is given. Write the confrontation briefly in a few vivid sentences that lead to this outcome and the final condition above, without inventing specific decisive blows beyond what the final state implies.'
    : detail === 'full' ? `- The full log is given. Follow it faithfully, but write it as a scene, not a list. ${amount}` : `- ${amount}`;
  return [
    '<battle_engine>',
    `[{{user}} just played out this ${kind} in the game screen. Everything below is the final, authoritative result.]`,
    `${b.title ? `"${b.title}"` : 'Encounter'}${b.place ? ` at ${b.place}` : ''} — ${turns} turns — Outcome: ${outcome}`,
    ...body,
    '',
    '[Final state]',
    M.status(b.st, profile, { lang: 'en' }),
    b.loot?.length && ['win', 'success'].includes(b.status) ? `Possible spoils: ${b.loot.join(', ')}` : '',
    '',
    '[How to write this response]',
    '- Write the whole confrontation as one continuous scene in the story\'s language and style, not a turn-by-turn list.',
    howMuch,
    '- The outcome and everything listed above are FINAL. Add nothing that contradicts them; keep exact numbers out of the prose.',
    detail !== 'result' ? '- Match the force of each hit to how much it took. Show super-effective hits, stat changes, parries, broken charges and finishing blows vividly.' : '',
    '- Let every combatant\'s feelings show at the key moments; respond to whatever {{user}} wrote in their message.',
    b.status === 'lose' ? '- {{user}}\'s side lost. Show the defeat and its consequence (capture, rescue, retreat, waking up later…) without killing {{user}}.' : '- End with the aftermath, then let the story continue.',
    opts.statusWindow ? '- If your format includes a status window, use the exact HP/SP values above for {{user}}.' : '',
    '</battle_engine>',
  ].filter(x => x !== '').join('\n');
}

export function panelWaitPrompt(b, profile, opts = {}) {
  return [
    '<battle_engine>',
    `[A ${{ party: 'battle', duel: 'duel', stealth: 'stealth sequence' }[b.mode]} is being played out in the game screen right now. Its result will arrive later.]`,
    '- Do not narrate any attack, damage, detection or outcome. If {{user}} speaks, keep the reply short and in the moment, with the confrontation still unresolved.',
    '</battle_engine>',
  ].join('\n');
}

/* ====================== Aux model: coding a character's whole kit ====================== */
/** One call: the signature passive and up to 2 skill effects, implementing the sheet builder's design notes. */
export function kitMessages({ profile, sheet, kit = {}, concept = '', brief = '', feedback = '', prevError = '' }) {
  const base = passiveMessages({ profile, sheet, concept, brief })[1].content;
  const api = base.slice(base.indexOf('## Sandbox API'), base.indexOf('## Output'));
  const twists = Object.entries(kit?.twists ?? {}).filter(([n]) => (sheet.skills ?? []).some(k => k.name === n));
  const system = 'You code the combat kit of one turn-based RPG character in a restricted JavaScript sandbox: ONE signature passive plus extra effects for up to 2 of their skills, designed together so they work as one plan. Output ONLY one JSON object. No markdown, no commentary.';
  const user = `## Character
${sheetText(sheet, profile)}
Elements: ${(sheet.elements ?? []).join(', ') || 'none'} | Threat: ${sheet.threat ?? 'normal'} | Archetype: ${sheet.archetype ?? '-'}
${concept ? `Concept / bio: ${String(concept).slice(0, 800)}\n` : ''}${brief ? `\n## World\n${String(brief).slice(0, 600)}\n` : ''}
## Design notes from the sheet builder (implement these)
Passive: ${kit?.passive || '(none given — design one from who they are and their skills)'}
${twists.length ? twists.map(([n, t]) => `Skill "${n}": ${t}`).join('\n') : 'Skill twists: (none given — pick up to 2 signature skills that fit the passive, or none)'}
${feedback ? `\n## The user's feedback (follow it; balance caps still apply)\n${feedback}\n` : ''}${prevError ? `\n## Previous attempt failed — FIX THIS\n${prevError}\n` : ''}
${api}
## Skill effects
A skill effect runs ONLY while that skill is used. Hooks: 'onUse' (once, after the skill resolves; ctx.target = first target) for any skill, 'beforeAttack' / 'afterAttack' (each hit, ctx.firstHit) for damaging skills. The skill's own listed effect already happens — add a twist, not raw power.
The passive and the skill effects share ctx.mem, so a skill can feed or spend the passive's stacks (e.g. the passive grants a stack on fire hits, the finisher consumes them for a bonus).
All of a character's code shares the per-turn caps, so keep each piece small.

## Output
{"passive": {"name": "짧은 이름", "desc": "한국어 1-2문장", "code": "JS"}, "skills": [{"skill": "<exact skill name from the sheet>", "name": "짧은 이름", "desc": "한국어 1문장", "code": "JS using only onUse / beforeAttack / afterAttack"}]}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: LLM-coded signature passive ====================== */
export function passiveMessages({ profile, sheet, concept = '', lore = '', brief = '', instruction = '', prevError = '', prevCode = '', skill = null }) {
  const system = skill
    ? `You design and code ONE extra effect for a single skill of a turn-based RPG character, in a restricted JavaScript sandbox. The skill's normal effect (damage, its listed status/stat changes) already happens; your code adds what makes this skill special. Output ONLY a single JSON object: {"name": "...", "desc": "...", "code": "..."}. No markdown, no commentary.`
    : `You design and code ONE balanced, character-defining combat passive in a restricted JavaScript sandbox for a turn-based RPG engine. Output ONLY a single JSON object: {"name": "...", "desc": "...", "code": "..."}. No markdown, no commentary.`;
  const skillPart = skill ? `\n## THE SKILL this effect belongs to\n${skillLine(skill)}${skill.desc ? ` — ${skill.desc}` : ''}${skill.customFx?.name ? `\nCurrent extra effect: ${skill.customFx.name} — ${skill.customFx.desc}` : ''}\nYour code runs ONLY while this skill is being used. Use these hooks only:\n- 'onUse': once, after the skill resolves (ctx.target = its first target, ctx.skill = this skill) — any skill kind\n- 'beforeAttack': each hit of this skill before damage (ctx.target, ctx.dmg; fx.dmgMul / fx.dmgFlat change this hit) — damaging skills only\n- 'afterAttack': each hit after damage (ctx.ko, ctx.firstHit) — damaging skills only\nDo not repeat what the skill line already does. Keep it to ONE clear twist (a condition, a follow-up, a stack, a trade-off), not raw extra power.\n` : '';
  const user = `## Character
${sheetText(sheet, profile)}
Elements: ${(sheet.elements ?? []).join(', ') || 'none'} | Threat: ${sheet.threat ?? 'normal'} | Trait: ${sheet.trait ?? 'none'}
${concept ? `Concept / bio: ${concept}` : ''}
${sheet.customPassive?.name ? `Current passive: ${sheet.customPassive.name} — ${sheet.customPassive.desc}` : ''}
${skillPart}
${brief ? `## World\n${String(brief).slice(0, 600)}\n` : ''}${lore ? `## Relevant lore\n${String(lore).slice(0, 1200)}\n` : ''}${instruction ? `## User request (follow this)\n${instruction}\n` : ''}${prevError ? `## Previous attempt failed — FIX THIS\nError: ${prevError}\nPrevious code:\n${prevCode}\n` : ''}
## Sandbox API (strict — code is statically security-checked before running)
Your code runs as the body of a function(ctx, fx, Math). Check ctx.hook and call fx.* to trigger effects.

Hooks (ctx.hook):
- 'battleStart': entering battle
- 'turnStart': start of each turn
- 'beforeAttack': attacker damage calc (ctx.target, ctx.skill, ctx.dmg, ctx.crit, ctx.eff)
- 'afterAttack': after hitting target (ctx.target, ctx.skill, ctx.dmg, ctx.crit, ctx.eff, ctx.ko)
- 'beforeHit': defender damage calc (ctx.attacker, ctx.skill, ctx.dmg, ctx.fatal)
- 'afterHit': after taking damage (ctx.attacker, ctx.skill, ctx.dmg)
- 'turnEnd': end of turn
- 'onKill': after knocking out an enemy (ctx.victim)
- 'onAllyDown': when an ally falls (ctx.fallen)

Read-only ctx:
- ctx.turn, ctx.allyCount, ctx.foeCount, ctx.isBoss
- ctx.self / ctx.target / ctx.attacker / ctx.victim / ctx.fallen:
  { name, hp, maxHp, hpPct (0-100), sp, maxSp, spPct (0-100), row ('front'|'back'), elements, statuses, statusCount, hasDebuff, hasBuff, isBoss }
- ctx.skill: { name, kind ('physical'|'magic'|'heal'|'buff'|'debuff'|'guard'), element, power, range ('melee'|'ranged'), isBasic, hits, priority }
- ctx.hit (0-based hit number) / ctx.firstHit: the attack hooks fire once PER HIT, so a multi-hit skill (hits 3) runs beforeAttack/afterAttack 3 times. Use if (ctx.firstHit) for "once per action" stacks or bonuses.
- turnStart / turnEnd fire once per turn; stacks that grow "every turn" go there.
- ctx.dmg, ctx.crit, ctx.eff ('super'|'weak'|'resist'|'immune'|null), ctx.ko, ctx.fatal (boolean: incoming hit would KO)
- ctx.mem: persistent per-battle key-value object (read stacks/flags stored by fx.flag)
- ctx.hasStatus('self'|'target'|'attacker', statusId) -> boolean
- ctx.stageOf('self'|'target'|'attacker', stat) -> -6..+6
- ctx.rng() -> 0..1 seeded, ctx.chance(pct) -> boolean seeded

Effect API (fx.*) — engine enforces balance caps automatically:
- fx.dmgMul(mul, msg?): multiply damage in beforeAttack/beforeHit (0.65..1.45)
- fx.dmgFlat(pctMaxHp, msg?; 12 % total per turn, 6 % on bosses): bonus flat damage in beforeAttack (-10..12 % of target maxHp)
- fx.heal(pctMaxHp, msg?): heal self (1..20 % of maxHp; capped 25%/turn)
- fx.sp(pctMaxSp, msg?): change self SP (-25..25 % of maxSp)
- fx.stage('self'|'target'|'foes'|'allies', stat, delta, msg?): stat in pow|mag|def|res|spd|acc|eva|luk, delta -2..+2
- fx.status('self'|'target', statusId, chancePct, turns?, msg?): statusId MUST be one of burn|poison|bleed|stun|freeze|sleep|blind|silence|confuse|fear|vulnerable|mark|regen|shield|taunt (for speed slow/haste use fx.stage(..., 'spd', -1 or +1))
- fx.counter(pctMaxHp, msg?): thorns/counter dmg to attacker in afterHit (3..15 % of attacker maxHp)
- fx.endure(msg?): survive a fatal hit at 1 HP in beforeHit (max 1/battle; any fx.heal called alongside it applies right after surviving)
- fx.flag(key, value): store number/boolean/short-string in ctx.mem for stacks or once-per-battle flags
- fx.log(msg): short flavor note

STRICT SECURITY RULES (violation rejects the code):
- ONLY use if/else, const/let, arithmetic, comparisons, dot property access, ctx.*, fx.*, Math.min/max/floor/ceil/round/abs.
- ALLOWLIST: any name that is not ctx, fx, Math, Number, String, Boolean or a variable you declared with const/let is rejected, and so is any property not listed above (plus .length .includes .indexOf .startsWith .endsWith .toLowerCase .toUpperCase .trim .slice .at on strings/arrays).
- Read stored values directly as ctx.mem.key (do not copy ctx.mem into a variable). Assign only to your own let variables; no ++/--, one variable per const/let.
- NEVER use: while, for, do, function, =>, new, class, this, try/catch, backticks (\`), regex, Math.random, eval, Function, window, document, fetch, Object, or dynamic bracket access obj[key] (only obj.prop or arr[0]).
- Always guard nullable objects (e.g. if (ctx.skill && ctx.skill.kind === 'physical')).
- Keep code concise (5-20 lines), thematic to the character, and tactically interesting (1-2 clean synergistic hooks — e.g. stacking mechanic, conditional power, crisis survival, counter-stance, or kill momentum — NOT overpowered).

## Examples
Example 1 (sword aura stacker):
{"name":"검기 축적","desc":"물리 공격마다 검기 스택을 1 쌓는다(최대 4). 스택당 물리 피해 +8%, 4스택 도달 시 스피드 상승.","code":"if (ctx.hook === 'beforeAttack' && ctx.skill && ctx.skill.kind === 'physical') {\\n  const s = ctx.mem.stacks || 0;\\n  if (s > 0) fx.dmgMul(1 + s * 0.08, '검기 방출');\\n}\\nif (ctx.hook === 'afterAttack' && ctx.firstHit && ctx.skill && ctx.skill.kind === 'physical') {\\n  const next = Math.min(4, (ctx.mem.stacks || 0) + 1);\\n  fx.flag('stacks', next);\\n  if (next === 4 && !ctx.mem.peaked) { fx.flag('peaked', true); fx.stage('self', 'spd', 1, '검기 완성'); }\\n}"}

Example 2 (phoenix crisis passive):
{"name":"불사조의 잔불","desc":"전투당 1회 치명타/치명상을 HP 1로 버티고 체력을 18% 회복한다. 근접 피격 시 30% 확률로 화상 반사.","code":"if (ctx.hook === 'beforeHit' && ctx.fatal && !ctx.mem.revived) {\\n  fx.flag('revived', true);\\n  fx.endure('불사조의 가호');\\n  fx.heal(18, '잔불 재생');\\n}\\nif (ctx.hook === 'afterHit' && ctx.attacker && ctx.skill && ctx.skill.range === 'melee') {\\n  fx.status('target', 'burn', 30, 2, '작열의 반사');\\n}"}

## Output
Return ONE JSON object in Korean for name & desc, valid sandbox JS for code:
${skill ? '{"name": "짧은 부가효과 이름", "desc": "이 기술에 더해지는 효과 (한국어 1문장)", "code": "JS code using only onUse / beforeAttack / afterAttack"}' : '{"name": "짧은 고유 특성명", "desc": "효과 요약 (한국어 1-2문장)", "code": "JS code"}'}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
