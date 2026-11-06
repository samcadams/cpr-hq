import { getHQ } from "../hq.mjs";
import { getDefinition, improvementView, advanceImprovement } from "../improvements.mjs";
import {
  PROJECT_TYPES, isTech, techProfile, workshopAccess, crewHQ, benchSize, workshopData, benchPlan, workable,
  needsRoll, checkAt, halfwayDue, materialsOk, resolveRoll,
  checkBonus, canLinkItem, proposeProject, reviseProject, deleteProject, linkItem, benchProject, unbenchProject, work,
  rollProject, startPrototype, reviewProject, finishProject, designsOf, fabricationOf, fabricateAgain
} from "./model.mjs";
import { projectDialog, reviewDialog, bankDialog } from "./dialogs.mjs";

/**
 * The Workshop panel, shared by the Workshop window (opened from a Tech's character sheet) and the HQ's Workshop
 * page. `ui` is per-view state: {actorUuid, hours, view, open, filter, sort}.
 */

const loc = key => game.i18n.localize(key);
const DRAG_TYPE = "cpr-hq-ws-project";

export function newWorkshopUI(actorUuid = null) {
  return { actorUuid, hours: null, view: "active", open: null, filter: "all", sort: null };
}

/** The column sorts: sorted lists are flat, ascending on these keys. A hidden DV sorts as no DV. */
const SORTS = {
  name: v => v.name.toLowerCase(),
  dv: v => -((v.approved && v.showDV && v.dv) || -1),
  chance: v => -(v.chance ?? -1),
  hours: v => (v.hours ? v.remaining : Infinity)
};

/**
 * Chance (%) that bonus + 1d10 beats the DV, counting CP:R criticals: a 10 adds a second d10, a 1 subtracts one.
 * Every pair (first die, second die) is one of 100 equally likely outcomes; the second die only matters on a 10 or 1.
 */
export function successChance(bonus, dv) {
  let wins = 0;
  for ( let face = 1; face <= 10; face++ ) {
    for ( let k = 1; k <= 10; k++ ) {
      const total = bonus + face + ((face === 10) ? k : (face === 1) ? -k : 0);
      if ( total > dv ) wins++;
    }
  }
  return Math.round(wins);
}

/** What a project shows: approved ones are Available (on the shelf) or In progress (on the bench) unless held up. */
function statusOf(p, onBench) {
  if ( p.status !== "approved" ) return p.status;
  if ( p.pendingRoll ) return "rolled";
  if ( needsRoll(p) ) return "ready";
  if ( !materialsOk(p) ) return "materials";
  return onBench ? "active" : "available";
}

/**
 * Where a project is in the Maker process, as steps: propose, GM review, materials (if any are listed), work, the
 * Maker check and done. A project checked halfway (inventions, by default) has a second stretch of work after the check.
 * @param {object} p           The project (a new one has no id yet)
 * @param {string} [status]    statusOf(); defaults to the project's own
 * @returns {{steps: {key, label, who, state}[], next: string, status: string}}
 */
export function processSteps(p, status) {
  status ??= p.id ? statusOf(p, false) : "draft";
  const invent = p.type === "invent";
  // Checked halfway: by the table rule, or already (the rule changed after its check).
  const twoStage = halfwayDue(p) || !!p.checked;
  const keys = ["propose", "review"];
  if ( p.materials ) keys.push("materials");
  keys.push("work", twoStage ? "halfway" : "check");
  if ( twoStage ) keys.push("finishWork");
  keys.push("done");
  const at = {
    draft: "propose", returned: "propose", pending: "review", materials: "materials",
    available: p.checked ? "finishWork" : "work",
    active: p.checked ? "finishWork" : "work",
    ready: halfwayDue(p) ? "halfway" : "check", rolled: halfwayDue(p) ? "halfway" : "check",
    complete: "done"
  }[status] ?? "propose";
  const current = p.finished ? keys.length : keys.indexOf(at);
  const gm = new Set(["review", "materials"]);
  const steps = keys.map((key, i) => ({
    key,
    label: loc(`CPRHQ.Workshop.step.${key}`),
    who: loc(gm.has(key) ? "CPRHQ.Workshop.who.gm" : "CPRHQ.Workshop.who.tech"),
    state: (i < current) ? "done" : (i === current) ? "current" : "todo"
  }));
  const nextKey = (status === "available") ? "available" : (status === "complete" && invent) ? "completeInvent" : status;
  return { steps, status, next: p.finished ? loc("CPRHQ.Workshop.next.finished") : loc(`CPRHQ.Workshop.next.${nextKey}`) };
}

function projectView(actor, p, { benchIndex, owner, open }) {
  const type = PROJECT_TYPES[p.type];
  const status = statusOf(p, benchIndex >= 0);
  // The GM may keep a DV secret: players see no DV, and so no chance either.
  const showDV = !p.hideDV || game.user.isGM;
  const hours = Number(p.hours) || 0;
  const progress = Math.min(Number(p.progress) || 0, hours || Infinity);
  const bonus = checkBonus(actor, p);
  const approved = (p.status === "approved") || (p.status === "complete");
  const last = p.attempts?.at(-1);
  // Projects checked halfway (inventions, by default): the bar shows where.
  const halfway = halfwayDue(p) && hours ? checkAt(p) : null;
  const chance = approved && p.dv && showDV ? successChance(bonus.total, p.dv) : null;
  const pending = p.pendingRoll;
  const pendingText = pending ? game.i18n.format(game.user.isGM ? "CPRHQ.Workshop.pendingGM" : "CPRHQ.Workshop.pendingPlayer",
      { total: pending.total, dv: pending.dv, verdict: loc(pending.total > pending.dv ? "CPRHQ.Workshop.beatsDV" : "CPRHQ.Workshop.missesDV") }) : "";
  return {
    ...p,
    process: processSteps(p, status),
    typeLabel: loc(`CPRHQ.Workshop.type.${p.type}`),
    icon: type.icon,
    color: type.color,
    status,
    statusLabel: (status === "active") ? loc(`CPRHQ.Workshop.onSlot.${benchIndex}`) : loc(`CPRHQ.Workshop.status.${status}`),
    open,
    // The row's buttons sit beside the note, so the sentence doesn't lead into them.
    rowNote: pending ? pendingText.replace(/:$/, "") : (status === "returned") ? p.gmNote : "",
    categoryLabel: p.category ? loc(`CPRHQ.Workshop.cat.${p.category}`) : "",
    upgradeLabel: p.upgrade ? loc(`CPRHQ.Workshop.up.${p.upgrade}`) : "",
    specialty: type.specialty,
    approved,
    showDV,
    dvHiddenIcon: !!p.hideDV && game.user.isGM,
    pending: pending ? { total: pending.total, text: pendingText } : null,
    canResolve: game.user.isGM && !!pending,
    needsMaterials: (p.status === "approved") && !materialsOk(p),
    hours, progress,
    pct: hours ? Math.round((progress / hours) * 100) : 0,
    remaining: Math.max(0, hours - progress),
    bonus: bonus.total,
    bonusTip: bonus.parts.map(([label, n]) => `${label} ${n}`).join(" + "),
    chance,
    chanceClass: (chance === null) ? "" : (chance >= 70) ? "ws-odds-high" : (chance >= 40) ? "ws-odds-mid" : "ws-odds-low",
    chanceTip: (chance !== null) ? game.i18n.format("CPRHQ.Workshop.chanceTip", { bonus: bonus.total, dv: p.dv }) : "",
    halfway,
    halfwayPct: halfway ? Math.round((halfway / hours) * 100) : null,
    checked: !!p.checked,
    attemptsCount: p.attempts?.length ?? 0,
    lastAttempt: last ? game.i18n.format(last.success ? "CPRHQ.Workshop.lastSuccess" : "CPRHQ.Workshop.lastFail", { total: last.total })
      + (showDV && last.dv ? ` (DV ${last.dv})` : "") : "",
    benchIndex,
    onBench: benchIndex >= 0,
    benchLabel: benchIndex >= 0 ? loc(`CPRHQ.Workshop.slot.${benchIndex}`) : "",
    workable: workable(p),
    canBench: owner && workable(p),
    canUnbench: owner && (benchIndex >= 0),
    noWorkshop: !!type.noWorkshop,
    canDrop: owner && canLinkItem(p),
    awaitingItem: type.gmItem && !p.item && (p.status !== "complete"),
    canEdit: owner && ["pending", "returned"].includes(p.status),
    canReview: game.user.isGM,
    canRoll: owner && (status === "ready"),
    rollLabel: loc(halfway ? "CPRHQ.Workshop.rollHalfway" : "CPRHQ.Workshop.roll"),
    canDelete: game.user.isGM || (owner && (p.status !== "complete")),
    canPrototype: owner && (p.type === "invent") && (p.status === "complete") && !p.finished,
    canFinish: owner && (p.type !== "invent") && (p.status === "complete") && !p.finished,
    draggable: owner && workable(p)
  };
}

/** A design's row shows what the next run would be: its DV, hours and materials, and the check for Fabricate. */
function designView(actor, design, { owner, open }) {
  const { source, invented, made } = design;
  return {
    ...projectView(actor, { ...fabricationOf(source), id: source.id }, { benchIndex: -1, owner, open }),
    isDesign: true,
    status: "complete",
    statusLabel: loc(`CPRHQ.Workshop.kind.${invented ? "invent" : "fabricate"}`),
    made: made ? game.i18n.format("CPRHQ.Workshop.madeN", { n: made }) : "",
    completed: source.completed,
    canAgain: owner,
    canBench: false,
    canDelete: game.user.isGM,
    draggable: false
  };
}

/** The HQ Workshop card: rank, tiers and (GM) purchase/upgrade. */
function workshopCard(actor) {
  const access = workshopAccess(actor);
  const entry = access?.entry ?? crewHQ(actor);
  if ( !entry ) return { none: true };
  const hq = getHQ(entry);
  const def = getDefinition(hq, "workshop");
  const view = def ? improvementView(hq, def) : null;
  return {
    entryUuid: entry.uuid,
    hqName: entry.name,
    rank: access?.rank ?? 0,
    view,
    canAdvance: game.user.isGM && !!view?.action,
    accessNote: !hq.hasAccess ? loc("CPRHQ.Workshop.hqNoAccess") : ""
  };
}

/** Context for one Tech's Workshop panel. */
export function workshopContext(actor, ui) {
  if ( !actor ) return { empty: loc("CPRHQ.Workshop.noTech") };
  const owner = actor.isOwner;
  const data = workshopData(actor);
  const plan = benchPlan(actor, data);
  const size = benchSize(actor);
  const benchIds = plan.bench.map(p => p?.id ?? null);
  const views = data.projects.map(p => projectView(actor, p, { benchIndex: benchIds.indexOf(p.id), owner, open: ui.open === p.id }));
  const byId = new Map(views.map(v => [v.id, v]));
  const hours = Math.min(ui.hours ?? plan.max, plan.max);
  const access = workshopAccess(actor);

  const slots = Array.from({ length: 3 }, (_, i) => {
    const project = plan.bench[i] ? byId.get(plan.bench[i].id) : null;
    const locked = i >= size;
    return {
      slot: i,
      label: loc(`CPRHQ.Workshop.slot.${i}`),
      locked,
      lockText: !locked ? "" : (i === 1 ? loc("CPRHQ.Workshop.slotNeedsWorkshop") : loc("CPRHQ.Workshop.slotNeedsUpgrade")),
      project,
      gain: project ? plan.gets(plan.bench[i], i, hours) : 0,
      idle: project && (i > 0) && workable(plan.bench[i]) && !plan.gets(plan.bench[i], i, Math.max(1, hours)),
      idleText: project && (i > 0) ? loc(plan.echoes ? "CPRHQ.Workshop.repairNoEcho" : "CPRHQ.Workshop.mainIsRepair") : ""
    };
  });
  // Every slot the HQ could give, in one row: the next locked one shows what an upgrade would add.
  const bench = slots.filter(s => !s.locked || (s.slot === size));

  // Active: everything not finished. Designs: what can be made again, then finished upgrades and repairs.
  const active = views.filter(v => !v.finished);
  const types = [...new Set(active.map(v => v.type))];
  const filter = types.includes(ui.filter) ? ui.filter : "all";
  const shown = active.filter(v => (filter === "all") || (v.type === filter));
  const designs = designsOf(data).map(d => designView(actor, d, { owner, open: ui.open === d.source.id }));
  const finishedWork = views.filter(v => v.finished && !["invent", "fabricate"].includes(v.type))
    .map(v => ({ ...v, statusLabel: loc(`CPRHQ.Workshop.kind.${v.type}`) }));
  const sortKey = SORTS[ui.sort];
  const group = (...statuses) => shown.filter(v => statuses.includes(v.status));
  const ctx = {
    actor: { uuid: actor.uuid, name: actor.name, img: actor.img },
    owner, isGM: game.user.isGM,
    profile: techProfile(actor),
    bank: data.bank,
    bench,
    hasWorkshop: !!access,
    work: {
      max: plan.max, hours,
      disabled: !owner || !plan.max,
      reason: !plan.main ? loc("CPRHQ.Workshop.noMain") : !workable(plan.main) ? loc("CPRHQ.Workshop.mainBlocked") : ""
    },
    view: (ui.view === "designs") ? "designs" : "active",
    activeCount: active.length,
    designCount: designs.length + finishedWork.length,
    filters: (types.length > 1) ? ["all", ...types].map(id => ({
      id,
      active: id === filter,
      label: (id === "all") ? loc("CPRHQ.Workshop.filterAll") : loc(`CPRHQ.Workshop.type.${id}`),
      icon: PROJECT_TYPES[id]?.icon,
      color: PROJECT_TYPES[id]?.color
    })) : [],
    sort: sortKey ? ui.sort : null,
    sorted: sortKey ? [...shown].sort((a, b) => { const [x, y] = [sortKey(a), sortKey(b)]; return (x < y) ? -1 : (x > y) ? 1 : 0; }) : null,
    groups: [
      { id: "ready", label: loc("CPRHQ.Workshop.group.ready"), icon: "fa-solid fa-dice-d10", projects: group("ready", "rolled", "complete") },
      { id: "active", label: loc("CPRHQ.Workshop.group.active"), icon: "fa-solid fa-hammer", projects: group("active") },
      { id: "available", label: loc("CPRHQ.Workshop.group.available"), icon: "fa-solid fa-gears", projects: group("available", "materials") },
      { id: "pending", label: loc("CPRHQ.Workshop.group.pending"), icon: "fa-solid fa-hourglass-half", projects: group("pending", "returned") }
    ],
    designs,
    finishedWork,
    projects: views,
    counts: { ready: group("ready").length, pending: group("pending").length },
    workshop: workshopCard(actor),
    log: data.log.slice(-12).reverse()
  };
  ctx.empty = !views.length;
  return ctx;
}

/** Techs to choose from on the HQ page: the crew's Techs the user can see. */
export function crewTechs(hq) {
  return hq.crew.map(m => fromUuidSync(m.uuid)).filter(a => isTech(a) && a.testUserPermission(game.user, "OBSERVER"));
}

/* -------------------------------------------- */
/*  Listeners                                   */
/* -------------------------------------------- */

async function confirm(title, content) {
  return foundry.applications.api.DialogV2.confirm({
    classes: ["cpr-hq-dialog"], window: { title: loc(title) }, content: `<p>${content}</p>`, rejectClose: false, modal: true
  });
}

export function activateWorkshop(root, ui, rerender) {
  const panel = root.querySelector(".ws-panel");
  if ( !panel ) return;
  const actor = fromUuidSync(panel.dataset.actorUuid);
  if ( !actor ) return;
  const projectOf = el => workshopData(actor).projects.find(p => p.id === el.closest("[data-ws-project]")?.dataset.wsProject);

  panel.addEventListener("click", async event => {
    const button = event.target.closest("[data-ws-action]");
    if ( !button || button.disabled ) return;
    event.preventDefault();
    event.stopPropagation();
    const project = projectOf(button);
    switch ( button.dataset.wsAction ) {
      case "toggleRow":
        ui.open = (ui.open === project?.id) ? null : project?.id;
        return rerender();
      case "view":
        ui.view = button.dataset.value;
        ui.open = null;
        return rerender();
      case "filter":
        ui.filter = button.dataset.value;
        return rerender();
      case "sort":
        ui.sort = (ui.sort === button.dataset.value) ? null : button.dataset.value;
        return rerender();
      case "again":
        ui.view = "active";
        return project && fabricateAgain(actor, project.id);
      case "new": {
        const input = await projectDialog(actor);
        return input && proposeProject(actor, input);
      }
      case "edit": {
        const input = project && await projectDialog(actor, project);
        return input && reviseProject(actor, project.id, input);
      }
      case "review": {
        const result = project && await reviewDialog(actor, project);
        return result && reviewProject(actor, project.id, result.input, result.status);
      }
      case "delete": {
        const ok = project && await confirm("CPRHQ.Workshop.delete", game.i18n.format("CPRHQ.Workshop.deleteConfirm", { name: project.name }));
        return ok && deleteProject(actor, project.id);
      }
      case "roll": return project && rollProject(actor, project.id, event);
      case "succeed": return project && resolveRoll(actor, project.id, true);
      case "fail": return project && resolveRoll(actor, project.id, false);
      case "prototype": return project && startPrototype(actor, project.id);
      case "finish": return project && finishProject(actor, project.id);
      case "bench": {
        // First free slot (the main slot when empty).
        const { bench } = benchPlan(actor);
        const size = benchSize(actor);
        let slot = Array.from({ length: size }, (_, i) => i).find(i => !bench[i]);
        if ( slot === undefined ) slot = 0;
        return project && benchProject(actor, project.id, slot);
      }
      case "unbench": return project && unbenchProject(actor, project.id);
      case "work": {
        const input = panel.querySelector("[data-ws-hours]");
        await work(actor, Number(input?.value) || 0);
        ui.hours = null;
        return;
      }
      case "bank": return bankDialog(actor);
      case "openItem": {
        const item = project?.item && await fromUuid(project.item.uuid);
        return item?.sheet.render(true);
      }
      case "unlinkItem": return project && linkItem(actor, project.id, null);
      case "openHQ": {
        const entry = await fromUuid(button.dataset.uuid);
        const sheet = entry?.sheet;
        if ( !sheet ) return;
        await sheet.render(true);
        return sheet.changeTab?.("workshop", "page");
      }
      case "advanceWorkshop": {
        const entry = await fromUuid(button.dataset.uuid);
        return entry && advanceImprovement(entry, "workshop");
      }
      case "showImage": {
        const src = button.dataset.src;
        return src && new ImagePopout(src, { title: button.dataset.title ?? "" }).render(true);
      }
    }
  });

  // Hours to spend: the preview of what each slot gets follows the slider without a re-render.
  for ( const input of panel.querySelectorAll("[data-ws-hours]") ) {
    // Not part of the HQ sheet's form.
    input.addEventListener("change", event => event.stopPropagation());
    input.addEventListener("input", () => {
      const hours = Math.max(0, Math.min(Number(input.value) || 0, Number(input.max) || 0));
      ui.hours = hours;
      for ( const other of panel.querySelectorAll("[data-ws-hours]") ) if ( other !== input ) other.value = hours;
      const plan = benchPlan(actor);
      for ( const gain of panel.querySelectorAll("[data-ws-gain]") ) {
        const i = Number(gain.dataset.wsGain);
        gain.textContent = `+${plan.gets(plan.bench[i], i, hours)}h`;
      }
      const label = panel.querySelector("[data-ws-work-label]");
      if ( label ) label.textContent = game.i18n.format("CPRHQ.Workshop.workN", { n: hours });
    });
  }

  // Projects drag onto bench slots; items drag onto projects.
  for ( const card of panel.querySelectorAll("[draggable=true]") ) {
    const id = card.dataset.wsDrag ?? card.dataset.wsProject;
    if ( !id ) continue;
    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: DRAG_TYPE, id }));
      panel.classList.add("ws-dragging");
    });
    card.addEventListener("dragend", () => panel.classList.remove("ws-dragging"));
  }
  const dropTarget = (el, onDrop) => {
    el.addEventListener("dragover", event => { event.preventDefault(); el.classList.add("drag-over"); });
    el.addEventListener("dragleave", event => { if ( !el.contains(event.relatedTarget) ) el.classList.remove("drag-over"); });
    el.addEventListener("drop", async event => {
      event.preventDefault();
      event.stopPropagation();
      el.classList.remove("drag-over");
      panel.classList.remove("ws-dragging");
      const data = TextEditor.getDragEventData(event);
      await onDrop(data);
    });
  };
  for ( const slot of panel.querySelectorAll("[data-ws-slot]:not(.locked)") ) {
    if ( !actor.isOwner ) continue;
    dropTarget(slot, data => {
      if ( data?.type === DRAG_TYPE ) return benchProject(actor, data.id, Number(slot.dataset.wsSlot));
    });
  }
  for ( const zone of panel.querySelectorAll("[data-ws-item-drop]") ) {
    dropTarget(zone, async data => {
      if ( data?.type === DRAG_TYPE ) {
        // A project dropped on a benched card takes its slot.
        const slot = zone.closest("[data-ws-slot]");
        if ( slot ) return benchProject(actor, data.id, Number(slot.dataset.wsSlot));
        return;
      }
      if ( data?.type !== "Item" ) return;
      const item = await fromUuid(data.uuid);
      const project = projectOf(zone);
      if ( item && project ) return linkItem(actor, project.id, item);
    });
  }
}
