import party from './party.js';
import duel from './duel.js';
import stealth from './stealth.js';

export const MODES = { party, duel, stealth };
export const modeOf = id => MODES[id] ?? party;
export const MODE_IDS = Object.keys(MODES);
