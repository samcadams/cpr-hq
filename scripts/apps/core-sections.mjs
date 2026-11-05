import { TEMPLATE_ROOT } from "../constants.mjs";
import { registerSection } from "./sections.mjs";
import { HQ_TENURES } from "../data/hq-model.mjs";
import { formatNumber } from "../utils.mjs";
import { improvementViews, improvementView, getDefinition } from "../improvements.mjs";
import { crewViews, addCrew } from "../crew.mjs";
import { activeBenefits, memberBenefits, benefitChips, isCrewWide, isFullCrew } from "../benefits.mjs";
import { garageViews, addVehicle, lockupViews, lockupCapacity, addPrisoner } from "../facilities.mjs";
import { lifestyleActors, activateLifestyleCards } from "../lifestyle.mjs";
import { lifestylePanelContext } from "./downtime.mjs";
import { activateDowntime, newDowntimeUI } from "../downtime/ui.mjs";
import { canAddPage } from "../socket.mjs";
import { workshopContext, activateWorkshop, newWorkshopUI, crewTechs } from "../workshop/ui.mjs";

const IMP_FILTERS = ["all", "installed", "available", "custom"];

/** Most recent log entries shown on the Activity page. */
const LOG_LIMIT = 300;

/** Activity page filters -> the log entry types they show. */
const LOG_GROUPS = {
  all: [],
  ip: ["award", "correction"],
  improvements: ["purchase", "upgrade", "loss"],
  crew: ["crew"],
  money: ["money"],
  status: ["status"],
  notes: ["note", "facility"]
};

const LOG_ICONS = {
  award: "fa-solid fa-star",
  purchase: "fa-solid fa-cart-shopping",
  upgrade: "fa-solid fa-arrow-up",
  loss: "fa-solid fa-burst",
  status: "fa-solid fa-door-open",
  correction: "fa-solid fa-pen",
  crew: "fa-solid fa-user",
  money: "fa-solid fa-coins",
  facility: "fa-solid fa-screwdriver-wrench",
  note: "fa-solid fa-note-sticky"
};

/** Show/hide improvement cards for the current search text and filter, without re-rendering. */
function filterCards(element, { search = "", filter = "all" }) {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for ( const card of element.querySelectorAll(".imp-card") ) {
    const { status } = card.dataset;
    const byFilter = (filter === "all")
      || ((filter === "installed") && (status !== "available"))
      || ((filter === "available") && (status === "available"))
      || ((filter === "custom") && ("custom" in card.dataset));
    const bySearch = terms.every(t => card.dataset.search.includes(t));
    card.hidden = !(byFilter && bySearch);
    if ( !card.hidden ) shown++;
  }
  const empty = element.querySelector(".search-empty");
  if ( empty ) empty.hidden = shown > 0;
}


/** Display data for the linked stash Container actor, or null. */
function stashInfo(uuid) {
  if ( !uuid ) return null;
  const actor = fromUuidSync(uuid);
  if ( !actor ) return { missing: true };
  return {
    uuid,
    name: actor.name,
    eb: formatNumber(actor.system.wealth?.value),
    items: actor.items.size,
    canView: actor.testUserPermission(game.user, "LIMITED")
  };
}

/**
 * The viewing player's crew member and their benefit chips, or null if they have no character in this crew.
 * Shown in the strip under the title: only mechanical benefits, not rules-to-remember notes.
 */
export function playerBenefits(hq) {
  const crew = hq.crew.filter(m => isFullCrew(hq, m))
    .map(m => ({ member: m, actor: fromUuidSync(m.uuid) }))
    .filter(c => c.actor);
  const chosen = crew.find(c => c.member.uuid === game.user.character?.uuid) ?? crew.find(c => c.actor.isOwner);
  if ( !chosen ) return null;
  const chips = benefitChips(memberBenefits(hq, chosen.member, chosen.actor), { hq, compact: true }).filter(c => !c.note);
  return { actor: chosen.actor.name, chips };
}

/** Drop handler for panels that accept a dragged document. */
function acceptDrop(element, type, handler) {
  element.addEventListener("dragover", event => event.preventDefault());
  element.addEventListener("drop", async event => {
    const data = TextEditor.getDragEventData(event);
    if ( data?.type !== type ) return;
    event.preventDefault();
    event.stopPropagation();
    const doc = await fromUuid(data.uuid);
    if ( doc ) await handler(doc);
  });
}

/** Built-in sections. Feature work replaces placeholders and adds more through registerSection. */
export function registerCoreSections() {
  /* ---------- Left column ---------- */

  registerSection({
    id: "info",
    region: "left",
    label: "CPRHQ.Section.info",
    icon: "fa-solid fa-circle-info",
    order: 10,
    editToggle: true,
    template: `${TEMPLATE_ROOT}/sections/info.hbs`,
    async prepareContext(context, sheet) {
      const hq = context.hq;
      context.descriptionHTML = await TextEditor.enrichHTML(hq.profile.description, {
        secrets: sheet.document.isOwner,
        relativeTo: sheet.document
      });
      context.tenureLabel = HQ_TENURES[hq.profile.tenure];
      context.stash = stashInfo(hq.housing.stash);
      context.tenants = hq.crew.filter(m => m.tenant).map(m => fromUuidSync(m.uuid)?.name).filter(Boolean);
      if ( context.editing ) {
        context.stashChoices = Object.fromEntries(game.actors
          .filter(a => a.type === "container")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(a => [a.uuid, a.name]));
      }
    }
  });

  // GM overview of every crew member's benefits. Players see their own in the strip under the title bar.
  registerSection({
    id: "benefits",
    region: "left",
    label: "CPRHQ.Section.crewBenefits",
    icon: "fa-solid fa-user",
    order: 20,
    template: `${TEMPLATE_ROOT}/sections/benefits.hbs`,
    visible: ({ user }) => user.isGM,
    prepareContext(context) {
      const hq = context.hq;
      const crew = hq.crew.filter(m => isFullCrew(hq, m))
        .map(m => ({ member: m, actor: fromUuidSync(m.uuid) }))
        .filter(c => c.actor);
      // Crew-wide benefits once, then whatever each member gets on top (Role and tenant benefits).
      // Mechanical benefits only, like the players' strip (rules-to-remember notes live on the improvements).
      const chips = list => benefitChips(list, { hq, compact: true }).filter(c => !c.note);
      context.sharedChips = chips(activeBenefits(hq).filter(isCrewWide));
      context.members = crew.map(c => ({
        uuid: c.member.uuid,
        name: c.actor.name,
        chips: chips(memberBenefits(hq, c.member, c.actor).filter(b => !isCrewWide(b)))
      })).filter(m => m.chips.length);
      context.anyChips = context.sharedChips.length || context.members.length;
    }
  });

  registerSection({
    id: "crew",
    region: "left",
    label: "CPRHQ.Section.crew",
    icon: "fa-solid fa-users",
    order: 30,
    template: `${TEMPLATE_ROOT}/sections/crew.hbs`,
    prepareContext(context) {
      const hq = context.hq;
      context.crew = crewViews(hq);
      context.headerNote = game.i18n.format("CPRHQ.Crew.headerNote", {
        n: hq.crew.length, tenants: hq.crew.filter(m => m.tenant).length, beds: hq.effectiveBeds
      });
      context.overBeds = hq.crew.filter(m => m.tenant).length > hq.effectiveBeds;
    },
    onRender(element, sheet) {
      if ( game.user.isGM ) acceptDrop(element, "Actor", actor => addCrew(sheet.document, actor));
    }
  });

  registerSection({
    id: "garage",
    region: "left",
    label: "CPRHQ.Section.garage",
    icon: "fa-solid fa-car",
    order: 35,
    template: `${TEMPLATE_ROOT}/sections/garage.hbs`,
    visible: ({ hq }) => hq.rankOf("garage") > 0,
    prepareContext(context) {
      context.vehicles = garageViews(context.hq);
      context.headerNote = String(context.vehicles.length);
    },
    onRender(element, sheet) {
      if ( game.user.isGM ) acceptDrop(element, "Item", item => addVehicle(sheet.document, item));
    }
  });

  registerSection({
    id: "lockup",
    region: "left",
    label: "CPRHQ.Section.lockup",
    icon: "fa-solid fa-lock",
    order: 37,
    template: `${TEMPLATE_ROOT}/sections/lockup.hbs`,
    visible: ({ hq }) => hq.rankOf("lockup") > 0,
    prepareContext(context) {
      const capacity = lockupCapacity(context.hq);
      context.prisoners = lockupViews(context.hq);
      context.capacity = capacity;
      context.lockupFull = context.prisoners.length >= capacity;
      context.headerNote = game.i18n.format("CPRHQ.Lockup.headerNote", { n: context.prisoners.length, max: capacity });
    },
    onRender(element, sheet) {
      if ( game.user.isGM ) acceptDrop(element, "Actor", actor => addPrisoner(sheet.document, actor));
    }
  });

  /* ---------- Center pages ---------- */

  registerSection({
    id: "improvements",
    region: "center",
    label: "CPRHQ.Section.improvements",
    icon: "fa-solid fa-layer-group",
    order: 10,
    template: `${TEMPLATE_ROOT}/sections/improvements.hbs`,
    prepareContext(context, sheet) {
      const state = sheet.sectionState("improvements", { filter: "all", search: "" });
      context.impState = state;
      context.improvements = improvementViews(context.hq).map(v => ({ ...v, selected: v.key === sheet.inspecting }));
      context.impFilters = IMP_FILTERS.map(id => ({ id, label: `CPRHQ.Filter.${id}`, active: id === state.filter }));
    },
    onRender(element, sheet) {
      const state = sheet.sectionState("improvements");
      const apply = () => filterCards(element, state);
      const search = element.querySelector(".imp-search");
      search?.addEventListener("input", () => {
        state.search = search.value;
        apply();
      });
      for ( const button of element.querySelectorAll("[data-filter]") ) {
        button.addEventListener("click", () => {
          state.filter = button.dataset.filter;
          for ( const b of element.querySelectorAll("[data-filter]") ) b.classList.toggle("active", b === button);
          apply();
        });
      }
      apply();
    }
  });

  // Facility pages: an installed improvement with its own tools gets a page; clicking its card opens it.
  // Workshop: the crew's Techs and their projects (the same panel as the Tech's Workshop window), then the improvement.
  registerSection({
    id: "workshop",
    region: "center",
    label: "CPRHQ.Section.workshop",
    icon: "fa-solid fa-screwdriver-wrench",
    order: 15,
    improvement: "workshop",
    template: `${TEMPLATE_ROOT}/sections/workshop.hbs`,
    visible: ({ hq }) => hq.rankOf("workshop") > 0,
    prepareContext(context, sheet) {
      const def = getDefinition(context.hq, "workshop");
      context.facility = def ? sheet._detailView(context.hq, def) : null;
      context.textEditing = sheet.textEditing === "workshop";
      const ui = sheet.sectionState("workshop", newWorkshopUI());
      const techs = crewTechs(context.hq);
      // Players start on their own Tech.
      if ( !techs.some(a => a.uuid === ui.actorUuid) ) ui.actorUuid = (techs.find(a => a.isOwner && !game.user.isGM) ?? techs[0])?.uuid ?? null;
      context.wsTechs = techs.map(a => ({ uuid: a.uuid, name: a.name, img: a.img, active: a.uuid === ui.actorUuid }));
      const actor = ui.actorUuid ? fromUuidSync(ui.actorUuid) : null;
      context.workshopPanel = actor ? { ...workshopContext(actor, ui), inHQ: true } : { empty: game.i18n.localize("CPRHQ.Workshop.noCrewTech") };
    },
    onRender(element, sheet) {
      const ui = sheet.sectionState("workshop");
      const rerender = () => sheet.render({ parts: ["center"] });
      for ( const button of element.querySelectorAll("[data-ws-tech]") ) {
        button.addEventListener("click", () => {
          ui.actorUuid = button.dataset.wsTech;
          ui.hours = null;
          rerender();
        });
      }
      activateWorkshop(element, ui, rerender);
    }
  });

  registerSection({
    id: "activity",
    region: "center",
    label: "CPRHQ.Section.activity",
    icon: "fa-solid fa-list",
    // Least-used page, so it sits last.
    order: 90,
    template: `${TEMPLATE_ROOT}/sections/activity.hbs`,
    prepareContext(context, sheet) {
      const state = sheet.sectionState("activity", { filter: "all" });
      const log = context.hq.log;
      context.logFilters = Object.keys(LOG_GROUPS).map(id => ({ id, label: `CPRHQ.Activity.filter.${id}`, active: id === state.filter }));
      context.logLimit = LOG_LIMIT;
      context.logTruncated = log.length > LOG_LIMIT;
      context.logRows = log.slice(-LOG_LIMIT).reverse().map(e => ({
        ...e,
        group: Object.entries(LOG_GROUPS).find(([, types]) => types.includes(e.type))?.[0] ?? "notes",
        icon: LOG_ICONS[e.type] ?? "fa-solid fa-circle",
        date: e.date || new Date(e.time).toLocaleDateString(game.i18n.lang),
        tooltip: game.i18n.format("CPRHQ.Activity.by", { user: e.user || "—", when: new Date(e.time).toLocaleString(game.i18n.lang) })
      }));
    },
    onRender(element, sheet) {
      const state = sheet.sectionState("activity");
      const apply = () => {
        let shown = 0;
        for ( const row of element.querySelectorAll(".ledger-row") ) {
          row.hidden = (state.filter !== "all") && (row.dataset.logGroup !== state.filter);
          if ( !row.hidden ) shown++;
        }
        const empty = element.querySelector(".log-empty");
        if ( empty ) empty.hidden = (shown > 0) || !element.querySelector(".ledger-row");
      };
      for ( const button of element.querySelectorAll("[data-log-filter]") ) {
        button.addEventListener("click", () => {
          state.filter = button.dataset.logFilter;
          for ( const b of element.querySelectorAll("[data-log-filter]") ) b.classList.toggle("active", b === button);
          apply();
        });
      }
      apply();
    }
  });

  registerSection({
    id: "downtime",
    region: "center",
    label: "CPRHQ.Section.downtime",
    icon: "fa-solid fa-hourglass-half",
    order: 30,
    // The same panel as the standalone Downtime/Lifestyle window, for this crew's characters.
    template: `${TEMPLATE_ROOT}/sections/downtime.hbs`,
    prepareContext(context, sheet) {
      const actors = context.hq.crew.filter(m => !m.teamMember).map(m => fromUuidSync(m.uuid)).filter(a => a?.type === "character");
      const ui = sheet.sectionState("downtime", newDowntimeUI());
      context.lifestylePanel = lifestylePanelContext(lifestyleActors({ actors }), { scope: "hq", ui });
    },
    onRender(element, sheet) {
      activateLifestyleCards(element);
      activateDowntime(element, sheet.sectionState("downtime"), () => sheet.render({ parts: ["center"] }));
    }
  });

  registerSection({
    id: "pages",
    region: "center",
    label: "CPRHQ.Section.journal",
    icon: "fa-solid fa-book-open",
    order: 40,
    template: `${TEMPLATE_ROOT}/sections/pages.hbs`,
    prepareContext(context, sheet) {
      const user = game.user;
      context.canCreatePage = canAddPage(sheet.document);
      context.pages = sheet.document.pages.contents
        .filter(p => p.testUserPermission(user, "LIMITED"))
        .sort((a, b) => a.sort - b.sort)
        .map(p => ({
          id: p.id,
          name: p.name,
          type: game.i18n.localize(CONFIG.JournalEntryPage.typeLabels[p.type] ?? p.type)
        }));
    }
  });

}
