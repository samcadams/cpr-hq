import { storeImage } from "../socket.mjs";
import {
  PROJECT_TYPES, CATEGORIES, TECH_SKILLS, UPGRADES, INVENT_MIN, TIME_PRESETS, DV_PRESETS, cleanProject, defaultsFor, missingFields,
  itemRef, categoryForItem, skillForItem, workshopData, adjustBank, workDay, presetHours, presetLabel, timeLabel, checkBonus
} from "./model.mjs";
import { processSteps, successChance } from "./ui.mjs";

/**
 * Workshop dialogs: a player proposes (or revises) a project; the GM reviews it. One form serves both: fields show
 * for the project types they belong to, split into what's required and what helps the GM; the GM also sets the job
 * (DV and time from the Maker table presets, materials, notes). Both show where the project is in the process.
 */

const { DialogV2 } = foundry.applications.api;
const loc = key => game.i18n.localize(key);
const esc = value => Handlebars.escapeExpression(value ?? "");
const CATEGORY_KEYS = Object.keys(CATEGORIES);
/** Item types a Tech can upgrade or repair. */
const GEAR_TYPES = ["weapon", "armor", "cyberware", "gear", "clothing", "vehicle", "itemUpgrade", "program", "cyberdeck", "drug", "ammo"];

function options(list, selected, blank) {
  const rows = list.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`);
  if ( blank !== undefined ) rows.unshift(`<option value="">${esc(blank)}</option>`);
  return rows.join("");
}

/** "Premium · 100eb · DV 17 · 1 day (16h)" */
const categoryOptions = min => CATEGORY_KEYS.slice(min ? CATEGORY_KEYS.indexOf(min) : 0).map(k => [k,
  `${loc(`CPRHQ.Workshop.cat.${k}`)} · ${CATEGORIES[k].price.toLocaleString(game.i18n.lang)}eb${k === "superLuxury" ? "+" : ""} · DV ${CATEGORIES[k].dv} · ${
    k === "superLuxury" ? loc("CPRHQ.Workshop.time.perTenK") : presetLabel(CATEGORIES[k].time)}`]);

/** DV presets: "DV 17 · Premium". */
const dvOptions = () => DV_PRESETS.map(({ dv, categories }) =>
  [String(dv), `DV ${dv} · ${categories.map(k => loc(`CPRHQ.Workshop.cat.${k}`)).join(" / ")}`]);

/** Time presets: "1 week (112h)". */
const timeOptions = () => Object.keys(TIME_PRESETS).map(k => [String(presetHours(k)), presetLabel(k)]);

/** A field's help line. */
const help = key => `<small class="ws-help">${loc(key)}</small>`;

/** The character's own gear, for Upgrade/Repair. */
function inventory(actor) {
  return actor.items.filter(i => GEAR_TYPES.includes(i.type)).sort((a, b) => a.name.localeCompare(b.name));
}

function typePicker(selected, locked) {
  return `<div class="ws-type-picker">${Object.entries(PROJECT_TYPES).map(([key, t]) => `
    <label class="ws-type ${key === selected ? "active" : ""}" style="--ws: ${t.color}" ${locked && key !== selected ? "hidden" : ""}>
      <input type="radio" name="type" value="${key}" ${key === selected ? "checked" : ""} ${locked ? "disabled" : ""}>
      <i class="${t.icon}"></i><strong>${loc(`CPRHQ.Workshop.type.${key}`)}</strong>
      <small>${loc(`CPRHQ.Workshop.typeHint.${key}`)}</small>
    </label>`).join("")}</div>`;
}

function itemField(actor, project) {
  const own = inventory(actor).map(i => [i.uuid, i.name]);
  const linked = project.item;
  if ( linked && !own.some(([uuid]) => uuid === linked.uuid) ) own.unshift([linked.uuid, linked.name]);
  return `
    <div class="ws-field ws-item-field" data-for="upgrade repair">
      <span class="ws-label">${loc("CPRHQ.Workshop.f.item")} <em class="req">*</em></span>
      <div class="ws-dropzone" data-ws-dialog-drop>
        ${linked ? `<img src="${esc(linked.img)}" alt="">` : `<i class="fa-solid fa-hand-holding-box"></i>`}
        <select name="itemUuid">${options(own, linked?.uuid ?? "", loc("CPRHQ.Workshop.f.pickItem"))}</select>
        <small>${loc("CPRHQ.Workshop.f.dropHint")}</small>
      </div>
    </div>`;
}

/** A reference image (Fabricate, Invent, Upgrade): pick, drop or paste a file; the GM's client stores it for players. */
function imageField(project) {
  const browse = game.user.can("FILES_BROWSE");
  return `
    <div class="ws-field ws-image-field" data-for="fabricate invent upgrade">
      <span class="ws-label">${loc("CPRHQ.Workshop.f.image")}</span>
      <div class="ws-image-pick" data-ws-image tabindex="0">
        <input type="hidden" name="image" value="${esc(project.image)}">
        <input type="file" accept="image/*" hidden>
        <img src="${esc(project.image)}" alt="" ${project.image ? "" : "hidden"}>
        <span class="ws-image-empty" ${project.image ? "hidden" : ""}><i class="fa-solid fa-image"></i> ${loc("CPRHQ.Workshop.f.imageHint")}</span>
        <span class="ws-image-busy" hidden><i class="fa-solid fa-spinner fa-spin"></i></span>
      </div>
      <div class="ws-image-tools">
        <input type="text" data-ws-image-url placeholder="${loc("CPRHQ.Workshop.f.imageUrl")}" value="${/^https?:/.test(project.image ?? "") ? esc(project.image) : ""}">
        <button type="button" class="btn-sm" data-ws-image-act="file"><i class="fa-solid fa-upload"></i> ${loc("CPRHQ.Workshop.f.imageUpload")}</button>
        ${browse ? `<button type="button" class="btn-sm" data-ws-image-act="browse"><i class="fa-solid fa-folder-open"></i> ${loc("CPRHQ.Workshop.f.imageBrowse")}</button>` : ""}
        <button type="button" class="btn-sm" data-ws-image-act="clear" ${project.image ? "" : "hidden"}><i class="fa-solid fa-xmark"></i> ${loc("CPRHQ.Workshop.f.imageClear")}</button>
      </div>
    </div>`;
}

/** The steps of the Maker process, the current one lit. */
function processStrip(process) {
  return `<ol class="ws-process">${process.steps.map(st => `
    <li class="ws-step ${st.state}"><span>${esc(st.label)}</span><small>${esc(st.who)}</small></li>`).join("")}</ol>`;
}

/** The project form. `gm` adds the review fields. */
function projectForm(actor, project, { gm = false, locked = false } = {}) {
  const t = project.type;
  const d = { ...defaultsFor(project), ...project };
  const custom = loc("CPRHQ.Workshop.f.custom");
  // Where the project stands: at the top for the GM's review, as "what happens next" under a player's proposal.
  const process = `
      <div class="ws-wide ws-process-box">
        <span class="ws-label">${loc(gm ? "CPRHQ.Workshop.sec.processNow" : "CPRHQ.Workshop.sec.process")}</span>
        <ol class="ws-process"></ol>
        <p class="ws-next"></p>
      </div>`;
  return `
    ${gm ? process : ""}
    ${typePicker(t, locked)}
    ${Object.keys(PROJECT_TYPES).map(k => `<p class="ws-type-rule" data-for="${k}" style="--ws: ${PROJECT_TYPES[k].color}"><i class="fa-solid fa-book"></i> ${loc(`CPRHQ.Workshop.typeRule.${k}`)}</p>`).join("")}
    <div class="ws-form">
      <h4 class="ws-sec"><span class="ws-sec-n">1</span> ${loc("CPRHQ.Workshop.sec.required")} <small>${loc(gm ? "CPRHQ.Workshop.sec.requiredHintGM" : "CPRHQ.Workshop.sec.requiredHint")}</small></h4>
      <label class="ws-field" data-for="fabricate invent">
        <span class="ws-label">${loc("CPRHQ.Workshop.f.name")} <em class="req">*</em></span>
        <input type="text" name="name" value="${esc(project.name)}" data-ph-fabricate="${loc("CPRHQ.Workshop.f.namePhFabricate")}"
          data-ph-invent="${loc("CPRHQ.Workshop.f.namePhInvent")}">
      </label>
      ${itemField(actor, project)}
      <label class="ws-field" data-for="upgrade">
        <span class="ws-label">${loc("CPRHQ.Workshop.f.upgrade")} <em class="req">*</em></span>
        <select name="upgrade">${options(UPGRADES.map(u => [u, loc(`CPRHQ.Workshop.up.${u}`)]), project.upgrade, "—")}</select>
        ${help("CPRHQ.Workshop.f.upgradeHelp")}
      </label>
      <label class="ws-field" data-for="fabricate upgrade repair ${gm ? "invent" : ""}">
        <span class="ws-label">${loc("CPRHQ.Workshop.f.category")} <em class="req" data-for="fabricate">*</em></span>
        <select name="category">${options(categoryOptions((t === "invent") ? INVENT_MIN : null), project.category, "—")}</select>
        <small class="ws-help" data-for="fabricate">${loc("CPRHQ.Workshop.f.categoryHelpFabricate")}</small>
        <small class="ws-help" data-for="upgrade repair">${loc("CPRHQ.Workshop.f.categoryHelpItem")}</small>
        <small class="ws-help" data-for="invent">${loc("CPRHQ.Workshop.f.categoryHelpInvent")}</small>
      </label>
      <label class="ws-field">
        <span class="ws-label">${loc("CPRHQ.Workshop.f.skill")} <em class="req">*</em></span>
        <select name="skill">${options(TECH_SKILLS.map(s => [s, s]), project.skill, "—")}</select>
        ${help("CPRHQ.Workshop.f.skillHelp")}
      </label>
      <label class="ws-field ws-wide ws-details">
        <span class="ws-label"><span data-label-for="fabricate upgrade">${loc("CPRHQ.Workshop.f.notes")}</span><span data-label-for="invent">${loc("CPRHQ.Workshop.f.function")}</span><span data-label-for="repair">${loc("CPRHQ.Workshop.f.damage")}</span>
          <em class="req" data-for="invent repair">*</em></span>
        <textarea name="details" rows="3" data-ph-invent="${loc("CPRHQ.Workshop.f.functionPh")}" data-ph-repair="${loc("CPRHQ.Workshop.f.damagePh")}"
          data-ph-upgrade="${loc("CPRHQ.Workshop.f.upgradePh")}" data-ph-fabricate="${loc("CPRHQ.Workshop.f.notesPh")}">${esc(project.details)}</textarea>
      </label>
      <h4 class="ws-sec ws-sec-opt" data-for="fabricate invent upgrade"><span class="ws-sec-n">2</span> ${loc("CPRHQ.Workshop.sec.optional")} <small>${loc("CPRHQ.Workshop.sec.optionalHint")}</small></h4>
      ${imageField(project)}
      <p class="ws-missing ws-wide" hidden><i class="fa-solid fa-circle-exclamation"></i> <span></span></p>
      ${gm ? `
      <fieldset class="ws-gm">
        <legend><i class="fa-solid fa-user-shield"></i> ${loc("CPRHQ.Workshop.f.gmReview")}</legend>
        <p class="ws-rulebook ws-wide"><i class="fa-solid fa-book"></i> <span></span>
          <button type="button" class="btn-sm" data-ws-defaults data-tooltip="CPRHQ.Workshop.f.defaultsTip">${loc("CPRHQ.Workshop.f.defaults")}</button></p>
        <h5 class="ws-wide">${loc("CPRHQ.Workshop.sec.check")}</h5>
        <label class="ws-field"><span class="ws-label">DV</span>
          <span class="ws-preset"><select data-ws-preset="dv">${options(dvOptions(), String(d.dv), custom)}</select>
          <input type="number" name="dv" min="1" value="${d.dv}"></span></label>
        <label class="ws-field"><span class="ws-label">${loc("CPRHQ.Workshop.f.hours")}</span>
          <span class="ws-preset"><select data-ws-preset="hours">${options(timeOptions(), String(d.hours), custom)}</select>
          <input type="number" name="hours" min="1" value="${d.hours}"></span>
          <small class="ws-help">${game.i18n.format("CPRHQ.Workshop.f.hoursHelp", { day: workDay() })}</small></label>
        <label class="ws-field"><span class="ws-label">${loc("CPRHQ.Workshop.f.progress")}</span><input type="number" name="progress" min="0" value="${project.progress ?? 0}"></label>
        <label class="ws-field ws-check" data-tooltip="CPRHQ.Workshop.f.hideDVTip"><input type="checkbox" name="hideDV" ${project.hideDV ? "checked" : ""}> ${loc("CPRHQ.Workshop.f.hideDV")}</label>
        <h5 class="ws-wide">${loc("CPRHQ.Workshop.sec.materials")}</h5>
        <label class="ws-field ws-span2"><span class="ws-label">${loc("CPRHQ.Workshop.f.materials")}</span><input type="text" name="materials" value="${esc(d.materials)}">
          ${help("CPRHQ.Workshop.f.materialsHelp")}</label>
        <label class="ws-field ws-check"><input type="checkbox" name="materialsReady" ${project.materialsReady ? "checked" : ""}> ${loc("CPRHQ.Workshop.f.materialsReady")}</label>
        <h5 class="ws-wide">${loc("CPRHQ.Workshop.sec.player")}</h5>
        <label class="ws-field ws-wide" data-for="invent fabricate upgrade"><span class="ws-label">${loc("CPRHQ.Workshop.f.rules")}</span>
          <textarea name="rules" rows="2" placeholder="${loc("CPRHQ.Workshop.f.rulesPh")}">${esc(project.rules)}</textarea></label>
        <label class="ws-field ws-wide"><span class="ws-label">${loc("CPRHQ.Workshop.f.gmNote")}</span>
          <textarea name="gmNote" rows="2" placeholder="${loc("CPRHQ.Workshop.f.gmNotePh")}">${esc(project.gmNote)}</textarea></label>
      </fieldset>` : `
      <div class="ws-estimate ws-wide"></div>`}
      ${gm ? "" : process}
    </div>`;
}

/** The player's "What to expect": the rulebook DV, time and materials for the category, and their chance. */
function estimateHTML(actor, p, type) {
  const info = text => `<i class="fa-solid fa-circle-info"></i> ${text}`;
  if ( type === "invent" ) return info(loc("CPRHQ.Workshop.inventEstimate"));
  if ( !p.category ) return info(loc(type === "fabricate" ? "CPRHQ.Workshop.estimateNoCategory" : "CPRHQ.Workshop.estimateNoItem"));
  const d = defaultsFor(p);
  const bonus = p.skill ? checkBonus(actor, p).total : null;
  const rows = [
    ["DV", d.dv],
    [loc("CPRHQ.Workshop.f.time"), timeLabel(p.category, p.price)],
    [loc("CPRHQ.Workshop.f.materials"), d.materials || "—"],
    ...(bonus === null ? [] : [[loc("CPRHQ.Workshop.check"), `+${bonus} · ${game.i18n.format("CPRHQ.Workshop.chanceN", { n: successChance(bonus, d.dv) })}`]])
  ];
  return `<span class="ws-label">${loc("CPRHQ.Workshop.expect")}</span>
    <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <small>${loc("CPRHQ.Workshop.expectHint")}</small>`;
}

/** Read the form: a project input, plus the linked item from the select or a drop. */
function readForm(form, dropped) {
  const data = new FormDataExtended(form).object;
  const type = form.querySelector("input[name=type]:checked")?.value;
  let item;
  if ( (type === "upgrade") || (type === "repair") ) {
    const uuid = data.itemUuid;
    const doc = uuid ? (dropped?.uuid === uuid ? dropped : fromUuidSync(uuid)) : null;
    item = doc ? itemRef(doc) : null;
  }
  return { ...data, type, ...(item !== undefined ? { item } : {}) };
}

/** Show the fields for the chosen type; check required ones; update the rulebook estimate. */
function wireForm(element, actor, project, { gm }) {
  const form = element.querySelector("form") ?? element;
  let dropped = null;
  const details = form.querySelector(".ws-details");
  const optional = form.querySelector(".ws-sec-opt");
  const skill = form.elements.skill.closest(".ws-field");
  const sync = () => {
    const type = form.querySelector("input[name=type]:checked")?.value;
    for ( const label of form.querySelectorAll(".ws-type") ) label.classList.toggle("active", label.querySelector("input").checked);
    for ( const el of form.querySelectorAll("[data-for]") ) el.hidden = !el.dataset.for.split(" ").includes(type);
    for ( const el of form.querySelectorAll("[data-label-for]") ) el.hidden = !el.dataset.labelFor.split(" ").includes(type);
    for ( const el of form.querySelectorAll("[data-ph-fabricate]") ) el.placeholder = el.dataset[`ph${type.capitalize()}`] ?? "";
    // The text box is required for Invent and Repair, a helpful extra for Fabricate and Upgrade.
    if ( ["invent", "repair"].includes(type) ) skill.after(details);
    else optional.after(details);
    const p = cleanProject(readForm(form, dropped), project);
    const missing = missingFields(p);
    const submit = element.querySelector("footer button[data-action=ok], footer button[data-action=approve]");
    if ( submit ) submit.disabled = missing.length > 0;
    for ( const f of form.querySelectorAll(".ws-field") ) f.classList.remove("missing");
    const labels = [];
    for ( const name of missing ) {
      const field = form.querySelector(`[name="${name === "item" ? "itemUuid" : name}"]`)?.closest(".ws-field");
      field?.classList.add("missing");
      const label = field?.querySelector(".ws-label > span:not([hidden])") ?? field?.querySelector(".ws-label");
      if ( label ) labels.push(label.firstChild?.textContent?.trim() ?? label.textContent.trim());
    }
    const note = form.querySelector(".ws-missing");
    note.hidden = !missing.length;
    note.querySelector("span").textContent = game.i18n.format("CPRHQ.Workshop.stillNeeded", { fields: labels.join(", ") });
    const d = defaultsFor(p);
    const rulebook = form.querySelector(".ws-rulebook span");
    if ( rulebook ) {
      rulebook.textContent = p.category ? game.i18n.format("CPRHQ.Workshop.rulebook", { category: loc(`CPRHQ.Workshop.cat.${p.category}`),
        dv: d.dv, time: timeLabel(p.category, p.price), materials: d.materials || "—" }) : loc("CPRHQ.Workshop.rulebookNoCategory");
    }
    const estimate = form.querySelector(".ws-estimate");
    if ( estimate ) estimate.innerHTML = estimateHTML(actor, p, type);
    // A saved project shows where it stands; a draft shows the road ahead for the chosen type.
    const process = processSteps(project.id ? { ...project, type } : { ...p, id: null, materials: d.materials });
    form.querySelector(".ws-process").outerHTML = processStrip(process);
    form.querySelector(".ws-next").textContent = process.next;
    return p;
  };
  // DV and time presets fill the number; a number that matches no preset shows "Custom".
  const presets = [...form.querySelectorAll("[data-ws-preset]")];
  const syncPresets = () => {
    for ( const select of presets ) {
      const value = form.elements[select.dataset.wsPreset].value;
      select.value = [...select.options].some(o => o.value === value) ? value : "";
    }
  };
  for ( const select of presets ) {
    select.addEventListener("change", event => {
      event.stopPropagation();
      if ( select.value ) form.elements[select.dataset.wsPreset].value = select.value;
      syncPresets();
    });
  }
  form.addEventListener("input", event => {
    if ( ["dv", "hours"].includes(event.target.name) ) syncPresets();
  });
  form.addEventListener("change", event => {
    // Picking an item fills the category and suggests a skill.
    if ( event.target.name === "itemUuid" ) {
      const doc = dropped?.uuid === event.target.value ? dropped : fromUuidSync(event.target.value);
      if ( doc ) {
        form.elements.category.value = categoryForItem(form.querySelector("input[name=type]:checked")?.value, doc);
        if ( !form.elements.skill.value ) form.elements.skill.value = skillForItem(doc);
      }
    }
    sync();
  });
  form.addEventListener("input", sync);
  form.querySelector("[data-ws-defaults]")?.addEventListener("click", () => {
    const d = defaultsFor(sync());
    for ( const [name, value] of Object.entries({ dv: d.dv, hours: d.hours, materials: d.materials }) ) {
      const input = form.elements[name];
      input.value = value;
      // Flash the fields so the reset is visible even when nothing changed.
      input.classList.remove("ws-flash");
      void input.offsetWidth;
      input.classList.add("ws-flash");
    }
    syncPresets();
  });
  wireImage(form, sync);
  // Drop any item (a crewmate's gun, a compendium entry) onto the item field.
  const zone = form.querySelector("[data-ws-dialog-drop]");
  zone?.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("drag-over"); });
  zone?.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone?.addEventListener("drop", async event => {
    event.preventDefault();
    zone.classList.remove("drag-over");
    const data = TextEditor.getDragEventData(event);
    if ( data?.type !== "Item" ) return;
    const doc = await fromUuid(data.uuid);
    if ( !doc ) return;
    dropped = doc;
    const select = form.elements.itemUuid;
    if ( ![...select.options].some(o => o.value === doc.uuid) ) select.insertAdjacentHTML("beforeend", `<option value="${esc(doc.uuid)}">${esc(doc.name)}</option>`);
    select.value = doc.uuid;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  sync();
  return () => readForm(form, dropped);
}

/** The image picker: file chooser, drag-and-drop, paste, and (if allowed) Foundry's file browser. */
function wireImage(form, sync) {
  const box = form.querySelector("[data-ws-image]");
  if ( !box ) return;
  const field = box.closest(".ws-image-field");
  const hidden = box.querySelector("input[name=image]");
  const fileInput = box.querySelector("input[type=file]");
  const img = box.querySelector("img");
  const urlInput = field.querySelector("[data-ws-image-url]");
  const show = path => {
    if ( !/^https?:/.test(path ?? "") ) urlInput.value = "";
    hidden.value = path ?? "";
    img.src = path ?? "";
    img.hidden = !path;
    box.querySelector(".ws-image-empty").hidden = !!path;
    field.querySelector("[data-ws-image-act=clear]").hidden = !path;
    sync();
  };
  const upload = async file => {
    if ( !file?.type?.startsWith("image/") ) return;
    const busy = box.querySelector(".ws-image-busy");
    busy.hidden = false;
    try {
      const path = await storeImage(file);
      if ( path ) show(path);
    }
    catch(err) {
      console.error(err);
      ui.notifications.error("CPRHQ.Workshop.imageFailed", { localize: true });
    }
    finally { busy.hidden = true; }
  };
  fileInput.addEventListener("change", () => upload(fileInput.files[0]));
  // A direct link to an image on the web is used as-is (nothing is uploaded).
  urlInput.addEventListener("change", event => {
    event.stopPropagation();
    const url = urlInput.value.trim();
    if ( !url ) return show("");
    if ( !/^https?:\/\/\S+$/i.test(url) ) return ui.notifications.warn("CPRHQ.Workshop.imageBadUrl", { localize: true });
    const probe = new Image();
    probe.onload = () => show(url);
    probe.onerror = () => ui.notifications.warn("CPRHQ.Workshop.imageBadUrl", { localize: true });
    probe.src = url;
  });
  urlInput.addEventListener("keydown", event => {
    if ( event.key === "Enter" ) { event.preventDefault(); urlInput.dispatchEvent(new Event("change")); }
  });
  box.addEventListener("click", event => {
    if ( event.target !== fileInput ) fileInput.click();
  });
  field.addEventListener("click", event => {
    const act = event.target.closest("[data-ws-image-act]")?.dataset.wsImageAct;
    if ( act === "file" ) fileInput.click();
    else if ( act === "clear" ) show("");
    else if ( act === "browse" ) new FilePicker({ type: "image", current: hidden.value, callback: path => show(path) }).render(true);
  });
  box.addEventListener("dragover", event => { event.preventDefault(); box.classList.add("drag-over"); });
  box.addEventListener("dragleave", () => box.classList.remove("drag-over"));
  box.addEventListener("drop", event => {
    event.preventDefault();
    box.classList.remove("drag-over");
    const file = event.dataTransfer.files?.[0];
    if ( file ) return upload(file);
    // An image dragged from another tab or the Foundry file browser.
    const url = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if ( url && /^(https?:|worlds\/|modules\/|systems\/|icons\/)/.test(url) ) show(url.trim());
  });
  // Paste a screenshot anywhere in the dialog.
  form.addEventListener("paste", event => {
    if ( field.hidden ) return;
    const file = [...(event.clipboardData?.files ?? [])].find(f => f.type.startsWith("image/"));
    if ( file ) {
      event.preventDefault();
      upload(file);
    }
  });
}

/** Player (or GM on their behalf): propose a new project, or revise one. Resolves to the input, or null. */
export async function projectDialog(actor, project = null) {
  const base = project ?? { type: "fabricate", status: "pending" };
  let read;
  const result = await DialogV2.wait({
    classes: ["cpr-hq-dialog", "cpr-hq-ws-dialog"],
    window: { title: loc(project ? "CPRHQ.Workshop.reviseTitle" : "CPRHQ.Workshop.newTitle"), icon: "fa-solid fa-screwdriver-wrench" },
    position: { width: 620 },
    content: `${project?.gmNote && project.status === "returned" ? `<p class="ws-returned"><i class="fa-solid fa-rotate-left"></i> ${esc(project.gmNote)}</p>` : ""}
      ${projectForm(actor, base, { locked: !!project })}`,
    rejectClose: false,
    modal: true,
    render: (event, element) => { read = wireForm(element, actor, base, { gm: false }); },
    buttons: [
      { action: "cancel", label: loc("Cancel"), icon: "fa-solid fa-xmark" },
      { action: "ok", label: loc("CPRHQ.Workshop.submit"), icon: "fa-solid fa-paper-plane", default: true, callback: () => read() }
    ]
  });
  return (result && typeof result === "object") ? result : null;
}

/** GM: review a project. Resolves to {input, status} (status "approved", "returned" or null to keep), or null. */
export async function reviewDialog(actor, project) {
  let read;
  const decided = ["pending", "returned"].includes(project.status);
  const buttons = decided ? [
    { action: "return", label: loc("CPRHQ.Workshop.return"), icon: "fa-solid fa-rotate-left", callback: () => ({ input: read(), status: "returned" }) },
    { action: "save", label: loc("CPRHQ.Save"), icon: "fa-solid fa-floppy-disk", callback: () => ({ input: read(), status: null }) },
    { action: "approve", label: loc("CPRHQ.Workshop.approve"), icon: "fa-solid fa-check", default: true, callback: () => ({ input: read(), status: "approved" }) }
  ] : [
    { action: "cancel", label: loc("Cancel"), icon: "fa-solid fa-xmark" },
    { action: "save", label: loc("CPRHQ.Save"), icon: "fa-solid fa-floppy-disk", default: true, callback: () => ({ input: read(), status: null }) }
  ];
  const result = await DialogV2.wait({
    classes: ["cpr-hq-dialog", "cpr-hq-ws-dialog"],
    window: { title: game.i18n.format("CPRHQ.Workshop.reviewTitle", { actor: actor.name }), icon: "fa-solid fa-user-shield" },
    position: { width: 660 },
    content: projectForm(actor, project, { gm: true, locked: true }),
    rejectClose: false,
    modal: true,
    render: (event, element) => { read = wireForm(element, actor, project, { gm: true }); },
    buttons
  });
  return (result && typeof result === "object") ? result : null;
}

/** GM: grant or remove banked Tech hours. */
export async function bankDialog(actor) {
  const { bank } = workshopData(actor);
  const result = await DialogV2.prompt({
    classes: ["cpr-hq-dialog"],
    window: { title: game.i18n.format("CPRHQ.Workshop.bankTitle", { actor: actor.name }), icon: "fa-solid fa-clock" },
    content: `
      <p>${game.i18n.format("CPRHQ.Workshop.bankNow", { n: bank })}</p>
      <label class="ws-field"><span class="ws-label">${loc("CPRHQ.Workshop.bankChange")}</span><input type="number" name="hours" value="0" step="1" autofocus></label>
      <label class="ws-field"><span class="ws-label">${loc("CPRHQ.Workshop.bankReason")}</span><input type="text" name="reason"></label>`,
    rejectClose: false,
    modal: true,
    ok: { label: loc("CPRHQ.Save"), icon: "fa-solid fa-floppy-disk", callback: (event, button) => new FormDataExtended(button.form).object }
  });
  if ( result?.hours ) await adjustBank(actor, result.hours, result.reason);
}
