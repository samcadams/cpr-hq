/**
 * Section registry for the HQ board sheet.
 * A section is either a panel in the left column or a page in the center (one tab each),
 * so features (and other modules) can add, reorder or hide content without touching the sheet class.
 *
 * @typedef {object} HQSection
 * @property {string} id                    Unique id
 * @property {"left"|"center"} region       Left-column panel or center page
 * @property {string} label                 i18n key for the panel heading / page tab
 * @property {string} template              Handlebars partial for the section body
 * @property {string} [icon]                Font Awesome classes
 * @property {number} [order=100]           Sort order within the region
 * @property {boolean} [editToggle]         Left panels: show a pencil that switches the panel into edit mode
 * @property {string[]} [templates]         Extra templates/partials to preload
 * @property {(ctx: object) => boolean} [visible]  Whether the section shows for this user/HQ
 * @property {(context: object, sheet: object) => Promise<void>|void} [prepareContext]  Add section data to its context
 * @property {(element: HTMLElement, sheet: object) => void} [onRender]  Attach non-action listeners to the section element
 */

export const REGIONS = ["left", "center"];
const registry = new Map();

export function registerSection(config) {
  if ( !config?.id || !config.template ) throw new Error("HQ sections require an id and a template.");
  if ( !REGIONS.includes(config.region) ) throw new Error(`HQ section "${config.id}" needs a region: ${REGIONS.join(", ")}.`);
  registry.set(config.id, {
    icon: "fa-solid fa-square",
    order: 100,
    visible: () => true,
    ...config
  });
}

export function unregisterSection(id) {
  registry.delete(id);
}

export function getSection(id) {
  return registry.get(id);
}

/** @param {string} [region]  Only sections in this region */
export function getSections(region) {
  return [...registry.values()]
    .filter(s => !region || s.region === region)
    .sort((a, b) => a.order - b.order);
}
