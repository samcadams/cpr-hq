import { MODULE_ID } from "../constants.mjs";
import { isHQ, getHQ } from "../hq.mjs";
import { actorRoles, isFullCrew } from "../benefits.mjs";
import { currentDateLabel } from "../calendar.mjs";

/**
 * Workshop: a Tech's Maker projects (CP:R p.145), independent of any HQ.
 *
 *  1. The player proposes a project: Fabricate, Invent, Upgrade or Repair, each with its own required fields.
 *  2. The GM reviews it: sets the DV, hours and materials (defaults come from the Price Category table), links the
 *     item, then approves it or returns it with a note.
 *  3. Hours the character spent on "Tech" downtime go to their bank when a downtime round settles (the GM can also
 *     grant hours). The player spends banked hours on the project in the main bench slot. Unspent hours are lost
 *     when the next round settles.
 *  4. A Workshop on an HQ the Tech is crew of adds bench slots: the same hours also count toward a 2nd (and, upgraded,
 *     a 3rd) project, if the main project is Upgrade, Fabrication or Invention work (not Repair).
 *  5. Once a project has all its hours, the Tech rolls TECH + Skill + Specialty Rank + 1d10 against the DV.
 *     Success completes it; failure starts it over (hours lost, materials kept). An invention is checked halfway
 *     through instead: success lets the Tech finish the remaining hours, failure is back to the drawing board.
 *
 * Storage: flags.cpr-hq.workshop on the character (owner-editable): {bank, bench: [ids], projects, log}.
 */

const FLAG = "workshop";
const LOG_LIMIT = 100;

export const PROJECT_TYPES = {
  fabricate: { icon: "fa-solid fa-industry", color: "#31c6d4", specialty: "Fabrication Expertise", gmItem: true },
  invent: { icon: "fa-solid fa-lightbulb", color: "#f2d024", specialty: "Invention Expertise", gmItem: true, gmCategory: true },
  upgrade: { icon: "fa-solid fa-arrow-up-right-dots", color: "#ff7a2f", specialty: "Upgrade Expertise", needsItem: true },
  repair: { icon: "fa-solid fa-wrench", color: "#4fd18b", specialty: "Field Expertise", needsItem: true, noWorkshop: true }
};

/**
 * Price Categories: DV and time for Upgrade, Fabrication and Invention (the Maker table, CP:R p.145). Cheap and
 * Everyday share a row. Time is in hours or days; a day is workDay() hours of Tech time (world setting, 8 or 16).
 * Super Luxury takes a month per 10,000eb.
 */
export const CATEGORIES = {
  cheap: { price: 10, dv: 9, time: "1h" },
  everyday: { price: 20, dv: 9, time: "1h" },
  costly: { price: 50, dv: 13, time: "6h" },
  premium: { price: 100, dv: 17, time: "1d" },
  expensive: { price: 500, dv: 21, time: "1w" },
  veryExpensive: { price: 1000, dv: 24, time: "2w" },
  luxury: { price: 5000, dv: 29, time: "1m" },
  superLuxury: { price: 10000, dv: 29, time: "1m" }
};

/** The time column of the Maker table: a preset is hours, or days of work. */
export const TIME_PRESETS = {
  "1h": { hours: 1 },
  "6h": { hours: 6 },
  "1d": { days: 1 },
  "1w": { days: 7 },
  "2w": { days: 14 },
  "1m": { days: 30 }
};

/** The DV column of the Maker table, with the categories that use each DV. */
export const DV_PRESETS = [...new Set(Object.values(CATEGORIES).map(c => c.dv))]
  .map(dv => ({ dv, categories: Object.keys(CATEGORIES).filter(k => CATEGORIES[k].dv === dv) }));

/** Hours of Tech work in a day (world setting: 8 for a working day, 16 for every waking hour). */
export const WORK_DAY_SETTING = "workDay";
export const WORK_DAY_CHOICES = [8, 16];
export function workDay() {
  const hours = Number(game.settings.get(MODULE_ID, WORK_DAY_SETTING));
  return WORK_DAY_CHOICES.includes(hours) ? hours : 16;
}

export function registerWorkshopSettings(onChange) {
  game.settings.register(MODULE_ID, WORK_DAY_SETTING, {
    name: "CPRHQ.Workshop.setting.workDay", hint: "CPRHQ.Workshop.setting.workDayHint",
    scope: "world", config: true, type: Number, default: 16,
    choices: Object.fromEntries(WORK_DAY_CHOICES.map(n => [n, `CPRHQ.Workshop.setting.workDay${n}`])),
    onChange
  });
}

/** Hours a time preset takes. */
export function presetHours(key) {
  const t = TIME_PRESETS[key];
  return t ? (t.hours ?? (t.days * workDay())) : 0;
}

/** "1 week (112h)" */
export function presetLabel(key) {
  const label = loc(`CPRHQ.Workshop.time.${key}`);
  return TIME_PRESETS[key]?.days ? `${label} (${presetHours(key)}h)` : label;
}

/** Project types that can carry a reference image (a sketch, the finished look). */
export const IMAGE_TYPES = ["fabricate", "invent", "upgrade"];
const CATEGORY_KEYS = Object.keys(CATEGORIES);
/** Inventions are at least Expensive. */
export const INVENT_MIN = "expensive";

export const TECH_SKILLS = ["Basic Tech", "Cybertech", "Electronics/Security Tech", "Land Vehicle Tech", "Sea Vehicle Tech",
  "Air Vehicle Tech", "Weaponstech"];

/** Upgrade Expertise options (one upgrade per item). */
export const UPGRADES = ["humanity", "slot", "repairTime", "conceal", "excellent", "exoticSlot", "exoticAmmo", "sp", "nomad",
  "invented"];

export const STATUSES = ["pending", "returned", "approved", "complete"];

const loc = key => game.i18n.localize(key);
const int = (value, min = 0) => Math.max(min, Math.floor(Number(value) || 0));
const text = value => String(value ?? "").trim();

/* -------------------------------------------- */
/*  Characters                                  */
/* -------------------------------------------- */

export function isTech(actor) {
  return (actor?.type === "character") && actorRoles(actor).has("tech");
}

/** TECH, Maker rank and the four specialty ranks (from the Tech Role item). */
export function techProfile(actor) {
  const role = actor.itemTypes.role?.find(r => r.name.toLowerCase() === "tech");
  const rank = name => role?.system.abilities?.find(a => a.name === name)?.rank ?? 0;
  return {
    tech: actor.system.stats?.tech?.value ?? 0,
    maker: role?.system.rank ?? 0,
    specialties: ["Field Expertise", "Upgrade Expertise", "Fabrication Expertise", "Invention Expertise"].map(name => ({ name, rank: rank(name) })),
    skills: TECH_SKILLS.map(name => ({ name, level: skillLevel(actor, name) }))
  };
}

function skillLevel(actor, name) {
  return actor.itemTypes.skill?.find(s => s.name === name)?.system.level ?? 0;
}

/**
 * The best Workshop this character can work in: crew (full crew) of an accessible HQ with one installed.
 * @returns {{entry: JournalEntry, hq: object, rank: number}|null}
 */
export function workshopAccess(actor) {
  let best = null;
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) ) continue;
    const hq = getHQ(entry);
    const rank = hq.rankOf("workshop");
    if ( !rank || !hq.hasAccess ) continue;
    const member = hq.crew.find(m => m.uuid === actor.uuid);
    if ( !member || !isFullCrew(hq, member) ) continue;
    if ( !best || (rank > best.rank) ) best = { entry, hq, rank };
  }
  return best;
}

/** An HQ the character is crew of (for the Workshop card when none has a Workshop yet). */
export function crewHQ(actor) {
  return game.journal.find(e => isHQ(e) && getHQ(e).crew.some(m => (m.uuid === actor.uuid) && !m.teamMember)) ?? null;
}

/** Bench slots: the main project, plus one per Workshop rank. */
export function benchSize(actor) {
  return 1 + (workshopAccess(actor)?.rank ?? 0);
}

/* -------------------------------------------- */
/*  Data                                        */
/* -------------------------------------------- */

export function workshopData(actor) {
  const data = foundry.utils.deepClone(actor?.getFlag(MODULE_ID, FLAG) ?? {});
  return { bank: int(data.bank), bench: data.bench ?? [], projects: data.projects ?? [], log: data.log ?? [] };
}

async function save(actor, data, log) {
  if ( log ) {
    data.log.push({ id: foundry.utils.randomID(), time: Date.now(), date: currentDateLabel() ?? "", user: game.user.name, ...log });
    data.log = data.log.slice(-LOG_LIMIT);
  }
  data.bench = tidyBench(actor, data);
  await actor.update({ [`flags.${MODULE_ID}.${FLAG}`]: data });
}

/** Category for a market price: the cheapest category whose price covers it. */
export function categoryFor(price) {
  price = Number(price) || 0;
  return CATEGORY_KEYS.find(k => price <= CATEGORIES[k].price) ?? "superLuxury";
}

/** Hours a category takes (Super Luxury: a month per 10,000eb of the item's price). */
export function hoursFor(category, price = 0) {
  const hours = presetHours((CATEGORIES[category] ?? CATEGORIES.cheap).time);
  if ( category === "superLuxury" ) return hours * superLuxuryMonths(price);
  return hours;
}

/** Super Luxury: a month per 10,000eb of the item's price. */
export function superLuxuryMonths(price = 0) {
  return Math.max(1, Math.ceil((Number(price) || 0) / 10000));
}

/** The time a category takes, in words: "1 week (112h)", or "3 months (1,440h)" for Super Luxury. */
export function timeLabel(category, price = 0) {
  const row = CATEGORIES[category];
  if ( !row ) return "";
  if ( category !== "superLuxury" ) return presetLabel(row.time);
  const n = superLuxuryMonths(price);
  return game.i18n.format(n === 1 ? "CPRHQ.Workshop.time.month1" : "CPRHQ.Workshop.time.months",
    { n, hours: hoursFor(category, price).toLocaleString(game.i18n.lang) });
}

/** The Price Category an item's work uses: its price, except vehicle upgrades (always Very Expensive). */
export function categoryForItem(type, item) {
  if ( (type === "upgrade") && (item?.type === "vehicle") ) return "veryExpensive";
  return categoryFor(item?.system?.price?.market ?? item?.price);
}

/** Materials, by type: Fabricate one category lower (Super Luxury: half the price), Upgrade the item's category. */
export function materialsFor(type, category, price = 0) {
  const fmt = n => `${n.toLocaleString(game.i18n.lang)}eb`;
  if ( type === "fabricate" ) {
    if ( category === "superLuxury" ) return price ? fmt(Math.round(price / 2)) : loc("CPRHQ.Workshop.halfPrice");
    const lower = CATEGORY_KEYS[Math.max(0, CATEGORY_KEYS.indexOf(category) - 1)];
    return `${fmt(CATEGORIES[lower].price)} (${loc(`CPRHQ.Workshop.cat.${lower}`)})`;
  }
  if ( type === "upgrade" ) return `${fmt(CATEGORIES[category]?.price ?? 0)} (${loc(`CPRHQ.Workshop.cat.${category}`)})`;
  return "";
}

/** The rulebook defaults for a project's DV, hours and materials. */
export function defaultsFor(project) {
  const category = project.category || "cheap";
  return {
    dv: CATEGORIES[category]?.dv ?? 9,
    hours: hoursFor(category, project.price),
    materials: materialsFor(project.type, category, project.price)
  };
}

/** A skill to suggest for an item. */
export function skillForItem(item) {
  switch ( item?.type ) {
    case "weapon": case "ammo": return "Weaponstech";
    case "cyberware": return "Cybertech";
    case "vehicle": return "Land Vehicle Tech";
    case "program": case "netarch": return "Electronics/Security Tech";
    default: return "Basic Tech";
  }
}

/** What a project keeps of a linked item. */
export function itemRef(item) {
  return item ? { uuid: item.uuid, name: item.name, img: item.img, type: item.type, price: Number(item.system?.price?.market) || 0 } : null;
}

/** Fields the player still has to give, as localized labels. */
export function missingFields(p) {
  const out = [];
  if ( !text(p.name) && (p.type !== "upgrade") && (p.type !== "repair") ) out.push("name");
  if ( PROJECT_TYPES[p.type]?.needsItem && !p.item ) out.push("item");
  if ( (p.type === "fabricate") && !p.category ) out.push("category");
  if ( (p.type === "invent" || p.type === "repair") && !text(p.details) ) out.push("details");
  if ( (p.type === "upgrade") && !p.upgrade ) out.push("upgrade");
  if ( (p.type === "upgrade") && (p.upgrade === "invented") && !text(p.details) ) out.push("details");
  if ( !p.skill ) out.push("skill");
  return out;
}

/** A clean project from dialog data. */
export function cleanProject(input, existing = {}) {
  const type = PROJECT_TYPES[input.type] ? input.type : (existing.type ?? "fabricate");
  const item = (input.item !== undefined) ? input.item : (existing.item ?? null);
  const p = {
    ...existing,
    id: existing.id ?? foundry.utils.randomID(),
    type,
    name: text(input.name ?? existing.name),
    details: text(input.details ?? existing.details),
    skill: TECH_SKILLS.includes(input.skill) ? input.skill : (existing.skill ?? ""),
    upgrade: (type === "upgrade") ? (UPGRADES.includes(input.upgrade) ? input.upgrade : (existing.upgrade ?? "")) : "",
    item,
    image: IMAGE_TYPES.includes(type) ? text(input.image ?? existing.image) : "",
    category: CATEGORIES[input.category] ? input.category : (existing.category ?? ""),
    // An item's market price sets Super Luxury time and materials.
    price: int(input.price ?? item?.price ?? existing.price),
    progress: int(existing.progress),
    attempts: existing.attempts ?? [],
    created: existing.created ?? (currentDateLabel() ?? ""),
    status: existing.status ?? "pending"
  };
  if ( (type === "upgrade" || type === "repair") && p.item && !p.name ) p.name = p.item.name;
  if ( (type === "invent") && p.category && (CATEGORY_KEYS.indexOf(p.category) < CATEGORY_KEYS.indexOf(INVENT_MIN)) ) p.category = INVENT_MIN;
  return p;
}

/* -------------------------------------------- */
/*  Player actions                              */
/* -------------------------------------------- */

/** Propose a new project (goes to the GM). */
export async function proposeProject(actor, input) {
  const data = workshopData(actor);
  const project = cleanProject(input);
  if ( missingFields(project).length ) return null;
  project.status = "pending";
  data.projects.push(project);
  await save(actor, data, { type: "propose", project: project.id, text: game.i18n.format("CPRHQ.Workshop.log.propose", { name: project.name }) });
  await notifyGM(actor, project);
  return project;
}

/** The player edits a project the GM hasn't approved yet (or returned): it goes back to the GM. */
export async function reviseProject(actor, id, input) {
  const data = workshopData(actor);
  const i = data.projects.findIndex(p => p.id === id);
  if ( i < 0 ) return;
  const project = cleanProject(input, data.projects[i]);
  if ( missingFields(project).length ) return;
  project.status = "pending";
  data.projects[i] = project;
  await save(actor, data, { type: "propose", project: id, text: game.i18n.format("CPRHQ.Workshop.log.revise", { name: project.name }) });
  await notifyGM(actor, project);
}

export async function deleteProject(actor, id) {
  const data = workshopData(actor);
  const project = data.projects.find(p => p.id === id);
  if ( !project ) return;
  data.projects = data.projects.filter(p => p.id !== id);
  await save(actor, data, { type: "delete", text: game.i18n.format("CPRHQ.Workshop.log.delete", { name: project.name }) });
}

/** Link (or unlink) an item. Upgrade/Repair: the owner may; Fabricate/Invent: GM only. */
export async function linkItem(actor, id, item) {
  const data = workshopData(actor);
  const project = data.projects.find(p => p.id === id);
  if ( !project ) return;
  if ( !canLinkItem(project) ) return ui.notifications.warn("CPRHQ.Workshop.gmLinks", { localize: true });
  project.item = itemRef(item);
  if ( item && (project.type === "upgrade" || project.type === "repair") ) {
    if ( !project.name || (project.status !== "approved") ) project.name = item.name;
    if ( project.status !== "approved" ) {
      project.price = project.item.price;
      project.category = categoryForItem(project.type, item);
    }
  }
  await save(actor, data);
}

export function canLinkItem(project, user = game.user) {
  if ( user.isGM ) return true;
  return !PROJECT_TYPES[project.type]?.gmItem && (project.status !== "complete");
}

/**
 * Put a project in a bench slot (0 = main). Taking an occupied slot swaps the two; a project coming off the shelf
 * moves the one it displaces to a free slot, if there is one.
 */
export async function benchProject(actor, id, slot) {
  const data = workshopData(actor);
  const project = data.projects.find(p => p.id === id);
  // Moving within the bench is always fine; a project joins it only when it can be worked on.
  if ( project && !data.bench.includes(id) ) {
    if ( !materialsOk(project) ) return ui.notifications.warn("CPRHQ.Workshop.needsMaterials", { localize: true });
    if ( !workable(project) ) return;
  }
  const size = benchSize(actor);
  slot = Math.min(int(slot), size - 1);
  const bench = Array.from({ length: size }, (_, i) => data.bench[i] ?? null);
  const from = bench.indexOf(id);
  if ( from >= 0 ) bench[from] = bench[slot];
  else if ( bench[slot] ) {
    const free = bench.findIndex((b, i) => !b && (i !== slot));
    if ( free >= 0 ) bench[free] = bench[slot];
  }
  bench[slot] = id;
  data.bench = bench;
  await save(actor, data);
}

export async function unbenchProject(actor, id) {
  const data = workshopData(actor);
  data.bench = data.bench.map(b => (b === id ? null : b));
  await save(actor, data);
}

/** Hours worked before the next Maker check: an invention is checked halfway, everything else at the end. */
export function checkAt(p) {
  const hours = int(p.hours);
  return ((p.type === "invent") && !p.checked) ? Math.max(1, Math.ceil(hours / 2)) : hours;
}

/** Have the materials a project lists been acquired (the GM ticks it)? Nothing listed: nothing to wait for. */
export function materialsOk(p) {
  return !text(p?.materials) || !!p.materialsReady;
}

/** Can a project go on the bench (approved, materials in, and hours to go before its check or its end)? */
export function workable(p) {
  return (p?.status === "approved") && materialsOk(p) && (int(p.progress) < checkAt(p));
}

/** Is a project waiting on its Maker check (and not already rolled, waiting for the GM)? */
export function needsRoll(p) {
  if ( (p?.status !== "approved") || p.pendingRoll || (int(p.progress) < checkAt(p)) ) return false;
  return (p.type !== "invent") || !p.checked;
}

/** Keep the projects that are still on the bench, in the slots this character has. Nothing moves by itself. */
function tidyBench(actor, data) {
  const size = benchSize(actor);
  const ids = new Set(data.projects.filter(staysOnBench).map(p => p.id));
  return Array.from({ length: size }, (_, i) => (ids.has(data.bench[i]) ? data.bench[i] : null));
}

/**
 * A project stays in its slot until the player takes it off, finishes it, or it's deleted: through rolls, failures
 * (back to 0 hours) and completion. Only work in progress gets hours.
 */
function staysOnBench(p) {
  return (p.status === "approved") || ((p.status === "complete") && !p.finished);
}

/**
 * What spending hours on the bench would do: the main project gets them, and with a Workshop each extra slot gets
 * the same hours, if the main project is Maker work (not Repair). Hours are capped at the main project's remainder.
 */
export function benchPlan(actor, data = workshopData(actor)) {
  const byId = new Map(data.projects.map(p => [p.id, p]));
  const bench = tidyBench(actor, data).map(id => byId.get(id) ?? null);
  const main = bench[0];
  const remaining = p => Math.max(0, checkAt(p) - int(p.progress));
  const echoes = (main && !PROJECT_TYPES[main.type].noWorkshop);
  return {
    bench,
    main,
    echoes,
    max: workable(main) ? Math.min(data.bank, remaining(main)) : 0,
    gets: (p, i, hours) => {
      if ( !workable(p) ) return 0;
      if ( i === 0 ) return Math.min(hours, remaining(p));
      return (echoes && !PROJECT_TYPES[p.type].noWorkshop) ? Math.min(hours, remaining(p)) : 0;
    }
  };
}

/** Spend banked hours on the bench. */
export async function work(actor, hours) {
  const data = workshopData(actor);
  const plan = benchPlan(actor, data);
  hours = Math.min(int(hours), plan.max);
  if ( !hours ) return;
  const parts = [];
  plan.bench.forEach((p, i) => {
    const gain = plan.gets(p, i, hours);
    if ( !gain ) return;
    const target = data.projects.find(x => x.id === p.id);
    target.progress = int(target.progress) + gain;
    parts.push(`${target.name} +${gain}h`);
  });
  data.bank -= hours;
  const touched = plan.bench.filter(Boolean).map(p => data.projects.find(x => x.id === p.id));
  const ready = touched.filter(needsRoll);
  // An invention that passed its halfway check is done once the rest of the hours are in.
  const finished = touched.filter(p => (p.type === "invent") && p.checked && (int(p.progress) >= int(p.hours)));
  for ( const p of finished ) {
    p.status = "complete";
    p.completed = currentDateLabel() ?? "";
  }
  await save(actor, data, { type: "work", hours: -hours, text: game.i18n.format("CPRHQ.Workshop.log.work", { n: hours, parts: parts.join(", ") }) });
  for ( const p of ready ) ui.notifications.info(game.i18n.format(p.type === "invent" ? "CPRHQ.Workshop.halfwayNotice" : "CPRHQ.Workshop.readyNotice", { name: p.name }));
  for ( const p of finished ) ui.notifications.info(game.i18n.format("CPRHQ.Workshop.inventedNotice", { name: p.name }));
}

/**
 * Roll the Maker check for a project that has its hours (an invention: halfway), using CPR's own Role Ability roll:
 * its roll dialog (mods, LUCK) and chat card. The result waits for the GM to call it a success or a failure.
 * @param {Event} [event]  The click, so CPR's ctrl-click "skip the dialog" works as on the character sheet
 */
export async function rollProject(actor, id, event) {
  const data = workshopData(actor);
  const project = data.projects.find(p => p.id === id);
  if ( !needsRoll(project) ) return;
  const cprRoll = await makerRoll(actor, project, event);
  if ( !cprRoll ) return;
  const crit = cprRoll.criticalRoll ? (cprRoll.wasCritFail() ? -cprRoll.criticalRoll : cprRoll.criticalRoll) : 0;
  project.pendingRoll = { time: Date.now(), date: currentDateLabel() ?? "", total: cprRoll.resultTotal, die: cprRoll.initialRoll, crit,
    dv: int(project.dv), user: game.user.id };
  // The GM decides with Succeed / Fail on the project (bench slot or card).
  await save(actor, data, { type: "roll", project: id, text: game.i18n.format("CPRHQ.Workshop.log.rolled", { name: project.name, total: cprRoll.resultTotal }) });
  return project.pendingRoll;
}

/** CPR Role Ability roll: specialty rank + TECH (from the Tech Role item) + the project's skill, with Active Effect mods. */
async function makerRoll(actor, project, event) {
  const root = path => foundry.utils.getRoute(`systems/${game.system.id}/modules/${path}`);
  const [CPRRolls, { default: CPRChat }, { default: CPRMod }, { default: SystemUtils }] = await Promise.all([
    import(root("rolls/cpr-rolls.js")), import(root("chat/cpr-chat.js")), import(root("rolls/cpr-modifiers.js")),
    import(root("utils/cpr-systemUtils.js"))
  ]);
  const role = actor.itemTypes.role?.find(r => r.name.toLowerCase() === "tech");
  const specialty = PROJECT_TYPES[project.type].specialty;
  if ( !role?.system.abilities?.some(a => a.name === specialty) ) {
    ui.notifications.warn(game.i18n.format("CPRHQ.Workshop.noSpecialty", { name: specialty }));
    return null;
  }
  const cprRoll = role.createRoll(CPRRolls.rollTypes.ROLEABILITY, actor, { rollSubType: "subRoleAbility", subRoleName: specialty });
  // The specialty has no fixed skill: the project's skill joins TECH and the rank, with its Active Effect bonuses.
  cprRoll.skillName = project.skill;
  cprRoll.skillValue = skillLevel(actor, project.skill);
  const mods = CPRMod.getAllModifiers(Array.from(actor.allApplicableEffects()))
    .filter(m => !m.isSituational || m.onByDefault);
  const slug = SystemUtils.slugify(project.skill);
  cprRoll.addMod(CPRMod.getRelevantMods(mods, [slug, `${slug}Hearing`, `${slug}Sight`]));
  cprRoll.rollTitle = specialty;
  const go = await cprRoll.handleRollDialog(event ?? { ctrlKey: false, metaKey: false, type: "click" }, actor, role);
  if ( !go ) return null;
  await cprRoll.roll();
  // LUCK spent in the dialog, as the character sheet does.
  if ( Number.isInteger(cprRoll.luck) && (cprRoll.luck > 0) ) {
    const luck = actor.system.stats.luck.value;
    await actor.update({ "system.stats.luck.value": luck - Math.min(cprRoll.luck, luck) });
  }
  cprRoll.entityData = { actor: actor.id, token: null, item: role.id };
  await CPRChat.RenderRollCard(cprRoll);
  return cprRoll;
}

/** Is a project's roll waiting for the GM? */
export function awaitingVerdict(p) {
  return !!p?.pendingRoll;
}

/**
 * GM: settle a pending roll. Success completes the project (an invention's halfway check unlocks the rest of its
 * hours); failure starts it over (an invention: back to the drawing board). Everyone sees the outcome in chat.
 */
export async function resolveRoll(actor, id, success) {
  if ( !game.user.isGM ) return;
  const data = workshopData(actor);
  const project = data.projects.find(p => p.id === id);
  const pending = project?.pendingRoll;
  // Another GM (or the card buttons) may have decided it already.
  if ( !pending ) return ui.notifications.info("CPRHQ.Workshop.alreadyResolved", { localize: true });
  const halfway = (project.type === "invent") && !project.checked;
  project.attempts = [...(project.attempts ?? []), { ...pending, success }];
  delete project.pendingRoll;
  if ( success && halfway ) {
    project.checked = true;
    if ( int(project.progress) >= int(project.hours) ) project.status = "complete";
  }
  else if ( success ) {
    project.status = "complete";
    project.completed = currentDateLabel() ?? "";
  }
  else project.progress = 0;
  await save(actor, data, { type: "roll", project: id, text: game.i18n.format(success ? "CPRHQ.Workshop.log.success" : "CPRHQ.Workshop.log.fail",
    { name: project.name, total: pending.total }) });

  const hint = success ? (halfway ? "CPRHQ.Workshop.successHint.halfway" : `CPRHQ.Workshop.successHint.${project.type}`)
    : (halfway ? "CPRHQ.Workshop.failureHintInvent" : "CPRHQ.Workshop.failureHint");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="cpr-hq-chat cpr-hq-ws-roll ${success ? "success" : "failure"}">
        <h3><i class="${PROJECT_TYPES[project.type].icon}"></i> ${Handlebars.escapeExpression(project.name)}</h3>
        <p class="ws-roll-total"><strong>${loc(success ? "CPRHQ.Workshop.success" : "CPRHQ.Workshop.failure")}</strong>
          <small>(${pending.total}${project.hideDV ? "" : ` vs DV ${pending.dv}`})</small></p>
        <p class="hint">${loc(hint)}</p>
      </div>`
  });
}

/** TECH + Skill + Specialty rank (Repair: Field Expertise, which adds to non-Maker TECH checks). */
export function checkBonus(actor, project) {
  const profile = techProfile(actor);
  const specialty = PROJECT_TYPES[project.type].specialty;
  const parts = [
    ["TECH", profile.tech],
    [project.skill || "—", skillLevel(actor, project.skill)],
    [specialty, profile.specialties.find(s => s.name === specialty)?.rank ?? 0]
  ];
  return { parts, total: parts.reduce((n, [, v]) => n + v, 0) };
}

/** Take a completed project off the bench (nothing is added to the character's gear: the GM hands items out). */
export async function finishProject(actor, id) {
  const data = workshopData(actor);
  const project = data.projects.find(p => p.id === id);
  if ( !project || (project.status !== "complete") || project.finished ) return;
  project.finished = true;
  data.bench = data.bench.map(b => (b === id ? null : b));
  await save(actor, data, { type: "finish", project: id, text: game.i18n.format("CPRHQ.Workshop.log.finish", { name: project.name }) });
}

/**
 * A new approved Fabricate project from an invention or an earlier fabrication. It keeps the DV and hours the GM set,
 * which may not match the Maker table (or have no Price Category at all), and its materials still have to be bought.
 */
export function fabricationOf(source) {
  const project = cleanProject({ type: "fabricate", name: source.name, skill: source.skill, category: source.category,
    item: source.item, details: source.details, image: source.image });
  const invented = source.type === "invent";
  const materials = (invented && source.category) ? materialsFor("fabricate", source.category, project.price) : (source.materials ?? "");
  const inventionOf = invented ? source.id : source.inventionOf;
  return Object.assign(project, { dv: source.dv, hours: source.hours, materials, status: "approved", rules: source.rules ?? "",
    hideDV: !!source.hideDV }, inventionOf ? { inventionOf } : {});
}

/** What a Tech can make again: finished inventions and fabrications, one per item, each with its latest run. */
export function designsOf(data) {
  const designs = new Map();
  for ( const p of data.projects ) {
    if ( !p.finished || !["invent", "fabricate"].includes(p.type) ) continue;
    const key = p.item?.uuid ?? p.name;
    const design = designs.get(key) ?? { invented: false, made: 0 };
    design.source = p;
    if ( (p.type === "invent") || p.inventionOf ) design.invented = true;
    if ( p.type === "fabricate" ) design.made++;
    designs.set(key, design);
  }
  return [...designs.values()];
}

/** Make a finished design again: a new approved project, off the bench (the bench never changes by itself). */
export async function fabricateAgain(actor, id) {
  const data = workshopData(actor);
  const source = data.projects.find(p => p.id === id);
  if ( !source?.finished || !["invent", "fabricate"].includes(source.type) ) return;
  const project = fabricationOf(source);
  data.projects.push(project);
  await save(actor, data, { type: "propose", project: project.id, text: game.i18n.format("CPRHQ.Workshop.log.again", { name: project.name }) });
}

/** Invented: the prototype is a new Fabricate project with the invention's DV and hours, already approved. */
export async function startPrototype(actor, id) {
  const data = workshopData(actor);
  const invention = data.projects.find(p => p.id === id);
  if ( !invention || (invention.type !== "invent") || (invention.status !== "complete") ) return;
  const project = fabricationOf(invention);
  data.projects.push(project);
  // The prototype takes the invention's bench slot.
  invention.finished = true;
  data.bench = data.bench.map(b => (b === invention.id ? project.id : b));
  await save(actor, data, { type: "propose", project: project.id, text: game.i18n.format("CPRHQ.Workshop.log.prototype", { name: project.name }) });
}

/* -------------------------------------------- */
/*  GM actions                                  */
/* -------------------------------------------- */

/** GM: save the review (DV, hours, materials, fields) and set the status (approved, returned, or unchanged). */
export async function reviewProject(actor, id, input, status) {
  if ( !game.user.isGM ) return;
  const data = workshopData(actor);
  const i = data.projects.findIndex(p => p.id === id);
  if ( i < 0 ) return;
  const project = cleanProject(input, data.projects[i]);
  project.dv = int(input.dv, 1);
  project.hours = int(input.hours, 1);
  project.progress = Math.min(int(input.progress ?? project.progress), project.hours);
  project.materials = text(input.materials);
  project.materialsReady = !!input.materialsReady;
  project.gmNote = text(input.gmNote);
  project.rules = text(input.rules);
  project.hideDV = !!input.hideDV;
  if ( status ) project.status = status;
  data.projects[i] = project;
  const log = status ? { type: status, project: id, text: game.i18n.format(`CPRHQ.Workshop.log.${status}`, { name: project.name }) } : null;
  await save(actor, data, log);
}

/** GM: grant (or remove) banked Tech hours. */
export async function adjustBank(actor, hours, reason = "") {
  const data = workshopData(actor);
  hours = Math.trunc(Number(hours) || 0);
  if ( !hours ) return;
  data.bank = Math.max(0, data.bank + hours);
  await save(actor, data, { type: "bank", hours, text: reason || loc("CPRHQ.Workshop.log.adjust") });
}

/**
 * Settled downtime: the hours each Tech spent on Workshop activities ("Tech" work) this round become their bank.
 * Hours left over from the previous round are lost: banked time only lasts until the next round settles.
 * Runs on the settling GM.
 */
export async function bankDowntime(round, actors, activityDefs) {
  const workshop = new Set(activityDefs.filter(a => a.mechanic === "workshop").map(a => a.id));
  for ( const actor of actors ) {
    const history = actor.getFlag(MODULE_ID, "downtimeHistory") ?? [];
    const entry = history.findLast(h => h.roundId === round.id);
    const hours = (entry?.blocks ?? []).filter(b => workshop.has(b.activity)).reduce((n, b) => n + b.length, 0);
    const data = workshopData(actor);
    const lost = data.bank;
    if ( !hours && !lost ) continue;
    if ( lost ) data.log.push({ id: foundry.utils.randomID(), time: Date.now(), date: currentDateLabel() ?? "", user: game.user.name,
      type: "bank", hours: -lost, text: game.i18n.format("CPRHQ.Workshop.log.expired", { n: lost }) });
    data.bank = hours;
    await save(actor, data, hours ? { type: "bank", hours, text: game.i18n.format("CPRHQ.Workshop.log.downtime", { n: hours }) } : null);
  }
}

/* -------------------------------------------- */
/*  Notifications                               */
/* -------------------------------------------- */

/** Whisper the GMs that a project is waiting for review. */
async function notifyGM(actor, project) {
  const gms = ChatMessage.getWhisperRecipients("GM");
  if ( !gms.length ) return;
  await ChatMessage.create({
    whisper: gms.map(u => u.id),
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="cpr-hq-chat cpr-hq-ws-notice">
        <p><i class="${PROJECT_TYPES[project.type].icon}"></i> ${game.i18n.format("CPRHQ.Workshop.notifyGM", {
          actor: Handlebars.escapeExpression(actor.name), type: loc(`CPRHQ.Workshop.type.${project.type}`), name: Handlebars.escapeExpression(project.name) })}</p>
        <button type="button" data-cpr-hq-workshop="${actor.uuid}"><i class="fa-solid fa-screwdriver-wrench"></i> ${loc("CPRHQ.Workshop.review")}</button>
      </div>`
  });
}
