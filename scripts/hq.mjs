import { MODULE_ID, HQ_FLAG, SHEET_CLASS } from "./constants.mjs";
import HQDataModel from "./data/hq-model.mjs";
import { currentDateLabel } from "./calendar.mjs";

/** Does this JournalEntry carry Headquarters data? */
export function isHQ(entry) {
  return !!entry?.flags?.[MODULE_ID]?.[HQ_FLAG];
}

/**
 * Build a validated HQDataModel from a JournalEntry's flag.
 * The source is cloned because DataModel cleaning mutates its input.
 */
export function getHQ(entry) {
  const source = foundry.utils.deepClone(entry?.flags?.[MODULE_ID]?.[HQ_FLAG] ?? {});
  return new HQDataModel(source, { strict: false });
}

/**
 * Validate changes against the HQ schema and return only the resulting diff.
 * Throws if any change is invalid.
 */
export function diffHQ(entry, changes) {
  const hq = getHQ(entry);
  // ObjectFields replace wholesale on update; merge partial improvement changes onto the current map.
  if ( changes?.improvements ) {
    changes = { ...changes, improvements: foundry.utils.mergeObject(hq.toObject().improvements ?? {}, changes.improvements, { inplace: false }) };
  }
  return hq.updateSource(changes);
}

/**
 * Build an activity log entry.
 * @param {object} data
 * @param {string} data.type          One of LOG_TYPES
 * @param {string} data.text          What happened
 * @param {string|number} [data.delta]  Signed change shown at the end of the row, e.g. "+40" or "1,500eb"
 * @param {string} [data.id]          For a row that's updated later
 */
export function logEntry({ type, text, delta = "", id = foundry.utils.randomID() }) {
  return {
    id,
    time: Date.now(),
    date: currentDateLabel() ?? "",
    type, text,
    delta: String(delta ?? ""),
    user: game.user.name
  };
}

/**
 * Apply validated changes to an HQ's flag data, optionally appending activity log entries in the same update.
 * @param {JournalEntry} entry
 * @param {object} changes
 * @param {object} [options]
 * @param {object|object[]} [options.log]  logEntry() data to append
 */
export async function updateHQ(entry, changes, { log } = {}) {
  changes = foundry.utils.deepClone(changes ?? {});
  if ( log ) {
    const entries = (Array.isArray(log) ? log : [log]).map(logEntry);
    changes.log = [...(getHQ(entry).toObject().log), ...entries];
  }
  const diff = diffHQ(entry, changes);
  if ( foundry.utils.isEmpty(diff) ) return entry;
  return entry.update({ [`flags.${MODULE_ID}.${HQ_FLAG}`]: diff });
}

/** Create a new JournalEntry configured as a Headquarters. */
export async function createHQ({ name, mode = "crew", folder = null, renderSheet = true } = {}) {
  const hq = new HQDataModel({ mode });
  return JournalEntry.implementation.create({
    name: name || game.i18n.localize("CPRHQ.NewHQName"),
    folder,
    flags: {
      core: { sheetClass: SHEET_CLASS },
      [MODULE_ID]: { [HQ_FLAG]: hq.toObject() }
    }
  }, { renderSheet });
}

/** Turn an existing JournalEntry into a Headquarters. Existing pages are kept. */
export async function convertToHQ(entry) {
  const update = { "flags.core.sheetClass": SHEET_CLASS };
  if ( !isHQ(entry) ) update[`flags.${MODULE_ID}.${HQ_FLAG}`] = new HQDataModel().toObject();
  return entry.update(update);
}

/** Remove one activity log entry. */
export async function deleteLogEntry(entry, id) {
  const log = getHQ(entry).toObject().log.filter(e => e.id !== id);
  return updateHQ(entry, { log });
}
