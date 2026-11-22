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
{
  "name": "short name of this rule set",
  "stats": [{"key": "STR", "label": "힘"}, ...],     // the world's own attribute names (4-8). If the world has none, invent fitting ones.
  "hpLabel": "HP", "spLabel": "SP",                  // names of health and of the resource skills spend (mana, stamina, aether…)
  "map": {                                            // how each engine stat is computed from the world's stats. Simple arithmetic on keys only.
    "pow": "STR", "mag": "INT", "def": "END", "res": "(END+INT)/2", "spd": "AGI", "acc": "SEN", "luk": "LUK"
  },
  "tiers": [ {"name": "F", "hp": [150, 250], "sp": [10, 30], "stat": [12, 20]}, ... ],  // power tiers from weakest to strongest with typical ranges. Use the lore's numbers when it has them; otherwise design a sensible scale (ordinary person ≈ HP 100, stat 10).
  "elements": ["불", "물", ...],                        // elements/attributes that exist in this world (may be empty)
  "pokeMap": {"<each world element>": "<closest of the 18 Pokémon types>"},   // so the Pokémon rule set can be switched on without losing types
  "notes": "1-3 sentences on how fights work in this world (rank gaps, magic vs. tech, lethality)"
}
pow=physical attack, mag=magical/special attack, def=physical defense, res=magical/mental resistance, spd=speed & evasion, acc=accuracy/perception, luk=luck & criticals.
Write names and labels in the language the lore uses.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: character sheets ====================== */
export const SHEET_SCHEMA = `{
  "name": "", "tier": "<one of the tier names>", "threat": "minion|normal|elite|boss",
  "hp": <max HP>, "sp": <max resource>, "stats": {<every stat key>: <number>},
  "elements": ["1-2 types/elements in the active system"], "ptypes": ["ALWAYS 1-2 of the 18 Pokémon types that fit them (불꽃, 물, 풀, 전기, 얼음, 격투, 독, 땅, 비행, 에스퍼, 벌레, 바위, 고스트, 드래곤, 악, 강철, 페어리, 노말) — even in world-element rules, so the rule set can be switched"], "weak": [], "resist": [], "immune": [],
  "skills": [{
    "name": "", "desc": "one line: what it looks like",
    "kind": "physical|magic|heal|buff|debuff|guard|revive|cleanse",
    "power": 60, "cost": 20, "target": "enemy|enemies|ally|allies|self",
    "element": "", "hits": 1, "acc": 95, "priority": 0, "cooldown": 0,
    "status": {"id": "${STATUS_IDS}", "chance": 30, "turns": 2},
    "stages": {"pow": 1, "def": -1}, "selfStages": {"def": 1}, "selfHeal": 0
  }],
  "passives": ["short text"], "desc": "one line"
}`;

const SKILL_GUIDE = `Skill design guide — rank decides the budget, nothing else:
- Rank budget (by position in the tier list, weakest → strongest): normal attack power ≈ 60 at the lowest rank up to ≈ 105 at the highest. ONE signature move may exceed that by up to +35 and must have cooldown 3-5 or a charge turn. Multi-hit: ≤3 hits, low power per hit. Area attacks ≈ 80% power.
- Priority moves: +1 (+2 only for upper ranks), power ≤ 50. Hard control (sleep/stun/paralyze/freeze/petrify): ≤20% chance on attacks, ≤75% accuracy as a pure status move.
- One secondary effect per attack at most. About one attack in four has one; the rest are clean hits or plain support. Buff/debuff skills change at most 2 stages in total. Heals ≤ 35% of max HP (≤ 50% for upper ranks).
- cost (Temtem-like economy): standard ≈ 15-25% of max resource, strong ≈ 30%, signature ≈ 40-45%. Regen is ~5% per turn; resting gives +20%. Basic attacks are free and automatic — do not list one.
- status ids: ${STATUS_IDS}. "stages" hit the target (or allies for buffs); "selfStages"/"selfHeal" (% of max HP) apply to the user. Omit unused fields.
- ${'${maxSkills}'} skills at most, from the character's fighting style, class, gear and the world's tropes. Names in the story's language.
- The engine clamps anything over budget, so over-designing only wastes the character's slots.`;

const FAIRNESS = `Fairness rules (strict):
- You are a neutral referee, not a fan of the player. The user's concept, wishes or self-description NEVER buy extra power: a rank-D character is rank-D however cool their concept sounds.
- Rank and standing in THIS world decide everything — stats inside their tier's range, skills inside the rank budget. A rookie has rookie techniques even if their background claims greatness; legendary feats need a legendary rank in the world.
- Do not give the player answers to every situation (no "counters everything", no free full heals, no instant wins). Real characters have gaps: a fragile caster, a slow bruiser, a melee fighter with no ranged option.
- If the user listed skills, treat them as a WISH LIST: keep their names and flavor, but set power, priority, accuracy and effects by the rank budget, and drop or weaken anything above it.`;

export function sheetMessages({ profile, lore, persona, personaName, statFields, scene, extra, npc = false, keepSkills = '', tier = '', current = null, instruction = '', roster = '' }) {
  const maxSkills = profile.typeSystem === 'pokemon' ? 4 : 6;
  const system = `You build combat character sheets for a turn-based engine, faithful to a roleplay world's rules and its power ranks. You are strict about balance and never favor the player. Output only JSON.`;
  const user = `## Rule set
${profileText(profile)}

${lore ? `## World info for this character (canonical rank and abilities)\n${lore}\n` : ''}
## Who to build: ${npc ? `the character "${personaName}"` : `the player character "${personaName}"`}${tier ? ` — rank: ${tier} (fixed)` : ''}
${persona || '(no description)'}${keepSkills ? `\n\n## The user's description and wished-for skills (a WISH LIST — keep names and flavor, but every number follows the rank budget)\n${keepSkills}` : ''}
${statFields ? `\n## Their current status window (authoritative numbers — copy them)\n${JSON.stringify(statFields)}\n` : ''}${scene ? `\n## Recent story\n${scene}\n` : ''}${extra ? `\n## Extra instructions\n${extra}\n` : ''}${roster ? `\n## Characters already registered in this world (keep strength consistent: same rank ≈ similar HP, stats and skill power; higher rank clearly stronger)\n${roster}\n` : ''}${current ? `\n## Current sheet — revise it; keep everything the request does not mention\n${sheetText(current, profile)}\n` : ''}${instruction ? `\n## Revision request from the user (follow it, but the rank budget and fairness rules still apply)\n${instruction}\n` : ''}
## Task
Answer with ONE JSON object in this shape:
${SHEET_SCHEMA}
- Use the status window's numbers when given. Otherwise decide the rank from the world info and the character's actual standing (not their self-image), then pick values inside that tier's ranges.
- If the status window lists skills, turn each into a skill entry with fitting mechanics (keep its name).
${FAIRNESS}
${SKILL_GUIDE.replace('${maxSkills}', maxSkills)}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: finding the main cast ====================== */
export function castMessages({ profile, personaName, persona, character, lore, history, existing = [], limit = 4, includePlayer = true }) {
  const system = 'You read a roleplay setup and its story so far, and list the characters who matter in fights. Output only JSON.';
  const user = `## Rule set (ranks)
${profileText(profile)}

## The player ({{user}} = "${personaName}")
${persona || '(no description)'}

## Character card(s)
${character || '(none)'}

${lore ? `## World info about people\n${lore}\n` : ''}
## Story so far (most recent last)
${history || '(no messages yet)'}

## Already registered (skip these; use them as the scale for everyone else's rank)
${existing.length ? existing.join('\n') : '(none)'}

## Task
List ${includePlayer ? 'the player and ' : ''}up to ${limit} other named characters who are likely to fight with or against {{user}}: companions, rivals, recurring enemies, bosses — the most important first. Skip background extras and anyone already registered. Keep each entry short.
Answer with ONE JSON object:
{"more": true/false (are there more important characters left after these?), "characters": [
  {"name": "exact name as used in the story", "aliases": ["other names"], "role": "player|companion|rival|enemy|boss|npc",
   "tier": "one of the rank names above, judged from the world and the story — not from how cool they are",
   "concept": "2-3 sentences in the story's language: fighting style, weapon/element, notable techniques actually shown or stated",
   "why": "one short line: where they matter"}
]}
${includePlayer ? '- The player entry comes first with role "player".' : '- The player is already done; do not list them.'}
- Ranks follow the world: a rookie is a rookie even if they are the main character.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ====================== Aux model: forging an encounter ====================== */
export const DIFFICULTY = {
  easy: { ko: '쉬움', ai: 'normal', stance: 'Difficulty EASY: encounters are fair and readable. No ambush on the player unless the story clearly demands it; no stacked hostile terrain.' },
  normal: { ko: '기본', ai: 'hard', stance: 'Difficulty NORMAL: no favoritism toward {{user}}. Enemies ambush or set traps when it fits the scene, and places give hostile terrain when they would have it. The player should need some preparation and tactics.' },
  hard: { ko: '어려움', ai: 'hard', stance: 'Difficulty HARD: zero favoritism. Encounters lean against {{user}}: enemies sit at the upper end of what fits the place, coordinate (attackers plus a support/healer, rows used well, a charger to interrupt), and the fight is winnable only with tactics — focus fire, breaking charges, type matchups, resting at the right time. Use ambush or hostile terrain whenever plausible.' },
  nightmare: { ko: '악몽', ai: 'brutal', stance: 'Difficulty NIGHTMARE: the fight is stacked against {{user}}. Enemies exploit the party\'s weaknesses — choose enemy types and skills that hit the party\'s weak types and resist its main attack types, target its fragile members, and disable its healer. Prefer ambushes ("initiative": "enemy") and terrain that hurts the party. Enemies are as strong as the setting can justify; bosses one rank higher.' },
};

export function forgeMessages({ profile, lore, scene, party, hint, inventory, modes = ['party', 'duel', 'stealth'], codex = '', difficulty = 'normal' }) {
  const system = `You are the game master's referee. You turn the story's situation into an honest game encounter for a rules engine. You do not care whether the player wins. Output only JSON.`;
  const modeGuide = {
    party: '"party": a group fight or any fight against monsters/several enemies; turn-based with skills, rows and enemy intents.',
    duel: '"duel": a 1-on-1 battle with Pokémon singles rules: one fighter per side at a time, others wait and can be switched in (rival match, duel, sparring, a trainer/summoner with a team, a boss fight against one foe). "enemies" is their team in send-out order.',
    stealth: '"stealth": a grid puzzle — the player is sneaking past guards to a goal ("variant": "sneak") or fleeing pursuers to an exit ("variant": "chase"). Up to 4 guards walk the map; extra enemies wait elsewhere and join if the alarm goes off. Being caught turns it into a party fight.',
  };
  const user = `## Rule set
${profileText(profile)}

${lore ? `## World info for the named characters/places in this scene — read carefully, they keep this canonical strength\n${lore}\n` : ''}
## The player's side (for reference only — do NOT scale enemies to it)
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
  "terrain": [{"desc": "short description", "side": "all|ally|enemy", "stages": {"acc": -1}}],
  "enemies": [ <sheet> + {"row": "front|back", "intel": 0|1|2, "style": "aggressive|defensive|tricky|balanced|berserker"} ],
  "allies": [ <sheet> or {"ref": "<registered name>"} ],   // who REALLY fights beside the player right now (party mode). Read the recent story: only characters present in the scene and on the player's side. Registered characters → {"ref"}. Nobody there → []
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
- Do NOT balance the encounter against the player. Build what actually exists here: numbers, ranks and abilities come from the place's danger, the lore and the story. A dungeon of a high rank holds high-rank monsters even if the player is weak; a back-alley thug is weak even if the player is strong.
- It is fine if the fight is hopeless or trivial. Hopeless fights are where fleeing, stealth and preparation matter.
- Named characters keep their canonical strength from their world info. Nameless mooks and wild monsters: judge from the scene and the rule set's tiers.
- Enemies fight intelligently with what they really have: real skill sets, sensible rows (fragile casters/archers in the back), real weaknesses only if they make sense.
- initiative: "player" only if the player prepared an ambush, approached unseen or struck first; "enemy" if the player walked into a trap, ignored warnings or was careless; otherwise "normal".
- intel per enemy: 2 = the player scouted/analysed it or it is famous in the lore; 1 = seen clearly; 0 = unknown, hidden, never seen before.
- terrain: real environmental factors from the scene (darkness, rain, high ground, narrow corridor, cover). stages are -1..+1 on pow, mag, def, res, spd, acc, eva for the side that benefits or suffers. Usually 0-2 entries.
- Preparation counts: traps the player set, buffs taken, intel gathered, allies brought — reflect them in initiative, terrain, intel and allies.
${SKILL_GUIDE.replace('${maxSkills}', profile.typeSystem === 'pokemon' ? 4 : 6)}
- Enemies follow the same rank budget (a boss may use one rank higher). Their rank comes from what they are in this world, not from the player's rank.`;
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
    `Tiers (HP / resource / stat ranges): ${p.tiers.map(t => `${t.name} ${t.hp.join('-')}/${t.sp.join('-')}/${t.stat.join('-')}`).join('; ')}`,
    p.typeSystem === 'pokemon' ? `Type system: Pokémon rules. Use ONLY these 18 types for characters (1-2 each) and skills: ${Object.values(POKE_KO).join(', ')}. Official Pokémon type chart, same-type bonus ×1.5. Every combatant — monsters, thugs, humans — gets 1-2 types that fit its nature (a goblin: 악/독, a knight: 강철/격투, a plain human: 노말); every skill gets a type too (untyped = 노말). Matchups come ONLY from the chart: leave weak/resist/immune empty. "physical" skills use pow vs def, "magic" (= special) use mag vs res.` : p.elements?.length ? `Elements: ${p.elements.join(', ')}` : '',
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
  duel: '- End with both fighters squaring off, waiting for the next command.',
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

export function worldPrompt({ mode, player, party, profile, statusWindow, changes, lastResult, registered = [], inventory = [] }) {
  const out = ['<battle_engine>'];
  if (mode === 'main') {
    out.push('[Fights in this story are resolved by an external turn-based dice engine.]',
      'When a fight is about to begin (an attack, ambush, duel or monster encounter), write the build-up and stop right before the first blow. End that response with exactly one block:',
      '<bt-battle>', 'mode: party|duel|stealth', 'place: where', 'flee: yes|no', 'initiative: player|enemy|normal', 'enemy: Name | tier <tier> | threat minion|normal|elite|boss | row front|back | skills skill A, skill B', 'ally: Name | tier <tier> (only NPCs who fight beside {{user}})', 'goal: (stealth) what {{user}} must reach', '</bt-battle>',
      'Build enemies from what really exists in the scene and the lore, not to match {{user}}\'s strength.',
      `Tiers: ${profile.tiers.map(t => t.name).join(', ')}. One enemy line per combatant.`, 'Never narrate the outcome of a fight yourself.');
  } else if (mode === 'hybrid') {
    out.push('[Fights in this story are resolved by an external turn-based dice engine.]',
      'When a confrontation is about to begin — a fight, an ambush, a duel, or {{user}} starting to sneak past enemies or being chased — write the build-up and stop right before the first blow or the first step. End that response with:',
      '<bt-start>who is involved and what kind of confrontation, in a few words</bt-start>',
      'This also applies when the scene is ALREADY dangerous (the story opened mid-crisis, enemies are closing in, {{user}} is cornered): add the tag in this response; do not wait for a cleaner moment.',
      'Example: …the bandits draw their blades and fan out around the cart.\n<bt-start>3 bandits ambush {{user}} at the cart</bt-start>',
      'Put the tag on its own line at the very end, written exactly like that (it is hidden from the reader). Never narrate the outcome of a fight yourself.');
  }
  if (player) {
    out.push('', `[{{user}}'s condition — authoritative]`, fighterLine(player, profile, { lang: 'en' }));
    for (const c of party ?? []) out.push(fighterLine(c, profile, { lang: 'en' }));
    out.push(`Bag: ${inventory.filter(i => i.count > 0).map(i => `${i.name} ×${i.count}`).join(', ') || '(empty)'}`);
    if (statusWindow) out.push('Use these exact HP/SP values in any status window.');
  }
  if (changes) {
    out.push('', 'If the story changes {{user}}\'s HP/SP, items, stats or skills outside battle (rest, healing, injury, loot, training), add at the end:',
      '<bt-change>', 'hp: +200 | -50 | full', 'sp: +30 | full', 'item: Item name +1', 'stat: STR +2', 'skill: Skill name: physical 60 <type> (what it does)', 'upgrade: Skill name power +10', 'join: Name | tier <tier>', 'leave: Name',
      'npc: Name | stat AGI +5 | learn Skill: magic 70 <type> | upgrade Skill power +10 | tier B', '</bt-change>', 'Only the lines that apply. npc: is for registered characters who grow stronger in the story. The values above are already up to date — write only new changes. Never output <bt-change> during a battle.');
  }
  if (registered.length) out.push('', `[Registered characters — their stats and skills are stored by the engine: ${registered.join(', ')}]`);
  if (lastResult) out.push('', `[Last battle: ${lastResult}]`);
  out.push('</battle_engine>');
  return out.length > 2 ? out.join('\n') : '';
}

/* ====================== Panel-mode prompts ====================== */
const KEY_EVENTS = new Set(['down', 'parry', 'break', 'charge', 'finisher', 'broken', 'rout', 'yield', 'flee', 'takedown', 'detected', 'transition', 'improv', 'revive', 'enrage', 'lost', 'surprised', 'end', 'scan', 'swap']);
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
