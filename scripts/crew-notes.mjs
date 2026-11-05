import { MODULE_ID } from "./constants.mjs";
import { isHQ, getHQ } from "./hq.mjs";

/**
 * Crew Notes: text pages inside an HQ's journal entry that the whole crew can read, write and delete
 * (the Functional Agent's Notes app lists them beside each character's own notes).
 *
 * Each page carries flags.cpr-hq.crewNotes. Their ownership follows the crew: every non-GM user who owns
 * a crew member's actor is an Owner of the page (whatever they can see of the HQ entry itself); everyone
 * else inherits from the entry. The GM creates them on request (crew players don't own the entry) and
 * the active GM re-syncs them whenever the crew changes.
 */

const FLAG = "crewNotes";
const { NONE, OWNER, INHERIT } = CONST.DOCUMENT_OWNERSHIP_LEVELS;

/** The HQ's Crew Notes pages, in journal order. */
export function crewNotesPages(entry) {
  return (entry?.pages.filter(p => p.getFlag(MODULE_ID, FLAG)) ?? []).sort((a, b) => a.sort - b.sort);
}

/** Non-GM users who own a crew member's actor. */
function crewUsers(entry) {
  const ids = new Set();
  for ( const member of getHQ(entry).crew ) {
    const actor = fromUuidSync(member.uuid);
    if ( !actor ) continue;
    for ( const user of game.users ) {
      if ( !user.isGM && actor.testUserPermission(user, "OWNER") ) ids.add(user.id);
    }
  }
  return ids;
}

/** The page ownership the crew should have: Owner for crew players, the entry's for anyone else. */
function crewOwnership(entry, current = {}) {
  const ownership = { default: INHERIT };
  const crew = crewUsers(entry);
  for ( const id of crew ) ownership[id] = OWNER;
  // Players who left the crew lose the page, unless the GM gave it to them some other way (kept as is).
  for ( const [id, level] of Object.entries(current) ) {
    if ( id !== "default" && !crew.has(id) && level !== OWNER ) ownership[id] = level;
    else if ( id !== "default" && !crew.has(id) ) ownership[id] = NONE;
  }
  return ownership;
}

/**
 * Active HQs (active or unclaimed: the crew still has access) whose crew includes this actor.
 * @param {Actor} actor
 * @returns {JournalEntry[]}
 */
export function crewHQsOf(actor) {
  if ( !actor ) return [];
  return game.journal.filter(e => isHQ(e) && getHQ(e).hasAccess && getHQ(e).crew.some(m => m.uuid === actor.uuid));
}

/**
 * GM: a new Crew Notes page, owned by the crew.
 * @param {JournalEntry} entry
 * @param {object} [data]       { name, content }
 * @returns {Promise<JournalEntryPage|null>}
 */
export async function createCrewNote(entry, { name, content = "" } = {}) {
  if ( !game.user.isGM || !isHQ(entry) ) return null;
  const [page] = await entry.createEmbeddedDocuments("JournalEntryPage", [{
    name: String(name ?? "").trim().slice(0, 100) || game.i18n.localize("CPRHQ.CrewNotes.name"),
    type: "text",
    text: { content },
    sort: (entry.pages.contents.reduce((max, p) => Math.max(max, p.sort), 0)) + CONST.SORT_INTEGER_DENSITY,
    ownership: crewOwnership(entry),
    flags: { [MODULE_ID]: { [FLAG]: true } }
  }]);
  return page ?? null;
}

/** GM: match every Crew Notes page's ownership to the crew. */
export async function syncCrewNotes(entry) {
  if ( !game.user.isGM ) return;
  const updates = crewNotesPages(entry).map(page => ({ page, ownership: crewOwnership(entry, page.ownership) }))
    .filter(({ page, ownership }) => !foundry.utils.objectsEqual(ownership, page.ownership))
    .map(({ page, ownership }) => ({ _id: page.id, ownership }));
  if ( updates.length ) await entry.updateEmbeddedDocuments("JournalEntryPage", updates, { diff: false, recursive: false });
}

/**
 * Open the HQ's sheet on its Journal tab (falls back to the page itself for someone who can't see the HQ).
 * @param {JournalEntry} entry
 * @param {JournalEntryPage} [page]
 */
export function openCrewJournal(entry, page) {
  if ( !entry?.testUserPermission(game.user, "OBSERVER") ) return page?.sheet.render(true);
  const sheet = entry.sheet;
  if ( sheet.tabGroups ) sheet.tabGroups.page = "pages";
  sheet.render(true);
  if ( sheet.rendered ) sheet.changeTab?.("pages", "page");
}

/** The active GM re-syncs Crew Notes when a crew changes, or when a crew member's owners change. */
export function registerCrewNotesHooks() {
  const pending = new Set();
  const flush = foundry.utils.debounce(() => {
    for ( const entry of pending ) syncCrewNotes(entry);
    pending.clear();
  }, 250);
  const resync = entry => {
    pending.add(entry);
    flush();
  };
  Hooks.on("updateJournalEntry", (entry, changes) => {
    if ( !game.users.activeGM?.isSelf || !isHQ(entry) ) return;
    if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) && crewNotesPages(entry).length ) resync(entry);
  });
  Hooks.on("updateActor", (actor, changes) => {
    if ( !game.users.activeGM?.isSelf || !("ownership" in changes) ) return;
    for ( const entry of crewHQsOf(actor) ) if ( crewNotesPages(entry).length ) resync(entry);
  });
}
