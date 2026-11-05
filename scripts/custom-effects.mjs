import { MODULE_ID } from "./constants.mjs";
import { getHQ, updateHQ } from "./hq.mjs";

/**
 * Active Effects for custom improvements.
 *
 * Each custom improvement can get a hidden backing Item (type "gear", in a GM-only folder) that holds its effects,
 * so the GM builds them with CPR's own Active Effect sheet, exactly like on a character sheet.
 * Every effect is tagged with the tier (rank index) that grants it: flags.cpr-hq.tier.
 * The effects engine (effects.mjs) copies the changes of every owned tier onto matching crew members.
 */

const FOLDER_FLAG = "effectsFolder";

/** The GM-only Item folder that holds backing Items, created on first use. */
async function effectsFolder() {
  const existing = game.folders.find(f => (f.type === "Item") && f.getFlag(MODULE_ID, FOLDER_FLAG));
  if ( existing ) return existing;
  return Folder.implementation.create({
    name: game.i18n.localize("CPRHQ.Effects.folder"),
    type: "Item",
    color: "#e0303f",
    flags: { [MODULE_ID]: { [FOLDER_FLAG]: true } }
  });
}

/** The backing Item for a custom improvement, or null. */
export function effectItemFor(def) {
  return def?.effectItem ? fromUuidSync(def.effectItem) : null;
}

/** GM: the backing Item for a custom improvement, creating it (and linking it) if needed. */
export async function ensureEffectItem(entry, key) {
  const hq = getHQ(entry);
  const custom = hq.custom.find(c => c.key === key);
  if ( !custom ) return null;
  const existing = custom.effectItem ? await fromUuid(custom.effectItem) : null;
  if ( existing ) return existing;
  const folder = await effectsFolder();
  // CPR's Item.create returns nothing; createDocuments returns the created Items.
  const [item] = await Item.implementation.createDocuments([{
    name: game.i18n.format("CPRHQ.Effects.itemName", { hq: entry.name, name: custom.name }),
    type: "gear",
    img: "icons/svg/house.svg",
    folder: folder.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MODULE_ID]: { hq: entry.uuid, custom: key } }
  }]);
  const list = hq.toObject().custom.map(c => c.key === key ? { ...c, effectItem: item.uuid } : c);
  await updateHQ(entry, { custom: list });
  return item;
}

/** GM: add an effect to one tier of a custom improvement and open CPR's effect sheet on it. */
export async function addTierEffect(entry, key, tierIndex, label) {
  const item = await ensureEffectItem(entry, key);
  if ( !item ) return;
  const [effect] = await item.createEmbeddedDocuments("ActiveEffect", [{
    name: label,
    img: "icons/svg/house.svg",
    transfer: false,
    // CPR's effect sheet expects its per-change flag maps to exist.
    flags: { [MODULE_ID]: { tier: tierIndex }, "cyberpunk-red-core": { changes: { cats: {}, situational: {} } } }
  }]);
  effect?.sheet.render(true);
}

/** Effects on a backing Item, grouped by tier index: Map<number, ActiveEffect[]>. */
export function effectsByTier(item) {
  const map = new Map();
  for ( const effect of item?.effects ?? [] ) {
    const tier = Number(effect.getFlag(MODULE_ID, "tier") ?? 0);
    if ( !map.has(tier) ) map.set(tier, []);
    map.get(tier).push(effect);
  }
  return map;
}

/** Short "+2 bonuses.handgun; +1 system.stats.luck.max" description of an effect's changes. */
export function describeChanges(effect) {
  const sign = v => (/^[+-]/.test(String(v)) ? String(v) : `+${v}`);
  return effect.changes.map(c => `${sign(c.value)} ${c.key.replace(/^bonuses\./, "").replace(/^system\./, "")}`).join(", ");
}

/** Remove a custom improvement's backing Item (when the improvement itself is deleted). */
export async function deleteEffectItem(uuid) {
  const item = uuid ? await fromUuid(uuid) : null;
  await item?.delete();
}

/** Hooks: editing a backing Item's effects re-syncs its HQ and redraws open sheets. */
export function registerCustomEffectHooks(queueSync) {
  const onChange = effect => {
    const item = effect.parent;
    if ( !(item instanceof Item) ) return;
    const hqUuid = item.getFlag(MODULE_ID, "hq");
    if ( !hqUuid ) return;
    const entry = fromUuidSync(hqUuid);
    if ( !entry ) return;
    queueSync(entry);
    entry.sheet?.rendered && entry.sheet.render({ parts: ["inspector", "left"] });
  };
  for ( const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"] ) Hooks.on(hook, onChange);
}
