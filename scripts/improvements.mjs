import { CATALOGUE, ROLES, IMPROVEMENT_COST, UPGRADE_COST, maxRankFor } from "./data/improvements.mjs";
import { getHQ, updateHQ } from "./hq.mjs";
import { MODULE_ID, HQ_FLAG } from "./constants.mjs";
import { deleteEffectItem } from "./custom-effects.mjs";

const loc = key => game.i18n.localize(key);
const has = key => game.i18n.has(key);

/* -------------------------------------------- */
/*  Definitions                                 */
/* -------------------------------------------- */

/**
 * Apply the GM's per-HQ text edits (improvements[key].override = {name, tiers: {i: {summary, text}}}).
 * Blank fields fall back to the original text.
 */
function applyOverride(hq, def) {
  const o = hq.improvements?.[def.key]?.override;
  def.original = { name: def.name, description: def.description, tiers: def.tiers };
  if ( !o ) return def;
  const pick = (value, fallback) => (typeof value === "string" && value.trim()) ? value : fallback;
  def.name = pick(o.name, def.name);
  def.description = pick(o.description, def.description);
  def.tiers = def.tiers.map((t, i) => {
    const summary = pick(o.tiers?.[i]?.summary, t.summary);
    // Summary-only tiers (no content file) keep their text in step with an edited summary
    return { text: pick(o.tiers?.[i]?.text, (t.text === t.summary) ? summary : t.text), summary };
  });
  def.edited = (def.name !== def.original.name) || (def.description !== def.original.description) || def.tiers.some((t, i) =>
    (t.text !== def.original.tiers[i].text) || (t.summary !== def.original.tiers[i].summary));
  return def;
}

/**
 * Resolve every improvement available to an HQ (catalogue + custom) into a common shape.
 * @returns {{key, name, icon, custom, edited, maxRank, roles: string[], tiers: {text, summary}[], benefits: object[][]}[]}
 */
export function getDefinitions(hq) {
  const defs = Object.entries(CATALOGUE).map(([key, def]) => {
    const tiers = [];
    // The full text comes from the GM's content file (content.mjs); without it, the summary
    for ( let i = 0; has(`CPRHQ.Imp.${key}.tiers.${i}.summary`); i++ ) {
      const summary = loc(`CPRHQ.Imp.${key}.tiers.${i}.summary`);
      const textKey = `CPRHQ.Imp.${key}.tiers.${i}.text`;
      tiers.push({ text: has(textKey) ? loc(textKey) : summary, summary });
    }
    const descKey = `CPRHQ.Imp.${key}.description`;
    return {
      key, name: loc(`CPRHQ.Imp.${key}.name`), icon: def.icon, custom: false,
      description: has(descKey) ? loc(descKey) : "",
      maxRank: maxRankFor(key, def, hq),
      roles: def.roles.map(r => loc(ROLES[r])),
      requiresRent: !!def.requiresRent,
      tiers, benefits: def.benefits
    };
  });
  for ( const c of hq.custom ) {
    defs.push({
      key: c.key, name: c.name, icon: c.icon || "fa-solid fa-star", custom: true,
      description: c.description ?? "",
      maxRank: Math.max(1, c.tiers.length),
      roles: c.roles.split(",").map(r => r.trim()).filter(Boolean),
      // Cards show the summary; the full text falls back to it
      tiers: c.tiers.map(t => ({ summary: t.summary, text: t.text || t.summary })),
      effectItem: c.effectItem ?? "",
      benefits: []
    });
  }
  return defs.map(def => applyOverride(hq, def));
}

export function getDefinition(hq, key) {
  return getDefinitions(hq).find(d => d.key === key) ?? null;
}

/** Tier text index for a rank: repeatable upgrades (Rent Reduction) reuse the last tier's text. */
function tierFor(def, rank) {
  return def.tiers[Math.min(rank, def.tiers.length) - 1] ?? null;
}

/* -------------------------------------------- */
/*  Rules                                       */
/* -------------------------------------------- */

/**
 * What the next purchase of this improvement would be, and whether it is allowed.
 * @returns {{type: "purchase"|"upgrade"|null, cost: number, blocked: string|null}}
 */
export function nextAction(hq, def) {
  const rank = hq.rankOf(def.key);
  if ( rank >= def.maxRank ) return { type: null, cost: 0, blocked: null };
  const type = rank === 0 ? "purchase" : "upgrade";
  const cost = hq.isFaction ? 0 : (type === "purchase" ? IMPROVEMENT_COST : UPGRADE_COST);
  let blocked = null;
  if ( hq.status === "destroyed" ) blocked = "CPRHQ.Blocked.destroyed";
  else if ( hq.workstationLock && def.key !== "workstation" ) blocked = "CPRHQ.Blocked.workstation";
  else if ( def.requiresRent && !hq.housing.rent ) blocked = "CPRHQ.Blocked.noRent";
  else if ( hq.ip.unspent < cost ) blocked = "CPRHQ.Blocked.ip";
  return { type, cost, blocked };
}

/** Total HQ IP spent on currently held ranks. */
export function ipInvested(hq) {
  if ( hq.isFaction ) return 0;
  return getDefinitions(hq).reduce((sum, def) => {
    const rank = hq.rankOf(def.key);
    return sum + (rank ? IMPROVEMENT_COST + (rank - 1) * UPGRADE_COST : 0);
  }, 0);
}

/* -------------------------------------------- */
/*  View data                                   */
/* -------------------------------------------- */

function levelLabel(def, rank) {
  if ( !rank ) return loc("CPRHQ.Level.none");
  if ( def.key === "moraleBoost" ) return game.i18n.format("CPRHQ.Level.morale", { n: rank - 1, max: def.maxRank - 1 });
  if ( def.key === "rentReduction" ) {
    return rank === 1 ? loc("CPRHQ.Level.improvement") : game.i18n.format("CPRHQ.Level.beds", { n: rank - 1 });
  }
  if ( rank === 1 ) return loc("CPRHQ.Level.improvement");
  return def.maxRank > 2 ? game.i18n.format("CPRHQ.Level.upgrades", { n: rank - 1 }) : loc("CPRHQ.Level.upgraded");
}

function tierLabel(def, index) {
  if ( index === 0 ) return loc("CPRHQ.Level.improvement");
  if ( def.key === "moraleBoost" ) return game.i18n.format("CPRHQ.Level.upgradeN", { n: index });
  return def.maxRank > 2 ? game.i18n.format("CPRHQ.Level.upgradeN", { n: index }) : loc("CPRHQ.Level.upgrade");
}

/** Benefit ids replaced by owned higher tiers (Morale Boost ladder, Evidence Wall). */
function replacedIds(def, rank) {
  const ids = new Set();
  for ( const tier of def.benefits.slice(0, rank) ) {
    for ( const b of tier ) if ( b.replaces ) ids.add(b.replaces);
  }
  return ids;
}

/** Everything the cards and inspector need for one improvement. */
export function improvementView(hq, def) {
  const rank = hq.rankOf(def.key);
  const installed = rank > 0;
  const maxed = rank >= def.maxRank;
  const action = nextAction(hq, def);
  const replaced = replacedIds(def, rank);
  const status = !installed ? "available" : maxed ? "maxed" : "installed";

  // Repeatable tiers (Rent Reduction) are listed once per possible rank so the ladder shows the cap.
  const ladder = Array.from({ length: def.maxRank }, (_, i) => {
    const tier = tierFor(def, i + 1);
    const owned = i < rank;
    const isReplaced = owned && (def.benefits[i]?.length > 0) && def.benefits[i].every(b => replaced.has(b.id));
    const tierIndex = Math.min(i, def.tiers.length - 1);
    return {
      index: i, tierIndex, label: tierLabel(def, i), text: tier?.text ?? "", summary: tier?.summary ?? "",
      // Repeatable tiers share text; only the first occurrence is editable.
      textEditable: tierIndex === i,
      originalText: def.original?.tiers[tierIndex]?.text ?? "",
      originalSummary: def.original?.tiers[tierIndex]?.summary ?? "",
      override: hq.improvements?.[def.key]?.override?.tiers?.[tierIndex] ?? {},
      state: isReplaced ? "replaced" : owned ? "owned" : i === rank ? "next" : "locked",
      cost: i === 0 ? IMPROVEMENT_COST : UPGRADE_COST
    };
  });
  const current = tierFor(def, Math.max(1, rank));
  const next = installed && !maxed ? tierFor(def, rank + 1) : null;

  return {
    key: def.key, name: def.name, icon: def.icon, custom: def.custom, edited: !!def.edited,
    description: def.description ?? "",
    originalDescription: def.original?.description ?? "",
    originalName: def.original?.name ?? def.name,
    overrideName: hq.improvements?.[def.key]?.override?.name ?? "",
    rank, maxRank: def.maxRank, installed, maxed, status,
    statusLabel: loc(`CPRHQ.ImpStatus.${status}`),
    level: levelLabel(def, rank),
    pips: Array.from({ length: def.maxRank }, (_, i) => ({ filled: i < rank, base: i === 0 })),
    roles: def.roles,
    current: current?.summary ?? "",
    currentText: current?.text ?? "",
    next: next?.summary ?? "",
    nextText: next?.text ?? "",
    ladder,
    notes: hq.improvements?.[def.key]?.notes ?? "",
    action: action.type ? {
      type: action.type,
      label: loc(`CPRHQ.Action.${action.type}`),
      cost: action.cost,
      blocked: action.blocked ? loc(action.blocked) : null
    } : null,
    search: [def.name, def.description ?? "", ...def.roles, ...def.tiers.flatMap(t => [t.text, t.summary])].join(" ").toLowerCase()
  };
}

export function improvementViews(hq) {
  return getDefinitions(hq).map(def => improvementView(hq, def));
}

/* -------------------------------------------- */
/*  Mutations (GM)                              */
/* -------------------------------------------- */

function setRank(hq, key, rank) {
  return { improvements: { [key]: { ...(hq.improvements?.[key] ?? {}), rank } } };
}

/**
 * Purchase or upgrade an improvement, spending HQ IP (none for faction HQs).
 * @param {JournalEntry} entry
 * @param {string} key
 * @param {object} [extra]  Additional HQ changes to apply in the same update (e.g. reduced rent)
 */
export async function advanceImprovement(entry, key, extra = {}) {
  const hq = getHQ(entry);
  const def = getDefinition(hq, key);
  if ( !def ) return;
  const action = nextAction(hq, def);
  if ( !action.type ) return;
  if ( action.blocked ) return ui.notifications.warn(action.blocked, { localize: true });

  const rank = hq.rankOf(key) + 1;
  const changes = foundry.utils.mergeObject(setRank(hq, key, rank), extra);
  if ( action.cost ) changes.ip = { unspent: hq.ip.unspent - action.cost };
  if ( (key === "workstation") && (rank >= 2) ) changes.workstationLock = false;

  const tier = tierFor(def, rank);
  await updateHQ(entry, changes, {
    log: {
      type: action.type,
      text: game.i18n.format(`CPRHQ.Action.log.${action.type}`, { name: def.name, tier: tierLabel(def, rank - 1), summary: tier?.summary ?? "" }),
      delta: action.cost ? `−${action.cost}` : ""
    }
  });
}

/** Lose an improvement entirely: rank to 0, no refund (DLC rule). */
export async function loseImprovement(entry, key) {
  const hq = getHQ(entry);
  const def = getDefinition(hq, key);
  const rank = hq.rankOf(key);
  if ( !def || !rank ) return;
  const changes = setRank(hq, key, 0);
  if ( (key === "workstation") && (rank >= 2) ) changes.workstationLock = true;
  await updateHQ(entry, changes, {
    log: { type: "loss", text: game.i18n.format("CPRHQ.Action.log.loss", { name: def.name }) }
  });
}

/** GM correction: remove the most recent rank and refund its HQ IP. */
export async function refundImprovement(entry, key) {
  const hq = getHQ(entry);
  const def = getDefinition(hq, key);
  const rank = hq.rankOf(key);
  if ( !def || !rank ) return;
  const refund = hq.isFaction ? 0 : (rank === 1 ? IMPROVEMENT_COST : UPGRADE_COST);
  const changes = setRank(hq, key, rank - 1);
  if ( refund ) changes.ip = { unspent: hq.ip.unspent + refund };
  await updateHQ(entry, changes, {
    log: {
      type: "correction",
      text: game.i18n.format("CPRHQ.Action.log.refund", { name: def.name, tier: tierLabel(def, rank - 1) }),
      delta: refund ? `+${refund}` : ""
    }
  });
}

/** GM: drop every text edit on an improvement, restoring the original wording. */
export async function resetImprovementText(entry, key) {
  if ( !getHQ(entry).improvements?.[key]?.override ) return;
  await entry.update({ [`flags.${MODULE_ID}.${HQ_FLAG}.improvements.${key}.-=override`]: null });
}

/** Create or replace a custom improvement. */
export async function saveCustomImprovement(entry, { key, name, icon, roles, description = "", tiers }) {
  const hq = getHQ(entry);
  const custom = hq.toObject().custom;
  const isNew = !key;
  key ??= `custom${foundry.utils.randomID(8)}`;
  const index = custom.findIndex(c => c.key === key);
  const data = { key, name, icon: icon || "fa-solid fa-star", roles: roles ?? "", description, tiers,
    effectItem: custom[index]?.effectItem ?? "" };
  if ( index >= 0 ) custom[index] = data;
  else custom.push(data);
  const changes = { custom };
  // Shrinking a custom improvement's tiers clamps its rank.
  if ( hq.rankOf(key) > tiers.length ) Object.assign(changes, setRank(hq, key, tiers.length));
  await updateHQ(entry, changes, isNew ? {
    log: { type: "note", text: game.i18n.format("CPRHQ.Custom.logCreate", { name }) }
  } : {});
  return key;
}

/** Delete a custom improvement and its rank. No refund. */
export async function deleteCustomImprovement(entry, key) {
  const hq = getHQ(entry);
  const def = hq.custom.find(c => c.key === key);
  if ( !def ) return;
  await updateHQ(entry, {
    custom: hq.toObject().custom.filter(c => c.key !== key),
    improvements: { [key]: { rank: 0, notes: "" } }
  }, { log: { type: "note", text: game.i18n.format("CPRHQ.Custom.logDelete", { name: def.name }) } });
  await deleteEffectItem(def.effectItem);
}
