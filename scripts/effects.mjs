import { MODULE_ID } from "./constants.mjs";
import { isHQ, getHQ } from "./hq.mjs";
import { memberBenefits, isFullCrew, customRolesMatch } from "./benefits.mjs";
import { effectsByTier, registerCustomEffectHooks } from "./custom-effects.mjs";
import { rule } from "./rules.mjs";

/**
 * Managed Active Effects: keeps each crew member's HQ effects in step with the HQ.
 *
 * One effect per (HQ, improvement) on each crew actor, flagged flags.cpr-hq.{hq, source}.
 * CPR allows one change per key per effect, so splitting by improvement keeps keys unique.
 * Situational bonuses use CPR's native situational flag: a checkbox in the roll dialog, off by default.
 * Only the active GM writes effects. Faction HQs never auto-apply (benefits there are GM-permission only).
 */

const SYSTEM_ID = "cyberpunk-red-core";
const ADD = CONST.ACTIVE_EFFECT_MODES.ADD;

/** CPR's skill-name slug, as used for bonuses.<slug> keys (copy of CPR 0.92.4 SystemUtils.slugify). */
export function slugify(name) {
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

/**
 * Effect keys for a benefit's skills on this actor. Variant skills ("Martial Arts", "Play Instrument")
 * expand to every variant the actor actually has, e.g. "Martial Arts (Aikido)".
 */
export function skillKeys(actor, skillName) {
  const variants = actor.itemTypes.skill
    .map(s => s.name)
    .filter(n => (n !== skillName) && n.startsWith(`${skillName} (`));
  const names = variants.length ? variants : [skillName];
  return names.map(n => `bonuses.${slugify(n)}`);
}

/**
 * Desired effects for one crew member: Map of improvement key -> { changes: [{key, value, cat, situational}] }.
 */
export function desiredEffects(hq, member, actor) {
  const bySource = new Map();
  const add = (source, key, value, cat, situational) => {
    if ( !bySource.has(source) ) bySource.set(source, new Map());
    const changes = bySource.get(source);
    const prior = changes.get(key);
    // Same key twice from one improvement: LUCK stacks (Morale #3 + #7); skill bonuses take the best.
    if ( prior ) prior.value = (cat === "stat") ? prior.value + value : Math.max(prior.value, value);
    else changes.set(key, { key, value, cat, situational: !!situational });
  };
  for ( const b of memberBenefits(hq, member, actor) ) {
    if ( b.type === "luck" ) add(b.source, "system.stats.luck.max", b.value, "stat", false);
    else if ( b.type === "skill" ) {
      for ( const skill of b.skills ) {
        for ( const key of skillKeys(actor, skill) ) add(b.source, key, b.value, "skill", b.situational);
      }
    }
    else if ( b.type === "roleAbility" ) add(b.source, b.key, b.value, "role", b.situational);
  }
  const desired = new Map([...bySource].map(([source, changes]) => [source, [...changes.values()]]));

  // Custom improvements: copy the effects of every owned tier from the backing Item (custom-effects.mjs).
  if ( hq.hasAccess && isFullCrew(hq, member) ) {
    for ( const c of hq.custom ) {
      const rank = hq.rankOf(c.key);
      const item = (rank && c.effectItem) ? fromUuidSync(c.effectItem) : null;
      if ( !item || !customRolesMatch(c.roles, member, actor) ) continue;
      for ( const [tier, effects] of effectsByTier(item) ) {
        if ( tier >= rank ) continue;
        for ( const effect of effects ) {
          if ( effect.disabled || !effect.changes.length ) continue;
          desired.set(`${c.key}.${effect.id}`, { custom: true, name: effect.name, effect });
        }
      }
    }
  }
  return desired;
}

/** ActiveEffect data copied from a custom improvement's backing-Item effect, keeping CPR's change flags. */
function customEffectData(entry, source, { name, effect }) {
  const sys = effect.flags?.[SYSTEM_ID]?.changes ?? {};
  return {
    name: `${entry.name}: ${name}`,
    img: effect.img || "icons/svg/house.svg",
    origin: entry.uuid,
    disabled: false,
    changes: effect.changes.map(c => ({ key: c.key, mode: c.mode, value: String(c.value), priority: c.priority })),
    flags: {
      [MODULE_ID]: { hq: entry.uuid, source },
      [SYSTEM_ID]: { changes: { cats: foundry.utils.deepClone(sys.cats ?? {}), situational: foundry.utils.deepClone(sys.situational ?? {}) } }
    }
  };
}

/** Effect data for one desired entry: built-in benefits are a list of changes, custom ones carry their source effect. */
function dataFor(entry, source, desired) {
  return Array.isArray(desired) ? effectData(entry, source, desired) : customEffectData(entry, source, desired);
}

/** ActiveEffect data for one improvement's changes. */
function effectData(entry, source, changes) {
  const name = game.i18n.localize(`CPRHQ.Imp.${source}.name`);
  return {
    name: `${entry.name}: ${name}`,
    img: "icons/svg/house.svg",
    origin: entry.uuid,
    disabled: false,
    changes: changes.map(c => ({ key: c.key, mode: ADD, value: String(c.value) })),
    flags: {
      [MODULE_ID]: { hq: entry.uuid, source },
      [SYSTEM_ID]: {
        changes: {
          cats: Object.fromEntries(changes.map((c, i) => [String(i), c.cat])),
          situational: Object.fromEntries(changes.map((c, i) => [String(i), { isSituational: c.situational, onByDefault: false }]))
        }
      }
    }
  };
}

/** Comparable fingerprint of an effect's content. */
function fingerprint(data) {
  const sys = data.flags?.[SYSTEM_ID]?.changes ?? {};
  return JSON.stringify([data.name, data.changes.map(c => [c.key, Number(c.mode), String(c.value)]), sys.cats ?? {}, sys.situational ?? {}]);
}

function managedEffects(actor, entryUuid) {
  return actor.effects.filter(e => e.getFlag(MODULE_ID, "hq") === entryUuid);
}

/**
 * Bring every actor's effects for one HQ in line with that HQ. Active GM only.
 * Table rule crewEffects: auto syncs; manual only when `force` (the Sync benefits button); display never adds any.
 * @param {JournalEntry} entry
 * @param {object} [options]
 * @param {boolean} [options.remove]  Remove all of this HQ's effects (the HQ was deleted), in any mode
 * @param {boolean} [options.force]   Sync in manual mode too
 */
export async function syncHQ(entry, { remove = false, force = false } = {}) {
  if ( !game.users.activeGM?.isSelf || !entry ) return;
  const mode = rule("crewEffects");
  if ( !remove && ((mode === "display") || ((mode === "manual") && !force)) ) return;
  const hq = (!remove && isHQ(entry)) ? getHQ(entry) : null;
  const apply = hq && !hq.isFaction;

  // Everyone who should have effects, plus anyone who still carries effects from this HQ.
  const actors = new Set();
  if ( hq ) for ( const m of hq.crew ) {
    const actor = fromUuidSync(m.uuid);
    if ( actor ) actors.add(actor);
  }
  for ( const actor of game.actors ) if ( managedEffects(actor, entry.uuid).length ) actors.add(actor);

  for ( const actor of actors ) {
    const member = hq?.crew.find(m => m.uuid === actor.uuid);
    const desired = (apply && member) ? desiredEffects(hq, member, actor) : new Map();
    const existing = managedEffects(actor, entry.uuid);
    const toCreate = [];
    const toUpdate = [];
    const toDelete = [];

    for ( const effect of existing ) {
      const source = effect.getFlag(MODULE_ID, "source");
      const wanted = desired.get(source);
      if ( !wanted || (Array.isArray(wanted) && !wanted.length) ) {
        toDelete.push(effect.id);
        continue;
      }
      const data = dataFor(entry, source, wanted);
      const current = { name: effect.name, changes: effect.changes, flags: effect.flags };
      if ( fingerprint(current) !== fingerprint(data) ) toUpdate.push({ _id: effect.id, ...data });
      desired.delete(source);
    }
    for ( const [source, wanted] of desired ) {
      if ( Array.isArray(wanted) && !wanted.length ) continue;
      toCreate.push(dataFor(entry, source, wanted));
    }

    try {
      if ( toDelete.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete);
      // Replace (not merge) the system's per-change flags so stale indices don't linger.
      if ( toUpdate.length ) await actor.updateEmbeddedDocuments("ActiveEffect", toUpdate, { recursive: false });
      if ( toCreate.length ) await actor.createEmbeddedDocuments("ActiveEffect", toCreate);
    } catch ( err ) {
      console.error(`${MODULE_ID} | Failed to sync HQ effects on ${actor.name}`, err);
    }
  }
}

/** Sync every HQ that lists this actor as crew (e.g. after a role or skill change). */
export function syncForActor(actor) {
  for ( const entry of game.journal ) {
    if ( isHQ(entry) && getHQ(entry).crew.some(m => m.uuid === actor.uuid) ) queueSync(entry);
  }
}

const queue = new Set();
const flush = foundry.utils.debounce(async () => {
  const entries = [...queue];
  queue.clear();
  for ( const entry of entries ) await syncHQ(entry);
}, 250);

/** Debounced sync, so a burst of updates writes effects once. */
export function queueSync(entry) {
  if ( !game.users.activeGM?.isSelf || (rule("crewEffects") !== "auto") ) return;
  queue.add(entry);
  flush();
}

/** Every actor's crew benefit effects (any HQ's, including deleted ones). Training Practice has no hq flag. */
export function crewEffects() {
  return game.actors.contents.flatMap(actor => actor.effects.filter(e => e.getFlag(MODULE_ID, "hq")));
}

/** Active GM: remove every crew benefit effect. */
export async function removeCrewEffects() {
  if ( !game.users.activeGM?.isSelf ) return;
  for ( const actor of game.actors ) {
    const ids = actor.effects.filter(e => e.getFlag(MODULE_ID, "hq")).map(e => e.id);
    if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}

/** Register the hooks that keep effects in sync. */
export function registerEffectHooks() {
  registerCustomEffectHooks(queueSync);
  Hooks.once("ready", () => {
    for ( const entry of game.journal ) if ( isHQ(entry) ) queueSync(entry);
  });
  Hooks.on("updateJournalEntry", (entry, changes) => {
    if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) || ("name" in changes) ) queueSync(entry);
  });
  // A deleted HQ takes its effects with it.
  Hooks.on("deleteJournalEntry", entry => syncHQ(entry, { remove: true }));
  Hooks.on("updateActor", (actor, changes) => {
    if ( foundry.utils.hasProperty(changes, "system.roleInfo") ) syncForActor(actor);
  });
  for ( const hook of ["createItem", "updateItem", "deleteItem"] ) {
    Hooks.on(hook, item => {
      if ( (item.parent instanceof Actor) && ["role", "skill"].includes(item.type) ) syncForActor(item.parent);
    });
  }
}
