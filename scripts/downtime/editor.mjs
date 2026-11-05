import { activities, saveActivities, resetActivities, isFlexible } from "./model.mjs";
import { CATALOGUE } from "../data/improvements.mjs";

/**
 * GM: the activity editor. Every activity is a collapsible row: name, icon, colour, hours (per day) × days, the shortest
 * allowed block, sleep, cost (shown only), Role and HQ-upgrade requirements, a detail the player must give, the rules
 * text, and types (variants) such as the kinds of Medical Treatment. Rows read top to bottom in palette order.
 */

const loc = key => game.i18n.localize(key);
const esc = value => Handlebars.escapeExpression(value ?? "");
const ROLES = ["solo", "rockerboy", "netrunner", "tech", "medtech", "media", "exec", "lawman", "fixer", "nomad"];

function options(list, selected) {
  return list.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function variantRow(v = {}) {
  return `
    <fieldset class="variant" data-variant-id="${esc(v.id)}">
      <legend><button type="button" class="icon-btn" data-act="removeVariant" data-tooltip="CPRHQ.Downtime.ed.removeVariant"><i class="fa-solid fa-xmark"></i></button></legend>
      <div class="act-grid">
        <label class="wide">${loc("CPRHQ.Downtime.ed.name")}<input type="text" data-v="name" value="${esc(v.name)}"></label>
        <label>${loc("CPRHQ.Downtime.ed.cost")}<input type="text" data-v="cost" value="${esc(v.cost)}"></label>
        <label>${loc("CPRHQ.Downtime.ed.hours")}<input type="number" data-v="hours" min="1" step="1" value="${v.hours ?? 1}"></label>
        <label class="check"><input type="checkbox" data-v="countsAsSleep" ${v.countsAsSleep ? "checked" : ""}> ${loc("CPRHQ.Downtime.countsAsSleep")}</label>
        <label class="full">${loc("CPRHQ.Downtime.ed.description")}<textarea data-v="description" rows="2">${esc(v.description)}</textarea></label>
      </div>
    </fieldset>`;
}

function activityRow(a) {
  const mission = a.id === "mission";
  const core = mission || (a.id === "sleep");
  const days = Math.max(1, a.days ?? 1);
  const meta = a.variants?.length ? game.i18n.format("CPRHQ.Downtime.ed.types", { n: a.variants.length })
    : (days > 1 ? `${a.hours}h × ${days}` : `${a.hours ?? 1}h`);
  const improvements = [["", loc("CPRHQ.Downtime.ed.none")], ...Object.keys(CATALOGUE).map(k => [k, loc(`CPRHQ.Imp.${k}.name`)])];
  return `
    <details class="act" data-id="${esc(a.id)}" data-locked="${mission}" data-mechanic="${esc(a.mechanic)}" data-app="${esc(a.app)}" style="--act: ${esc(a.color)}">
      <summary><i class="${esc(a.icon)}"></i> <strong class="act-title">${esc(a.name)}</strong><span class="act-meta">${esc(meta)}${a.cost ? ` · ${esc(a.cost)}` : ""}</span></summary>
      <div class="act-grid">
        <label class="wide">${loc("CPRHQ.Downtime.ed.name")}<input type="text" data-f="name" value="${esc(a.name)}"></label>
        <label>${loc("CPRHQ.Downtime.ed.icon")}<input type="text" data-f="icon" value="${esc(a.icon)}" placeholder="fa-solid fa-circle"></label>
        <label>${loc("CPRHQ.Downtime.ed.color")}<input type="color" data-f="color" value="${esc(a.color)}"></label>
        ${mission ? "" : `
        <label>${loc("CPRHQ.Downtime.ed.hours")}<input type="number" data-f="hours" min="1" step="1" value="${a.hours ?? 1}"></label>
        <label>${loc("CPRHQ.Downtime.ed.days")}<input type="number" data-f="days" min="1" step="1" value="${days}"></label>
        <label>${loc("CPRHQ.Downtime.ed.minHours")}<input type="number" data-f="minHours" min="1" step="1" value="${a.minHours ?? 1}"></label>
        <label class="check"><input type="checkbox" data-f="countsAsSleep" ${a.countsAsSleep ? "checked" : ""}> ${loc("CPRHQ.Downtime.countsAsSleep")}</label>
        <label class="check" data-tooltip="CPRHQ.Downtime.ed.flexibleTip"><input type="checkbox" data-f="flexible" ${isFlexible(a) ? "checked" : ""}> ${loc("CPRHQ.Downtime.ed.flexible")}</label>
        <label class="wide">${loc("CPRHQ.Downtime.ed.cost")}<input type="text" data-f="cost" value="${esc(a.cost)}" placeholder="${loc("CPRHQ.Downtime.ed.costHint")}"></label>
        <label>${loc("CPRHQ.Downtime.ed.role")}<select data-f="role">${options([["", loc("CPRHQ.Downtime.ed.anyone")], ...ROLES.map(r => [r, r])], a.role ?? "")}</select></label>
        ${a.app ? `<label>${loc("CPRHQ.Downtime.ed.app")}<input type="text" value="${esc(a.app)}" readonly></label>` : ""}
        <label>${loc("CPRHQ.Downtime.ed.prompt")}<select data-f="promptType">${options([["", loc("CPRHQ.Downtime.ed.none")],
          ["comment", loc("CPRHQ.Downtime.ed.promptComment")], ["text", loc("CPRHQ.Downtime.ed.promptText")],
          ["skill", loc("CPRHQ.Downtime.ed.promptSkill")]], a.prompt?.type ?? "")}</select></label>
        <label class="wide">${loc("CPRHQ.Downtime.ed.promptLabel")}<input type="text" data-f="promptLabel" value="${esc(a.prompt?.label)}"></label>
        <label class="full">${loc("CPRHQ.Downtime.ed.promptOptions")}<input type="text" data-f="promptOptions" value="${esc((a.prompt?.options ?? []).join(", "))}"
          placeholder="${loc("CPRHQ.Downtime.ed.promptOptionsHint")}"></label>
        <label>${loc("CPRHQ.Downtime.ed.requires")}<select data-f="requires">${options(improvements, a.requires?.improvement ?? "")}</select></label>
        <label>${loc("CPRHQ.Downtime.ed.rank")}<input type="number" data-f="rank" min="1" step="1" value="${a.requires?.rank ?? 1}"></label>
        <label class="full">${loc("CPRHQ.Downtime.ed.description")}<textarea data-f="description" rows="3">${esc(a.description)}</textarea></label>`}
      </div>
      ${mission ? "" : `
      <div class="act-variants">${(a.variants ?? []).map(variantRow).join("")}</div>
      <p class="hint">${loc("CPRHQ.Downtime.ed.variantsHint")}</p>`}
      <div class="act-row-actions">
        ${mission ? "" : `<button type="button" data-act="addVariant"><i class="fa-solid fa-plus"></i> ${loc("CPRHQ.Downtime.ed.addVariant")}</button>`}
        <button type="button" data-act="up" data-tooltip="CPRHQ.Downtime.ed.up"><i class="fa-solid fa-arrow-up"></i></button>
        <button type="button" data-act="down" data-tooltip="CPRHQ.Downtime.ed.down"><i class="fa-solid fa-arrow-down"></i></button>
        ${core ? "" : `<button type="button" class="btn-danger" data-act="remove"><i class="fa-solid fa-trash"></i> ${loc("CPRHQ.Downtime.ed.remove")}</button>`}
      </div>
    </details>`;
}

/** Read the edited list back from the dialog, in row order. */
function collect(element) {
  return [...element.querySelectorAll("details.act")].map(row => {
    const f = name => row.querySelector(`[data-f="${name}"]`);
    const val = name => f(name)?.value ?? "";
    const a = {
      id: row.dataset.id, name: val("name"), icon: val("icon"), color: val("color"),
      hours: val("hours") || 1, days: val("days") || 1, minHours: val("minHours") || 1,
      countsAsSleep: !!f("countsAsSleep")?.checked, flexible: row.dataset.locked === "true" || !!f("flexible")?.checked, cost: val("cost"), role: val("role"), description: val("description"),
      locked: row.dataset.locked === "true", mechanic: row.dataset.mechanic, app: row.dataset.app
    };
    if ( val("promptType") ) a.prompt = { type: val("promptType"), label: val("promptLabel") || loc("CPRHQ.Downtime.detail"), options: val("promptOptions") };
    if ( val("requires") ) a.requires = { improvement: val("requires"), rank: val("rank") || 1 };
    a.variants = [...row.querySelectorAll("fieldset.variant")].map(v => {
      const vf = name => v.querySelector(`[data-v="${name}"]`);
      return { id: v.dataset.variantId || "", name: vf("name").value, cost: vf("cost").value, hours: vf("hours").value,
        countsAsSleep: vf("countsAsSleep").checked, description: vf("description").value };
    });
    return a;
  });
}

export async function activitiesDialog() {
  if ( !game.user.isGM ) return;
  let reset = false;
  const result = await foundry.applications.api.DialogV2.wait({
    classes: ["cpr-hq-dialog", "cpr-hq-activities"],
    window: { title: loc("CPRHQ.Downtime.ed.title"), icon: "fa-solid fa-list-check", resizable: true },
    position: { width: 720 },
    content: `
      <p class="hint">${loc("CPRHQ.Downtime.ed.hint")}</p>
      <div class="act-list">${activities().map(activityRow).join("")}</div>
      <div class="act-tools">
        <button type="button" data-act="add"><i class="fa-solid fa-plus"></i> ${loc("CPRHQ.Downtime.ed.add")}</button>
      </div>`,
    rejectClose: false,
    modal: true,
    render: (event, element) => {
      const list = element.querySelector(".act-list");
      element.addEventListener("click", ev => {
        const button = ev.target.closest("button[data-act]");
        if ( !button ) return;
        const row = button.closest("details.act");
        switch ( button.dataset.act ) {
          case "add": {
            list.insertAdjacentHTML("beforeend", activityRow({ id: "", name: loc("CPRHQ.Downtime.ed.newName"), icon: "fa-solid fa-circle", color: "#888888", hours: 1, minHours: 1 }));
            const added = list.lastElementChild;
            added.open = true;
            added.scrollIntoView({ block: "nearest" });
            added.querySelector("[data-f=name]").select();
            break;
          }
          case "remove": row.remove(); break;
          case "up": row.previousElementSibling?.before(row); break;
          case "down": row.nextElementSibling?.after(row); break;
          case "addVariant": row.querySelector(".act-variants").insertAdjacentHTML("beforeend", variantRow({ hours: 1 })); break;
          case "removeVariant": button.closest("fieldset.variant").remove(); break;
        }
      });
      // Keep the row titles in step with the name and colour fields.
      element.addEventListener("input", ev => {
        const row = ev.target.closest("details.act");
        if ( !row ) return;
        if ( ev.target.dataset.f === "name" ) row.querySelector(".act-title").textContent = ev.target.value;
        if ( ev.target.dataset.f === "color" ) row.style.setProperty("--act", ev.target.value);
        if ( ev.target.dataset.f === "icon" ) row.querySelector("summary > i").className = ev.target.value;
      });
    },
    buttons: [
      { action: "reset", label: loc("CPRHQ.Downtime.ed.reset"), icon: "fa-solid fa-rotate-left", callback: () => { reset = true; return "reset"; } },
      { action: "cancel", label: loc("Cancel"), icon: "fa-solid fa-xmark" },
      { action: "ok", label: loc("CPRHQ.Save"), icon: "fa-solid fa-floppy-disk", default: true,
        callback: (event, button) => collect(button.form) }
    ]
  });
  if ( reset ) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      classes: ["cpr-hq-dialog"], window: { title: loc("CPRHQ.Downtime.ed.reset") },
      content: `<p>${loc("CPRHQ.Downtime.ed.resetConfirm")}</p>`, rejectClose: false, modal: true
    });
    if ( ok ) await resetActivities();
    return;
  }
  if ( Array.isArray(result) ) await saveActivities(result);
}
