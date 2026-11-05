import {
  currentRound, unsettled, settledAt, dayLabel, startRound, releaseRound, cancelRound, missionBlocks, setMission,
  draftFor, saveDraft, unassignedHours, sleepPerDay, hoursByActivity, settleRound, pastDays, SLEEP_MINIMUM, HOURS,
  blockSpec, fillGaps, missingDetails, costsOf, parseCost, DAY, daysBehind, shiftDates
} from "./model.mjs";
import { timelineView, activateTimeline, blockDialog, blockInfoDialog, blockTip, captionOf } from "./timeline.mjs";
import { dateLabelAt } from "../calendar.mjs";
import { formatSpan } from "../alerts.mjs";
import { formatNumber } from "../utils.mjs";
import { activitiesDialog } from "./editor.mjs";
import { applyContext, appliedResults, activateApply } from "./apply.mjs";
import { clearPractice } from "../training.mjs";

/**
 * The Downtime section (top of the Downtime/Lifestyle panel). Hosts (the window and the HQ tab) keep a small UI state
 * object and call `downtimeContext` when rendering and `activateDowntime` afterwards.
 * Buttons use data-dt-action (handled here), so either host works without registering actions.
 */

const loc = key => game.i18n.localize(key);
const PAST_STEP = 7;

export function newDowntimeUI() {
  return { target: null, pastOpen: false, pastLimit: PAST_STEP, pastActor: null };
}

/** The player's status banner: what's happening with their schedule. */
const BANNER_ICONS = { draft: "fa-solid fa-calendar-plus", submitted: "fa-solid fa-paper-plane", approved: "fa-solid fa-circle-check", returned: "fa-solid fa-rotate-left" };

const STATUS_ICONS = { draft: "fa-solid fa-pen", submitted: "fa-solid fa-paper-plane", approved: "fa-solid fa-check", returned: "fa-solid fa-rotate-left" };

/**
 * Review summary for a schedule: unassigned hours, hours per activity, days short on sleep, details still missing,
 * costs to settle by hand, and comments.
 */
function summary(round, blocks) {
  const sleep = sleepPerDay(round, blocks);
  const day = b => dayLabel(round.start, Math.floor(b.start / HOURS));
  const missing = missingDetails(blocks);
  return {
    unassigned: unassignedHours(round, blocks),
    totals: hoursByActivity(blocks),
    shortSleep: (() => {
      const days = sleep.map((h, d) => ({ h, label: dayLabel(round.start, d) })).filter(x => x.h < SLEEP_MINIMUM);
      return days.length ? { n: days.length, tip: days.map(x => `${x.label}: ${x.h}h`).join("<br>") } : null;
    })(),
    missing: missing.length ? { n: missing.length, tip: missing.map(b => `${Handlebars.escapeExpression(blockSpec(b).fullName)} · ${day(b)}`).join("<br>") } : null,
    costs: costSummary(costsOf(round, blocks)),
    notes: onePerGroup(blocks).filter(b => b.notes || b.detail).map(b => ({ name: blockSpec(b).fullName, day: day(b), detail: b.detail, notes: b.notes }))
  };
}

/** Hours new activities can use: unassigned, plus Sleep (which makes way for anything placed on it). */
function freeHours(sum, blocks) {
  return sum.unassigned + blocks.filter(b => b.activity === "sleep").reduce((n, b) => n + b.length, 0);
}

/** One entry per multi-day activity (its first day), so a 5-day Training lists once. */
function onePerGroup(blocks) {
  const seen = new Set();
  return blocks.filter(b => {
    if ( !b.group ) return true;
    if ( seen.has(b.group) ) return false;
    seen.add(b.group);
    return true;
  });
}

/** "Total costs: 650eb" (with "+" when a cost can run higher), and the lines behind it. */
function costSummary(lines) {
  if ( !lines.length ) return null;
  const parsed = lines.map(l => parseCost(l.cost));
  const total = parsed.reduce((sum, p) => sum + p.value, 0);
  return { lines, total: `${formatNumber(total)}eb${parsed.some(p => p.extra) ? "+" : ""}` };
}

/**
 * @param {Actor[]} actors  Characters this view covers (participants)
 * @param {object} ui       State from newDowntimeUI()
 */
export function downtimeContext(actors, ui) {
  const isGM = game.user.isGM;
  const round = currentRound();
  const { days: unsettledDays, seconds } = unsettled();
  const settled = settledAt();
  const ctx = {
    isGM, unsettledDays,
    // Less than a day isn't worth mentioning (e.g. the hour since a round was settled).
    pendingLabel: seconds >= DAY ? formatSpan(seconds) : null,
    settledLabel: settled !== null ? dateLabelAt(settled) : null,
    // Simple Calendar turned back past the settled date: nothing settles until it catches up (or the GM shifts dates).
    behindLabel: isGM && daysBehind() ? game.i18n.format("CPRHQ.Downtime.behind", { n: daysBehind() }) : null,
    round: null, past: pastContext(actors, ui), applyRounds: applyContext(actors)
  };
  if ( !round ) return ctx;

  ctx.round = {
    status: round.status, planning: round.status === "planning", open: round.status === "open", days: round.days,
    range: `${dayLabel(round.start, 0)} – ${dayLabel(round.start, round.days - 1)}`
  };

  if ( isGM ) {
    ctx.participants = actors.map(a => {
      const draft = draftFor(a, round);
      return { uuid: a.uuid, name: a.name, status: draft.status, icon: STATUS_ICONS[draft.status],
        statusLabel: loc(`CPRHQ.Downtime.status.${draft.status}`), custom: !!round.missionFor?.[a.uuid] };
    });
    ctx.allApproved = ctx.participants.length && ctx.participants.every(p => p.status === "approved");
    if ( round.status === "planning" ) {
      // Planning: the GM blocks out In Mission for the party, or overrides one character.
      const target = actors.find(a => a.uuid === ui.target) ?? null;
      ctx.target = target?.uuid ?? "party";
      ctx.targetName = target?.name ?? loc("CPRHQ.Downtime.party");
      ctx.targetCustom = !!(target && round.missionFor?.[target.uuid]);
      const blocks = target ? (round.missionFor?.[target.uuid] ?? null) : round.mission;
      ctx.timeline = timelineView(round, {
        blocks: blocks ?? [], locked: target && !blocks ? round.mission : [], editable: !target || !!blocks, mode: "mission"
      });
      // The party's mission is saved with no character.
      ctx.timelineTarget = target?.uuid ?? "";
    } else {
      const target = actors.find(a => a.uuid === ui.target) ?? actors[0];
      if ( target ) {
        const draft = draftFor(target, round);
        const mission = missionBlocks(round, target.uuid);
        ctx.target = target.uuid;
        ctx.targetName = target.name;
        ctx.draft = { ...draft, statusLabel: loc(`CPRHQ.Downtime.status.${draft.status}`) };
        ctx.summary = summary(round, [...mission.map(b => ({ ...b, activity: "mission" })), ...draft.blocks]);
        ctx.timeline = timelineView(round, { blocks: draft.blocks, locked: mission, editable: true, mode: "schedule", actor: target, free: freeHours(ctx.summary, draft.blocks) });
        ctx.timelineTarget = target.uuid;
      }
    }
    return ctx;
  }

  // Player: their own character's schedule once the GM releases the round.
  if ( round.status !== "open" ) return ctx;
  const mine = actors.filter(a => a.isOwner);
  const target = mine.find(a => a.uuid === ui.target) ?? mine[0];
  if ( !target ) return ctx;
  const draft = draftFor(target, round);
  const mission = missionBlocks(round, target.uuid);
  ctx.mine = mine.length > 1 ? mine.map(a => ({ uuid: a.uuid, name: a.name, selected: a === target })) : null;
  ctx.target = target.uuid;
  ctx.targetName = target.name;
  ctx.draft = { ...draft, statusLabel: loc(`CPRHQ.Downtime.status.${draft.status}`) };
  const editable = ["draft", "returned"].includes(draft.status);
  ctx.banner = { icon: BANNER_ICONS[draft.status], title: loc(`CPRHQ.Downtime.banner.${draft.status}`) };
  ctx.summary = summary(round, [...mission.map(b => ({ ...b, activity: "mission" })), ...draft.blocks]);
  ctx.timeline = timelineView(round, { blocks: draft.blocks, locked: mission, editable, mode: "schedule", actor: target, free: freeHours(ctx.summary, draft.blocks) });
  ctx.timelineTarget = target.uuid;
  // Every hour must be accounted for (and every detail given) before submitting: offer to fill the rest with Freetime.
  ctx.canSubmit = editable;
  ctx.needsFill = editable && (ctx.summary.unassigned > 0);
  ctx.blockedSubmit = editable && !ctx.needsFill && !!ctx.summary.missing;
  return ctx;
}

/** Past Days: collapsed by default; a few days at a time; the GM picks the character. */
function pastContext(actors, ui) {
  const options = game.user.isGM ? actors : actors.filter(a => a.isOwner);
  const actor = options.find(a => a.uuid === ui.pastActor) ?? options[0];
  const past = { open: ui.pastOpen, choices: options.map(a => ({ uuid: a.uuid, name: a.name, selected: a === actor })) };
  ui.pastShown = actor?.uuid ?? null;
  if ( !ui.pastOpen || !actor ) return past;
  const { days, more } = pastDays(actor, ui.pastLimit);
  past.more = more;
  past.results = appliedResults(actor);
  past.days = days.map(d => ({
    label: d.label,
    segments: d.blocks.map(b => {
      const spec = blockSpec(b);
      const shown = { ...b, length: b.end - b.start };
      return { left: (b.start / HOURS) * 100, width: ((b.end - b.start) / HOURS) * 100, color: spec.color, icon: spec.icon,
        name: spec.variant?.name ?? spec.name, caption: captionOf(b), tip: blockTip(shown, spec) };
    })
  }));
  return past;
}

/**
 * Wire the section. `rerender` redraws the host (UI-state changes); data changes redraw through hooks.
 */
export function activateDowntime(root, ui, rerender) {
  const section = root.querySelector(".dt-downtime");
  if ( !section ) return;
  activateApply(section);
  const round = currentRound();

  section.addEventListener("change", event => {
    const el = event.target;
    if ( !el.dataset.dtSelect ) return;
    event.stopPropagation();
    if ( el.dataset.dtSelect === "target" ) ui.target = el.value || null;
    if ( el.dataset.dtSelect === "past" ) { ui.pastActor = el.value; ui.pastLimit = PAST_STEP; }
    rerender();
  });

  section.addEventListener("click", async event => {
    const button = event.target.closest("[data-dt-action]");
    if ( !button ) return;
    event.preventDefault();
    const action = button.dataset.dtAction;
    const actor = ui.target ? fromUuidSync(ui.target) : null;
    switch ( action ) {
      case "start": return startRound();
      case "release": return releaseRound();
      case "cancel": {
        const ok = await confirm("CPRHQ.Downtime.cancel", loc("CPRHQ.Downtime.cancelConfirm"));
        return ok && cancelRound();
      }
      case "target":
        ui.target = button.dataset.uuid || null;
        return rerender();
      case "customMission":
        return actor && setMission(actor.uuid, foundry.utils.deepClone(round.mission ?? []));
      case "partyMission":
        return actor && setMission(actor.uuid, null);
      case "fill": {
        const target = fromUuidSync(button.dataset.uuid);
        const draft = draftFor(target, round);
        const filler = fillGaps(round, [...missionBlocks(round, target.uuid), ...draft.blocks]);
        return saveDraft(target, { blocks: [...draft.blocks, ...filler], status: game.user.isGM ? draft.status : "draft" });
      }
      case "submit": {
        const target = fromUuidSync(button.dataset.uuid);
        const draft = draftFor(target, round);
        const all = [...missionBlocks(round, target.uuid), ...draft.blocks];
        if ( unassignedHours(round, all) ) return ui.notifications.warn("CPRHQ.Downtime.fillFirst", { localize: true });
        if ( missingDetails(draft.blocks).length ) return ui.notifications.warn("CPRHQ.Downtime.detailsFirst", { localize: true });
        return saveDraft(target, { status: "submitted" });
      }
      case "pastBlock": {
        const owner = fromUuidSync(ui.pastShown);
        const day = owner && pastDays(owner, ui.pastLimit).days[Number(button.dataset.day)];
        const block = day?.blocks[Number(button.dataset.seg)];
        return block && blockInfoDialog({ ...block, length: block.end - block.start }, day.label);
      }
      case "approve":
        return saveDraft(fromUuidSync(button.dataset.uuid), { status: "approved", note: "" });
      case "return": {
        const target = fromUuidSync(button.dataset.uuid);
        const note = await returnDialog(target.name);
        return (note !== null) && saveDraft(target, { status: "returned", note });
      }
      case "settle":
        return settleDialog(ui.participants());
      case "activities":
        return activitiesDialog();
      case "shiftDates":
        return shiftDialog();
      case "missionIP": {
        if ( !await confirm("CPRHQ.Training.missionIP", loc("CPRHQ.Training.missionIPConfirm")) ) return;
        const n = await clearPractice();
        // `ui` here is the section's UI state, not Foundry's.
        return globalThis.ui.notifications.info(game.i18n.format("CPRHQ.Training.cleared", { n }));
      }
      case "pastToggle":
        ui.pastOpen = !ui.pastOpen;
        return rerender();
      case "pastMore":
        ui.pastLimit += PAST_STEP;
        return rerender();
    }
  });

  // The timeline: mission painting (GM, planning) or a character's schedule.
  if ( !round ) return;
  const mode = section.querySelector(".dt-timeline")?.dataset.mode;
  const targetUuid = section.querySelector(".dt-timeline")?.dataset.target || null;
  const target = targetUuid ? fromUuidSync(targetUuid) : null;
  activateTimeline(section, {
    save: blocks => {
      if ( mode === "mission" ) return setMission(targetUuid, blocks);
      if ( !target ) return;
      const draft = draftFor(target, round);
      // Players editing a returned schedule put it back to draft; GM edits keep the status.
      return saveDraft(target, { blocks, status: game.user.isGM ? draft.status : "draft" });
    },
    edit: block => blockDialog(block, { actor: target })
  });
}

async function confirm(title, content) {
  const result = await foundry.applications.api.DialogV2.confirm({
    classes: ["cpr-hq-dialog"], window: { title: loc(title) }, content: `<p>${content}</p>`, rejectClose: false, modal: true
  });
  return result === true;
}

async function returnDialog(name) {
  const data = await foundry.applications.api.DialogV2.prompt({
    classes: ["cpr-hq-dialog"],
    window: { title: game.i18n.format("CPRHQ.Downtime.returnTitle", { name }), icon: "fa-solid fa-rotate-left" },
    content: `<div class="form-group stacked"><label>${loc("CPRHQ.Downtime.returnNote")}</label><textarea name="note" rows="3"></textarea></div>`,
    rejectClose: false, modal: true,
    ok: { label: loc("CPRHQ.Downtime.return"), icon: "fa-solid fa-rotate-left", callback: (e, b) => b.form.elements.note.value }
  });
  return (data === null || data === undefined) ? null : String(data);
}

/** GM: settle the round. Warn if anyone isn't approved; optionally apply Fatigued for short sleep on the last day. */
async function settleDialog(actors) {
  const round = currentRound();
  if ( !round ) return;
  const pending = actors.filter(a => draftFor(a, round).status !== "approved");
  const data = await foundry.applications.api.DialogV2.prompt({
    classes: ["cpr-hq-dialog"],
    window: { title: loc("CPRHQ.Downtime.settle"), icon: "fa-solid fa-flag-checkered" },
    content: `
      <p>${game.i18n.format("CPRHQ.Downtime.settleText", { n: round.days })}</p>
      ${pending.length ? `<p class="hint"><i class="fa-solid fa-triangle-exclamation"></i> ${game.i18n.format("CPRHQ.Downtime.settlePending",
        { names: pending.map(a => Handlebars.escapeExpression(a.name)).join(", ") })}</p>` : ""}
      <div class="form-group"><label>${loc("CPRHQ.Downtime.applyFatigue")}</label>
        <div class="form-fields"><input type="checkbox" name="fatigue" checked></div></div>`,
    rejectClose: false, modal: true,
    ok: { label: loc("CPRHQ.Downtime.settle"), icon: "fa-solid fa-flag-checkered", callback: (e, b) => ({ fatigue: b.form.elements.fatigue.checked }) }
  });
  if ( !data ) return;
  await settleRound(actors, { applyFatigue: data.fatigue });
}

/**
 * GM: move every downtime date (settled date, open round, Past Days) by a number of days, and optionally Simple
 * Calendar with them. When the calendar was already turned back past the settled date, offers to catch up to it.
 */
async function shiftDialog() {
  const behind = daysBehind();
  const data = await foundry.applications.api.DialogV2.prompt({
    classes: ["cpr-hq-dialog"],
    window: { title: loc("CPRHQ.Downtime.shift"), icon: "fa-solid fa-calendar-days" },
    content: `
      <p>${loc("CPRHQ.Downtime.shiftText")}</p>
      ${behind ? `<p class="hint"><i class="fa-solid fa-triangle-exclamation"></i> ${game.i18n.format("CPRHQ.Downtime.shiftBehind", { n: behind })}</p>` : ""}
      <div class="form-group"><label>${loc("CPRHQ.Downtime.shiftDays")}</label>
        <div class="form-fields"><input type="number" name="days" step="1" value="${behind ? -behind : -7}" autofocus></div>
        <p class="hint">${loc("CPRHQ.Downtime.shiftDaysHint")}</p></div>
      <div class="form-group"><label>${loc("CPRHQ.Downtime.shiftCalendar")}</label>
        <div class="form-fields"><input type="checkbox" name="calendar" ${behind ? "" : "checked"}></div></div>`,
    rejectClose: false, modal: true,
    ok: {
      label: loc("CPRHQ.Downtime.shift"), icon: "fa-solid fa-calendar-days",
      callback: (e, b) => ({ days: Math.trunc(Number(b.form.elements.days.value)), calendar: b.form.elements.calendar.checked })
    }
  });
  if ( !data?.days ) return;
  await shiftDates(data.days, { calendar: data.calendar });
}
