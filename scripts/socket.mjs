import { MODULE_ID } from "./constants.mjs";
import { isHQ, getHQ } from "./hq.mjs";
import { applyPlayerTrauma } from "./trauma.mjs";

/**
 * GM relay for things players may do on an HQ without owning the Journal Entry.
 * Uses socketlib; the active GM performs the change.
 */

let socket = null;

/** Can this user add pages to this HQ? Owners always; otherwise players with a character in the crew. */
export function canAddPage(entry, user = game.user) {
  if ( entry.testUserPermission(user, "OWNER") ) return true;
  if ( !isHQ(entry) ) return false;
  const hq = getHQ(entry);
  if ( hq.isFaction ) return false;
  return hq.crew.some(m => {
    const actor = fromUuidSync(m.uuid);
    return actor && !m.teamMember && actor.testUserPermission(user, "OWNER");
  });
}

/** Active GM: create a page owned by the requesting player. Returns the new page id. */
async function createPageAsGM(entryUuid, { name, type }, userId) {
  const entry = await fromUuid(entryUuid);
  const user = game.users.get(userId);
  if ( !entry || !user || !canAddPage(entry, user) ) return null;
  if ( !["text", "image", "video", "pdf"].includes(type) ) type = "text";
  const [page] = await entry.createEmbeddedDocuments("JournalEntryPage", [{
    name: name?.trim() || game.i18n.localize("CPRHQ.Pages.untitled"),
    type,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.INHERIT, [userId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
  }]);
  return page?.id ?? null;
}

/** Ask the GM to create a page for this player. Resolves to the page, or null. */
export async function requestPage(entry, data) {
  if ( !socket ) return null;
  if ( !game.users.activeGM ) {
    ui.notifications.warn("CPRHQ.Pages.noGM", { localize: true });
    return null;
  }
  const id = await socket.executeAsGM("createPage", entry.uuid, data, game.user.id);
  if ( !id ) return null;
  // The page's own create broadcast can land just after the socket reply.
  for ( let i = 0; (i < 20) && !entry.pages.has(id); i++ ) await new Promise(r => setTimeout(r, 100));
  return entry.pages.get(id) ?? null;
}

/* -------------------------------------------- */
/*  Images (Workshop projects)                  */
/* -------------------------------------------- */

/** Where uploaded project images go. */
const IMAGE_DIR = () => `worlds/${game.world.id}/cpr-hq`;
/** Largest image (as a data URL) a player may send through the GM. Images are shrunk before sending. */
const IMAGE_LIMIT = 3 * 1024 * 1024;

async function uploadImage(dataUrl, name) {
  const dir = IMAGE_DIR();
  try { await FilePicker.createDirectory("data", dir, {}); }
  catch(err) { /* Already there. */ }
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], name, { type: blob.type });
  const result = await FilePicker.upload("data", dir, file, {}, { notify: false });
  return result?.path ?? null;
}

/** Active GM: store an image for a player who can't upload files. */
async function uploadImageAsGM(dataUrl, name, userId) {
  if ( !game.users.get(userId) || (typeof dataUrl !== "string") || !dataUrl.startsWith("data:image/") ) return null;
  if ( dataUrl.length > IMAGE_LIMIT ) return null;
  return uploadImage(dataUrl, name);
}

/**
 * Store an image file in the world's data folder and return its path: directly when this user may upload, otherwise
 * through the GM. Large images are scaled down (longest side 1280px) first.
 */
export async function storeImage(file) {
  const dataUrl = await shrinkImage(file, 1280);
  const name = `ws-${foundry.utils.randomID(8)}.webp`;
  if ( game.user.can("FILES_UPLOAD") ) return uploadImage(dataUrl, name);
  if ( !socket || !game.users.activeGM ) {
    ui.notifications.warn("CPRHQ.Workshop.imageNoGM", { localize: true });
    return null;
  }
  return socket.executeAsGM("uploadImage", dataUrl, name, game.user.id);
}

async function shrinkImage(file, max) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.85);
}

/* -------------------------------------------- */
/*  Trauma Team (Lifestyle cards)               */
/* -------------------------------------------- */

/** Ask the GM to change this player's Trauma Team plan (see trauma.mjs). */
export async function requestTrauma(actor, changes) {
  if ( !socket ) return false;
  if ( !game.users.activeGM ) {
    ui.notifications.warn("CPRHQ.Trauma.noGM", { localize: true });
    return false;
  }
  return socket.executeAsGM("setTrauma", actor.uuid, changes, game.user.id);
}

export function registerSocket() {
  Hooks.once("socketlib.ready", () => {
    socket = socketlib.registerModule(MODULE_ID);
    socket.register("createPage", createPageAsGM);
    socket.register("uploadImage", uploadImageAsGM);
    socket.register("setTrauma", applyPlayerTrauma);
  });
}
