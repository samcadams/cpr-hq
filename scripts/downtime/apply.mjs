import { MODULE_ID } from "../constants.mjs";
import { formatNumber } from "../utils.mjs";
import { blockSpec, costsOf, dayLabel, parseCost, HOURS } from "./model.mjs";

/**
 * Applying a settled round's results (healing, Humanity from therapy, costs). Nothing happens by itself: the GM presses
 * Apply, Deduct or Skip per row in the Downtime section, and can adjust the value first (failed or partial rolls aren't
 * automated).
 *
 * Done rows are kept on the round in history: flags.cpr-hq.downtimeHistory[n].applied = {heal, humanity, paid}, each
 * {[key]: {value} | {note: true} | {skipped: true}}. Rounds settled before this existed have no `applied`, and never
 * show: their costs were settled by hand.
 */

const HISTORY_FLAG = "downtimeHistory";
/** HP per day as a multiple of BODY, by activity or activity-variant. */
const HEAL_RATES = { naturalHealing: 1, "medical-hospital": 1.5 };
const THERAPIES = ["therapy", "therapyExtreme", "therapyAddiction"];
const ADDICTION = "therapyAddiction";

const loc = key => game.i18n.localize(`CPRHQ.Downtime.apply.${key}`);
const fmt = (key, data) => game.i18n.format(`CPRHQ.Downtime.apply.${key}`, data);

/** Therapy prices are in the activity's text (which the GM can edit): "Costs 500eb, or 100eb (in materials) ...". */
function therapyCost(spec) {
  const match = String(spec.description ?? "").replace(/,/g, "").match(/Costs (\d+)eb(?: or (\d+)eb \(in materials\))?/i);
  return match ? { value: Number(match[1]), materials: match[2] ? Number(match[2]) : null } : null;
}

/** Every effect of a settled round, done or not: [{kind, key, name, day?, detail?, value?, formula?, materials?, note?}]. */
function effectsOf(actor, entry) {
  const body = actor.system.stats?.body?.value ?? 0;
  const healing = new Map();
  const humanity = [];
  const paid = [];
  const seen = new Set();
  for ( const block of entry.blocks ) {
    const spec = blockSpec(block);
    const healKey = block.variant ? `${block.activity}-${block.variant}` : block.activity;
    if ( HEAL_RATES[healKey] ) {
      const row = healing.get(healKey) ?? { kind: "heal", key: healKey, name: spec.fullName, days: 0, rate: HEAL_RATES[healKey] };
      row.days += Math.max(1, Math.floor(block.length / spec.hours));
      healing.set(healKey, row);
    }
    // A multi-day activity counts once, for the rest.
    const key = block.group ?? block.id;
    if ( seen.has(key) ) continue;
    seen.add(key);
    const day = dayLabel(entry.start, Math.floor(block.start / HOURS));
    const formula = String(spec.description ?? "").match(/Recover (\d+d\d+) Humanity/i)?.[1];
    if ( block.activity === ADDICTION ) humanity.push({ kind: "humanity", key, name: spec.fullName, day, note: true });
    else if ( formula ) humanity.push({ kind: "humanity", key, name: spec.fullName, day, formula });
    const line = costsOf(entry, [block])[0];
    if ( line ) paid.push({ kind: "paid", key, name: line.name, day, value: parseCost(line.cost).value, costText: line.cost });
    else if ( THERAPIES.includes(block.activity) ) {
      const cost = therapyCost(spec);
      if ( cost ) paid.push({ kind: "paid", key, name: spec.fullName, day, ...cost, costText: `${formatNumber(cost.value)}eb` });
    }
  }
  const heal = [...healing.values()].map(row => ({
    ...row, value: Math.floor(body * row.rate) * row.days, detail: fmt("healDetail", { days: row.days, body, rate: row.rate })
  }));
  return [...heal, ...humanity, ...paid];
}

/**
 * GM's panel: rounds with results still to apply, oldest first, each with its characters and their open rows.
 * @param {Actor[]} actors
 */
export function applyContext(actors) {
  if ( !game.user.isGM ) return [];
  const rounds = new Map();
  for ( const actor of actors ) {
    for ( const entry of actor.getFlag(MODULE_ID, HISTORY_FLAG) ?? [] ) {
      if ( !entry.applied ) continue;
      const rows = effectsOf(actor, entry).filter(row => !entry.applied[row.kind]?.[row.key]);
      if ( !rows.length ) continue;
      if ( !rounds.has(entry.roundId) ) rounds.set(entry.roundId, {
        id: entry.roundId, start: entry.start, characters: [],
        label: fmt("round", { from: dayLabel(entry.start, 0), to: dayLabel(entry.start, entry.days - 1) })
      });
      const { hp, humanity } = actor.system.derivedStats;
      rounds.get(entry.roundId).characters.push({
        uuid: actor.uuid, name: actor.name,
        stats: fmt("stats", { hp: `${hp.value}/${hp.max}`, humanity: `${humanity.value}/${humanity.max}`, eb: formatNumber(actor.system.wealth?.value ?? 0) }),
        rows: rows.map(row => ({ ...row, isHeal: row.kind === "heal", isPaid: row.kind === "paid" }))
      });
    }
  }
  return [...rounds.values()].sort((a, b) => a.start - b.start);
}

/** What was applied to a character (not what was skipped), newest round first, for Past Days: [{label, lines}]. */
export function appliedResults(actor) {
  const out = [];
  for ( const entry of [...(actor?.getFlag(MODULE_ID, HISTORY_FLAG) ?? [])].reverse() ) {
    if ( !entry.applied ) continue;
    const lines = effectsOf(actor, entry).flatMap(row => {
      const done = entry.applied[row.kind]?.[row.key];
      if ( !done || done.skipped ) return [];
      if ( done.note ) return fmt("resultNote", { name: row.name });
      const key = { heal: "resultHeal", humanity: "resultHumanity", paid: "resultPaid" }[row.kind];
      return fmt(key, { name: row.name, n: formatNumber(done.value) });
    });
    if ( lines.length ) out.push({ label: fmt("round", { from: dayLabel(entry.start, 0), to: dayLabel(entry.start, entry.days - 1) }), lines });
  }
  return out;
}

/** GM and the character's owners only: the same people who see the results in Past Days. */
const recipients = actor => game.users.filter(u => u.isGM || actor.testUserPermission(u, "OWNER")).map(u => u.id);

/** Rows being applied right now, so a double click can't get past the "already done" check. */
const busy = new Set();

/**
 * GM: apply one row, or skip it. Refused if the row was already done.
 * @param {Actor} actor
 * @param {string} roundId
 * @param {string} kind             "heal", "humanity" or "paid"
 * @param {string} key
 * @param {object} [options]
 * @param {number|string} [options.value]  HP to heal, Humanity formula, or eb to deduct
 * @param {boolean} [options.skip]
 * @returns {Promise<boolean>} whether the row is now done
 */
export async function applyEffect(actor, roundId, kind, key, { value, skip = false } = {}) {
  if ( !game.user.isGM ) return false;
  const lock = `${actor.uuid}.${roundId}.${kind}.${key}`;
  if ( busy.has(lock) ) return false;
  busy.add(lock);
  try {
    const history = foundry.utils.deepClone(actor.getFlag(MODULE_ID, HISTORY_FLAG) ?? []);
    const entry = history.find(r => r.roundId === roundId);
    const row = entry?.applied && effectsOf(actor, entry).find(r => (r.kind === kind) && (r.key === key));
    if ( !row ) return false;
    if ( entry.applied[kind]?.[key] ) {
      ui.notifications.warn(loc("already"));
      return false;
    }
    const mark = done => {
      entry.applied[kind] = { ...entry.applied[kind], [key]: done };
      return { [`flags.${MODULE_ID}.${HISTORY_FLAG}`]: history };
    };
    if ( skip ) {
      await actor.update(mark({ skipped: true }));
      return true;
    }
    const done = await APPLIERS[kind](actor, row, value, mark);
    if ( !done ) return false;
    /** A row was applied (never for Skip): (actor, {roundId, kind, key, name, value?, note?}). */
    Hooks.callAll(`${MODULE_ID}.downtimeApplied`, actor, { roundId, kind, key, name: row.name, ...done });
    return true;
  } finally {
    busy.delete(lock);
  }
}

/** Whole, non-negative number from a field, or null. */
function amountOf(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && (n >= 0) ? n : null;
}

const APPLIERS = {
  /** HP and the "done" mark in one update, so they can't come apart. */
  async heal(actor, row, value, mark) {
    const amount = amountOf(value ?? row.value);
    if ( amount === null ) return invalid();
    const { hp } = actor.system.derivedStats;
    const after = Math.min(hp.max, hp.value + amount);
    const done = { value: after - hp.value };
    await actor.update({ "system.derivedStats.hp.value": after, ...mark(done) });
    return done;
  },

  /** A real Roll with its chat card. setMaxHumanity is the sheet's Humanity click: it recalculates EMP. */
  async humanity(actor, row, value, mark) {
    const speaker = ChatMessage.getSpeaker({ actor });
    const whisper = recipients(actor);
    if ( row.note ) {
      await ChatMessage.implementation.create({ speaker, whisper, content: `<p>${fmt("addictionNote", { actor: actor.name, name: row.name })}</p>` });
      const done = { note: true };
      await actor.update(mark(done));
      return done;
    }
    const formula = String(value ?? row.formula).trim();
    if ( !formula || !Roll.validate(formula) ) return invalid();
    const roll = await new Roll(formula).evaluate();
    // toMessage applies the roll mode, which would clear a whisper passed to it.
    const card = await roll.toMessage({ speaker, flavor: fmt("rollFlavor", { actor: actor.name, name: row.name }) }, { create: false });
    await ChatMessage.implementation.create({ ...card, whisper });
    const { humanity } = actor.system.derivedStats;
    const after = Math.min(humanity.max, humanity.value + Math.max(0, roll.total));
    const done = { value: after - humanity.value };
    await actor.update({ "system.derivedStats.humanity.value": after, ...mark(done) });
    await actor.setMaxHumanity();
    return done;
  },

  /** Marked first: the system's ledger call doesn't wait for its own update, and a double charge is the worse failure. */
  async paid(actor, row, value, mark) {
    const amount = amountOf(value ?? row.value);
    if ( !amount ) return invalid();
    const done = { value: amount };
    await actor.update(mark(done));
    const after = (actor.system.wealth?.value ?? 0) - amount;
    actor.deltaLedgerProperty("wealth", -amount, fmt("reason", { name: row.name }));
    if ( after < 0 ) ui.notifications.warn(fmt("short", { name: actor.name, eb: formatNumber(after) }));
    return done;
  }
};

function invalid() {
  ui.notifications.warn(loc("invalid"));
  return null;
}

/** Wire the panel. Saved changes redraw the window through the updateActor hook. */
export function activateApply(section) {
  const panel = section.querySelector(".dt-apply");
  if ( !panel ) return;

  panel.addEventListener("change", event => {
    const box = event.target.closest("[data-apply-materials]");
    if ( !box ) return;
    const row = box.closest(".dt-apply-row");
    row.querySelector("[data-apply-value]").value = box.checked ? row.dataset.materials : row.dataset.full;
  });

  panel.addEventListener("click", async event => {
    const button = event.target.closest("[data-apply-action]");
    if ( !button ) return;
    event.preventDefault();
    const row = button.closest(".dt-apply-row");
    const actor = fromUuidSync(row.closest("[data-apply-actor]").dataset.applyActor);
    const roundId = row.closest("[data-apply-round]").dataset.applyRound;
    const { kind, key } = row.dataset;
    const skip = button.dataset.applyAction === "skip";
    if ( !skip && (kind === "paid") && !row.querySelector("[data-apply-confirm]").checked ) {
      return ui.notifications.warn(loc("confirmFirst"));
    }
    await applyEffect(actor, roundId, kind, key, { skip, value: row.querySelector("[data-apply-value]")?.value });
  });
}
