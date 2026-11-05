import { MODULE_ID, TEMPLATE_ROOT } from "./constants.mjs";
import HQDataModel from "./data/hq-model.mjs";
import HQJournalSheet from "./apps/hq-sheet.mjs";
import { registerSection, unregisterSection, getSections } from "./apps/sections.mjs";
import { registerCoreSections } from "./apps/core-sections.mjs";
import { isHQ, getHQ, updateHQ, createHQ, convertToHQ } from "./hq.mjs";
import { SC_DATE_HOOK } from "./calendar.mjs";
import { pruneDeletedActor, pruneDeletedItem } from "./crew.mjs";
import { registerLifestyleSettings } from "./lifestyle.mjs";
import DowntimeApp, { registerDowntimeHooks, registerLifestyleSheetButton, refreshLifestyleViews, lifestylePanelContext,
  downtimePanelContext, housingPanelContext, activateHousingButtons } from "./apps/downtime.mjs";
import { registerEffectHooks, syncHQ } from "./effects.mjs";
import { registerAlert, unregisterAlert, registerCoreAlerts } from "./alerts.mjs";
import { billDialog } from "./apps/dialogs.mjs";
import { registerSocket } from "./socket.mjs";
import { registerDowntimeSettings, initSettled, mergeNewDefaults, downtimeDays, downtimeRoundFor } from "./downtime/model.mjs";
import { activateDowntime, newDowntimeUI } from "./downtime/ui.mjs";
import { lifestyleActors, activateLifestyleCards, lifestyleOf } from "./lifestyle.mjs";
import { isTech } from "./workshop/model.mjs";
import { workshopContext, activateWorkshop, newWorkshopUI } from "./workshop/ui.mjs";
import WorkshopApp, { registerWorkshopHooks } from "./apps/workshop.mjs";
import { registerTraumaHooks } from "./trauma.mjs";
import { registerAppsHooks } from "./apps-subs.mjs";
import { registerBillingHooks } from "./billing.mjs";
import { createCrewNote, crewHQsOf, crewNotesPages, openCrewJournal, registerCrewNotesHooks } from "./crew-notes.mjs";
import { registerUpkeepSettings, registerUpkeepHooks, upkeepAPI } from "./upkeep.mjs";
import { healingOf } from "./benefits.mjs";
import { registerTrainingHooks } from "./training.mjs";
import { registerContentSettings, contentReady } from "./content.mjs";

/** Embedded Downtime/Lifestyle panels (api.panels): who they're for, and the per-sheet UI state. */
const hasLifestyle = actor => (actor?.type === "character") && !!actor.system.lifestyle?.lifeStyle;
const panelUI = actor => ({ ...newDowntimeUI(), actorUuid: actor.uuid });
const panelActors = ui => lifestyleActors({ actors: [fromUuidSync(ui.actorUuid)].filter(Boolean) });

// socketlib announces itself during its own init, before ours runs: listen at load time.
registerSocket();

// Trauma Team and App Store subscriptions through the Agent module (its ready hook comes after ours is registered).
const refreshAgentViews = foundry.utils.debounce(() => refreshLifestyleViews(), 150);
registerTraumaHooks(refreshAgentViews);
registerAppsHooks(refreshAgentViews);
registerBillingHooks();
registerCrewNotesHooks();
registerUpkeepHooks();
registerTrainingHooks();

function registerSettings() {
  registerLifestyleSettings(refreshLifestyleViews);
  // Round / settled date / activities: redraw downtime views and HQ sheets (alerts, top bar date).
  registerDowntimeSettings(() => {
    refreshLifestyleViews();
    refreshDates();
  });
  registerUpkeepSettings();
  registerContentSettings();
}

Hooks.once("ready", () => { initSettled(); mergeNewDefaults(); });
// The GM's book texts, merged before HQ sheets render.
Hooks.once("ready", contentReady);

Hooks.once("init", () => {
  DocumentSheetConfig.registerSheet(JournalEntry, MODULE_ID, HQJournalSheet, {
    label: "CPRHQ.SheetLabel",
    makeDefault: false
  });

  registerSettings();
  registerCoreSections();
  registerDowntimeHooks();
  registerLifestyleSheetButton();
  registerWorkshopHooks();
  registerEffectHooks();
  registerCoreAlerts({ billDialog });
  loadTemplates({
    "cpr-hq.pips": `${TEMPLATE_ROOT}/partials/pips.hbs`,
    "cpr-hq.imp-card": `${TEMPLATE_ROOT}/partials/imp-card.hbs`,
    "cpr-hq.imp-detail": `${TEMPLATE_ROOT}/partials/imp-detail.hbs`,
    "cpr-hq.benefit-strip": `${TEMPLATE_ROOT}/partials/benefit-strip.hbs`,
    "cpr-hq.lifestyle-panel": `${TEMPLATE_ROOT}/downtime/panel.hbs`,
    "cpr-hq.lifestyle-card": `${TEMPLATE_ROOT}/downtime/card.hbs`,
    "cpr-hq.lifestyle-section": `${TEMPLATE_ROOT}/downtime/lifestyle.hbs`,
    "cpr-hq.downtime-section": `${TEMPLATE_ROOT}/downtime/downtime.hbs`,
    "cpr-hq.downtime-timeline": `${TEMPLATE_ROOT}/downtime/timeline.hbs`,
    ...Object.fromEntries(["panel", "profile", "bench", "row", "hq-card", "layout"]
      .map(name => [`cpr-hq.ws-${name}`, `${TEMPLATE_ROOT}/workshop/${name}.hbs`]))
  });

  const api = {
    HQDataModel, HQJournalSheet,
    isHQ, getHQ, updateHQ, createHQ, convertToHQ,
    registerSection, unregisterSection, getSections, syncHQ,
    registerAlert, unregisterAlert,
    /** Open the Downtime/Lifestyle window (all player characters for the GM, or one character). */
    openDowntime: actor => DowntimeApp.open(actor),
    /** Open a Tech's Workshop window. */
    openWorkshop: actor => WorkshopApp.open(actor),
    /** HQs whose crew includes the actor and still has access (active or unclaimed). */
    crewHQsOf,
    /** An HQ's shared Crew Notes pages (owned by the crew); the GM's createCrewNote adds one. */
    crewNotesPages,
    createCrewNote,
    /** Open the HQ's sheet on its Journal tab. */
    openCrewJournal,
    /** A character's settled downtime by day, and the open round as it stands for them. */
    downtime: { days: downtimeDays, round: downtimeRoundFor },
    /** A character's Lifestyle preset and its Black Chrome perks (Combat Cabb's free taxi). */
    lifestyle: { of: lifestyleOf },
    /** A character's best "heal as if BODY were higher" bonus from their HQs: { label, value } or null. */
    healing: { of: healingOf },
    /** Gear upkeep (Breaking Your Stuff): status per item, maintenance checks, Damaged, malfunctions. */
    upkeep: upkeepAPI,
    /**
     * Panels another sheet can embed for one character (e.g. a character sheet tab). Keep one `ui` per sheet,
     * render `{{> partial context}}` inside `<div class="application cpr-hq"><div class="window-content">`,
     * then call `activate(element, ui, rerender)` after each render.
     */
    panels: {
      workshop: {
        partial: "cpr-hq.ws-panel",
        available: actor => isTech(actor),
        newUI: actor => newWorkshopUI(actor.uuid),
        context: (actor, ui) => workshopContext(actor, ui),
        activate: (element, ui, rerender) => activateWorkshop(element, ui, rerender)
      },
      /** Downtime and Lifestyle & Housing together, as in the Downtime/Lifestyle window. */
      lifestyle: {
        partial: "cpr-hq.lifestyle-panel",
        available: hasLifestyle,
        newUI: actor => panelUI(actor),
        context: (actor, ui) => lifestylePanelContext(lifestyleActors({ actors: [actor] }), { scope: "one", ui }),
        activate: (element, ui, rerender) => {
          activateLifestyleCards(element);
          activateHousingButtons(element, () => panelActors(ui));
          activateDowntime(element, ui, rerender);
        }
      },
      /** The Downtime section alone. */
      downtime: {
        partial: "cpr-hq.downtime-section",
        available: hasLifestyle,
        newUI: actor => panelUI(actor),
        context: (actor, ui) => downtimePanelContext(lifestyleActors({ actors: [actor] }), ui),
        activate: (element, ui, rerender) => activateDowntime(element, ui, rerender)
      },
      /** The Lifestyle & Housing section alone. */
      housing: {
        partial: "cpr-hq.lifestyle-section",
        available: hasLifestyle,
        newUI: actor => panelUI(actor),
        context: (actor, ui) => housingPanelContext(lifestyleActors({ actors: [actor] })),
        activate: (element, ui) => {
          activateLifestyleCards(element);
          activateHousingButtons(element, () => panelActors(ui));
        }
      }
    }
  };
  game.modules.get(MODULE_ID).api = api;
  Hooks.callAll(`${MODULE_ID}.registerSections`, api);
});

/* -------------------------------------------- */
/*  Journal Directory                           */
/* -------------------------------------------- */

Hooks.on("renderJournalDirectory", (app, html) => {
  const root = html instanceof HTMLElement ? html : html[0];

  if ( game.user.isGM ) {
    const actions = root.querySelector(".header-actions");
    if ( actions && !actions.querySelector(".cpr-hq-create") ) {
      const button = document.createElement("button");
      button.type = "button";
      button.classList.add("cpr-hq-create");
      button.innerHTML = `<i class="fa-solid fa-building"></i> ${game.i18n.localize("CPRHQ.CreateHQ")}`;
      button.addEventListener("click", () => createHQ());
      actions.append(button);
    }
  }

  for ( const li of root.querySelectorAll("li.directory-item[data-document-id]") ) {
    if ( !isHQ(game.journal.get(li.dataset.documentId)) ) continue;
    li.classList.add("cpr-hq-entry");
    const name = li.querySelector(".document-name, .entry-name");
    if ( name && !name.querySelector(".cpr-hq-icon") ) {
      name.insertAdjacentHTML("afterbegin", `<i class="cpr-hq-icon fa-solid fa-building"></i>`);
    }
  }
});

Hooks.on("getJournalDirectoryEntryContext", (app, options) => {
  const entryFor = li => game.journal.get((li[0] ?? li).dataset.documentId);
  options.push({
    name: "CPRHQ.ConvertToHQ",
    icon: `<i class="fa-solid fa-building"></i>`,
    condition: li => game.user.isGM && !isHQ(entryFor(li)),
    callback: li => convertToHQ(entryFor(li))
  });
});

/* -------------------------------------------- */
/*  Simple Calendar                             */
/* -------------------------------------------- */

/** Keep the date (and date-driven alerts) on open HQ sheets current, without re-rendering every clock tick. */
const refreshDates = foundry.utils.debounce(() => {
  for ( const app of foundry.applications.instances.values() ) {
    if ( (app instanceof HQJournalSheet) && app.rendered ) app.render({ parts: ["topbar", "center"] });
  }
  foundry.applications.instances.get("cpr-hq-downtime")?.render();
}, 1000);

// Downtime tracks time world-wide from the last settled date (downtime/model.mjs); the calendar only needs redraws.
Hooks.on(SC_DATE_HOOK, () => refreshDates());

/* -------------------------------------------- */
/*  Linked actors (crew, stash)                 */
/* -------------------------------------------- */

/** Re-render the left column of open HQ sheets that show this actor as crew or stash. */
function refreshForActor(actor) {
  if ( !actor ) return;
  for ( const app of foundry.applications.instances.values() ) {
    if ( !(app instanceof HQJournalSheet) || !app.rendered ) continue;
    const hq = app.hq;
    const linked = (hq.housing.stash === actor.uuid) || hq.crew.some(m => m.uuid === actor.uuid)
      || hq.facilities.lockup.prisoners.some(p => p.uuid === actor.uuid);
    if ( linked ) {
      // Crew panel and the Downtime/Lifestyle tab both show character data.
      app.render({ parts: ["left", "center"] });
    }
  }
}

/** Batch bursts of actor/item updates (e.g. a stash transfer) into one re-render per actor. */
const pending = new Set();
const flushRefresh = foundry.utils.debounce(() => {
  pending.forEach(refreshForActor);
  pending.clear();
}, 100);
function queueRefresh(actor) {
  if ( !actor ) return;
  pending.add(actor);
  flushRefresh();
}

Hooks.on("updateActor", actor => queueRefresh(actor));
Hooks.on("deleteActor", actor => pruneDeletedActor(actor));
Hooks.on("deleteItem", item => {
  if ( !item.parent ) pruneDeletedItem(item);
});
for ( const hook of ["createItem", "updateItem", "deleteItem"] ) {
  Hooks.on(hook, item => {
    if ( item.parent instanceof Actor ) queueRefresh(item.parent);
  });
}
