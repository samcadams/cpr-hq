import { MODULE_ID } from "./constants.mjs";
import { isHQ, getHQ } from "./hq.mjs";
import { lifestyleModifier, isFullCrew } from "./benefits.mjs";
import { formatNumber } from "./utils.mjs";
import { setTrauma, traumaCard, traumaState } from "./trauma.mjs";
import { appsCard, appsState, appsTip } from "./apps-subs.mjs";
import { rule } from "./rules.mjs";

/**
 * Lifestyle & Housing for characters. Works with or without an HQ: the Downtime/Lifestyle window (macro or the
 * character sheet's "Lifestyle" button) and the HQ sheet's Downtime/Lifestyle tab both use the cards built here.
 *
 * Storage, on the character:
 *  - CPR's own fields: system.lifestyle.lifeStyle {cost, description} and system.lifestyle.housing {cost, description}
 *    (kept in sync so anything reading CPR data sees the right values).
 *  - flags.cpr-hq.housing {id, purchased, uncomfortable}: what CPR has no field for.
 */

export const PRESETS_SETTING = "lifestylePresets";
const HOUSING_FLAG = "housing";
const BAD_SLEEP_FLAG = "badSleep";
const SYSTEM_ID = "cyberpunk-red-core";

const loc = key => game.i18n.localize(key);

/* -------------------------------------------- */
/*  Catalogues                                  */
/* -------------------------------------------- */

/** Core rulebook Lifestyles (monthly cost in eb). Names/descriptions in lang: CPRHQ.Lifestyle.<id>, .desc.<id>. */
const LIFESTYLES = [
  { id: "kibble", cost: 100 },
  { id: "genericPrepak", cost: 300 },
  { id: "goodPrepak", cost: 600 },
  { id: "freshFood", cost: 1500 }
];

/**
 * Black Chrome's taxi perk (p. 130): free rides per period ("day"|"week"|"month"); `anywhere` false = only to and
 * from Moderate, Corporate or Executive zones (Combat Cabb: neither end in a Combat Zone or the Hot Zone).
 * Custom presets have none. Read by other modules through api.lifestyle.of (Combat Cabb's ride credit).
 */
const TAXI = {
  kibble: { per: "month", anywhere: false },
  genericPrepak: { per: "week", anywhere: false },
  goodPrepak: { per: "day", anywhere: false },
  freshFood: { per: "day", anywhere: true }
};

/**
 * Housing options. rent: eb/month (null = none). provided: the company pays. buy: purchase price (null = can't buy).
 * check: a nightly check the character has to make (shown as text, not automated).
 */
export const HOUSING = [
  { id: "street", rent: null, buy: null, check: "street" },
  { id: "wilderness", rent: null, buy: null, check: "wilderness" },
  { id: "vehicle", rent: null, buy: null },
  { id: "cube", rent: 500, buy: null },
  { id: "cargo", rent: 1000, buy: 15000 },
  { id: "studio", rent: 1500, buy: 25000 },
  { id: "twoBedroom", rent: 2500, buy: 25000 },
  { id: "corpConapt", rent: 0, provided: true, buy: null },
  { id: "upscaleConapt", rent: 7500, buy: 85000 },
  { id: "penthouse", rent: 15000, buy: 150000 },
  { id: "beavervilleHouse", rent: 0, provided: true, buy: 200000 },
  { id: "beavervilleMansion", rent: 0, provided: true, buy: 500000 }
];

export function registerLifestyleSettings(onChange) {
  game.settings.register(MODULE_ID, PRESETS_SETTING, {
    name: `CPRHQ.Settings.${PRESETS_SETTING}.name`, hint: `CPRHQ.Settings.${PRESETS_SETTING}.hint`,
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange
  });
}

/** Every Lifestyle preset: the rulebook's, then the GM's. {id, name, cost, description, custom} */
export function lifestylePresets() {
  const builtin = LIFESTYLES.map(p => {
    const descKey = `CPRHQ.Lifestyle.desc.${p.id}`;
    return { id: p.id, name: loc(`CPRHQ.Lifestyle.${p.id}`), cost: p.cost,
      description: game.i18n.has(descKey) ? loc(descKey) : "", custom: false };
  });
  const custom = (game.settings.get(MODULE_ID, PRESETS_SETTING) ?? []).map(p => ({ ...p, custom: true }));
  return [...builtin, ...custom];
}

/** GM: replace the custom presets. */
export async function saveCustomPresets(list) {
  await game.settings.set(MODULE_ID, PRESETS_SETTING, list.map(p => ({
    id: p.id || `custom${foundry.utils.randomID(6)}`,
    name: String(p.name ?? "").trim(),
    cost: Math.max(0, Math.floor(Number(p.cost) || 0)),
    description: String(p.description ?? "").trim()
  })).filter(p => p.name));
}

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/** The HQ this character lives in as a tenant (active, accessible HQs only), or null. */
export function residence(actor) {
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) ) continue;
    const hq = getHQ(entry);
    if ( !hq.hasAccess || hq.isFaction ) continue;
    if ( hq.crew.some(m => (m.uuid === actor.uuid) && m.tenant) ) return entry;
  }
  return null;
}

/** Morale Boost etc.: Lifestyle discount from the HQ(s) this character is full crew of (best one applies). */
function lifestyleDiscount(actor) {
  let best = 0;
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) ) continue;
    const hq = getHQ(entry);
    const member = hq.crew.find(m => m.uuid === actor.uuid);
    if ( !member || !isFullCrew(hq, member) ) continue;
    best = Math.min(best, lifestyleModifier(hq));
  }
  return best;
}

/** Saved housing choice; characters without one are matched to CPR's housing description (default Cargo Container). */
function housingId(actor) {
  const saved = actor.getFlag(MODULE_ID, HOUSING_FLAG)?.id;
  if ( HOUSING.some(h => h.id === saved) ) return saved;
  const description = actor.system.lifestyle?.housing?.description?.replace(/<[^>]*>/g, "").trim().toLowerCase();
  return HOUSING.find(h => loc(`CPRHQ.Housing.${h.id}`).toLowerCase() === description)?.id ?? "cargo";
}

/**
 * Everything about a character's Lifestyle and Housing, including what the next Lifestyle bill charges.
 * Housing rent isn't charged when the home is bought, company-provided, or the HQ (the HQ bill covers that).
 * With the Agent module, an active paid Trauma Team plan is on the bill too (see trauma.mjs), and so are App Store
 * subscriptions while its App Store is on (apps-subs.mjs); neither while the Agent bills them itself (billAgentPlans off).
 */
export function lifestyleState(actor) {
  const flag = actor.getFlag(MODULE_ID, HOUSING_FLAG) ?? {};
  const housing = HOUSING.find(h => h.id === housingId(actor));
  const home = residence(actor);
  const purchased = !!flag.purchased && (housing.buy !== null);
  const life = actor.system.lifestyle?.lifeStyle ?? { cost: 0, description: "" };
  const discount = lifestyleDiscount(actor);
  const housingCharge = (home || purchased || housing.provided || (housing.rent === null)) ? 0 : housing.rent;
  const lifestyleCharge = Math.max(0, (life.cost ?? 0) + discount);
  const billed = rule("billAgentPlans");
  const trauma = traumaState(actor);
  const traumaCharge = billed ? (trauma?.charge ?? 0) : 0;
  const apps = billed ? appsState(actor) : null;
  const appsCharge = apps?.charge ?? 0;
  return {
    housing, home, purchased, uncomfortable: !!flag.uncomfortable,
    lifestyle: { cost: life.cost ?? 0, description: life.description?.replace(/<[^>]*>/g, "").trim() ?? "" },
    discount, housingCharge, lifestyleCharge, trauma, traumaCharge, apps, appsCharge,
    total: housingCharge + lifestyleCharge + traumaCharge + appsCharge
  };
}

/** The GM-approved preset a character's Lifestyle matches (same name and cost), or undefined. */
function matchPreset(life, presets = lifestylePresets()) {
  return presets.find(p => (p.name === life.description) && (p.cost === life.cost));
}

/**
 * A character's Lifestyle for other modules (api.lifestyle.of): { preset (id, null when the GM typed it by hand),
 * name, cost, custom, perks: { taxi: { per, anywhere } | null } }, or null when the actor has no Lifestyle.
 */
export function lifestyleOf(actor) {
  const life = actor?.system?.lifestyle?.lifeStyle;
  if ( !life ) return null;
  const name = life.description?.replace(/<[^>]*>/g, "").trim() ?? "";
  const cost = life.cost ?? 0;
  const preset = matchPreset({ description: name, cost });
  const taxi = (preset && !preset.custom && TAXI[preset.id]) ? { ...TAXI[preset.id] } : null;
  return { preset: preset?.id ?? null, name: preset?.name ?? name, cost, custom: !!preset?.custom, perks: { taxi } };
}

/* -------------------------------------------- */
/*  Changes (owner or GM)                       */
/* -------------------------------------------- */

function flagUpdate(actor, changes) {
  const current = actor.getFlag(MODULE_ID, HOUSING_FLAG) ?? {};
  return { [`flags.${MODULE_ID}.${HOUSING_FLAG}`]: { ...current, ...changes } };
}

export async function setHousing(actor, id) {
  const housing = HOUSING.find(h => h.id === id);
  if ( !housing ) return;
  await actor.update({
    ...flagUpdate(actor, { id, purchased: false }),
    "system.lifestyle.housing.description": loc(`CPRHQ.Housing.${id}`),
    "system.lifestyle.housing.cost": housing.rent ?? 0
  });
}

export async function setPurchased(actor, purchased) {
  const housing = HOUSING.find(h => h.id === housingId(actor));
  await actor.update({
    ...flagUpdate(actor, { purchased: !!purchased }),
    "system.lifestyle.housing.cost": purchased ? 0 : (housing?.rent ?? 0)
  });
}

export async function setUncomfortable(actor, uncomfortable) {
  await actor.update(flagUpdate(actor, { uncomfortable: !!uncomfortable }));
  await syncBadSleep(actor, !!uncomfortable);
}

export async function setLifestyle(actor, { description, cost }) {
  const update = {};
  if ( description !== undefined ) update["system.lifestyle.lifeStyle.description"] = String(description).trim();
  if ( cost !== undefined ) update["system.lifestyle.lifeStyle.cost"] = Math.max(0, Math.floor(Number(cost) || 0));
  await actor.update(update);
}

/**
 * "Bad sleep": sleeping uncomfortably leaves you Fatigued (−2 to everything) the next day.
 * CPR has no "all checks" key, so the effect carries −2 on every skill the character has plus CPR's universal
 * attack modifier, all as roll-dialog situational options that start ticked (players can untick them).
 */
export async function setBadSleep(actor, on) {
  return syncBadSleep(actor, on);
}

async function syncBadSleep(actor, on) {
  const existing = actor.effects.filter(e => e.getFlag(MODULE_ID, BAD_SLEEP_FLAG));
  if ( !on ) {
    if ( existing.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(e => e.id));
    return;
  }
  if ( existing.length ) return;
  const keys = [...new Set(actor.itemTypes.skill.map(s => `bonuses.${slugify(s.name)}`))];
  const changes = [...keys.map(key => ({ key, cat: "skill" })), { key: "bonuses.universalAttack", cat: "combat" }];
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: loc("CPRHQ.Housing.badSleep"),
    img: "icons/svg/sleep.svg",
    changes: changes.map(c => ({ key: c.key, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "-2" })),
    flags: {
      [MODULE_ID]: { [BAD_SLEEP_FLAG]: true },
      [SYSTEM_ID]: {
        changes: {
          cats: Object.fromEntries(changes.map((c, i) => [String(i), c.cat])),
          situational: Object.fromEntries(changes.map((c, i) => [String(i), { isSituational: true, onByDefault: true }]))
        }
      }
    }
  }]);
}

/** CPR's skill-name slug (same rules as effects.mjs). */
function slugify(name) {
  const join = name.split(" ").join("");
  if ( ["Conceal/Reveal Object", "Paint/Draw/Sculpt", "Resist Torture/Drugs"].includes(name) ) {
    const s = join.split("/").join("Or");
    return s.charAt(0).toLowerCase() + s.slice(1);
  }
  if ( name === "Language (Streetslang)" ) {
    const s = join.split("(").join("").split(")").join("");
    return s.charAt(0).toLowerCase() + s.slice(1);
  }
  const s = join.split("/").join("And").split("&").join("And");
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/* -------------------------------------------- */
/*  Cards (shared UI)                           */
/* -------------------------------------------- */

/** Characters a user manages here: the GM sees every player-owned character, players their own. */
export function lifestyleActors({ actors } = {}) {
  const list = actors ?? game.actors.filter(a => (a.type === "character")
    && (game.user.isGM ? game.users.some(u => !u.isGM && a.testUserPermission(u, "OWNER")) : a.isOwner));
  return list.filter(a => a?.system?.lifestyle?.lifeStyle && (game.user.isGM || a.isOwner))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Black Chrome's breakdown of a rulebook Lifestyle (p. 130): food, the Agent, entertainment, transport. Display only. */
const DETAIL_ICONS = { eat: "fa-utensils", comms: "fa-mobile-screen", fun: "fa-ticket", travel: "fa-train-subway" };
function lifestyleDetails(preset) {
  if (!preset || preset.custom || !game.i18n.has(`CPRHQ.Lifestyle.bc.${preset.id}.eat`)) return null;
  return Object.entries(DETAIL_ICONS).map(([key, icon]) => ({
    icon, label: loc(`CPRHQ.Lifestyle.bc.${key}`), text: loc(`CPRHQ.Lifestyle.bc.${preset.id}.${key}`)
  }));
}

/** Display data for one character's Lifestyle card. */
export function lifestyleCard(actor) {
  const state = lifestyleState(actor);
  const presets = lifestylePresets();
  const preset = matchPreset(state.lifestyle, presets);
  const rentLabel = h => h.provided ? loc("CPRHQ.Housing.provided")
    : (h.rent === null ? loc("CPRHQ.Housing.noRent") : `${formatNumber(h.rent)}eb/${loc("CPRHQ.Housing.month")}`);
  return {
    uuid: actor.uuid, name: actor.name, img: actor.img,
    editable: actor.isOwner,
    home: state.home ? { name: state.home.name } : null,
    housingOptions: HOUSING.map(h => ({
      id: h.id, label: `${loc(`CPRHQ.Housing.${h.id}`)} (${rentLabel(h)})`, selected: h.id === state.housing.id
    })),
    housingName: loc(`CPRHQ.Housing.${state.housing.id}`),
    canBuy: state.housing.buy !== null,
    buyLabel: state.housing.buy !== null ? game.i18n.format("CPRHQ.Housing.purchased", { price: formatNumber(state.housing.buy) }) : "",
    purchased: state.purchased,
    check: state.housing.check ? loc(`CPRHQ.Housing.check.${state.housing.check}`) : "",
    uncomfortable: state.uncomfortable,
    presetOptions: presets.map(p => ({ id: p.id, label: `${p.name} (${formatNumber(p.cost)}eb)`, selected: p === preset })),
    presetDescription: preset?.description ?? "",
    presetDetails: lifestyleDetails(preset),
    lifestyle: state.lifestyle,
    discount: state.discount ? formatNumber(state.discount) : null,
    trauma: traumaCard(actor),
    // Read-only, for the bill: gone while the Agent bills subscriptions itself.
    apps: rule("billAgentPlans") ? appsCard(actor) : null,
    charges: {
      housing: formatNumber(state.housingCharge),
      lifestyle: formatNumber(state.lifestyleCharge),
      total: formatNumber(state.total)
    },
    housingNote: (!state.home && state.housing.provided) ? loc("CPRHQ.Housing.providedNote") : "",
    // Only GM-approved presets are offered; values the GM typed by hand show as their own entry.
    gmSet: !preset ? `${state.lifestyle.description || "—"} (${formatNumber(state.lifestyle.cost)}eb)` : null,
    canEditValues: game.user.isGM
  };
}

/**
 * Wire up Lifestyle cards inside any rendered element (the window or the HQ tab). Changes write straight to the
 * character; the "change" event is stopped so a host form (the HQ sheet) doesn't also submit.
 */
export function activateLifestyleCards(root) {
  for ( const card of root.querySelectorAll("[data-ls-actor]") ) {
    const actor = fromUuidSync(card.dataset.lsActor);
    if ( !actor?.isOwner ) continue;
    card.addEventListener("change", async event => {
      const field = event.target.dataset.ls;
      if ( !field ) return;
      event.stopPropagation();
      const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      if ( field === "housing" ) return setHousing(actor, value);
      if ( field === "purchased" ) return setPurchased(actor, value);
      if ( field === "uncomfortable" ) return setUncomfortable(actor, value);
      if ( field === "preset" ) {
        const preset = lifestylePresets().find(p => p.id === value);
        if ( preset ) return setLifestyle(actor, { description: preset.name, cost: preset.cost });
        return;
      }
      if ( field === "description" ) return setLifestyle(actor, { description: value });
      if ( field === "cost" ) return setLifestyle(actor, { cost: value });
      // Trauma Team (with the Agent module): a plan or none; GM: lapsed, and who pays for it.
      if ( field === "tt-plan" ) return setTrauma(actor, { plan: value });
      if ( field === "tt-lapsed" ) return setTrauma(actor, { status: value ? "lapsed" : "active" });
      if ( field === "tt-sponsor" ) return setTrauma(actor, { sponsor: value });
    });
  }
}

/** Proposed Lifestyle bill lines for a set of characters. */
export function proposeLifestyleBill(actors) {
  return actors.map(actor => {
    const state = lifestyleState(actor);
    return {
      uuid: actor.uuid, name: actor.name, wealth: actor.system.wealth?.value ?? null,
      charges: { housing: state.housingCharge, lifestyle: state.lifestyleCharge, trauma: state.traumaCharge, apps: state.appsCharge },
      tips: { housing: loc(`CPRHQ.Housing.${state.housing.id}`), lifestyle: state.lifestyle.description,
        trauma: state.trauma?.plan?.name ?? "", apps: appsTip(state.apps) }
    };
  });
}
