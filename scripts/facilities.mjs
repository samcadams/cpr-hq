import { MODULE_ID } from "./constants.mjs";
import { getHQ, updateHQ } from "./hq.mjs";
import { currentDateLabel } from "./calendar.mjs";

/**
 * Facility state for improvements that hold things: Garage (vehicles), Lockup (prisoners),
 * Workstation (the Improved Team Member). Mutations are GM-only.
 */

const loc = key => game.i18n.localize(key);
const esc = value => Handlebars.escapeExpression(value ?? "");

function facilities(entry) {
  return getHQ(entry).toObject().facilities;
}

/* -------------------------------------------- */
/*  Garage                                      */
/* -------------------------------------------- */

/** The DLC's crew-owned car, referenced straight from CPR's core vehicle compendium when a Garage is first built. */
const DEFAULT_VEHICLE = { pack: "cyberpunk-red-core.core_vehicles", name: "Compact Groundcar" };

/**
 * Display data for the vehicles parked in a Garage. Entries are vehicle Items: world/actor Items, or compendium
 * entries (the default car), which resolve to their index data. Deleted Items are skipped.
 */
export function garageViews(hq) {
  return hq.facilities.garage.vehicles.map(uuid => {
    const item = fromUuidSync(uuid);
    if ( !item ) return null;
    const inCompendium = uuid.startsWith("Compendium.");
    return {
      uuid, name: item.name, img: item.img,
      canView: inCompendium || item.testUserPermission(game.user, "LIMITED"),
      owner: item.parent?.name ?? ""
    };
  }).filter(Boolean);
}

export async function addVehicle(entry, item) {
  if ( item?.type !== "vehicle" ) return ui.notifications.warn("CPRHQ.Garage.wrongType", { localize: true });
  const f = facilities(entry);
  if ( f.garage.vehicles.includes(item.uuid) ) return;
  f.garage.vehicles.push(item.uuid);
  await updateHQ(entry, { facilities: { garage: f.garage } }, {
    log: { type: "facility", text: game.i18n.format("CPRHQ.Garage.logAdd", { name: item.name }) }
  });
}

export async function removeVehicle(entry, uuid) {
  const f = facilities(entry);
  const name = fromUuidSync(uuid)?.name ?? "";
  f.garage.vehicles = f.garage.vehicles.filter(v => v !== uuid);
  await updateHQ(entry, { facilities: { garage: f.garage } }, {
    log: { type: "facility", text: game.i18n.format("CPRHQ.Garage.logRemove", { name }) }
  });
}

/** A newly built Garage comes with the crew's Compact Groundcar (linked from the compendium, no copy made). */
export async function stockGarage(entry) {
  if ( !game.user.isGM || facilities(entry).garage.vehicles.length ) return;
  const pack = game.packs.get(DEFAULT_VEHICLE.pack);
  const id = (await pack?.getIndex())?.find(i => i.name === DEFAULT_VEHICLE.name)?._id;
  if ( !id ) return ui.notifications.warn("CPRHQ.Garage.noDefault", { localize: true });
  await addVehicle(entry, await pack.getDocument(id));
}

/* -------------------------------------------- */
/*  Lockup                                      */
/* -------------------------------------------- */

/** Cells: 1 with the Improvement, 3 once Upgraded. */
export function lockupCapacity(hq) {
  const rank = hq.rankOf("lockup");
  return rank >= 2 ? 3 : rank;
}

/** Athletics for an escape: DEX + Athletics skill level (0 if the actor has no Athletics skill). */
function athletics(actor) {
  const skill = actor.itemTypes?.skill?.find(s => s.name === "Athletics");
  const stat = skill?.system.stat ?? "dex";
  return { stat: stat.toUpperCase(), statValue: actor.system.stats?.[stat]?.value ?? 0, level: skill?.system.level ?? 0 };
}

export function lockupViews(hq) {
  return hq.facilities.lockup.prisoners.map(p => {
    const actor = fromUuidSync(p.uuid);
    if ( !actor ) return null;
    return {
      uuid: p.uuid, since: p.since, name: actor.name, img: actor.img,
      body: actor.system.stats?.body?.value ?? "—",
      canView: actor.testUserPermission(game.user, "LIMITED")
    };
  }).filter(Boolean);
}

export async function addPrisoner(entry, actor) {
  if ( !(actor instanceof Actor) || !["character", "mook"].includes(actor.type) ) {
    return ui.notifications.warn("CPRHQ.Lockup.wrongType", { localize: true });
  }
  const hq = getHQ(entry);
  const f = facilities(entry);
  if ( f.lockup.prisoners.some(p => p.uuid === actor.uuid) ) return;
  if ( f.lockup.prisoners.length >= lockupCapacity(hq) ) {
    return ui.notifications.warn(game.i18n.format("CPRHQ.Lockup.full", { n: lockupCapacity(hq) }));
  }
  f.lockup.prisoners.push({ uuid: actor.uuid, since: currentDateLabel() ?? "" });
  await updateHQ(entry, { facilities: { lockup: f.lockup } }, {
    log: { type: "facility", text: game.i18n.format("CPRHQ.Lockup.logAdd", { name: actor.name }) }
  });
}

export async function removePrisoner(entry, uuid, { text } = {}) {
  const f = facilities(entry);
  const name = fromUuidSync(uuid)?.name ?? "";
  f.lockup.prisoners = f.lockup.prisoners.filter(p => p.uuid !== uuid);
  await updateHQ(entry, { facilities: { lockup: f.lockup } }, {
    log: { type: "facility", text: text ?? game.i18n.format("CPRHQ.Lockup.logRelease", { name }) }
  });
}

/** Ask for the escape DV. Resolves to a number or null. */
async function escapeDVDialog(name) {
  const data = await foundry.applications.api.DialogV2.prompt({
    classes: ["cpr-hq-dialog"],
    window: { title: game.i18n.format("CPRHQ.Lockup.escapeTitle", { name }), icon: "fa-solid fa-person-running" },
    content: `
      <div class="form-group">
        <label>${loc("CPRHQ.Lockup.dv")}</label>
        <div class="form-fields"><input type="number" name="dv" min="1" step="1" value="15" autofocus></div>
      </div>
      <p class="hint">${loc("CPRHQ.Lockup.dvHint")}</p>`,
    rejectClose: false,
    modal: true,
    ok: {
      label: loc("CPRHQ.Lockup.roll"), icon: "fa-solid fa-dice-d10",
      callback: (event, button) => Number(button.form.elements.dv.value)
    }
  });
  return Number.isFinite(data) && data > 0 ? data : null;
}

/**
 * GM: roll an escape attempt. Athletics (DEX + skill + 1d10, CPR criticals: a 10 adds another d10, a 1 subtracts one)
 * against a DV the GM sets. Beating the DV frees the prisoner.
 */
export async function tryEscape(entry, uuid) {
  if ( !game.user.isGM ) return;
  const actor = await fromUuid(uuid);
  if ( !actor ) return;
  const dv = await escapeDVDialog(actor.name);
  if ( dv === null ) return;

  const { stat, statValue, level } = athletics(actor);
  const roll = await new Roll("1d10").evaluate();
  const face = roll.total;
  let crit = 0;
  let critRoll = null;
  if ( (face === 10) || (face === 1) ) {
    critRoll = await new Roll("1d10").evaluate();
    crit = face === 10 ? critRoll.total : -critRoll.total;
  }
  const total = statValue + level + face + crit;
  const escaped = total > dv;

  // Public card: only the outcome. Colours are from the captors' side: a failed escape is good news.
  await ChatMessage.implementation.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="cpr-hq-escape">
        <h3><i class="fa-solid fa-person-running"></i> ${game.i18n.format("CPRHQ.Lockup.attempts", { name: esc(actor.name) })}</h3>
        <p class="${escaped ? "escaped" : "held"}"><strong>${loc(escaped ? "CPRHQ.Lockup.successful" : "CPRHQ.Lockup.unsuccessful")}</strong></p>
      </div>`
  });
  // The GM gets the numbers privately.
  const critText = crit ? ` ${crit > 0 ? "+" : "−"} ${Math.abs(crit)} (${loc(crit > 0 ? "CPRHQ.Lockup.critSuccess" : "CPRHQ.Lockup.critFail")})` : "";
  await ChatMessage.implementation.create({
    speaker: { alias: entry.name },
    // No dice attached: whispered rolls still show players a "privately rolled some dice" placeholder.
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
    content: `<p class="cpr-hq-escape-detail">${game.i18n.format("CPRHQ.Lockup.formula", { stat, statValue, level, face })}${critText}
      = <strong>${total}</strong> ${loc("CPRHQ.Lockup.vs")} DV ${dv}</p>`
  });

  if ( escaped ) {
    await ChatMessage.implementation.create({
      speaker: { alias: entry.name },
      content: `<p class="cpr-hq-breakout"><i class="fa-solid fa-lock-open"></i> ${game.i18n.format("CPRHQ.Lockup.brokeOut", { name: esc(actor.name) })}</p>`
    });
    await removePrisoner(entry, uuid, { text: game.i18n.format("CPRHQ.Lockup.logEscape", { name: actor.name }) });
  }
  else {
    await updateHQ(entry, {}, {
      log: { type: "facility", text: game.i18n.format("CPRHQ.Lockup.logHeld", { name: actor.name }) }
    });
  }
}

/* -------------------------------------------- */
/*  Workstation                                 */
/* -------------------------------------------- */

/** GM: choose which Team Member the Workstation makes full crew ("" for none). */
export async function setImprovedTeamMember(entry, uuid) {
  const name = uuid ? (fromUuidSync(uuid)?.name ?? "") : "";
  await updateHQ(entry, { facilities: { workstation: { member: uuid ?? "" } } }, {
    log: {
      type: "crew",
      text: uuid ? game.i18n.format("CPRHQ.Workstation.logSet", { name }) : loc("CPRHQ.Workstation.logClear")
    }
  });
}

/** Workstation block for the improvement detail: who's improved, and (GM) the Team Members to pick from. */
export function workstationView(hq) {
  const member = hq.facilities.workstation.member;
  const choices = hq.crew.filter(m => m.teamMember)
    .map(m => ({ uuid: m.uuid, name: fromUuidSync(m.uuid)?.name }))
    .filter(c => c.name)
    .map(c => ({ ...c, selected: c.uuid === member }));
  return {
    member, memberName: member ? (fromUuidSync(member)?.name ?? "") : "",
    choices, noTeamMembers: !choices.length
  };
}

/** Facility cleanup when an actor/item is deleted (active GM). */
export async function pruneFacilities(entry, uuid) {
  const f = facilities(entry);
  let changed = false;
  if ( f.garage.vehicles.includes(uuid) ) { f.garage.vehicles = f.garage.vehicles.filter(v => v !== uuid); changed = true; }
  if ( f.lockup.prisoners.some(p => p.uuid === uuid) ) { f.lockup.prisoners = f.lockup.prisoners.filter(p => p.uuid !== uuid); changed = true; }
  if ( f.workstation.member === uuid ) { f.workstation.member = ""; changed = true; }
  if ( changed ) await updateHQ(entry, { facilities: f });
}
