/*
 * The books' full texts (Improvement tiers, Lifestyle), which the module doesn't ship: the GM drops cpr-hq.json
 * into a folder under Data (world setting "contentFolder"). It's a lang overlay in en.json's shape, merged into
 * the translations at ready. Without it the sheet shows the short summaries.
 *
 * Players can't browse files, so the active GM looks for it (on ready, and when the setting changes) and saves
 * the answer in the hidden world setting "contentFound"; clients fetch only then (no 404s).
 */

import { MODULE_ID } from "./constants.mjs";

const FILE = "cpr-hq.json";

const trimSlashes = path => String(path ?? "").trim().replace(/^\/+|\/+$/g, "");

const decode = p => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

/** Whether FilePicker.browse's `paths` (full, maybe URL-encoded) include `<folder>/cpr-hq.json`. */
export function hasContentFile(folder, paths) {
  const dir = trimSlashes(folder);
  return !!dir && Array.isArray(paths) && paths.map(decode).includes(`${dir}/${FILE}`);
}

/** cpr-hq.json's text → its object; anything else: null. */
export function parseContent(text) {
  try {
    const data = JSON.parse(text);
    return (data && (typeof data === "object") && !Array.isArray(data)) ? data : null;
  } catch {
    return null;
  }
}

const folderSetting = () => trimSlashes(game.settings.get(MODULE_ID, "contentFolder"));

/** Merge the file into the translations. */
async function loadContent() {
  const src = `${folderSetting()}/${FILE}`;
  try {
    const res = await fetch(encodeURI(foundry.utils.getRoute(src)));
    const data = res.ok ? parseContent(await res.text()) : null;
    if ( !data ) return console.warn(`${MODULE_ID} | Couldn't read ${src}`);
    foundry.utils.mergeObject(game.i18n.translations, foundry.utils.expandObject(data));
  } catch (err) {
    console.warn(`${MODULE_ID} | Couldn't read ${src}`, err);
  }
}

/** The active GM saves whether the folder has the file, only when that changed. */
async function rescan() {
  if ( game.user !== game.users.activeGM ) return;
  const folder = folderSetting();
  let found = false;
  if ( folder ) {
    try {
      found = hasContentFile(folder, (await FilePicker.browse("data", folder)).files ?? []);
    } catch {
      // No such folder: not found
    }
  }
  if ( found !== game.settings.get(MODULE_ID, "contentFound") ) await game.settings.set(MODULE_ID, "contentFound", found);
}

/** init: the settings. */
export function registerContentSettings() {
  game.settings.register(MODULE_ID, "contentFolder", {
    name: "CPRHQ.Settings.contentFolder.name", hint: "CPRHQ.Settings.contentFolder.hint",
    scope: "world", config: true, type: String, filePicker: "folder", default: "cpr-sam-agent-content",
    onChange: () => rescan()
  });
  // Whether the GM found the file there; see rescan. Sheets pick it up on reload.
  game.settings.register(MODULE_ID, "contentFound", {
    scope: "world", config: false, type: Boolean, default: false,
    onChange: found => found && loadContent()
  });
}

/** ready: merge the file (before sheets render), then the GM looks again. */
export async function contentReady() {
  if ( game.settings.get(MODULE_ID, "contentFound") ) await loadContent();
  rescan().catch(err => console.warn(`${MODULE_ID} | Couldn't look in the content folder`, err));
}
