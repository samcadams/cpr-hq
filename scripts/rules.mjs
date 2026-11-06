/**
 * Table rules: the GM's world toggles (settings.mjs registers them) and the pure helpers that read them.
 * No Foundry globals at import time, so node tests can import it.
 */
import { MODULE_ID } from "./constants.mjs";

export const RENT_SPLITS = ["equal", "first", "none"];
export const CREW_EFFECTS = ["auto", "manual", "display"];
export const HALFWAY_CHECKS = ["invent", "all", "none"];
export const DEFAULT_SLEEP = "22:00-06:00";
export const DEFAULT_ROLES = ["tech"];

/** The Table rules settings: key -> { type, default, choices?, range? }. Choice labels: CPRHQ.Settings.<key>.<choice>. */
export const TABLE_RULES = {
  upkeep: { type: Boolean, default: true },
  billAgentPlans: { type: Boolean, default: true },
  rentSplit: { type: String, default: "equal", choices: RENT_SPLITS },
  crewEffects: { type: String, default: "auto", choices: CREW_EFFECTS },
  downtimeSystem: { type: Boolean, default: true },
  requireFullDay: { type: Boolean, default: true },
  sleepMinimum: { type: Number, default: 6, range: { min: 0, max: 12, step: 1 } },
  defaultSleep: { type: String, default: DEFAULT_SLEEP },
  fatigueOnSettle: { type: Boolean, default: true },
  halfwayCheck: { type: String, default: "invent", choices: HALFWAY_CHECKS },
  workshopRoles: { type: String, default: DEFAULT_ROLES.join(", ") }
};

/**
 * The module's settings in setup order (api.settings and the Table rules form both read these).
 * Labels and hints: CPRHQ.Settings.group.<id>.label / .hint. `menu`: the registerMenu key that edits them.
 */
export const SETTING_GROUPS = [
  { id: "activities", menu: "editActivities", keys: ["downtimeActivities"] },
  { id: "lifestyle", menu: "editPresets", keys: ["lifestylePresets"] },
  { id: "upkeep", menu: "tableRules", keys: ["upkeep", "upkeepMalfunctions", "upkeepNeglect"] },
  { id: "billing", menu: "tableRules", keys: ["billAgentPlans", "rentSplit"] },
  { id: "crewBenefits", menu: "tableRules", keys: ["crewEffects"] },
  { id: "downtime", menu: "tableRules", keys: ["downtimeSystem", "requireFullDay", "sleepMinimum", "defaultSleep", "fatigueOnSettle"] },
  { id: "workshop", menu: "tableRules", keys: ["workDay", "halfwayCheck", "workshopRoles"] },
  { id: "content", keys: ["contentFolder"] }
];

/** A table rule's current value (any module setting, by key). */
export function rule(key) {
  return game.settings.get(MODULE_ID, key);
}

/**
 * A month's rent as `count` charges. equal: floor share, the remainder 1eb each to the first members;
 * first: all of it to the first member; none: nothing.
 */
export function splitRent(rent, count, mode = "equal") {
  if ( !(count > 0) ) return [];
  if ( mode === "none" ) return Array(count).fill(0);
  if ( mode === "first" ) return Array.from({ length: count }, (_, i) => (i ? 0 : rent));
  const share = Math.floor(rent / count);
  const remainder = rent - (share * count);
  return Array.from({ length: count }, (_, i) => share + (i < remainder ? 1 : 0));
}

/** "22:00-06:00" -> { from: 22, hours: 8 } (whole hours, wraps past midnight); anything else -> the default. */
export function parseSleep(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(text ?? "");
  const valid = m && [m[1], m[3]].every(h => Number(h) < 24) && [m[2], m[4]].every(min => Number(min) < 60);
  const from = valid ? Number(m[1]) : null;
  const hours = valid ? (Number(m[3]) - from + 24) % 24 : 0;
  return hours ? { from, hours } : { from: 22, hours: 8 };
}

/** Whether a project of this type gets the halfway check. invent: inventions only; all; none. */
export function checksHalfway(type, mode) {
  if ( mode === "all" ) return true;
  if ( mode === "none" ) return false;
  return type === "invent";
}

/** "Tech, Medtech" -> ["tech", "medtech"]; empty -> ["tech"]. */
export function roleList(text) {
  const roles = String(text ?? "").split(",").map(r => r.trim().toLowerCase()).filter(Boolean);
  return roles.length ? roles : [...DEFAULT_ROLES];
}
