import { MODULE_ID, TEMPLATE_ROOT } from "../constants.mjs";
import { isTech, bankDowntime, registerWorkshopSettings } from "../workshop/model.mjs";
import { workshopContext, activateWorkshop, newWorkshopUI } from "../workshop/ui.mjs";
import { activities } from "../downtime/model.mjs";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

/**
 * A Tech's Workshop, independent of any HQ: one window per character, opened from the character sheet header.
 * The HQ's Workshop page shows the same panel for its crew's Techs (see core-sections.mjs).
 * Open from a macro: game.modules.get("cpr-hq").api.openWorkshop(actor)
 */
export default class WorkshopApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["cpr-hq", "cpr-hq-workshop"],
    position: { width: 980, height: 800 },
    window: { icon: "fa-solid fa-screwdriver-wrench", resizable: true }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_ROOT}/workshop/app.hbs`, scrollable: [""] }
  };

  constructor(actor, options = {}) {
    super({ ...options, id: `cpr-hq-workshop-${actor.id}` });
    this.actor = actor;
    this.wsUI = newWorkshopUI(actor.uuid);
  }

  static open(actor) {
    if ( !actor ) return;
    const app = foundry.applications.instances.get(`cpr-hq-workshop-${actor.id}`) ?? new WorkshopApp(actor);
    return app.render({ force: true });
  }

  /** @override */
  get title() {
    return game.i18n.format("CPRHQ.Workshop.windowTitle", { actor: this.actor.name });
  }

  /** @override */
  async _prepareContext() {
    return workshopContext(this.actor, this.wsUI);
  }

  /** @override */
  _onRender(context, options) {
    activateWorkshop(this.element, this.wsUI, () => this.render());
  }
}

/** Re-render Workshop windows and HQ Workshop pages showing this character. */
function refreshWorkshops(actor) {
  for ( const app of foundry.applications.instances.values() ) {
    if ( !app.rendered ) continue;
    if ( (app instanceof WorkshopApp) && (!actor || app.actor === actor) ) app.render();
    else if ( app.constructor.name === "HQJournalSheet" ) {
      if ( !actor || app.hq.crew.some(m => m.uuid === actor.uuid) ) app.render({ parts: ["center"] });
    }
  }
}

export function registerWorkshopHooks() {
  // Tech work day (8 or 16 hours): redraw every Workshop so the time presets follow.
  registerWorkshopSettings(() => refreshWorkshops());

  // A "Workshop" button in the header of Tech character sheets.
  Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
    const actor = sheet.actor;
    if ( !isTech(actor) || !actor.testUserPermission(game.user, "OBSERVER") ) return;
    buttons.unshift({
      label: "CPRHQ.Workshop.button",
      class: "cpr-hq-workshop-button",
      icon: "fa-solid fa-screwdriver-wrench",
      onclick: () => WorkshopApp.open(actor)
    });
  });

  Hooks.on("updateActor", (actor, changes) => {
    // Projects, bank, and anything the check bonus reads (TECH).
    if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.workshop`) || foundry.utils.hasProperty(changes, "system.stats") ) refreshWorkshops(actor);
  });
  for ( const hook of ["createItem", "updateItem", "deleteItem"] ) {
    Hooks.on(hook, item => {
      const actor = item.parent;
      if ( (actor instanceof Actor) && ["skill", "role"].includes(item.type) && isTech(actor) ) refreshWorkshops(actor);
    });
  }
  // The HQ's Workshop rank changes the bench.
  Hooks.on("updateJournalEntry", entry => {
    if ( entry.flags?.[MODULE_ID] ) for ( const app of foundry.applications.instances.values() ) if ( (app instanceof WorkshopApp) && app.rendered ) app.render();
  });

  // Settled downtime: Tech hours go to the bank (on the GM who settles).
  Hooks.on(`${MODULE_ID}.downtimeSettled`, (round, actors) => bankDowntime(round, actors.filter(isTech), activities()));

  // "Review" button on the GM's notice of a new project.
  Hooks.on("renderChatMessage", (message, html) => {
    const root = html instanceof HTMLElement ? html : html[0];
    root.querySelector("[data-cpr-hq-workshop]")?.addEventListener("click", async event => {
      const actor = await fromUuid(event.currentTarget.dataset.cprHqWorkshop);
      if ( actor ) WorkshopApp.open(actor);
    });
  });
}
