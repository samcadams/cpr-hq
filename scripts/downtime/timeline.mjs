import { HOURS, activities, activity, blockSpec, blocksFor, availability, dayLabel, isMissing, isMaintenance, reorderActivities } from "./model.mjs";
import { needingUpkeep, upkeepStatus } from "../upkeep.mjs";
import { practiceSlots, practiceSkills } from "../training.mjs";

/**
 * The downtime timeline: one row per day, 24 hour columns, activities as bars.
 * View data is built by `timelineView`; `activateTimeline` wires dragging from the palette, moving and resizing bars
 * (snapping to whole hours, with a live preview), and clicking a bar to edit it. Blocks are absolute hour ranges in the
 * round, so a bar can cross midnight and is drawn as one segment per day it touches.
 * Sleep gives way: placing anything over Sleep trims the Sleep around it.
 */

const loc = key => game.i18n.localize(key);
const esc = value => Handlebars.escapeExpression(value ?? "");
/** Multi-line text for a tooltip (tooltips render HTML). */
const tipText = value => esc(value).replace(/\n/g, "<br>");
const clock = hour => `${String(((hour % HOURS) + HOURS) % HOURS).padStart(2, "0")}:00`;

/** The caption after a bar's name: the activity detail, else the first line of the notes. */
export function captionOf(block) {
  return String(block.detail || (block.notes ?? "").split("\n")[0] || "").trim();
}

/** Tooltip for a bar or a past-day segment. */
export function blockTip(block, spec = blockSpec(block)) {
  const lines = [`<strong>${esc(spec.fullName)}</strong> · ${block.length}h · ${clock(block.start)}–${clock(block.start + block.length)}`];
  if ( block.detail ) lines.push(`${esc(spec.prompt?.label ?? loc("CPRHQ.Downtime.detail"))}: ${esc(block.detail)}`);
  if ( spec.cost ) lines.push(`<i class="fa-solid fa-coins"></i> ${esc(spec.cost)}`);
  if ( block.notes ) lines.push(`<em>${tipText(block.notes)}</em>`);
  return lines.join("<br>");
}

/** Split blocks into per-day segments for drawing. */
function segmentsFor(blocks, days, { locked = false } = {}) {
  const rows = Array.from({ length: days }, () => []);
  for ( const b of blocks ) {
    const spec = blockSpec(b);
    let first = true;
    for ( let d = Math.floor(b.start / HOURS); d < days && (d * HOURS) < (b.start + b.length); d++ ) {
      if ( d < 0 ) continue;
      const from = Math.max(b.start, d * HOURS) - (d * HOURS);
      const to = Math.min(b.start + b.length, (d + 1) * HOURS) - (d * HOURS);
      const missing = isMissing(b, spec);
      rows[d].push({
        id: b.id, name: spec.variant ? spec.variant.name : spec.name, icon: spec.icon, color: spec.color,
        left: (from / HOURS) * 100, width: ((to - from) / HOURS) * 100,
        label: first, locked, caption: first ? captionOf(b) : "", resizable: !locked && spec.flexible,
        missing,
        tip: (missing ? `<span class="dt-tip-missing"><i class="fa-solid fa-circle-exclamation"></i> ${game.i18n.format("CPRHQ.Downtime.missingTip", { what: esc(spec.prompt?.label ?? "") })}</span><br>` : "") + blockTip(b, spec),
        startsHere: b.start >= d * HOURS, endsHere: (b.start + b.length) <= (d + 1) * HOURS
      });
      first = false;
    }
  }
  return rows;
}

/** Hours an activity takes in all (every day of a multi-day one); with types, the shortest type. */
function totalHours(def) {
  if ( def.variants?.length ) return Math.min(...def.variants.map(v => v.hours ?? 1));
  return (def.hours ?? 1) * Math.max(1, def.days ?? 1);
}

/** Palette tooltip: length, cost, requirements and the activity's description. */
function paletteTip(def, why) {
  const days = Math.max(1, def.days ?? 1);
  const lines = [`<strong>${esc(def.name)}</strong>`];
  if ( def.variants?.length ) lines.push(loc("CPRHQ.Downtime.hintVariants"));
  else if ( days > 1 ) lines.push(game.i18n.format("CPRHQ.Downtime.hintMulti", { h: def.hours, d: days }));
  else lines.push(game.i18n.format("CPRHQ.Downtime.hintHours", { h: def.hours ?? 1 }));
  if ( def.cost ) lines.push(`<i class="fa-solid fa-coins"></i> ${esc(def.cost)}`);
  if ( def.countsAsSleep ) lines.push(`<i class="fa-solid fa-bed"></i> ${loc("CPRHQ.Downtime.countsAsSleep")}`);
  if ( def.prompt ) lines.push(`<i class="fa-solid fa-pen"></i> ${esc(def.prompt.label)}`);
  if ( why ) lines.push(`<span class="dt-tip-warn"><i class="fa-solid fa-lock"></i> ${esc(why)}</span>`);
  if ( def.description ) lines.push(`<hr>${tipText(def.description)}`);
  return lines.join("<br>");
}

/**
 * @param {object} round
 * @param {object} options
 * @param {object[]} options.blocks    Editable blocks
 * @param {object[]} [options.locked]  Fixed blocks drawn underneath (e.g. "In Mission" for a player)
 * @param {boolean} options.editable
 * @param {"schedule"|"mission"} options.mode  Mission mode: the GM paints In Mission only
 * @param {Actor} [options.actor]      Whose schedule (Role / HQ requirements in the palette)
 * @param {number} [options.free]      Hours free for new activities (unassigned + Sleep, which makes way): activities
 *                                     needing more are shown colourless (still usable)
 */
export function timelineView(round, { blocks, locked = [], editable, mode, actor = null, free = null }) {
  const editRows = segmentsFor(blocks, round.days);
  const lockRows = segmentsFor(locked.map(b => ({ ...b, activity: "mission" })), round.days, { locked: true });
  const palette = [];
  for ( const def of activities() ) {
    if ( (mode === "mission") ? (def.id !== "mission") : def.locked ) continue;
    const check = (mode === "mission") ? { ok: true } : availability(def, actor);
    if ( check.hidden ) continue;
    const needs = totalHours(def);
    const tooBig = (free !== null) && (needs > free);
    palette.push({
      id: def.id, name: def.name, icon: def.icon, color: def.color,
      tip: paletteTip(def, check.ok ? null : check.reason) + (tooBig ? `<br><span class="dt-tip-warn">${game.i18n.format("CPRHQ.Downtime.notEnoughTime", { h: needs, free })}</span>` : ""),
      unavailable: !check.ok, tooBig, draggable: check.ok || game.user.isGM
    });
  }
  return {
    editable, mode,
    reorderable: game.user.isGM && (mode !== "mission"),
    hours: Array.from({ length: HOURS / 3 }, (_, i) => String(i * 3).padStart(2, "0")),
    rows: Array.from({ length: round.days }, (_, d) => ({
      index: d, label: dayLabel(round.start, d), segments: [...lockRows[d], ...editRows[d]]
    })),
    palette,
    blocksJSON: JSON.stringify(blocks),
    lockedJSON: JSON.stringify(locked)
  };
}

/* -------------------------------------------- */
/*  Placement rules                             */
/* -------------------------------------------- */

const overlapping = (a, b) => (a.start < b.start + b.length) && (b.start < a.start + a.length);

/**
 * Would these candidate blocks fit? Locked (mission) and non-Sleep blocks block them; Sleep gives way.
 * @returns {{ok: boolean, reason?: string}}
 */
function checkPlacement(candidates, { blocks, locked, total, ignore = new Set(), minCheck = false }) {
  if ( !candidates.every(c => (c.start >= 0) && (c.length >= 1) && (c.start + c.length <= total)) ) return { ok: false, reason: loc("CPRHQ.Downtime.noRoom") };
  if ( minCheck ) {
    const short = candidates.find(c => c.length < blockSpec(c).minHours);
    if ( short ) return { ok: false, reason: game.i18n.format("CPRHQ.Downtime.tooShort", { h: blockSpec(short).minHours }) };
  }
  const ids = new Set(candidates.map(c => c.id));
  const others = [...blocks.filter(b => !ignore.has(b.id) && !ids.has(b.id) && (b.activity !== "sleep")), ...locked];
  if ( candidates.some(c => others.some(b => overlapping(c, b))) ) return { ok: false, reason: loc("CPRHQ.Downtime.overlap") };
  return { ok: true };
}

/** The block list with candidates placed (replacing `ignore`d blocks) and any Sleep under them trimmed. */
function applyPlacement(candidates, { blocks, ignore = new Set() }) {
  const ids = new Set(candidates.map(c => c.id));
  const out = [];
  for ( const b of blocks ) {
    if ( ignore.has(b.id) || ids.has(b.id) ) continue;
    if ( (b.activity !== "sleep") || !candidates.some(c => overlapping(c, b)) ) {
      out.push(b);
      continue;
    }
    // Keep the Sleep hours nothing covers, as one block per stretch.
    let run = null;
    let first = true;
    for ( let h = b.start; h <= b.start + b.length; h++ ) {
      const free = (h < b.start + b.length) && !candidates.some(c => (h >= c.start) && (h < c.start + c.length));
      if ( free ) run = run ? { ...run, length: run.length + 1 } : { ...b, id: first ? b.id : foundry.utils.randomID(), start: h, length: 1, group: undefined };
      else if ( run ) {
        out.push(run);
        run = null;
        first = false;
      }
    }
  }
  return [...out, ...candidates];
}

/* -------------------------------------------- */
/*  Holding re-renders while dragging           */
/* -------------------------------------------- */

/*
 * A save re-renders the window (and the HQ sheet) a moment later; if that lands while the next bar is being dragged,
 * the bar under the pointer is replaced and the drag is lost. Windows showing a timeline ask `holdRender` first: while
 * a drag is in progress their re-renders wait and run once (parts merged) when it ends.
 */
let holding = 0;
const held = new Map();

/** Called by a host's render(): true if this render was held for later. */
export function holdRender(app, options = {}) {
  if ( !holding || (options === true) || options?.force ) return false;
  const prev = held.get(app);
  const full = !options?.parts || (prev && !prev.parts);
  held.set(app, { parts: full ? null : new Set([...(prev?.parts ?? []), ...options.parts]) });
  return true;
}

function hold() {
  holding++;
}

function release() {
  holding = Math.max(0, holding - 1);
  if ( holding ) return;
  const pending = [...held];
  held.clear();
  for ( const [app, { parts }] of pending ) if ( app.rendered ) app.render(parts ? { parts: [...parts] } : {});
}

/* -------------------------------------------- */
/*  Interaction                                 */
/* -------------------------------------------- */

/**
 * Wire a rendered timeline.
 * @param {HTMLElement} root   Element containing one `.dt-timeline`
 * @param {object} handlers
 * @param {(blocks: object[]) => Promise} handlers.save       Persist the editable blocks
 * @param {(block: object) => Promise<object|null|false>} handlers.edit  Edit one block: returns changes, false = delete
 */
export function activateTimeline(root, { save, edit }) {
  const timeline = root.querySelector(".dt-timeline");
  if ( !timeline || (timeline.dataset.editable !== "true") ) return;
  let blocks = JSON.parse(timeline.dataset.blocks || "[]");
  const locked = JSON.parse(timeline.dataset.locked || "[]");
  const tracks = [...timeline.querySelectorAll(".dt-track")];
  const days = tracks.length;
  const total = days * HOURS;
  const rules = extra => ({ blocks, locked, total, ...extra });
  const commit = async next => {
    blocks = next;
    await save(next);
  };

  /** Absolute hour under the pointer (by position: a captured pointer keeps targeting the bar). Clamped to the rows. */
  const hourAt = event => {
    if ( !tracks.length ) return null;
    const rects = tracks.map(t => t.getBoundingClientRect());
    let index = rects.findIndex(r => (event.clientY >= r.top - 2) && (event.clientY < r.bottom + 2));
    if ( index < 0 ) {
      if ( event.clientY < rects[0].top ) index = 0;
      else if ( event.clientY >= rects.at(-1).bottom ) index = rects.length - 1;
      else return null;
    }
    const rect = rects[index];
    const hour = Math.min(HOURS - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * HOURS)));
    return (index * HOURS) + hour;
  };

  /** Draw candidate blocks as ghost bars (green when they fit, red when they don't). */
  const clearGhost = () => {
    timeline.querySelectorAll(".dt-ghost").forEach(g => g.remove());
    timeline.querySelectorAll(".dt-seg.is-dragging").forEach(s => s.classList.remove("is-dragging"));
  };
  const showGhost = (candidates, { ok, reason }, hide = new Set()) => {
    clearGhost();
    timeline.querySelectorAll(".dt-seg").forEach(s => hide.has(s.dataset.id) && s.classList.add("is-dragging"));
    let labelled = false;
    for ( const c of candidates ) {
      const spec = blockSpec(c);
      for ( let d = Math.floor(c.start / HOURS); (d * HOURS) < (c.start + c.length); d++ ) {
        if ( (d < 0) || (d >= days) ) continue;
        const from = Math.max(c.start, d * HOURS) - (d * HOURS);
        const to = Math.min(c.start + c.length, (d + 1) * HOURS) - (d * HOURS);
        const ghost = document.createElement("div");
        ghost.className = `dt-ghost ${ok ? "" : "invalid"}`;
        ghost.style.cssText = `left: ${(from / HOURS) * 100}%; width: ${((to - from) / HOURS) * 100}%; --act: ${spec.color}`;
        if ( !labelled ) {
          ghost.innerHTML = `<span>${esc(spec.variant?.name ?? spec.name)} · ${c.length}h · ${clock(c.start)}–${clock(c.start + c.length)}${ok ? "" : ` · ${esc(reason)}`}</span>`;
          labelled = true;
        }
        tracks[d].append(ghost);
      }
    }
  };

  // Palette -> drop on a day, previewing the block's size while dragging.
  let dragging = null;
  for ( const chip of root.querySelectorAll(".dt-palette [data-activity][draggable=true]") ) {
    chip.addEventListener("dragstart", event => {
      if ( !dragging ) hold();
      dragging = activity(chip.dataset.activity);
      event.dataTransfer.setData("text/plain", `cpr-hq-activity:${chip.dataset.activity}`);
      event.dataTransfer.effectAllowed = "copy";
    });
    // dragend fires after drop (or a cancelled drag): the drop has saved by then.
    chip.addEventListener("dragend", () => {
      if ( dragging ) release();
      dragging = null;
      clearGhost();
    });
  }
  const paletteCandidates = event => {
    const at = hourAt(event);
    return (dragging && (at !== null)) ? blocksFor(dragging, at) : null;
  };
  // GM: drop a chip on another chip to reorder the palette (saved for everyone).
  const palette = root.querySelector(".dt-palette[data-reorderable=true]");
  if ( palette ) {
    const chipAt = event => event.target.closest?.("[data-activity]");
    const before = (event, chip) => {
      const r = chip.getBoundingClientRect();
      return event.clientX < r.left + (r.width / 2);
    };
    palette.addEventListener("dragover", event => {
      const chip = chipAt(event);
      if ( !dragging || !chip || (chip.dataset.activity === dragging.id) ) return;
      event.preventDefault();
      palette.querySelectorAll(".drop-before, .drop-after").forEach(c => c.classList.remove("drop-before", "drop-after"));
      chip.classList.add(before(event, chip) ? "drop-before" : "drop-after");
    });
    palette.addEventListener("dragleave", event => {
      if ( !palette.contains(event.relatedTarget) ) palette.querySelectorAll(".drop-before, .drop-after").forEach(c => c.classList.remove("drop-before", "drop-after"));
    });
    palette.addEventListener("drop", async event => {
      const chip = chipAt(event);
      if ( !dragging || !chip ) return;
      event.preventDefault();
      const moving = dragging.id;
      const ids = [...palette.querySelectorAll("[data-activity]")].map(c => c.dataset.activity).filter(id => id !== moving);
      const at = ids.indexOf(chip.dataset.activity);
      if ( at < 0 ) return;
      ids.splice(before(event, chip) ? at : at + 1, 0, moving);
      await reorderActivities(ids);
    });
  }

  timeline.addEventListener("dragover", event => {
    if ( !dragging ) return;
    event.preventDefault();
    game.tooltip.deactivate();
    const candidates = paletteCandidates(event);
    if ( candidates ) showGhost(candidates, checkPlacement(candidates, rules()));
  });
  timeline.addEventListener("dragleave", event => {
    if ( !timeline.contains(event.relatedTarget) ) clearGhost();
  });
  timeline.addEventListener("drop", async event => {
    const data = event.dataTransfer.getData("text/plain");
    if ( !data.startsWith("cpr-hq-activity:") ) return;
    event.preventDefault();
    const def = dragging ?? activity(data.split(":")[1]);
    const at = hourAt(event);
    if ( dragging ) release();
    dragging = null;
    clearGhost();
    if ( !def || (at === null) ) return;
    // Activities with types (Medical Treatment, Cyberware): pick one first; it sets the length.
    let variant = null;
    if ( def.variants?.length ) {
      variant = await variantDialog(def);
      if ( !variant ) return;
    }
    const placed = blocksFor(def, at, { variant });
    const check = checkPlacement(placed, rules());
    if ( !check.ok ) return ui.notifications.warn(check.reason);
    await commit(applyPlacement(placed, rules()));
    // Activities that need a detail (product, skill, …): ask right away.
    if ( def.prompt ) clickEdit(placed[0]);
  });

  // Move / resize / click a bar.
  for ( const seg of timeline.querySelectorAll(".dt-seg:not(.locked)") ) {
    seg.addEventListener("pointerdown", event => {
      if ( event.button !== 0 ) return;
      const block = blocks.find(b => b.id === seg.dataset.id);
      if ( !block ) return;
      event.preventDefault();
      const handle = event.target.closest(".dt-handle")?.dataset.handle ?? null;
      const group = (block.group && !handle) ? blocks.filter(b => b.group === block.group) : [block];
      const ignore = new Set(group.map(b => b.id));
      const grabbed = hourAt(event);
      let delta = 0;
      let moved = false;
      let candidates = group;
      let done = false;
      hold();
      seg.setPointerCapture(event.pointerId);

      const candidatesFor = d => {
        if ( handle === "end" ) return [{ ...block, length: Math.max(1, block.length + d) }];
        if ( handle === "start" ) {
          const start = Math.min(block.start + block.length - 1, block.start + d);
          return [{ ...block, start, length: block.start + block.length - start }];
        }
        return group.map(b => ({ ...b, start: b.start + d }));
      };
      const onMove = ev => {
        const now = hourAt(ev);
        if ( (now === null) || (grabbed === null) ) return;
        if ( (now - grabbed) === delta ) return;
        delta = now - grabbed;
        if ( !moved ) game.tooltip.deactivate();
        moved = true;
        candidates = candidatesFor(delta);
        showGhost(candidates, checkPlacement(candidates, rules({ ignore, minCheck: !!handle })), ignore);
      };
      const onUp = async () => {
        if ( done ) return;
        done = true;
        for ( const type of ["pointerup", "pointercancel", "lostpointercapture"] ) seg.removeEventListener(type, onUp);
        seg.removeEventListener("pointermove", onMove);
        clearGhost();
        try {
          if ( moved && delta ) {
            const check = checkPlacement(candidates, rules({ ignore, minCheck: !!handle }));
            if ( check.ok ) await commit(applyPlacement(candidates, rules({ ignore })));
            else ui.notifications.warn(check.reason);
          }
        } finally {
          release();
        }
        if ( !moved ) clickEdit(block);
      };
      seg.addEventListener("pointermove", onMove);
      for ( const type of ["pointerup", "pointercancel", "lostpointercapture"] ) seg.addEventListener(type, onUp);
    });
  }

  const clickEdit = async block => {
    const result = await edit(block);
    if ( result === null || result === undefined ) return;
    const group = block.group ? blocks.filter(b => b.group === block.group) : [block];
    // Repeat: copy this bar to the same hours on every other day where it fits (Sleep gives way).
    if ( result.repeat ) {
      const hourOfDay = ((block.start % HOURS) + HOURS) % HOURS;
      let next = blocks;
      let n = 0;
      for ( let d = 0; d < days; d++ ) {
        const copy = { ...block, id: foundry.utils.randomID(), start: (d * HOURS) + hourOfDay, group: undefined };
        if ( copy.start === block.start ) continue;
        if ( !checkPlacement([copy], { blocks: next, locked, total }).ok ) continue;
        next = applyPlacement([copy], { blocks: next });
        n++;
      }
      if ( !n ) return ui.notifications.warn("CPRHQ.Downtime.noRepeat", { localize: true });
      ui.notifications.info(game.i18n.format("CPRHQ.Downtime.repeated", { n }));
      return commit(next);
    }
    if ( result === false ) {
      const drop = new Set(group.map(b => b.id));
      return commit(blocks.filter(b => !drop.has(b.id)));
    }
    // Notes, detail and type belong to the whole multi-day activity; the length to this bar.
    const shared = { notes: result.notes, detail: result.detail, variant: result.variant, item: result.item };
    for ( const key of Object.keys(shared) ) if ( shared[key] === undefined ) delete shared[key];
    const changed = group.map(b => (b.id === block.id) ? { ...b, ...shared, length: result.length } : { ...b, ...shared });
    const ignore = new Set(group.map(b => b.id));
    const check = checkPlacement(changed, rules({ ignore, minCheck: true }));
    if ( !check.ok ) return ui.notifications.warn(check.reason);
    await commit(applyPlacement(changed, rules({ ignore })));
  };
}

/* -------------------------------------------- */
/*  Dialogs                                     */
/* -------------------------------------------- */

/** The rules text shown in a block's dialog: cost, sleep, description. */
function specInfo(spec) {
  return `
    ${spec.cost ? `<p class="dt-cost"><i class="fa-solid fa-coins"></i> ${esc(spec.cost)} <span class="hint">${loc("CPRHQ.Downtime.costHint")}</span></p>` : ""}
    ${spec.countsAsSleep ? `<p class="hint"><i class="fa-solid fa-bed"></i> ${loc("CPRHQ.Downtime.countsAsSleep")}</p>` : ""}
    ${spec.description ? `<p class="dt-desc">${esc(spec.description)}</p>` : ""}`;
}

/**
 * Block editor: type (for activities with variants), the detail it asks for, length, comments; delete or repeat.
 * Resolves to changes ({length, notes, detail?, variant?} or {repeat: true}), false (delete) or null.
 */
export async function blockDialog(block, { actor = null } = {}) {
  const spec = blockSpec(block);
  const def = activity(block.activity);
  let choice = null;
  const variants = def?.variants ?? [];
  // Skill prompts: the activity's own list (Training), else the character's skills.
  const skills = (spec.prompt?.type !== "skill") ? []
    : (spec.prompt.options?.length ? [...spec.prompt.options] : (actor?.itemTypes?.skill ?? []).map(s => s.name))
      .sort((a, b) => a.localeCompare(b));
  // Training: a Solo with the upgraded Training Area picks two skills; both go in the detail ("Handgun, Evasion").
  const training = block.activity === "training";
  const slots = training ? practiceSlots(actor) : 1;
  const picks = training ? practiceSkills(block.detail) : [block.detail];
  const skillSelect = (name, value) => `<select name="${name}"><option value="">${loc("CPRHQ.Downtime.chooseOption")}</option>${skills.map(s => `<option ${s === value ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
  // Gear Maintenance: pick the item from what needs it (or "something else", explained in the comments).
  const maintenance = isMaintenance(spec) ? maintenanceField(block, actor) : null;
  // A "comment" prompt makes the Comments box itself required; other prompts get their own field.
  const requiredComment = !maintenance && (spec.prompt?.type === "comment");
  const detailField = maintenance ? maintenance.html : (!spec.prompt || requiredComment) ? "" : `
    <div class="form-group stacked">
      <label>${esc(spec.prompt.label)} <span class="dt-required">*</span></label>
      <div class="form-fields">${(spec.prompt.type === "skill") && skills.length
        ? skillSelect("detail", picks[0]) + ((slots > 1) ? skillSelect("detail2", picks[1]) : "")
        : `<input type="text" name="detail" value="${esc(block.detail)}">`}</div>
      ${(slots > 1) ? `<p class="hint">${loc("CPRHQ.Training.twoSkills")}</p>` : ""}
    </div>`;
  const data = await foundry.applications.api.DialogV2.wait({
    classes: ["cpr-hq-dialog", "cpr-hq-block-dialog"],
    window: { title: def?.name ?? spec.name, icon: spec.icon },
    position: { width: 540 },
    content: `
      ${variants.length ? `
      <div class="form-group">
        <label>${loc("CPRHQ.Downtime.variant")}</label>
        <div class="form-fields"><select name="variant">${variants.map(v =>
          `<option value="${esc(v.id)}" ${v.id === block.variant ? "selected" : ""}>${esc(v.name)}${v.cost ? ` · ${esc(v.cost)}` : ""} · ${v.hours}h</option>`).join("")}</select></div>
      </div>` : ""}
      <div class="dt-spec">${specInfo(spec)}</div>
      ${detailField}
      <div class="form-group">
        <label>${loc("CPRHQ.Downtime.length")}</label>
        <div class="form-fields"><input type="number" name="hours" min="1" step="1" value="${block.length}" ${spec.flexible ? "" : "disabled"}> h</div>
        ${spec.flexible ? "" : `<p class="hint">${loc("CPRHQ.Downtime.fixedLength")}</p>`}
      </div>
      <div class="form-group stacked">
        <label>${loc("CPRHQ.Downtime.notes")}${requiredComment ? ` <span class="dt-required">*</span>` : ""}</label>
        <textarea name="notes" rows="4" placeholder="${requiredComment ? esc(spec.prompt.label) : maintenance ? loc("CPRHQ.Upkeep.notesHint") : loc("CPRHQ.Downtime.notesHint")}">${esc(block.notes)}</textarea>
      </div>
      ${block.group ? `<p class="hint">${loc("CPRHQ.Downtime.groupHint")}</p>` : ""}`,
    rejectClose: false,
    modal: true,
    render: (event, element) => {
      // Picking another type shows its rules and resets the length to it.
      element.querySelector("select[name=variant]")?.addEventListener("change", ev => {
        const next = blockSpec({ ...block, variant: ev.target.value });
        element.querySelector(".dt-spec").innerHTML = specInfo(next);
        element.querySelector("input[name=hours]").value = next.hours;
      });
      // Picking an item shows what its check needs and stretches the block to the time it takes.
      element.querySelector("select[name=upkeepItem]")?.addEventListener("change", ev => {
        const info = maintenance.info[ev.target.value];
        element.querySelector(".dt-upkeep-info").innerHTML = info?.html ?? "";
        const hours = element.querySelector("input[name=hours]");
        if ( info && (Number(hours.value) < info.hours) ) hours.value = info.hours;
      });
    },
    buttons: [
      { action: "delete", label: loc("CPRHQ.Downtime.remove"), icon: "fa-solid fa-trash", callback: () => { choice = "delete"; return "delete"; } },
      ...(block.group ? [] : [{ action: "repeat", label: loc("CPRHQ.Downtime.repeat"), icon: "fa-solid fa-repeat",
        callback: () => { choice = "repeat"; return "repeat"; } }]),
      { action: "ok", label: loc("CPRHQ.Save"), icon: "fa-solid fa-floppy-disk", default: true,
        callback: (event, button) => new FormDataExtended(button.form).object }
    ]
  });
  if ( choice === "delete" ) return false;
  if ( choice === "repeat" ) return { repeat: true };
  if ( !data || typeof data !== "object" ) return null;
  // "hours", not "length": a form control named "length" clashes with form.elements.length.
  // Fixed-length activities keep their length; a new type brings its own.
  const next = blockSpec({ ...block, variant: data.variant ?? block.variant });
  const length = next.flexible ? Math.max(1, Math.floor(Number(data.hours) || block.length))
    : ((data.variant && (data.variant !== block.variant)) ? next.hours : block.length);
  const changes = { length, notes: String(data.notes ?? "") };
  if ( "detail" in data ) changes.detail = String(data.detail ?? "").trim();
  if ( "detail2" in data ) changes.detail = [...new Set([changes.detail, String(data.detail2 ?? "").trim()].filter(Boolean))].join(", ");
  if ( "variant" in data ) changes.variant = data.variant;
  if ( maintenance ) {
    // "upkeepItem", not "item": a form control named "item" clashes with form.elements.item().
    changes.item = String(data.upkeepItem ?? "");
    changes.detail = maintenance.info[changes.item]?.name ?? "";
  }
  return changes;
}

/**
 * The Gear Maintenance item picker: the character's items that need maintenance (plus the block's current item),
 * and "something else". {html, info: {[id]: {name, hours, html}}}
 */
function maintenanceField(block, actor) {
  const list = actor ? needingUpkeep(actor) : [];
  const current = block.item && (block.item !== "other") ? actor?.items.get(block.item) : null;
  if ( current && !list.some(s => s.id === current.id) ) {
    const status = upkeepStatus(current);
    if ( status ) list.push(status);
  }
  const info = { other: { name: loc("CPRHQ.Upkeep.other"), hours: 1, html: `<p class="hint">${loc("CPRHQ.Upkeep.otherHint")}</p>` } };
  for ( const s of list ) {
    const flags = [s.damaged ? loc("CPRHQ.Upkeep.damaged") : "", s.neglected ? loc("CPRHQ.Upkeep.state.neglected") : ""].filter(Boolean).join(", ");
    info[s.id] = {
      name: s.name, hours: s.hours,
      html: `<p class="hint"><i class="fa-solid fa-toolbox"></i> ${game.i18n.format("CPRHQ.Upkeep.checkLine",
        { dv: s.dv, skill: esc(s.skill), time: esc(s.time), need: esc(s.needsLifestyle) })}${flags ? ` · <strong>${esc(flags)}</strong>` : ""}</p>`
    };
  }
  const options = list.map(s => `<option value="${esc(s.id)}" ${s.id === block.item ? "selected" : ""}>${esc(s.name)}`
    + `${s.damaged ? ` (${esc(loc("CPRHQ.Upkeep.damaged"))})` : ""} · DV${s.dv}</option>`).join("");
  const html = `
    <div class="form-group stacked">
      <label>${loc("CPRHQ.Upkeep.pick")} <span class="dt-required">*</span></label>
      <div class="form-fields"><select name="upkeepItem"><option value="">${loc("CPRHQ.Downtime.chooseOption")}</option>${options}
        <option value="other" ${block.item === "other" ? "selected" : ""}>${loc("CPRHQ.Upkeep.other")}</option></select></div>
      ${list.length ? "" : `<p class="hint">${loc("CPRHQ.Upkeep.nothingDue")}</p>`}
      <div class="dt-upkeep-info">${info[block.item]?.html ?? ""}</div>
    </div>`;
  return { html, info };
}

/** Pick an activity's type: one button per variant with its length, cost and rules. Resolves to its id or null. */
export async function variantDialog(def) {
  let picked = null;
  await foundry.applications.api.DialogV2.wait({
    classes: ["cpr-hq-dialog", "cpr-hq-block-dialog"],
    window: { title: def.name, icon: def.icon },
    position: { width: 480 },
    content: `
      ${def.description ? `<p class="dt-desc">${esc(def.description)}</p>` : ""}
      <div class="dt-variants">${def.variants.map(v => `
        <button type="button" class="dt-variant" data-variant="${esc(v.id)}" style="--act: ${esc(def.color)}">
          <strong>${esc(v.name)}</strong>
          <span>${v.hours}h${v.cost ? ` · ${esc(v.cost)}` : ""}${v.countsAsSleep ? ` · <i class="fa-solid fa-bed"></i>` : ""}</span>
          ${v.description ? `<small>${esc(v.description)}</small>` : ""}
        </button>`).join("")}</div>`,
    rejectClose: false,
    modal: true,
    render: (event, element) => {
      element.querySelector(".dt-variants").addEventListener("click", ev => {
        const button = ev.target.closest("[data-variant]");
        if ( !button ) return;
        picked = button.dataset.variant;
        event.target.close();
      });
    },
    buttons: [{ action: "cancel", label: loc("Cancel"), icon: "fa-solid fa-xmark" }]
  });
  return picked;
}

/** Read-only view of a past block: what, when, how long, the detail and the notes. */
export async function blockInfoDialog(block, dayText) {
  const spec = blockSpec(block);
  return foundry.applications.api.DialogV2.prompt({
    classes: ["cpr-hq-dialog", "cpr-hq-block-dialog"],
    window: { title: spec.fullName, icon: spec.icon },
    position: { width: 460 },
    content: `
      <p><strong>${esc(dayText)}</strong> · ${clock(block.start)}–${clock(block.start + block.length)} · ${block.length}h</p>
      ${block.detail ? `<p><strong>${esc(spec.prompt?.label ?? loc("CPRHQ.Downtime.detail"))}:</strong> ${esc(block.detail)}</p>` : ""}
      ${spec.cost ? `<p class="dt-cost"><i class="fa-solid fa-coins"></i> ${esc(spec.cost)}</p>` : ""}
      ${block.notes ? `<p class="dt-desc">${esc(block.notes)}</p>` : `<p class="hint">${loc("CPRHQ.Downtime.noNotes")}</p>`}`,
    rejectClose: false,
    ok: { label: loc("CPRHQ.Close") }
  });
}
