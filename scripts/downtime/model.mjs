import { MODULE_ID } from "../constants.mjs";
import { isHQ, getHQ, updateHQ } from "../hq.mjs";
import { calendarActive, currentTimestamp, dateLabelAt } from "../calendar.mjs";
import { actorRoles } from "../benefits.mjs";
import { rule, parseSleep } from "../rules.mjs";

/**
 * Downtime: players schedule what their characters do, hour by hour, for the in-game days that have passed since
 * the last settled date. World-wide, independent of any HQ.
 *
 *  1. Simple Calendar moves forward: the days since `settled` are unsettled.
 *  2. The GM starts a round for those days and blocks out "In Mission" hours (whole party, or per character).
 *  3. The GM releases the round; each player fills their character's remaining hours and submits.
 *  4. The GM reviews each schedule (approve or return with a note), then settles the round: schedules go to each
 *     character's history, `settled` moves forward, and HQ facilities get the time (cpr-hq.applyTime).
 *
 * Storage:
 *  - world settings: `downtimeSettled` (SC timestamp), `downtimeRound` (the open round), `downtimeActivities`.
 *  - per character (owner-editable): flags.cpr-hq.downtime {roundId, status, blocks, note}, flags.cpr-hq.downtimeHistory.
 * A block is a range of absolute hours inside the round: {id, activity, start, length, group?, notes?}. Hour 0 is
 * midnight of the round's first day, so a block can cross midnight (e.g. sleep 22:00-06:00).
 */

export const DAY = 86400;
export const HOURS = 24;
const SETTLED = "downtimeSettled";
const ROUND = "downtimeRound";
const ACTIVITIES = "downtimeActivities";
const ADDED = "downtimeActivitiesAdded";
/** Defaults added after worlds may already have a saved list; merged in once (mergeNewDefaults). */
const LATER_DEFAULTS = ["fixerOps", "mediaCredibility", "rockerImpact", "execTeamwork", "techMaker", "medtechMedicine", "hustool", "brainwasher"];
const DRAFT_FLAG = "downtime";
const HISTORY_FLAG = "downtimeHistory";
/** Less sleep than this in a day leaves the character Fatigued the next day (table rule; 0: no short-sleep rule). */
export const sleepMinimum = () => Math.max(0, Number(rule("sleepMinimum")) || 0);

const loc = key => game.i18n.localize(key);

/* -------------------------------------------- */
/*  Activities                                  */
/* -------------------------------------------- */

/**
 * Activity definitions (GM-editable, world setting; these are the defaults).
 *  hours: length of a block when placed (per day for multi-day activities).
 *  flexible: the player can resize it (shortest: minHours); otherwise its length is fixed (hours, or a variant's).
 *  days: a multi-day activity places one block per day at the same hour (a group); 24h a day makes one long block.
 *  countsAsSleep: counts toward the daily sleep minimum.  cost: shown to players and the GM; only the GM's Deduct charges it (apply.mjs).
 *  description: flavour / rules text.  prompt: what the player must give ({type, label, options?}): "text" or "skill"
 *  is a separate detail field; "comment" makes the Comments box itself required (label = its placeholder).
 *  role: only characters with this Role (lower-case Role name).  requires: {improvement, rank} on an HQ they're crew of.
 *  app: only characters with this app on their Agent (cpr-sam-agent's api.pool.has); hidden without it.
 *  variants: picked after placing (Medical Treatment, Cyberware); each overrides hours, cost, sleep and adds text.
 *  locked: GM-only (In Mission).  mechanic: a hook for later automation ("workshop").
 * A block remembers its activity and variant ids: {id, activity, variant?, start, length, group?, notes?, detail?}.
 */
/** Skills the Training activity can focus on. */
const TRAINING_SKILLS = ["Athletics", "Archery", "Autofire", "Brawling", "Evasion", "Handgun", "Heavy Weapons", "Martial Arts",
  "Melee Weapon", "Shoulder Arms"];
const REST_AFTER = "The remainder of the day must be spent resting or lightly working.";
export const DEFAULT_ACTIVITIES = [
  { id: "mission", name: "In Mission", icon: "fa-solid fa-crosshairs", color: "#e0303f", hours: 1, minHours: 1, flexible: true, locked: true },
  { id: "sleep", name: "Sleep", icon: "fa-solid fa-bed", color: "#4a6fdc", hours: 8, minHours: 1, flexible: true, countsAsSleep: true },
  { id: "freetime", name: "Freetime", icon: "fa-solid fa-mug-hot", color: "#31c6d4", hours: 1, minHours: 1, flexible: true,
    description: "Unplanned time: hanging out, errands, whatever comes up." },
  { id: "naturalHealing", name: "Natural Healing", icon: "fa-solid fa-heart-pulse", color: "#4fd18b", hours: 16, minHours: 16,
    description: "Must be Stabilized first. Light duty; if you push it, you heal nothing and need Stabilization (wounds re-open).\nHP increased by BODY per day (plus modifiers)." },
  { id: "medical", name: "Medical Treatment", icon: "fa-solid fa-kit-medical", color: "#7fd1c7", hours: 1, minHours: 1,
    variants: [
      { id: "hospital", name: "Heal at the Hospital", cost: "100eb", hours: 24, countsAsSleep: true, description: "Heal BODY × 1.5 per day." },
      { id: "stabilize", name: "DV10 Stabilization", cost: "50eb", hours: 1 },
      { id: "quickFix", name: "DV13 Quick Fix or Simple Treatment", cost: "100eb", hours: 2 },
      { id: "serious", name: "DV15 Serious Critical Injury", cost: "500eb", hours: 4, description: REST_AFTER },
      { id: "crisis", name: "DV17 Health Crisis", cost: "1,100eb", hours: 24, countsAsSleep: true, description: "Includes one overnight stay in the hospital." }
    ] },
  { id: "bodySculpting", name: "Body Sculpting", icon: "fa-solid fa-user-pen", color: "#e07bd0", hours: 4, minHours: 4, cost: "500eb",
    description: "Morph yourself..." },
  { id: "cyberware", name: "Cyberware", icon: "fa-solid fa-microchip", color: "#f28c28", hours: 1, minHours: 1,
    variants: [
      { id: "mall", name: "Mall Install", cost: "100eb", hours: 1 },
      { id: "clinic", name: "Clinic Install", cost: "500eb", hours: 4, description: REST_AFTER },
      { id: "hospital", name: "Hospital Install", cost: "1,100eb", hours: 16, countsAsSleep: true, description: "Includes one night of recovery in the hospital; needs 1-2 days of rest or light activity." },
      { id: "uninstallMall", name: "Uninstall (Mall)", cost: "100eb", hours: 1, description: "Half the time of the install, same cost." },
      { id: "uninstallClinic", name: "Uninstall (Clinic)", cost: "500eb", hours: 2, description: "Half the time of the install, same cost." },
      { id: "uninstallHospital", name: "Uninstall (Hospital)", cost: "1,100eb", hours: 8, description: "Half the time of the install, same cost." }
    ] },
  { id: "therapy", name: "Standard Therapy", icon: "fa-solid fa-brain", color: "#b36ee0", hours: 24, minHours: 24, days: 5, countsAsSleep: true,
    description: "One week of intensive psychotherapy combining stress and anger management counseling, hypnosis, and minor direct brain reprogramming, aided by pharmaceuticals, and a safe environment which may be induced by therapeutic braindance.\nCosts 500eb, or 100eb (in materials) if a Med Tech completes it (DV 15 Med Tech).\nRecover 2d6 Humanity.\nRequires both patient & practitioner to be present." },
  { id: "therapyExtreme", name: "Extreme Therapy", icon: "fa-solid fa-brain", color: "#8e4cc0", hours: 24, minHours: 24, days: 5, countsAsSleep: true,
    description: "One week of intensive psychotherapy, and sessions focused on direct and extreme brain reprogramming, only made possible by state-of-the-art pharmaceuticals and a safe environment which may be induced by therapeutic braindance.\nCosts 1,000eb, or 500eb (in materials) if a Med Tech completes it (DV 17 Med Tech).\nRecover 4d6 Humanity.\nRequires both patient & practitioner to be present." },
  { id: "therapyAddiction", name: "Addiction Therapy", icon: "fa-solid fa-pills", color: "#c08ee0", hours: 24, minHours: 24, days: 5, countsAsSleep: true,
    description: "One week of intensive psychotherapy combined with a flight of anti-addiction drugs in a safe environment.\nCosts 1,000eb, or 500eb (in materials) if a Med Tech completes it (DV 17 Med Tech).\nPatient is freed of one addiction; they automatically regain the addiction if the drug is taken within 1 year.\nRequires both patient & practitioner to be present." },
  { id: "hustle", name: "Hustle", icon: "fa-solid fa-briefcase", color: "#f2d024", hours: 16, minHours: 16, days: 5,
    description: "Go to work! Roll on your Role's Hustle Table; income scales with Ability Rank." },
  { id: "salvage", name: "Salvage", icon: "fa-solid fa-recycle", color: "#a07a4a", hours: 16, minHours: 16, days: 5,
    description: "Search the ruins of Night City for gear. You may want to bring a radiation suit, breathing mask or grapple gun.\nRequires a Tech Toolkit." },
  { id: "training", name: "Training", icon: "fa-solid fa-dumbbell", color: "#ff8a5c", hours: 16, minHours: 16, days: 5,
    prompt: { type: "skill", label: "Skill to focus on", options: TRAINING_SKILLS },
    description: "Satisfies the HQ Training Area requirement." },
  { id: "medtechDrugs", name: "Med Tech: Produce Pharmaceuticals", icon: "fa-solid fa-flask", color: "#5fd3a0", hours: 1, minHours: 1, flexible: true, role: "medtech",
    prompt: { type: "text", label: "Intended product" },
    description: "1 hour per batch." },
  { id: "techWork", name: "Tech: Upgrade / Fabricate / Invent / Repair", icon: "fa-solid fa-screwdriver-wrench", color: "#d9a43a", hours: 1, minHours: 1, flexible: true, role: "tech",
    mechanic: "workshop", description: "Banks hours for your Workshop projects (Workshop button on your character sheet). Unspent hours are lost when the next downtime round settles." },
  { id: "fixerOps", name: "Fixer: Operator Work", icon: "fa-solid fa-handshake", color: "#d4b24a", hours: 1, minHours: 1, flexible: true, role: "fixer",
    prompt: { type: "skill", label: "Activity", options: ["Make Contacts", "Source an Item", "Find Work", "Investigate", "Other"] },
    description: "Use your Operator Role Ability." },
  { id: "mediaCredibility", name: "Media: Credibility Work", icon: "fa-solid fa-newspaper", color: "#6fa8ff", hours: 1, minHours: 1, flexible: true, role: "media",
    prompt: { type: "skill", label: "Activity", options: ["Focused Rumor Search", "Research Something", "Produce Content"] },
    description: "Use your Credibility Role Ability." },
  { id: "rockerImpact", name: "Rockerboy: Charismatic Impact", icon: "fa-solid fa-microphone-lines", color: "#ff7a9e", hours: 1, minHours: 1, flexible: true, role: "rockerboy",
    prompt: { type: "skill", label: "Activity", options: ["Network with Fans", "Produce Content", "Find a Gig"] },
    description: "Use your Charismatic Impact Role Ability." },
  { id: "execTeamwork", name: "Exec: Teamwork", icon: "fa-solid fa-building", color: "#9a8cff", hours: 1, minHours: 1, flexible: true, role: "exec",
    prompt: { type: "skill", label: "Activity", options: ["Research a Rival", "Lobby Management", "Develop a Project", "Exploit Corporate Resources", "Gather Intelligence"] },
    description: "Use your Teamwork Role Ability." },
  { id: "techMaker", name: "Tech: Maker Work", icon: "fa-solid fa-gears", color: "#c9913a", hours: 1, minHours: 1, flexible: true, role: "tech",
    prompt: { type: "skill", label: "Activity", options: ["Try to Sell Something", "Inspect Equipment", "Scavenge Components"] },
    description: "Use your Maker Role Ability outside the Workshop." },
  { id: "medtechMedicine", name: "Med Tech: Medicine Work", icon: "fa-solid fa-stethoscope", color: "#4fc4a0", hours: 1, minHours: 1, flexible: true, role: "medtech",
    prompt: { type: "skill", label: "Activity", options: ["Find/Restock Supplies", "Research Pathology", "Examine Evidence"] },
    description: "Use your Medicine Role Ability." },
  { id: "rockerStudio", name: "Rockerboy: Studio Time", icon: "fa-solid fa-guitar", color: "#ff5c8a", hours: 16, minHours: 16, days: 5, role: "rockerboy",
    requires: { improvement: "studio", rank: 2 }, description: "Work on a major creative project." },
  { id: "nomadGarage", name: "Nomad: Garage", icon: "fa-solid fa-car", color: "#9bb84a", hours: 16, minHours: 16, days: 5, role: "nomad",
    requires: { improvement: "garage", rank: 2 }, description: "Provides an opportunity to re-select your Moto Role Ability; requires all vehicles to be at full HP." },
  { id: "gearMaintenance", name: "Gear Maintenance", icon: "fa-solid fa-toolbox", color: "#8a9bb0", hours: 1, minHours: 1, flexible: true,
    mechanic: "maintenance", prompt: { type: "comment", label: "What are you working on maintaining?" },
    description: "Once a month, gear your Lifestyle doesn't cover needs time and a Skill Check (Breaking Your Stuff). Pick the item; after the round settles, roll the check from your sheet's Gear tab." },
  { id: "date", name: "Go on a Date", icon: "fa-solid fa-champagne-glasses", color: "#ff6fae", hours: 4, minHours: 4,
    cost: "50eb minimum; more depending on the activity" },
  { id: "leisure", name: "Leisure", icon: "fa-solid fa-umbrella-beach", color: "#3fb8e0", hours: 1, minHours: 1, flexible: true,
    prompt: { type: "comment", label: "What are you doing to take care of yourself? Creative submissions may warrant mechanical benefits." } },
  { id: "hustool", name: "HusTool gigs", icon: "fa-solid fa-bolt", color: "#f2d024", hours: 2, minHours: 1, flexible: true, app: "hustool",
    description: "2 hustles an hour. When the round settles, hit PAY ME in the app to spend each one, then Done; pay arrives at once." },
  { id: "brainwasher", name: "Brainwasher session", icon: "fa-solid fa-couch", color: "#9fd3c7", hours: 1, minHours: 1, days: 7, app: "brainwasher",
    description: "One hour a day with the Brainwasher app. Seven days in a row right before therapy may shorten it by a day, or lengthen it." }
];

export function registerDowntimeSettings(onChange) {
  const label = key => ({ name: `CPRHQ.Settings.${key}.name`, hint: `CPRHQ.Settings.${key}.hint` });
  game.settings.register(MODULE_ID, SETTLED, { ...label(SETTLED), scope: "world", config: false, type: Number, default: null, onChange });
  game.settings.register(MODULE_ID, ROUND, { ...label(ROUND), scope: "world", config: false, type: Object, default: null, onChange });
  game.settings.register(MODULE_ID, ACTIVITIES, { ...label(ACTIVITIES), scope: "world", config: false, type: Array, default: [], onChange });
  game.settings.register(MODULE_ID, ADDED, { ...label(ADDED), scope: "world", config: false, type: Array, default: [] });
}

/** Active GM, on ready: append defaults added since the GM saved their list, once each (a later delete sticks). */
export async function mergeNewDefaults() {
  if ( !game.users.activeGM?.isSelf ) return;
  const done = game.settings.get(MODULE_ID, ADDED) ?? [];
  const todo = LATER_DEFAULTS.filter(id => !done.includes(id));
  if ( !todo.length ) return;
  const saved = game.settings.get(MODULE_ID, ACTIVITIES);
  if ( Array.isArray(saved) && saved.length ) {
    const add = DEFAULT_ACTIVITIES.filter(d => todo.includes(d.id) && !saved.some(a => a.id === d.id));
    if ( add.length ) await game.settings.set(MODULE_ID, ACTIVITIES, [...saved, ...foundry.utils.deepClone(add)]);
  }
  await game.settings.set(MODULE_ID, ADDED, [...done, ...todo]);
}

/** The activity list: the GM's version if saved, else the defaults. "In Mission" and "Sleep" always exist. */
export function activities() {
  const saved = game.settings.get(MODULE_ID, ACTIVITIES);
  // Until the GM arranges them (editor or palette), activities are alphabetical.
  const list = (Array.isArray(saved) && saved.length) ? saved
    : [...DEFAULT_ACTIVITIES].sort((a, b) => a.name.localeCompare(b.name));
  const required = DEFAULT_ACTIVITIES.slice(0, 2).filter(d => !list.some(a => a.id === d.id));
  return [...required, ...list];
}

export function activity(id) {
  return activities().find(a => a.id === id) ?? null;
}

/**
 * What a block is, with its variant applied: {id, name, fullName, icon, color, hours, minHours, cost, countsAsSleep,
 * description, prompt, variant}. Unknown activities (deleted by the GM) still draw, in grey.
 */
export function blockSpec(block) {
  const def = activity(block.activity) ?? { id: block.activity, name: block.activity, icon: "fa-solid fa-circle", color: "#888888", hours: 1, minHours: 1 };
  const variant = def.variants?.find(v => v.id === block.variant) ?? null;
  const description = [def.description, variant?.description].filter(Boolean).join("\n");
  return {
    ...def, variant,
    fullName: variant ? `${def.name}: ${variant.name}` : def.name,
    hours: variant?.hours ?? def.hours ?? 1,
    flexible: !variant && isFlexible(def),
    minHours: variant ? (variant.hours ?? 1) : (def.minHours ?? 1),
    cost: variant ? (variant.cost ?? "") : (def.cost ?? ""),
    countsAsSleep: variant ? !!variant.countsAsSleep : !!def.countsAsSleep,
    description
  };
}

/** Can the player resize this activity? Lists saved before the setting existed: 1-hour or shortenable activities. */
export function isFlexible(def) {
  if ( def.variants?.length ) return false;
  if ( typeof def.flexible === "boolean" ) return def.flexible;
  return ((def.hours ?? 1) === 1) || ((def.minHours ?? 1) < (def.hours ?? 1));
}

/**
 * Blocks to place for an activity starting at `start`: one block, or one per day; 24h a day is one long block.
 * With a variant, its hours (one day). Without one, the activity's own hours (e.g. a drag preview before picking).
 */
export function blocksFor(def, start, { variant = null } = {}) {
  const v = variant ? (def.variants?.find(x => x.id === variant) ?? null) : null;
  const hours = v?.hours ?? def.hours ?? 1;
  const days = v ? 1 : Math.max(1, def.days ?? 1);
  const base = { activity: def.id, ...(v ? { variant: v.id } : {}) };
  if ( (days === 1) || (hours >= HOURS) ) return [{ ...base, id: foundry.utils.randomID(), start, length: hours * days }];
  const group = foundry.utils.randomID();
  return Array.from({ length: days }, (_, i) => ({ ...base, id: foundry.utils.randomID(), start: start + (i * HOURS), length: hours, group }));
}

/** Is this app on the character's Agent? No cpr-sam-agent, or an app it doesn't know (pool.has throws): no. */
function hasApp(actor, app) {
  const agent = game.modules.get("cpr-sam-agent");
  if ( !agent?.active ) return false;
  try {
    return !!agent.api.pool.has(actor, app);
  } catch {
    return false;
  }
}

/** Can this character do this activity? {ok, reason} — Role, Agent app and HQ upgrade requirements. */
export function availability(def, actor) {
  if ( isMaintenance(def) && !rule("upkeep") ) return { ok: false, hidden: true };
  if ( def.role && actor && !actorRoles(actor).has(def.role.toLowerCase()) ) {
    return { ok: false, hidden: true, reason: game.i18n.format("CPRHQ.Downtime.needsRole", { role: def.role }) };
  }
  if ( def.app && actor && !hasApp(actor, def.app) ) return { ok: false, hidden: true };
  if ( def.requires?.improvement && actor ) {
    const rank = def.requires.rank ?? 1;
    const has = game.journal.some(entry => {
      if ( !isHQ(entry) ) return false;
      const hq = getHQ(entry);
      return hq.hasAccess && hq.crew.some(m => m.uuid === actor.uuid) && (hq.rankOf(def.requires.improvement) >= rank);
    });
    if ( !has ) {
      const name = game.i18n.localize(`CPRHQ.Imp.${def.requires.improvement}.name`);
      return { ok: false, reason: game.i18n.format("CPRHQ.Downtime.needsUpgrade", { name, rank }) };
    }
  }
  return { ok: true };
}

const int = (value, min = 0) => Math.max(min, Math.floor(Number(value) || 0));
const text = value => String(value ?? "").trim();

/** GM: save the activity list (from the editor). */
export async function saveActivities(list) {
  const clean = list.map(a => {
    const out = {
      id: a.id || `act${foundry.utils.randomID(6)}`,
      name: text(a.name),
      icon: text(a.icon) || "fa-solid fa-circle",
      color: String(a.color || "#888888"),
      hours: int(a.hours, 1) || 1,
      minHours: int(a.minHours, 1) || 1,
      days: int(a.days, 1) || 1,
      countsAsSleep: !!a.countsAsSleep,
      flexible: !!a.flexible,
      cost: text(a.cost),
      description: String(a.description ?? "").replace(/\r/g, "").trim(),
      role: text(a.role).toLowerCase(),
      app: text(a.app),
      mechanic: text(a.mechanic)
    };
    if ( a.locked || (out.id === "mission") ) out.locked = true;
    if ( a.prompt?.type ) {
      out.prompt = { type: ["skill", "comment"].includes(a.prompt.type) ? a.prompt.type : "text", label: text(a.prompt.label) };
      const choices = (Array.isArray(a.prompt.options) ? a.prompt.options : String(a.prompt.options ?? "").split(","))
        .map(text).filter(Boolean);
      if ( (out.prompt.type === "skill") && choices.length ) out.prompt.options = choices;
    }
    if ( text(a.requires?.improvement) ) out.requires = { improvement: text(a.requires.improvement), rank: int(a.requires.rank, 1) || 1 };
    const variants = Object.values(a.variants ?? {}).map(v => ({
      id: v.id || foundry.utils.randomID(6), name: text(v.name), cost: text(v.cost), hours: int(v.hours, 1) || 1,
      countsAsSleep: !!v.countsAsSleep, description: String(v.description ?? "").replace(/\r/g, "").trim()
    })).filter(v => v.name);
    if ( variants.length ) out.variants = variants;
    return out;
  }).filter(a => a.name);
  await game.settings.set(MODULE_ID, ACTIVITIES, clean);
}

/**
 * GM: reorder the palette. `ids` are the chips shown, in their new order; activities not shown (other Roles, In
 * Mission) keep their places.
 */
export async function reorderActivities(ids) {
  const list = activities();
  const moved = new Set(ids);
  const queue = ids.map(id => list.find(a => a.id === id)).filter(Boolean);
  await saveActivities(list.map(a => moved.has(a.id) ? queue.shift() : a));
}

/** GM: back to the default activity list. */
export async function resetActivities() {
  await game.settings.set(MODULE_ID, ACTIVITIES, []);
}

/* -------------------------------------------- */
/*  Time                                        */
/* -------------------------------------------- */

/** Midnight at or before a timestamp. */
export function dayStart(timestamp) {
  return timestamp - (((timestamp % DAY) + DAY) % DAY);
}

/** Last settled timestamp (midnight). Null until first set. */
export function settledAt() {
  const value = game.settings.get(MODULE_ID, SETTLED);
  return Number.isFinite(value) ? value : null;
}

/**
 * Time since the last settled date: `seconds` (any amount, shown as "not applied") and whole `days` (what a round
 * can cover), from `start`.
 */
export function unsettled() {
  const now = currentTimestamp();
  const settled = settledAt();
  if ( !calendarActive() || !Number.isFinite(now) || (settled === null) ) return { days: 0, seconds: 0, start: settled };
  return {
    days: Math.max(0, Math.floor((dayStart(now) - settled) / DAY)),
    seconds: Math.max(0, now - settled),
    start: settled
  };
}

/**
 * First run (active GM): start tracking from the earliest unapplied HQ time, else from today, so existing
 * "not applied" days carry over.
 */
export async function initSettled() {
  if ( !game.users.activeGM?.isSelf || (settledAt() !== null) || !calendarActive() ) return;
  const now = currentTimestamp();
  let earliest = now;
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) ) continue;
    const { pending, since } = getHQ(entry).calendar;
    if ( pending > 0 ) earliest = Math.min(earliest, Number.isFinite(since) ? since : now - pending);
  }
  await game.settings.set(MODULE_ID, SETTLED, dayStart(earliest));
}

/**
 * How far the calendar has fallen behind the settled date, in whole days (0 when it hasn't), e.g. after the GM turned
 * Simple Calendar back. Until it catches up there's nothing to settle.
 */
export function daysBehind() {
  const now = currentTimestamp();
  const settled = settledAt();
  if ( !calendarActive() || !Number.isFinite(now) || (settled === null) ) return 0;
  return Math.max(0, Math.ceil((settled - dayStart(now)) / DAY));
}

/**
 * GM: move every downtime date by `days` (negative is earlier): the settled date, the open round, each character's
 * Past Days and HQs' unapplied time all shift together, so nothing overlaps or goes missing. Schedules are stored
 * relative to their round, so they move with it. With `calendar`, Simple Calendar moves by the same amount.
 */
export async function shiftDates(days, { calendar = false } = {}) {
  if ( !game.user.isGM || !Number.isInteger(days) || !days ) return;
  const seconds = days * DAY;
  const settled = settledAt();
  if ( settled !== null ) await game.settings.set(MODULE_ID, SETTLED, settled + seconds);
  const round = currentRound();
  if ( round ) await saveRound({ ...round, start: round.start + seconds });
  for ( const actor of game.actors ) {
    const history = actor.getFlag(MODULE_ID, HISTORY_FLAG);
    if ( !history?.length ) continue;
    await actor.update({ [`flags.${MODULE_ID}.${HISTORY_FLAG}`]: history.map(r => ({ ...r, start: r.start + seconds })) });
  }
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) ) continue;
    const { since } = getHQ(entry).calendar;
    if ( Number.isFinite(since) ) await updateHQ(entry, { calendar: { since: since + seconds } });
  }
  if ( calendar && calendarActive() ) await SimpleCalendar.api.changeDate({ day: days });
}

/** Date label for day `index` of a round. */
export function dayLabel(start, index) {
  return dateLabelAt(start + (index * DAY)) ?? `Day ${index + 1}`;
}

/* -------------------------------------------- */
/*  Round                                       */
/* -------------------------------------------- */

/** The open round, or null. {id, start, days, status: "planning"|"open", mission: Block[], missionFor: {uuid: Block[]}} */
export function currentRound() {
  const round = game.settings.get(MODULE_ID, ROUND);
  return round?.id ? round : null;
}

async function saveRound(round) {
  await game.settings.set(MODULE_ID, ROUND, round);
}

/** GM: start a round for the unsettled days (planning: only the GM sees it while blocking out missions). */
export async function startRound() {
  const { days, start } = unsettled();
  if ( !days ) return ui.notifications.warn("CPRHQ.Downtime.noDays", { localize: true });
  await saveRound({ id: foundry.utils.randomID(), start, days, status: "planning", mission: [], missionFor: {} });
}

export async function releaseRound() {
  const round = currentRound();
  if ( round ) await saveRound({ ...round, status: "open" });
}

export async function cancelRound() {
  await game.settings.set(MODULE_ID, ROUND, null);
}

/** "In Mission" blocks for a character: their own override if the GM set one, else the party's. */
export function missionBlocks(round, uuid) {
  return (uuid && round.missionFor?.[uuid]) ? round.missionFor[uuid] : (round.mission ?? []);
}

/** GM: replace mission blocks for the party (uuid null) or one character. `null` blocks clears an override. */
export async function setMission(uuid, blocks) {
  const round = foundry.utils.deepClone(currentRound());
  if ( !round ) return;
  if ( !uuid ) round.mission = blocks;
  else if ( blocks === null ) delete round.missionFor[uuid];
  else round.missionFor[uuid] = blocks;
  await saveRound(round);
}

/* -------------------------------------------- */
/*  Schedules                                   */
/* -------------------------------------------- */

/**
 * A character's schedule for the open round: {status: "draft"|"submitted"|"approved"|"returned", blocks, note}.
 * Until it's first saved, it starts with the table's default sleep (22:00-06:00) around their mission hours.
 */
export function draftFor(actor, round = currentRound()) {
  const flag = actor.getFlag(MODULE_ID, DRAFT_FLAG);
  if ( !round ) return { status: "draft", blocks: [], note: "" };
  if ( flag?.roundId !== round.id ) return { status: "draft", blocks: defaultSleep(round, missionBlocks(round, actor.uuid)), note: "" };
  return { status: flag.status ?? "draft", blocks: flag.blocks ?? [], note: flag.note ?? "" };
}

/** The table's default sleep (22:00-06:00) every night of the round, minus mission hours. */
export function defaultSleep(round, mission = []) {
  const { from, hours: length } = parseSleep(rule("defaultSleep"));
  const total = round.days * HOURS;
  const free = coverage(total, mission).map(c => !c);
  const hours = new Array(total).fill(false);
  for ( let night = -1; night < round.days; night++ ) {
    for ( let h = (night * HOURS) + from; h < (night * HOURS) + from + length; h++ ) if ( (h >= 0) && (h < total) && free[h] ) hours[h] = true;
  }
  return runs(hours).map(([start, length]) => ({ id: foundry.utils.randomID(), activity: "sleep", start, length }));
}

/** Which hours of the round are covered by these blocks. */
function coverage(total, blocks) {
  const covered = new Array(total).fill(false);
  for ( const b of blocks ) for ( let h = b.start; h < b.start + b.length; h++ ) if ( (h >= 0) && (h < total) ) covered[h] = true;
  return covered;
}

/** Contiguous true runs as [start, length]. */
function runs(flags) {
  const out = [];
  for ( let h = 0; h < flags.length; h++ ) {
    if ( !flags[h] ) continue;
    const start = h;
    while ( flags[h + 1] ) h++;
    out.push([start, h - start + 1]);
  }
  return out;
}

/** Freetime blocks for every unassigned stretch. */
export function fillGaps(round, blocks, activityId = "freetime") {
  const covered = coverage(round.days * HOURS, blocks);
  return runs(covered.map(c => !c)).map(([start, length]) => ({ id: foundry.utils.randomID(), activity: activityId, start, length }));
}

export async function saveDraft(actor, changes) {
  const round = currentRound();
  if ( !round ) return;
  const current = draftFor(actor, round);
  await actor.update({ [`flags.${MODULE_ID}.${DRAFT_FLAG}`]: { ...current, ...changes, roundId: round.id } });
}

/** Hours of each day not covered by any block (mission included). */
export function unassignedHours(round, blocks) {
  return coverage(round.days * HOURS, blocks).filter(c => !c).length;
}

/** Blocks whose activity asks for a detail (product, skill, …) that hasn't been given. One per multi-day group. */
export function missingDetails(blocks) {
  const seen = new Set();
  return blocks.filter(b => {
    if ( b.group && seen.has(b.group) ) return false;
    if ( b.group ) seen.add(b.group);
    return isMissing(b);
  });
}

/** Gear Maintenance (gear upkeep, see upkeep.mjs): by id for activity lists saved before the mechanic existed. */
export function isMaintenance(def) {
  return (def?.id === "gearMaintenance") || (def?.mechanic === "maintenance");
}

/** Does this block still need what its activity asks for (a detail, or a required comment)? */
export function isMissing(block, spec = blockSpec(block)) {
  // Gear Maintenance: an item, or "something else" explained in the comments.
  if ( isMaintenance(spec) ) return !block.item || ((block.item === "other") && !String(block.notes ?? "").trim());
  if ( !spec.prompt ) return false;
  const value = (spec.prompt.type === "comment") ? block.notes : block.detail;
  return !String(value ?? "").trim();
}

/** Euros in a cost text ("1,100eb" -> 1100); `extra` when it says more than a number ("50eb minimum; …"). */
export function parseCost(cost) {
  const textValue = String(cost ?? "");
  const match = textValue.replace(/,/g, "").match(/\d+(\.\d+)?/);
  return { value: match ? Number(match[0]) : 0, extra: !match || !/^\s*[\d,.]+\s*(eb)?\s*$/i.test(textValue) };
}

/** Costs to settle by hand (never charged automatically): one line per block, or per multi-day group. */
export function costsOf(round, blocks) {
  const seen = new Set();
  const out = [];
  for ( const b of blocks ) {
    if ( b.group && seen.has(b.group) ) continue;
    if ( b.group ) seen.add(b.group);
    const spec = blockSpec(b);
    if ( spec.cost ) out.push({ name: spec.fullName, cost: spec.cost, day: dayLabel(round.start, Math.floor(b.start / HOURS)) });
  }
  return out;
}

/** Sleep hours per calendar day of the round. */
export function sleepPerDay(round, blocks) {
  const perDay = new Array(round.days).fill(0);
  for ( const b of blocks ) {
    if ( !blockSpec(b).countsAsSleep ) continue;
    for ( let h = b.start; h < b.start + b.length; h++ ) {
      const day = Math.floor(h / HOURS);
      if ( day >= 0 && day < round.days ) perDay[day]++;
    }
  }
  return perDay;
}

/** Hours per activity, for the GM's review. */
export function hoursByActivity(blocks) {
  const totals = new Map();
  for ( const b of blocks ) totals.set(b.activity, (totals.get(b.activity) ?? 0) + b.length);
  return [...totals].map(([id, hours]) => ({ id, hours, name: blockSpec({ activity: id }).name, color: blockSpec({ activity: id }).color }));
}

/* -------------------------------------------- */
/*  Settling                                    */
/* -------------------------------------------- */

/**
 * GM: close the round. Every participant's schedule (approved or not, as the GM decided) goes to their history;
 * the settled date moves past the round; HQs get the time for their facilities; a character who slept less than
 * the minimum on the last day wakes up Fatigued.
 */
export async function settleRound(actors, { applyFatigue }) {
  const round = currentRound();
  if ( !round ) return;
  for ( const actor of actors ) {
    const draft = draftFor(actor, round);
    const blocks = [...missionBlocks(round, actor.uuid).map(b => ({ ...b, activity: "mission" })), ...draft.blocks];
    const history = foundry.utils.deepClone(actor.getFlag(MODULE_ID, HISTORY_FLAG) ?? []);
    history.push({ roundId: round.id, start: round.start, days: round.days, blocks, status: draft.status, applied: {} });
    await actor.update({
      [`flags.${MODULE_ID}.${HISTORY_FLAG}`]: history,
      [`flags.${MODULE_ID}.-=${DRAFT_FLAG}`]: null
    });
    const lastSleep = sleepPerDay(round, blocks).at(-1) ?? 0;
    if ( applyFatigue && (lastSleep < sleepMinimum()) ) await setFatigued(actor, true);
  }

  const seconds = round.days * DAY;
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) || getHQ(entry).status === "destroyed" ) continue;
    await updateHQ(entry, { calendar: { pending: 0, since: null } }, {
      log: { type: "facility", text: game.i18n.format("CPRHQ.Downtime.logSettled", { n: round.days }) }
    });
    /** Facilities that bank time (Workshop, Lockup, Studio) listen for this. */
    Hooks.callAll(`${MODULE_ID}.applyTime`, entry, seconds);
  }
  await game.settings.set(MODULE_ID, SETTLED, round.start + seconds);
  await game.settings.set(MODULE_ID, ROUND, null);
  /** A downtime round was settled: {round, actors} for modules that process activities (e.g. the Workshop). */
  Hooks.callAll(`${MODULE_ID}.downtimeSettled`, round, actors);
}

/** Fatigued from short sleep: the same "Bad sleep" effect as uncomfortable housing (see lifestyle.mjs). */
async function setFatigued(actor, on) {
  const { setBadSleep } = await import("../lifestyle.mjs");
  await setBadSleep(actor, on);
}

/* -------------------------------------------- */
/*  History                                     */
/* -------------------------------------------- */

/**
 * Past days for a character, newest first: [{label, blocks (day-relative), sleep}]. `limit` days.
 */
export function pastDays(actor, limit) {
  const history = actor.getFlag(MODULE_ID, HISTORY_FLAG) ?? [];
  const totalDays = history.reduce((n, r) => n + r.days, 0);
  const days = [];
  for ( const round of [...history].reverse() ) {
    for ( let d = round.days - 1; d >= 0; d-- ) {
      const from = d * HOURS;
      const blocks = round.blocks
        .map(b => ({ ...b, start: Math.max(b.start, from) - from, end: Math.min(b.start + b.length, from + HOURS) - from }))
        .filter(b => b.end > b.start);
      days.push({ label: dayLabel(round.start, d), blocks });
      if ( days.length >= limit ) return { days, more: totalDays > limit };
    }
  }
  return { days, more: false };
}

/* -------------------------------------------- */
/*  For other modules (the Agent's Calendar)    */
/* -------------------------------------------- */

/**
 * A character's settled downtime, by day: Map(midnight timestamp → [{name, icon, color, start, end, detail, notes}]),
 * hours within the day, for days from `from` up to (not including) `to`.
 * @param {Actor} actor
 * @param {number} [from]
 * @param {number} [to]
 */
export function downtimeDays(actor, from = -Infinity, to = Infinity) {
  const days = new Map();
  for ( const round of actor?.getFlag(MODULE_ID, HISTORY_FLAG) ?? [] ) {
    for ( let d = 0; d < round.days; d++ ) {
      const day = round.start + (d * DAY);
      if ( (day < from) || (day >= to) ) continue;
      const lo = d * HOURS;
      const blocks = round.blocks
        .map(b => ({ b, start: Math.max(b.start, lo) - lo, end: Math.min(b.start + b.length, lo + HOURS) - lo }))
        .filter(({ start, end }) => end > start)
        .sort((x, y) => x.start - y.start)
        .map(({ b, start, end }) => {
          const spec = blockSpec(b);
          return { name: spec.fullName, icon: spec.icon, color: spec.color, start, end, detail: b.detail ?? "", notes: b.notes ?? "" };
        });
      days.set(day, blocks);
    }
  }
  return days;
}

/**
 * The open downtime round as it stands for a character: {start, days, round: "planning"|"open", schedule:
 * "draft"|"submitted"|"approved"|"returned"}, or null without one.
 * @param {Actor} actor
 */
export function downtimeRoundFor(actor) {
  const round = currentRound();
  if ( !round ) return null;
  return { start: round.start, days: round.days, round: round.status, schedule: actor ? draftFor(actor, round).status : null };
}
