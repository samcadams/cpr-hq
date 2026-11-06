import { MODULE_ID } from "./constants.mjs";
import { calendarActive, currentTimestamp } from "./calendar.mjs";
import { actorRoles } from "./benefits.mjs";
import { slugify } from "./effects.mjs";
import { rule } from "./rules.mjs";

/**
 * Gear upkeep, after the "Breaking Your Stuff" DLC (optional rules for maintaining and damaging gear).
 *
 *  - Every weapon, armor, cyberdeck, vehicle, gear, clothing, upgrade and cyberware item a character owns (stashed
 *    too) has a maintenance
 *    tier from its price. A Lifestyle at or above that tier maintains it automatically; some Roles count one tier
 *    higher for some gear. Anything above that needs time once per in-game month and a Skill Check.
 *  - Time comes from the Downtime "Gear Maintenance" activity: the player picks the item from a list of what needs it.
 *    Settling the round books the time on the item ("check due"); the player then rolls the check from the sheet.
 *    Success: maintained this month, Damaged and malfunctions cleared. Failure: the time is lost, book it again.
 *  - Damaged items malfunction. With the world setting on, a natural 1 on an attack or Interface check with a Damaged
 *    item rolls its malfunction table in public (in combat only, by default), so players see the dice. A natural 1
 *    with a neglected item (a whole month skipped) makes it Damaged first.
 *  - Conditions: Damaged (usable, malfunctions), Destroyed (needs a repair, no upkeep until then), Beyond Repair. The
 *    GM can hide an item's condition and malfunction from players ("Damaged gear isn't always obvious at a glance");
 *    anyone can check an item for damage (DV13 Tech, 1 minute) and the GM answers on the chat card.
 *
 * Storage: flags.cpr-hq.upkeep on the item {since, done, condition, damaged, hidden, exempt, pending, malfunction}.
 * `damaged` is the old boolean, kept in step with condition === "damaged". Months are counted as year * 12 + month on
 * Simple Calendar's date (30-day months from world time without it).
 */

const FLAG = "upkeep";
const SYSTEM_ID = "cyberpunk-red-core";
export const MALFUNCTION_SETTING = "upkeepMalfunctions";
export const NEGLECT_SETTING = "upkeepNeglect";

const loc = key => game.i18n.localize(key);
const fmt = (key, data) => game.i18n.format(key, data);
const esc = value => Handlebars.escapeExpression(value ?? "");

/* -------------------------------------------- */
/*  Rules tables                                */
/* -------------------------------------------- */

/** Lifestyle ladder (monthly cost in eb), lowest first; a Lifestyle maintains gear up to its own tier. */
const LIFESTYLE_TIERS = [100, 300, 600, 1500];
/** Gear value at which each tier starts: ordinary gear, and drones/vehicles. */
const VALUE_TIERS = { gear: [0, 500, 1000, 5000], vehicle: [0, 20000, 50000, 100000] };
const TIER_DV = [13, 15, 17, 21];
/** Time the check takes, and the downtime hours that books it (a "day" is one 8-hour work day). */
const TIER_TIME = ["30min", "1h", "3h", "1day"];
const TIER_HOURS = [1, 1, 3, 8];

/** Seconds per malfunction duration; "next" lasts until used (cleared by hand), "now" is instant. */
const DURATION = { round: 3, minute: 60, hour: 3600, day: 86400, next: null, now: 0, month: null };

/** Item conditions (the DLC's three), worst last. */
export const CONDITIONS = ["damaged", "destroyed", "beyond"];
/** DV to find out whether a piece of gear is Damaged (1 minute of examination). */
const INSPECT_DV = 13;

/**
 * Malfunction tables (1d6), paraphrased. Each entry is [duration, text]. Keys are also the lang keys for the names.
 */
export const TABLES = {
  armor: [
    ["day", "Loose weave or soft plates: whenever the armor is ablated, it loses 1 extra SP."],
    ["day", "Worn straps: a Critical Injury to the location where it's worn makes the armor fall off."],
    ["day", "Cracked make-up: every successful Attack on you deals 1 damage straight to HP and ablates the armor by 1, even if it didn't get past its SP."],
    ["day", "Bad balance: Armor Penalty +1 (even if it is normally 0)."],
    ["minute", "The armor shifts as you move: its SP is halved against firearms and explosives."],
    ["day", "A hidden flaw: the first time the armor is ablated, it loses 2 extra SP."]
  ],
  cyberdeck: [
    ["next", "Misread data: pick a program that gives an Interface bonus; next time it's used, that bonus is a penalty instead."],
    ["next", "Worn circuit: next time you Jack Out, the deck sparks and a random program on it is Destroyed."],
    ["round", "Surge: a random Black ICE on the deck attacks you for 1 Round after it rezzes (no Black ICE: a random program won't work for 1 minute)."],
    ["next", "Loose Interface Plug port: next time you take damage in a NET Architecture, make a DV15 Electronics/Security Tech Check or be unsafely Jacked Out."],
    ["minute", "Faulty sensor: next time you Jack In, the deck beeps loudly for 1 minute."],
    ["minute", "Unoptimised: for 1 minute after Jacking In, NET Actions -1 (minimum 1), even if you Jack Out and back in."]
  ],
  limb: [
    ["minute", "Circuit wear: one of the limb's options is deactivated (or, if deployed, can't be retracted)."],
    ["minute", "Nervous tic telegraphs your intentions: -2 to Social Skill Checks."],
    ["now", "Motion processors glitch: DV15 Concentration Check or drop a held item (arm) / fall prone (leg)."],
    ["hour", "Microfractures: a Critical Success on a Check using the limb gives you the Torn Muscle Critical Injury."],
    ["now", "Inertial motivators over-exert: you accidentally strike the nearest target (a Brawling Attack)."],
    ["minute", "Joints partially lock: an arm can't drop or pick up items; a leg gives MOVE -1 (minimum 1)."]
  ],
  senses: [
    ["minute", "Junk data: -1 to Checks that need vision (optics) or hearing (audio), until you spend an Action to clear it."],
    ["minute", "Warped perception: -1 to Checks involving spatial awareness (optics) or balance (audio)."],
    ["hour", "Black and white or one colour only (optics), or a constant ringing (audio). Roleplay it."],
    ["hour", "Won't connect wirelessly to anything but its own options (Agents, Chipware Sockets, tracers...)."],
    ["round", "An option switches itself on: -2 to Checks that need vision (optics) or hearing (audio)."],
    ["hour", "Can't recognise people by their faces (optics) or voices (audio). Roleplay it."]
  ],
  body: [
    ["day", "Toxic leak: nauseated, -2 to Resist Torture/Drugs Checks."],
    ["now", "Overheats: 5 damage straight to HP; armor doesn't help."],
    ["hour", "Flickers, buzzes or stinks: lose Wardrobe & Style / Personal Grooming bonuses, -2 to Social Skill Checks."],
    ["round", "Stinging pain: before each Check, pass DV13 Concentration or that Check fails."],
    ["day", "Glitch: the cyberware shuts down (Grafted Muscle and Bone Lace: +1 to Death Saves; armor: can't repair itself)."],
    ["day", "Infection: Critical Injuries to that part of the body deal 5 extra damage."]
  ],
  neural: [
    ["day", "Junk data: -4 to Concentration Checks."],
    ["now", "Power surge: a random Neuralware option switches on or off (an Action to switch it back)."],
    ["round", "Sharp pain: before each Check, pass DV13 Concentration or that Check fails."],
    ["minute", "Feels intoxicated: -2 to all Checks. Roleplay it."],
    ["hour", "Mind fog: -1 to INT-based Skill Checks."],
    ["minute", "Scrambled language centres: you can only speak gibberish."]
  ],
  drone: [
    ["next", "IFF on the fritz: its next Attack targets you or an ally."],
    ["hour", "IFF really on the fritz: it sees everyone as friendly, or everyone as hostile (GM's choice)."],
    ["hour", "Can't go more than 2 m/yds from its control signal's source, or it shuts down."],
    ["day", "Backdoor exposed: countering it with Electronics/Security Tech takes 1 Action instead of 5 minutes."],
    ["minute", "One of its options stops working."],
    ["hour", "Locomotion seizing up: MOVE halved (rounded up)."]
  ],
  gear: [
    ["day", "Works poorly: no bonuses from it, and -1 to Checks made with it."],
    ["now", "It shocks, stabs or scrapes you: 5 damage straight to HP."],
    ["next", "On its last legs: after its next use it breaks (Destroyed)."],
    ["minute", "No better than no tool: no bonuses from it, and -2 to Checks made with it."],
    ["hour", "Refuses to do one specific thing (GM's choice)."],
    ["month", "Not easy to spot: at the start of next month it isn't maintained, even by Lifestyle or a check."]
  ],
  frame: [
    ["minute", "Actuators out of sync: after each Move Action the GM shifts you 2 m/yds left or right."],
    ["now", "Short circuit: 5 damage straight to HP; armor doesn't help."],
    ["hour", "Motors glitch: the frame doesn't enhance your BODY (HP, Wound Threshold, Death Save unchanged); a cyberchair loses 1 MOVE."],
    ["minute", "Seized joints: -1 to DEX and REF Skill Checks."],
    ["hour", "Knocking piston: -2 to Stealth unless you stay perfectly still."],
    ["day", "Fluid leak: inside you, nausea and -2 to Resist Torture/Drugs; outside, a foul-smelling trail. Roleplay it."]
  ],
  vehicle: [
    ["day", "Won't start easily: DV15 Vehicle Tech each time you start it, or it doesn't and you waste an Action."],
    ["minute", "Radio, lights, horn and wipers switch on and off at random."],
    ["hour", "Smoking engine: speed (Combat and Narrative) halved, rounded up."],
    ["day", "Prone to stalling: the GM may ask for DV15 Vehicle Tech at any time; on a failure it stalls (an Action to restart)."],
    ["hour", "Stiff controls: -2 to Checks to drive or pilot it."],
    ["hour", "Frame microfractures: successful Attacks on it deal double damage, as if hitting a weak spot."]
  ],
  weapon: [
    ["minute", "Dull edge or dirty barrel: the weapon deals 1d6 less damage."],
    ["next", "Accident: ranged, your next Attack targets an ally within 6 m/yds of the target; melee, you drop it; thrown explosive, it goes off at your feet."],
    ["next", "Off target: -2 to your next Attack Check with it."],
    ["minute", "Can't cause a Critical Injury with its damage roll."],
    ["next", "Jams after your next Attack Check, whatever its Quality (thrown explosive: lands but doesn't go off)."],
    ["now", "Firearm: all loaded ammunition is Destroyed Beyond Repair. Melee or bow: counts as Poor Quality for 1 minute (Destroyed for 1 minute if already Poor). Thrown explosive: fizzles."]
  ]
};

/**
 * Rules penalties a malfunction can carry, applied only when the GM approves them from the chat card.
 * By table and d6 face:
 *  skills: "all" | "social" | "int" | "dexref" | "drive" | [skill names], with value (each skill a separate change)
 *  attack: CPR's universal attack modifier.  stats: {ref, dex, move, …} added to the stat.  netSpeed: NET actions.
 *  hp: damage straight to HP (instant, no effect).
 *  checkbox: "on" (default) = roll-dialog option that starts ticked; "off" = starts unticked (only "while using it").
 * Faces not listed stay rules text only (the GM handles them).
 */
const PENALTIES = {
  armor: { 4: { stats: { ref: -1, dex: -1, move: -1 } } },
  cyberdeck: { 6: { netSpeed: -1 } },
  limb: { 2: { skills: "social", value: -2 }, 6: { stats: { move: -1 } } },
  senses: { 1: { skills: "all", value: -1, attack: -1 }, 2: { skills: "all", value: -1, attack: -1, checkbox: "off" },
    5: { skills: "all", value: -2, attack: -2 } },
  body: { 1: { skills: ["Resist Torture/Drugs"], value: -2 }, 2: { hp: 5 }, 3: { skills: "social", value: -2 } },
  neural: { 1: { skills: ["Concentration"], value: -4 }, 4: { skills: "all", value: -2, attack: -2 }, 5: { skills: "int", value: -1 } },
  gear: { 1: { skills: "all", value: -1, checkbox: "off" }, 2: { hp: 5 }, 4: { skills: "all", value: -2, checkbox: "off" } },
  frame: { 2: { hp: 5 }, 4: { skills: "dexref", value: -1 }, 5: { skills: ["Stealth"], value: -2 } },
  vehicle: { 5: { skills: "drive", value: -2 } },
  weapon: { 3: { attack: -2 } }
};

/** Maintenance Skill per kind of gear. */
const SKILLS = {
  armor: "Basic Tech", cyberdeck: "Electronics/Security Tech", cyberware: "Cybertech", drone: "Electronics/Security Tech",
  gear: "Basic Tech", weapon: "Weaponstech", land: "Land Vehicle Tech", air: "Air Vehicle Tech", sea: "Sea Vehicle Tech"
};

const TRACKED_TYPES = ["weapon", "armor", "cyberdeck", "cyberware", "gear", "vehicle", "clothing", "itemUpgrade"];
const isDrone = item => /\bdrones?\b/i.test(item.name);
const isFrame = item => /linear frame|cyberchair/i.test(item.name);

/**
 * Does this item need upkeep at all? Everything a character owns, stashed or not, except the
 * system's placeholder cyberware foundations. Upgrades and attachments are maintained separately (the DLC).
 */
export function isTracked(item) {
  if ( !(item?.parent instanceof Actor) || !TRACKED_TYPES.includes(item.type) ) return false;
  return !((item.type === "cyberware") && item.system.core);
}

/** The malfunction table that fits an item. */
export function tableOf(item) {
  if ( item.type === "itemUpgrade" ) return { weapon: "weapon", armor: "armor", cyberdeck: "cyberdeck", vehicle: "vehicle", cyberware: "body" }[item.system.type] ?? "gear";
  switch ( item.type ) {
    case "weapon": return "weapon";
    case "armor": return "armor";
    case "cyberdeck": return "cyberdeck";
    case "vehicle": return "vehicle";
    case "cyberware":
      switch ( item.system.type ) {
        case "cyberArm": case "cyberLeg": return "limb";
        case "borgware": return isFrame(item) ? "frame" : "limb";
        case "cyberEye": case "cyberAudioSuite": return "senses";
        case "neuralWare": return "neural";
        default: return "body";
      }
    default: return isDrone(item) ? "drone" : "gear";
  }
}

function skillOf(item) {
  if ( item.type === "itemUpgrade" ) return SKILLS[item.system.type] ?? (item.system.type === "vehicle" ? SKILLS.land : SKILLS.gear);
  if ( item.type === "vehicle" ) {
    if ( /aerodyne|\bav-|plane|heli|gyro|jet\b|air/i.test(item.name) ) return SKILLS.air;
    if ( /boat|yacht|ship|jet ?ski|hydrofoil|sub\b/i.test(item.name) ) return SKILLS.sea;
    return SKILLS.land;
  }
  if ( item.type === "gear" ) return isDrone(item) ? SKILLS.drone : SKILLS.gear;
  return SKILLS[item.type] ?? SKILLS.gear;
}

/** Maintenance tier (0-3) from the item's price. */
function valueTier(item) {
  const price = Number(item.system.price?.market) || 0;
  // Vehicles, drones and vehicle upgrades use the vehicle price bands.
  const vehicular = (item.type === "vehicle") || ((item.type === "itemUpgrade") && (item.system.type === "vehicle")) || isDrone(item);
  const steps = vehicular ? VALUE_TIERS.vehicle : VALUE_TIERS.gear;
  return steps.reduce((tier, from, i) => (price >= from ? i : tier), 0);
}

/** Lifestyle tier (-1 = none, 0 Kibble … 3 Fresh Food) from the monthly Lifestyle cost. */
function lifestyleTier(actor) {
  const cost = Number(actor?.system.lifestyle?.lifeStyle?.cost) || 0;
  return LIFESTYLE_TIERS.reduce((tier, from, i) => (cost >= from ? i : tier), -1);
}

/** Roles that count their Lifestyle one tier higher for this item (the DLC's Roles and Maintenance). */
function roleBonus(actor, item) {
  const roles = actorRoles(actor);
  const why = [];
  if ( roles.has("tech") ) why.push("Tech");
  // An upgrade counts as the kind of item it goes on (a scope is weapon gear).
  const kind = (item.type === "itemUpgrade") ? item.system.type : item.type;
  if ( ["weapon", "armor"].includes(kind) ) for ( const r of ["solo", "lawman"] ) if ( roles.has(r) ) why.push(r[0].toUpperCase() + r.slice(1));
  if ( (kind === "cyberdeck") && roles.has("netrunner") ) why.push("Netrunner");
  return why.length ? { bonus: 1, why: why.join(", ") } : { bonus: 0, why: "" };
}

/* -------------------------------------------- */
/*  Time                                        */
/* -------------------------------------------- */

/** This in-game month as a number (year * 12 + month). */
export function monthNow() {
  if ( calendarActive() ) {
    try {
      const d = SimpleCalendar.api.timestampToDate(currentTimestamp());
      if ( Number.isFinite(d?.year) && Number.isFinite(d?.month) ) return (d.year * 12) + d.month;
    } catch ( err ) { /* fall through */ }
  }
  return Math.floor((game.time.worldTime ?? 0) / (30 * 86400));
}

function monthLabel(index) {
  if ( !Number.isFinite(index) ) return "";
  if ( calendarActive() ) {
    try {
      const months = SimpleCalendar.api.getAllMonths?.() ?? [];
      const name = months[((index % 12) + 12) % 12]?.name;
      if ( name ) return `${name} ${Math.floor(index / 12)}`;
    } catch ( err ) { /* fall through */ }
  }
  return fmt("CPRHQ.Upkeep.monthN", { n: index });
}

const now = () => (calendarActive() ? currentTimestamp() : game.time.worldTime) ?? 0;

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

export function upkeepFlag(item) {
  return item.getFlag(MODULE_ID, FLAG) ?? {};
}

/** The item's condition: "damaged", "destroyed", "beyond" or null (fine). Reads the old `damaged` boolean too. */
export function conditionOf(item) {
  const flag = upkeepFlag(item);
  if ( CONDITIONS.includes(flag.condition) ) return flag.condition;
  return (flag.condition === undefined) && flag.damaged ? "damaged" : null;
}

/** A malfunction still running (not past its end time), or null. */
export function activeMalfunction(item) {
  const m = upkeepFlag(item).malfunction;
  if ( !m ) return null;
  if ( Number.isFinite(m.until) && (now() >= m.until) ) return null;
  return m;
}

/**
 * Everything about an item's upkeep. `state` is one of:
 *  "covered" (Lifestyle maintains it), "exempt" (GM), "done" (maintained this month), "due" (not yet this month),
 *  "neglected" (a whole month skipped), "pending" (time booked, check not rolled yet), "broken" (Destroyed or Beyond
 *  Repair: no upkeep until repaired).
 * `needs`: should be offered for the Gear Maintenance activity.
 * A condition the GM hid is left out (as if the item were fine) unless `reveal` (default: GMs see everything).
 * @param {Item} item
 * @param {object} [options]
 * @param {boolean} [options.reveal]  include a hidden condition and malfunction
 */
export function upkeepStatus(item, { reveal = game.user.isGM } = {}) {
  if ( !rule("upkeep") || !isTracked(item) ) return null;
  const actor = item.parent;
  const flag = upkeepFlag(item);
  const hidden = !!flag.hidden;
  const masked = hidden && !reveal;
  const condition = masked ? null : conditionOf(item);
  const broken = ["destroyed", "beyond"].includes(condition);
  const tier = valueTier(item);
  const life = lifestyleTier(actor);
  const role = roleBonus(actor, item);
  const covered = (life + role.bonus) >= tier;
  const month = monthNow();
  const last = Number.isFinite(flag.done) ? flag.done : (Number.isFinite(flag.since) ? flag.since : null);
  const doneNow = Number.isFinite(flag.done) && (flag.done >= month);
  const due = !covered && !flag.exempt && !doneNow && !broken;
  const neglected = due && (last !== null) && (last < month - 1);
  const pending = flag.pending ?? null;
  let state = covered ? "covered" : flag.exempt ? "exempt" : doneNow ? "done" : neglected ? "neglected" : "due";
  if ( pending ) state = "pending";
  if ( broken ) state = "broken";
  const table = tableOf(item);
  const malfunction = masked ? null : activeMalfunction(item);
  const status = {
    id: item.id, name: item.name, state, tier,
    dv: TIER_DV[tier], skill: skillOf(item), time: loc(`CPRHQ.Upkeep.time.${TIER_TIME[tier]}`), hours: TIER_HOURS[tier],
    lifestyle: life >= 0 ? loc(`CPRHQ.Lifestyle.${["kibble", "genericPrepak", "goodPrepak", "freshFood"][life]}`) : loc("CPRHQ.Upkeep.noLifestyle"),
    needsLifestyle: loc(`CPRHQ.Lifestyle.${["kibble", "genericPrepak", "goodPrepak", "freshFood"][tier]}`),
    roleWhy: role.why, covered, exempt: !!flag.exempt, due, neglected, pending,
    condition, conditionLabel: condition ? loc(`CPRHQ.Upkeep.condition.${condition}`) : "",
    damaged: condition === "damaged", destroyed: condition === "destroyed", beyondRepair: condition === "beyond", broken,
    hidden: hidden && !masked, inspectDV: INSPECT_DV,
    lastLabel: monthLabel(flag.done), table, tableName: loc(`CPRHQ.Upkeep.table.${table}`), malfunction,
    needs: !pending && !broken && ((condition === "damaged") || due)
  };
  status.label = broken ? status.conditionLabel : loc(`CPRHQ.Upkeep.state.${state}`);
  status.summary = summaryOf(status);
  return status;
}

/** One-paragraph tooltip text. */
function summaryOf(s) {
  const lines = [`${s.label}${(s.condition && !s.broken) ? ` · ${s.conditionLabel}` : ""}${s.hidden ? ` (${loc("CPRHQ.Upkeep.hiddenShort")})` : ""}`];
  if ( s.broken ) lines.push(loc(`CPRHQ.Upkeep.brokenLine.${s.condition}`));
  else if ( s.covered ) lines.push(fmt("CPRHQ.Upkeep.coveredBy", { life: s.lifestyle, need: s.needsLifestyle }) + (s.roleWhy ? ` (${s.roleWhy} +1)` : ""));
  else lines.push(fmt("CPRHQ.Upkeep.checkLine", { dv: s.dv, skill: s.skill, time: s.time, need: s.needsLifestyle }));
  if ( s.pending ) lines.push(loc("CPRHQ.Upkeep.pendingLine"));
  if ( s.lastLabel ) lines.push(fmt("CPRHQ.Upkeep.lastDone", { month: s.lastLabel }));
  if ( s.malfunction ) lines.push(`⚠ ${s.malfunction.text}`);
  return lines.join("\n");
}

/** Everything a character owns that needs upkeep, with its status. */
export function upkeepList(actor) {
  return (actor?.items ?? []).map(upkeepStatus).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

/** Items that need maintenance now (for the Gear Maintenance activity). */
export function needingUpkeep(actor) {
  return upkeepList(actor).filter(s => s.needs);
}

/** How many items are due, neglected, pending or damaged. */
export function upkeepCounts(actor) {
  const list = upkeepList(actor);
  return {
    due: list.filter(s => ["due", "neglected"].includes(s.state)).length,
    neglected: list.filter(s => s.state === "neglected").length,
    pending: list.filter(s => s.state === "pending").length,
    damaged: list.filter(s => s.damaged).length,
    broken: list.filter(s => s.broken).length,
    malfunctioning: list.filter(s => s.malfunction).length
  };
}

/* -------------------------------------------- */
/*  Changes                                     */
/* -------------------------------------------- */

async function setFlag(item, changes) {
  await item.update({ [`flags.${MODULE_ID}.${FLAG}`]: { ...upkeepFlag(item), ...changes } });
  // A malfunction that ends (or is replaced) takes its approved penalty with it.
  if ( "malfunction" in changes ) await removePenalty(item);
}

/**
 * Set an item's condition ("damaged", "destroyed", "beyond" or null). Only Damaged gear keeps a running malfunction.
 * The chat card is public, or whispered to the GMs while the condition is hidden from players.
 */
export async function setCondition(item, condition, { announce = true, reason = "" } = {}) {
  condition = CONDITIONS.includes(condition) ? condition : null;
  const from = conditionOf(item);
  if ( from === condition ) return;
  await setFlag(item, { condition, damaged: condition === "damaged", ...(condition === "damaged" ? {} : { malfunction: null }) });
  if ( announce ) await card(item, condition ?? (from === "damaged" ? "repaired" : "fixed"), { reason }, { gmOnly: !!upkeepFlag(item).hidden });
}

export async function setDamaged(item, damaged, options = {}) {
  await setCondition(item, damaged ? "damaged" : null, options);
}

/** GM: hide the item's condition and malfunction from players, or show them again. */
export async function setHidden(item, hidden) {
  await setFlag(item, { hidden: !!hidden });
}

export async function setExempt(item, exempt) {
  await setFlag(item, { exempt: !!exempt });
}

export async function clearMalfunction(item) {
  await setFlag(item, { malfunction: null });
}

/** GM: book maintenance time on an item without a downtime round (the check is still rolled). */
export async function allotTime(item, hours = upkeepStatus(item)?.hours ?? 1) {
  await setFlag(item, { pending: { at: monthNow(), hours } });
}

/** Maintenance fixes Damaged, not Destroyed (that takes a repair). */
const maintainedFlag = item => ({
  done: monthNow(), malfunction: null, pending: null,
  ...(conditionOf(item) === "damaged" ? { condition: null, damaged: false } : {})
});

/** GM: count it as maintained this month (no check). */
export async function markMaintained(item) {
  await setFlag(item, maintainedFlag(item));
}

/** Roll one of the roller's skills with the system's own roll (dialog, modifiers, Luck, roll card). Null if cancelled. */
async function skillRoll(roller, skillName, title, event) {
  const skill = roller?.itemTypes?.skill?.find(s => s.name === skillName);
  if ( !skill ) {
    ui.notifications.warn(fmt("CPRHQ.Upkeep.noSkill", { name: roller?.name ?? "?", skill: skillName }));
    return null;
  }
  const cprRoll = skill.createRoll("skill", roller);
  cprRoll.rollTitle = title;
  const keep = await cprRoll.handleRollDialog(event ?? { type: "click", ctrlKey: false, metaKey: false }, roller, skill);
  if ( !keep ) return null;
  await cprRoll.roll();
  if ( Number.isInteger(cprRoll.luck) && (cprRoll.luck > 0) ) {
    const luck = roller.system.stats.luck.value;
    await roller.update({ "system.stats.luck.value": Math.max(0, luck - cprRoll.luck) });
  }
  cprRoll.entityData = { actor: roller.id, token: roller.token?.id ?? null };
  const chat = await cprChat();
  await chat?.RenderRollCard(cprRoll);
  return cprRoll;
}

/**
 * Check an item for damage: DV13 with its Tech Skill and 1 minute of examination (the DLC). The roll card is public;
 * a second card asks the GM, who answers with its buttons: tell them the condition (it stops being hidden) or "nothing
 * found" (a failed check, or a good forgery, keeps it hidden).
 * @param {Item} item
 * @param {object} [options]
 * @param {Actor} [options.roller]  who examines it (default: the owner)
 * @param {Event} [options.event]
 */
export async function inspectItem(item, { roller = item.parent, event = null } = {}) {
  const status = upkeepStatus(item);
  if ( !status ) return null;
  const cprRoll = await skillRoll(roller, status.skill, fmt("CPRHQ.Upkeep.inspectTitle", { skill: status.skill, item: item.name, dv: INSPECT_DV }), event);
  if ( !cprRoll ) return null;
  const total = cprRoll.resultTotal;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: roller }),
    flags: { [MODULE_ID]: { inspect: { item: item.uuid, total, dv: INSPECT_DV, by: roller.name, answer: null } } },
    content: `
      <div class="cpr-hq-upkeep-card inspect">
        <header><i class="fa-solid fa-magnifying-glass"></i> ${fmt("CPRHQ.Upkeep.card.inspect", { item: esc(item.name) })}</header>
        <p class="dur">${fmt("CPRHQ.Upkeep.card.inspectText", { by: esc(roller.name), total, dv: INSPECT_DV })}</p>
        <div class="uk-penalty uk-inspect"><div class="uk-gm"></div><p class="uk-wait">${loc("CPRHQ.Upkeep.inspectWaiting")}</p></div>
      </div>`
  });
  return total;
}

/**
 * Roll the maintenance check with the system's own skill roll (dialog, modifiers, Luck, roll card). Beat the DV:
 * maintained this month, Damaged and malfunctions cleared. Otherwise the booked time is lost.
 * @param {Item} item
 * @param {object} [options]
 * @param {Actor} [options.roller]  who does the work (default: the owner)
 * @param {Event} [options.event]   the click, for the system's ctrl-to-skip-dialog
 */
export async function maintenanceCheck(item, { roller = item.parent, event = null } = {}) {
  const status = upkeepStatus(item);
  if ( !status ) return null;
  if ( status.broken ) {
    ui.notifications.warn(fmt("CPRHQ.Upkeep.brokenWarn", { item: item.name, condition: status.conditionLabel }));
    return null;
  }
  const cprRoll = await skillRoll(roller, status.skill, fmt("CPRHQ.Upkeep.rollTitle", { skill: status.skill, item: item.name, dv: status.dv }), event);
  if ( !cprRoll ) return null;
  const success = cprRoll.resultTotal > status.dv;
  if ( success ) await setFlag(item, maintainedFlag(item));
  else await setFlag(item, { pending: null });
  await card(item, success ? "maintained" : "failed", { total: cprRoll.resultTotal, dv: status.dv, by: roller.name });
  return success;
}

/**
 * Roll the item's malfunction table (1d6) in public and remember the result on the item.
 * @param {Item} item
 * @param {object} [options]
 * @param {string} [options.reason]  why (shown on the card)
 * @param {string} [options.table]   another table than the item's own
 */
export async function rollMalfunction(item, { reason = "", table = tableOf(item) } = {}) {
  const roll = await new Roll("1d6").evaluate();
  const face = roll.total;
  const [dur, text] = TABLES[table][face - 1];
  const seconds = DURATION[dur];
  const malfunction = { table, face, dur, text, at: now(), until: Number.isFinite(seconds) && seconds > 0 ? now() + seconds : null };
  await setFlag(item, { malfunction: (dur === "now") ? null : malfunction });
  const name = loc(`CPRHQ.Upkeep.table.${table}`);
  const penalty = PENALTIES[table]?.[face] ?? null;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: item.parent }),
    rolls: [roll],
    sound: CONFIG.sounds.dice,
    flags: { [MODULE_ID]: { malfunction: { item: item.uuid, table, face, until: malfunction.until, penalty: !!penalty, applied: false } } },
    content: `
      <div class="cpr-hq-upkeep-card malfunction">
        <header><i class="fa-solid fa-triangle-exclamation"></i> ${loc("CPRHQ.Upkeep.malfunctionTitle")}</header>
        <div class="who"><img src="${esc(item.img)}" alt=""> <strong>${esc(item.name)}</strong></div>
        ${reason ? `<p class="why">${esc(reason)}</p>` : ""}
        ${diceBlock(fmt("CPRHQ.Upkeep.malfunctionRoll", { table: name }), face)}
        <p class="text">${esc(text)}</p>
        <p class="dur"><i class="fa-regular fa-clock"></i> ${loc(`CPRHQ.Upkeep.dur.${dur}`)}</p>
        ${penalty ? `<div class="uk-penalty"><p class="uk-what"><i class="fa-solid fa-scale-unbalanced"></i> ${esc(penaltyText(penalty))}</p>
          <div class="uk-gm"><button type="button" data-cprhq-upkeep="apply">
            <i class="fa-solid fa-gavel"></i> ${loc(penalty.hp ? "CPRHQ.Upkeep.applyDamage" : "CPRHQ.Upkeep.applyPenalty")}</button>
            <button type="button" data-cprhq-upkeep="skip"><i class="fa-solid fa-xmark"></i> ${loc("CPRHQ.Upkeep.skipPenalty")}</button></div>
          <p class="uk-wait">${loc("CPRHQ.Upkeep.waitingGM")}</p></div>` : ""}
      </div>`
  });
  return malfunction;
}

/** The 1d6 the way CPR's own roll cards show dice: title (formula), die face, total. */
function diceBlock(title, face) {
  return `
    <div class="rollcard uk-dice">
      <div class="rollcard-top"><div class="cpr-block chat-rollTitle-stat">
        <div class="text-center text-padding-top text-normal text-semi">${esc(title)} (1d6)</div></div></div>
      <div class="rollcard-bottom"><div class="cpr-block"><div class="d6-rollcard-data">
        <div class="d6-dice-div"><img class="d6 d6-60" src="systems/${SYSTEM_ID}/icons/dice/black/d6_${face}.svg" alt="${face}"/></div>
        <div class="d6-number-div"><span>${face}</span></div>
      </div></div></div>
    </div>`;
}

/* -------------------------------------------- */
/*  Penalties (GM-approved)                     */
/* -------------------------------------------- */

const SELECTORS = {
  all: () => true,
  social: s => s.system.category === "socialSkills",
  int: s => s.system.stat === "int",
  dexref: s => ["dex", "ref"].includes(s.system.stat),
  drive: s => /^(Drive Land|Pilot Air|Pilot Sea) Vehicle$/.test(s.name)
};

/** What a penalty does, in a line, for the chat card. */
function penaltyText(p) {
  if ( p.hp ) return fmt("CPRHQ.Upkeep.pen.hp", { n: p.hp });
  const parts = [];
  if ( p.skills ) {
    const which = Array.isArray(p.skills) ? p.skills.join(", ") : loc(`CPRHQ.Upkeep.pen.skills.${p.skills}`);
    parts.push(fmt("CPRHQ.Upkeep.pen.skillsLine", { n: p.value, which }));
  }
  if ( p.attack ) parts.push(fmt("CPRHQ.Upkeep.pen.attack", { n: p.attack }));
  for ( const [stat, n] of Object.entries(p.stats ?? {}) ) parts.push(`${stat.toUpperCase()} ${n}`);
  if ( p.netSpeed ) parts.push(fmt("CPRHQ.Upkeep.pen.netSpeed", { n: p.netSpeed }));
  const checkbox = (p.skills || p.attack) ? ` (${loc(p.checkbox === "off" ? "CPRHQ.Upkeep.pen.unticked" : "CPRHQ.Upkeep.pen.ticked")})` : "";
  return parts.join(", ") + checkbox;
}

/** The changes (with CPR's categories and roll-dialog flags) for a penalty on this actor. */
function penaltyChanges(actor, p) {
  const out = [];
  const situational = { isSituational: true, onByDefault: p.checkbox !== "off" };
  if ( p.skills ) {
    const pick = Array.isArray(p.skills) ? (s => p.skills.includes(s.name)) : SELECTORS[p.skills];
    const keys = [...new Set(actor.itemTypes.skill.filter(pick).map(s => `bonuses.${slugify(s.name)}`))];
    for ( const key of keys ) out.push({ key, value: p.value, cat: "skill", situational });
  }
  if ( p.attack ) out.push({ key: "bonuses.universalAttack", value: p.attack, cat: "combat", situational });
  for ( const [stat, n] of Object.entries(p.stats ?? {}) ) out.push({ key: `system.stats.${stat}.value`, value: n, cat: "stat" });
  if ( p.netSpeed ) out.push({ key: "bonuses.speed", value: p.netSpeed, cat: "netrun" });
  return out;
}

/**
 * GM: apply a malfunction's penalty: damage straight to HP, or an Active Effect on the owner that lasts as long as
 * the malfunction (removed when it ends, is cleared, or the item is maintained).
 */
export async function applyPenalty(item, table, face) {
  const p = PENALTIES[table]?.[face];
  const actor = item?.parent;
  if ( !p || !actor ) return false;
  if ( p.hp ) {
    const hp = actor.system.derivedStats.hp;
    await actor.update({ "system.derivedStats.hp.value": hp.value - p.hp });
    return true;
  }
  const changes = penaltyChanges(actor, p);
  if ( !changes.length ) return false;
  const m = upkeepFlag(item).malfunction;
  const seconds = (m && Number.isFinite(m.until)) ? Math.max(1, m.until - now()) : null;
  await removePenalty(item);
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: fmt("CPRHQ.Upkeep.effectName", { item: item.name, table: loc(`CPRHQ.Upkeep.table.${table}`), face }),
    img: "icons/svg/hazard.svg",
    origin: item.uuid,
    duration: seconds ? { seconds, startTime: game.time.worldTime } : {},
    changes: changes.map(c => ({ key: c.key, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: String(c.value) })),
    flags: {
      [MODULE_ID]: { upkeepPenalty: { item: item.uuid } },
      [SYSTEM_ID]: {
        changes: {
          cats: Object.fromEntries(changes.map((c, i) => [String(i), c.cat])),
          situational: Object.fromEntries(changes.map((c, i) => [String(i), c.situational ?? { isSituational: false, onByDefault: false }]))
        }
      }
    }
  }]);
  return true;
}

/** Remove an item's approved malfunction penalty from its owner. */
async function removePenalty(item) {
  const actor = item?.parent;
  if ( !actor?.isOwner ) return;
  const ids = actor.effects.filter(e => e.getFlag(MODULE_ID, "upkeepPenalty")?.item === item.uuid).map(e => e.id);
  if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

/** GM: malfunctions whose time ran out end, with their penalties. */
async function expireMalfunctions() {
  for ( const actor of game.actors ) {
    for ( const effect of actor.effects ) {
      const uuid = effect.getFlag(MODULE_ID, "upkeepPenalty")?.item;
      if ( !uuid ) continue;
      const item = fromUuidSync(uuid);
      if ( !item ) await effect.delete();
      else if ( !activeMalfunction(item) ) await clearMalfunction(item);
    }
  }
}

/** Chat cards: only GMs see the approve buttons; once decided, the card says what happened. */
function onRenderChat(message, html) {
  if ( message.getFlag(MODULE_ID, "inspect") ) return onRenderInspect(message, html);
  const data = message.getFlag(MODULE_ID, "malfunction");
  if ( !data?.penalty ) return;
  const root = html instanceof HTMLElement ? html : html[0];
  const box = root.querySelector(".uk-penalty");
  if ( !box ) return;
  const gm = box.querySelector(".uk-gm");
  const wait = box.querySelector(".uk-wait");
  if ( data.applied ) {
    gm?.remove();
    wait.innerHTML = `<i class="fa-solid ${data.applied === "skip" ? "fa-xmark" : "fa-check"}"></i> ${loc(data.applied === "skip" ? "CPRHQ.Upkeep.skipped" : "CPRHQ.Upkeep.applied")}`;
    wait.classList.add("done");
    return;
  }
  if ( !game.user.isGM || !rule("upkeep") ) return gm?.remove();
  wait?.remove();
  gm?.addEventListener("click", async event => {
    const button = event.target.closest("[data-cprhq-upkeep]");
    if ( !button ) return;
    event.preventDefault();
    gm.querySelectorAll("button").forEach(b => { b.disabled = true; });
    const choice = button.dataset.cprhqUpkeep;
    if ( choice === "apply" ) {
      const item = await fromUuid(data.item);
      if ( !item || !(await applyPenalty(item, data.table, data.face)) ) {
        ui.notifications.warn("CPRHQ.Upkeep.applyFailed", { localize: true });
        gm.querySelectorAll("button").forEach(b => { b.disabled = false; });
        return;
      }
    }
    await message.setFlag(MODULE_ID, "malfunction", { ...data, applied: choice });
  });
}

/**
 * "Check for damage" cards: the GM sees the item's real condition and answers; players see the answer once given.
 * Answers: "found" (tell them the condition and stop hiding it), "fine" (nothing found).
 */
function onRenderInspect(message, html) {
  const data = message.getFlag(MODULE_ID, "inspect");
  const root = html instanceof HTMLElement ? html : html[0];
  const gm = root.querySelector(".uk-inspect .uk-gm");
  const wait = root.querySelector(".uk-inspect .uk-wait");
  if ( !gm || !wait ) return;
  if ( data.answer ) {
    gm.remove();
    const found = data.answer === "found";
    wait.innerHTML = `<i class="fa-solid ${found ? "fa-triangle-exclamation" : "fa-circle-check"}"></i> ${esc(found
      ? fmt("CPRHQ.Upkeep.inspectFound", { condition: data.conditionLabel || loc("CPRHQ.Upkeep.condition.damaged") })
      : loc("CPRHQ.Upkeep.inspectFine"))}`;
    wait.classList.add("done");
    return;
  }
  if ( !game.user.isGM || !rule("upkeep") ) return gm.remove();
  wait.remove();
  const item = fromUuidSync(data.item);
  const truth = item ? upkeepStatus(item, { reveal: true }) : null;
  const real = truth?.condition ? truth.conditionLabel : loc("CPRHQ.Upkeep.condition.none");
  const pass = data.total > data.dv;
  gm.innerHTML = `
    <p class="uk-what"><i class="fa-solid fa-eye"></i> ${esc(fmt("CPRHQ.Upkeep.inspectTruth", { condition: real }))}${truth?.hidden ? ` (${esc(loc("CPRHQ.Upkeep.hiddenShort"))})` : ""}
      · ${esc(loc(pass ? "CPRHQ.Upkeep.inspectPass" : "CPRHQ.Upkeep.inspectFail"))}</p>
    ${truth?.condition ? `<button type="button" data-cprhq-inspect="found"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(fmt("CPRHQ.Upkeep.inspectTell", { condition: real }))}</button>` : ""}
    <button type="button" data-cprhq-inspect="fine"><i class="fa-solid fa-circle-check"></i> ${esc(loc("CPRHQ.Upkeep.inspectNothing"))}</button>`;
  gm.addEventListener("click", async event => {
    const button = event.target.closest("[data-cprhq-inspect]");
    if ( !button ) return;
    event.preventDefault();
    gm.querySelectorAll("button").forEach(b => { b.disabled = true; });
    const answer = button.dataset.cprhqInspect;
    let conditionLabel = "";
    if ( (answer === "found") && item ) {
      // Once they're told, it's no longer hidden.
      await setHidden(item, false);
      conditionLabel = upkeepStatus(item, { reveal: true })?.conditionLabel ?? "";
    }
    await message.setFlag(MODULE_ID, "inspect", { ...data, answer, conditionLabel });
  });
}

/** Short chat cards: damaged, destroyed, beyond, repaired, fixed, maintained, failed. `gmOnly` whispers them to the GMs. */
async function card(item, kind, data = {}, { gmOnly = false } = {}) {
  const icon = {
    damaged: "fa-heart-crack", destroyed: "fa-burst", beyond: "fa-skull", repaired: "fa-screwdriver-wrench",
    fixed: "fa-screwdriver-wrench", maintained: "fa-circle-check", failed: "fa-circle-xmark"
  }[kind];
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: item.parent }),
    ...(gmOnly ? { whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id) } : {}),
    content: `
      <div class="cpr-hq-upkeep-card ${kind}">
        <header><i class="fa-solid ${icon}"></i> ${fmt(`CPRHQ.Upkeep.card.${kind}`, { item: esc(item.name), ...data })}${gmOnly ? ` <small>(${loc("CPRHQ.Upkeep.hiddenShort")})</small>` : ""}</header>
        ${data.reason ? `<p class="why">${esc(data.reason)}</p>` : ""}
        ${(kind === "maintained" || kind === "failed") ? `<p class="dur">${fmt(`CPRHQ.Upkeep.card.${kind}Text`, { total: data.total, dv: data.dv, by: esc(data.by) })}</p>` : ""}
      </div>`
  });
}

/* -------------------------------------------- */
/*  Natural 1s                                  */
/* -------------------------------------------- */

let chatClass = null;
async function cprChat() {
  if ( chatClass ) return chatClass;
  try {
    chatClass = (await import(foundry.utils.getRoute(`systems/${SYSTEM_ID}/modules/chat/cpr-chat.js`))).default;
  } catch ( err ) {
    console.warn("cpr-hq | could not load CPR's chat module", err);
  }
  return chatClass;
}

function inCombat(actor) {
  return game.combats.some(c => c.started && c.combatants.some(cb => cb.actor?.id === actor.id || cb.actorId === actor.id));
}

/** A roll card was posted: a natural 1 with a Damaged item malfunctions it; with a neglected one, damages it. */
async function onRollCard(cprRoll) {
  if ( !rule("upkeep") ) return;
  const mode = game.settings.get(MODULE_ID, MALFUNCTION_SETTING);
  if ( mode === "off" ) return;
  if ( (cprRoll?.initialRoll !== 1) || (cprRoll.die !== "d10") || !cprRoll.calculateCritical ) return;
  const data = cprRoll.entityData;
  if ( !data?.item ) return;
  const actor = (data.token && game.actors.tokens[data.token]) || game.actors.get(data.actor);
  const item = actor?.items.get(data.item);
  if ( !item?.isOwner ) return;
  if ( (mode === "combat") && !inCombat(actor) ) return;
  const status = upkeepStatus(item, { reveal: true });
  if ( !status || status.broken ) return;
  if ( status.damaged ) {
    await rollMalfunction(item, { reason: fmt("CPRHQ.Upkeep.natural1", { roll: cprRoll.rollTitle }) });
  } else if ( status.neglected && game.settings.get(MODULE_ID, NEGLECT_SETTING) ) {
    await setDamaged(item, true, { reason: loc("CPRHQ.Upkeep.neglectReason") });
  }
}

/** Run after CPR posts any roll card. Wraps CPRChat.RenderRollCard once (the system offers no hook there). */
async function wrapRollCards() {
  const Chat = await cprChat();
  if ( !Chat || Chat.RenderRollCard.cprHqUpkeep ) return;
  const original = Chat.RenderRollCard;
  const wrapped = function(cprRoll, ...args) {
    const result = original.call(this, cprRoll, ...args);
    Promise.resolve(result).then(() => onRollCard(cprRoll)).catch(err => console.error("cpr-hq | upkeep", err));
    return result;
  };
  wrapped.cprHqUpkeep = true;
  Chat.RenderRollCard = wrapped;
}

/* -------------------------------------------- */
/*  Downtime                                    */
/* -------------------------------------------- */

/** GM, on settling: Gear Maintenance blocks book their hours on the chosen items (the check is rolled later). */
async function onSettled(round, actors) {
  if ( !rule("upkeep") ) return;
  const { isMaintenance } = await import("./downtime/model.mjs");
  for ( const actor of actors ) {
    const entry = (actor.getFlag(MODULE_ID, "downtimeHistory") ?? []).findLast(r => r.roundId === round.id);
    const hours = new Map();
    for ( const b of entry?.blocks ?? [] ) {
      if ( !isMaintenance({ id: b.activity }) || !b.item || (b.item === "other") ) continue;
      hours.set(b.item, (hours.get(b.item) ?? 0) + b.length);
    }
    for ( const [id, h] of hours ) {
      const item = actor.items.get(id);
      if ( item && isTracked(item) ) await setFlag(item, { pending: { at: monthNow(), hours: h } });
    }
  }
}

/** GM: start the month count on new player-character gear, so a skipped month can be told apart from a new item. */
async function stampSince(items) {
  const month = monthNow();
  const updates = new Map();
  for ( const item of items ) {
    if ( !isTracked(item) || !item.parent.hasPlayerOwner || Number.isFinite(upkeepFlag(item).since) ) continue;
    const list = updates.get(item.parent) ?? [];
    list.push({ _id: item.id, [`flags.${MODULE_ID}.${FLAG}.since`]: month });
    updates.set(item.parent, list);
  }
  for ( const [actor, list] of updates ) await actor.updateEmbeddedDocuments("Item", list);
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

export function registerUpkeepSettings() {
  game.settings.register(MODULE_ID, MALFUNCTION_SETTING, {
    name: "CPRHQ.Upkeep.setting.malfunctions", hint: "CPRHQ.Upkeep.setting.malfunctionsHint",
    scope: "world", config: false, type: String, default: "combat",
    choices: { off: "CPRHQ.Upkeep.setting.off", combat: "CPRHQ.Upkeep.setting.combat", always: "CPRHQ.Upkeep.setting.always" }
  });
  game.settings.register(MODULE_ID, NEGLECT_SETTING, {
    name: "CPRHQ.Upkeep.setting.neglect", hint: "CPRHQ.Upkeep.setting.neglectHint",
    scope: "world", config: false, type: Boolean, default: true
  });
}

/** Upkeep on (at ready, or switched on later): watch roll cards; the GM dates the gear that has no upkeep month yet. */
export function upkeepSwitchedOn() {
  wrapRollCards();
  if ( game.users.activeGM?.isSelf ) stampSince(game.actors.filter(a => a.hasPlayerOwner).flatMap(a => [...a.items]));
}

export function registerUpkeepHooks() {
  Hooks.on("renderChatMessage", onRenderChat);
  Hooks.on("updateWorldTime", foundry.utils.debounce(() => {
    if ( game.users.activeGM?.isSelf && rule("upkeep") ) expireMalfunctions();
  }, 500));
  Hooks.once("ready", () => {
    if ( rule("upkeep") ) upkeepSwitchedOn();
  });
  Hooks.on(`${MODULE_ID}.downtimeSettled`, (round, actors) => onSettled(round, actors));
  Hooks.on("createItem", item => {
    if ( game.users.activeGM?.isSelf && rule("upkeep") && (item.parent instanceof Actor) ) stampSince([item]);
  });
}

/** The API (api.upkeep). */
export const upkeepAPI = {
  status: upkeepStatus, list: upkeepList, needing: needingUpkeep, counts: upkeepCounts, tableOf, TABLES,
  check: maintenanceCheck, inspect: inspectItem, rollMalfunction, clearMalfunction, setDamaged, setCondition, setHidden,
  conditionOf, CONDITIONS, setExempt, allotTime, markMaintained, applyPenalty, PENALTIES
};
