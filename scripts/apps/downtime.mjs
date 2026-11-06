import { MODULE_ID, TEMPLATE_ROOT } from "../constants.mjs";
import {
  lifestyleActors, lifestyleCard, activateLifestyleCards, lifestylePresets, saveCustomPresets, proposeLifestyleBill
} from "../lifestyle.mjs";
import { lifestyleBillColumns, sendLifestyleBill } from "../billing.mjs";
import { billReviewDialog } from "./dialogs.mjs";
import { downtimeContext, activateDowntime, newDowntimeUI } from "../downtime/ui.mjs";
import { holdRender } from "../downtime/timeline.mjs";
import { rule } from "../rules.mjs";

const { HandlebarsApplicationMixin, ApplicationV2, DialogV2 } = foundry.applications.api;

const loc = key => game.i18n.localize(key);
const esc = value => Handlebars.escapeExpression(value ?? "");

/**
 * Downtime/Lifestyle, independent of any HQ: Downtime on top, then each character's Housing and Lifestyle.
 * The GM sees every player character (and can bill Lifestyle + Housing); players see their own.
 * The HQ sheet shows the same panel in its Downtime/Lifestyle tab (see core-sections.mjs), so it keeps working
 * if the HQ is lost. Open from a macro: game.modules.get("cpr-hq").api.openDowntime(actor?)
 */
export default class DowntimeApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cpr-hq-downtime",
    classes: ["cpr-hq", "cpr-hq-downtime"],
    position: { width: 760, height: 760 },
    window: { title: "CPRHQ.Downtime.title", icon: "fa-solid fa-hourglass-half", resizable: true },
    actions: {
      billLifestyle: DowntimeApp.#onBill,
      managePresets: DowntimeApp.#onManagePresets,
      openActor: DowntimeApp.#onOpenActor
    }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_ROOT}/downtime/app.hbs`, scrollable: [""] }
  };

  /** Only this character, if opened for one (e.g. from a character sheet). */
  actorUuid = null;

  /** Downtime section UI state (selected character, Past Days). */
  dtUI = newDowntimeUI();

  /** Open (or focus) the window, optionally focused on one character. */
  static open(actor) {
    const app = foundry.applications.instances.get("cpr-hq-downtime") ?? new DowntimeApp();
    app.actorUuid = actor?.uuid ?? null;
    return app.render({ force: true });
  }

  get actors() {
    const one = this.actorUuid ? fromUuidSync(this.actorUuid) : null;
    return lifestyleActors(one ? { actors: [one] } : {});
  }

  /** @override "Lifestyle" without the downtime system. */
  get title() {
    return game.i18n.localize(rule("downtimeSystem") ? this.options.window.title : "CPRHQ.Lifestyle.title");
  }

  /** @override */
  render(options, _options) {
    // Wait while a timeline bar is being dragged (see holdRender).
    if ( holdRender(this, options) ) return Promise.resolve(this);
    return super.render(options, _options);
  }

  /** @override */
  async _prepareContext() {
    return lifestylePanelContext(this.actors, { scope: this.actorUuid ? "one" : "all", ui: this.dtUI });
  }

  /** @override */
  _onRender(context, options) {
    // The frame keeps its first title: follow the downtime system switch.
    if ( this.window?.title ) this.window.title.textContent = this.title;
    activateLifestyleCards(this.element);
    activateDowntime(this.element, this.dtUI, () => this.render());
  }

  /** Re-render if one of the shown characters changed. */
  refreshFor(actor) {
    if ( this.rendered && this.actors.some(a => a.uuid === actor?.uuid) ) this.render();
  }

  static #onBill() {
    return lifestyleBillDialog(this.actors);
  }

  static #onManagePresets() {
    return presetsDialog();
  }

  static async #onOpenActor(event, target) {
    const actor = await fromUuid(target.closest("[data-ls-actor]")?.dataset.lsActor);
    actor?.sheet.render(true);
  }
}

/** Context for the shared Downtime/Lifestyle panel (window and HQ tab). No Downtime section without the downtime system. */
export function lifestylePanelContext(actors, { scope = "all", ui } = {}) {
  const downtime = rule("downtimeSystem") ? downtimePanelContext(actors, ui) : null;
  return { ...housingPanelContext(actors), scope, downtime };
}

/** Context for the Downtime section alone (the "cpr-hq.downtime-section" partial). */
export function downtimePanelContext(actors, ui) {
  if ( ui ) ui.participants = () => actors;
  return downtimeContext(actors, ui ?? newDowntimeUI());
}

/** Context for the Lifestyle & Housing section alone (the "cpr-hq.lifestyle-section" partial). */
export function housingPanelContext(actors) {
  return {
    isGM: game.user.isGM,
    cards: actors.map(lifestyleCard),
    empty: game.i18n.localize(game.user.isGM ? "CPRHQ.Lifestyle.emptyGM" : "CPRHQ.Lifestyle.empty")
  };
}

/**
 * The Lifestyle section's GM buttons, for hosts that aren't cpr-hq applications (whose `data-action`s the
 * window and HQ sheet handle themselves), e.g. a character sheet embedding api.panels.housing.
 */
export function activateHousingButtons(root, actors) {
  const section = root.querySelector(".dt-lifestyle");
  if ( !section || !game.user.isGM ) return;
  section.addEventListener("click", event => {
    const button = event.target.closest("[data-action='managePresets'], [data-action='billLifestyle']");
    if ( !button ) return;
    event.preventDefault();
    event.stopPropagation();
    if ( button.dataset.action === "managePresets" ) return presetsDialog();
    return lifestyleBillDialog(actors());
  });
}

/** GM: review and send a Lifestyle + Housing bill for these characters. */
export async function lifestyleBillDialog(actors) {
  if ( !game.user.isGM ) return;
  const lines = proposeLifestyleBill(actors);
  if ( !lines.length ) return ui.notifications.warn("CPRHQ.Bill.noCrew", { localize: true });
  const bill = await billReviewDialog({
    title: loc("CPRHQ.Lifestyle.billTitle"),
    note: loc("CPRHQ.Lifestyle.billNote"),
    columns: lifestyleBillColumns(),
    lines
  });
  if ( bill ) return sendLifestyleBill(bill);
}

/** One custom preset row in the presets dialog. */
function presetRow(p = {}, i) {
  return `
    <fieldset class="preset-row">
      <legend><button type="button" class="preset-remove" data-tooltip="CPRHQ.Lifestyle.removePreset"><i class="fa-solid fa-xmark"></i></button></legend>
      <input type="hidden" name="presets.${i}.id" value="${esc(p.id)}">
      <div class="preset-line">
        <input type="text" name="presets.${i}.name" value="${esc(p.name)}" placeholder="${loc("CPRHQ.Lifestyle.presetName")}">
        <input type="number" name="presets.${i}.cost" value="${p.cost ?? 0}" min="0" step="1"> <span>eb</span>
      </div>
      <textarea name="presets.${i}.description" rows="2" placeholder="${loc("CPRHQ.Lifestyle.presetDescription")}">${esc(p.description)}</textarea>
    </fieldset>`;
}

/** GM: add, edit and remove custom Lifestyle presets (everyone can pick them). Rulebook presets are listed read-only. */
export async function presetsDialog() {
  if ( !game.user.isGM ) return;
  const presets = lifestylePresets();
  const builtin = presets.filter(p => !p.custom)
    .map(p => `<li><strong>${esc(p.name)}</strong> · ${p.cost}eb${p.description ? `<br><small>${esc(p.description)}</small>` : ""}</li>`).join("");
  const custom = presets.filter(p => p.custom);
  const data = await DialogV2.prompt({
    classes: ["cpr-hq-dialog", "cpr-hq-presets"],
    window: { title: loc("CPRHQ.Lifestyle.presetsTitle"), icon: "fa-solid fa-utensils" },
    position: { width: 560 },
    content: `
      <h4>${loc("CPRHQ.Lifestyle.rulebook")}</h4>
      <ul class="preset-builtin">${builtin}</ul>
      <h4>${loc("CPRHQ.Lifestyle.customPresets")}</h4>
      <div class="preset-list">${custom.map((p, i) => presetRow(p, i)).join("")}</div>
      <button type="button" class="preset-add"><i class="fa-solid fa-plus"></i> ${loc("CPRHQ.Lifestyle.addPreset")}</button>`,
    rejectClose: false,
    modal: true,
    render: (event, element) => {
      const list = element.querySelector(".preset-list");
      let next = custom.length;
      element.querySelector(".preset-add").addEventListener("click", () => {
        list.insertAdjacentHTML("beforeend", presetRow({}, next++));
        list.lastElementChild.querySelector("input[type=text]").focus();
      });
      list.addEventListener("click", ev => ev.target.closest(".preset-remove")?.closest(".preset-row").remove());
    },
    ok: {
      label: loc("CPRHQ.Save"), icon: "fa-solid fa-floppy-disk",
      callback: (event, button) => foundry.utils.expandObject(new FormDataExtended(button.form).object)
    }
  });
  if ( !data ) return;
  await saveCustomPresets(Object.values(data.presets ?? {}));
}

/** Re-render every open Downtime window and HQ sheet showing Lifestyle (e.g. after presets change). */
export function refreshLifestyleViews() {
  for ( const app of foundry.applications.instances.values() ) {
    if ( !app.rendered ) continue;
    if ( app instanceof DowntimeApp ) app.render();
    else if ( app.constructor.name === "HQJournalSheet" ) app.render({ parts: ["center"] });
  }
}

/** Keep open Downtime windows current when a shown character changes. */
export function registerDowntimeHooks() {
  const refresh = doc => {
    const actor = doc instanceof Actor ? doc : doc?.parent;
    if ( !(actor instanceof Actor) ) return;
    foundry.applications.instances.get("cpr-hq-downtime")?.refreshFor(actor);
  };
  for ( const hook of ["createActiveEffect", "deleteActiveEffect"] ) Hooks.on(hook, refresh);
  // A schedule change (submitted, edited) re-renders the whole window: the GM sees every character's status.
  Hooks.on("updateActor", (actor, changes) => {
    if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) foundry.applications.instances.get("cpr-hq-downtime")?.render();
    else refresh(actor);
  });
  // HQ changes (tenancy, Morale Boost discount) change housing and bills too.
  Hooks.on("updateJournalEntry", entry => {
    if ( entry.flags?.[MODULE_ID] ) foundry.applications.instances.get("cpr-hq-downtime")?.render();
  });
}

/** A "Lifestyle" button in the header of character sheets the user owns: opens Downtime/Lifestyle for them. */
export function registerLifestyleSheetButton() {
  Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
    const actor = sheet.actor;
    if ( (actor?.type !== "character") || !actor.isOwner || !actor.system.lifestyle?.lifeStyle ) return;
    buttons.unshift({
      label: "CPRHQ.Downtime.button",
      class: "cpr-hq-lifestyle-button",
      icon: "fa-solid fa-hourglass-half",
      onclick: () => DowntimeApp.open(actor)
    });
  });
}
