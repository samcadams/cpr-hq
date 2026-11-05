import { MODULE_ID } from "../constants.mjs";
import { getHQ, updateHQ } from "../hq.mjs";
import { HQ_MODES, HQ_STATUSES } from "../data/hq-model.mjs";
import { saveCustomImprovement } from "../improvements.mjs";
import { proposeBill, billingMonth, sendBill, BILL_COLUMNS, billNotes, invoiceAgent } from "../billing.mjs";

const { DialogV2 } = foundry.applications.api;

const loc = key => game.i18n.localize(key);
const esc = value => Handlebars.escapeExpression(value ?? "");

/** Render a schema field as a form group, as HTML. */
function group(field, value, name) {
  return field.toFormGroup({ localize: true }, { value, name }).outerHTML;
}

/** Ask for form values; resolves to the expanded form data, or null if dismissed. */
async function promptForm({ title, icon, content, label, buttonIcon, width = 400 }) {
  const data = await DialogV2.prompt({
    classes: ["cpr-hq-dialog"],
    window: { title, icon },
    position: { width },
    content,
    rejectClose: false,
    modal: true,
    ok: {
      label, icon: buttonIcon,
      callback: (event, button) => new FormDataExtended(button.form).object
    }
  });
  return data ? foundry.utils.expandObject(data) : null;
}

/**
 * GM: award HQ IP. Adds to both unspent and lifetime earned, and logs it.
 * Character IP is not touched (DESIGN decision).
 */
export async function awardIPDialog(entry) {
  if ( !game.user.isGM ) return;
  const data = await promptForm({
    title: loc("CPRHQ.Award.title"),
    icon: "fa-solid fa-star",
    label: loc("CPRHQ.Award.confirm"),
    buttonIcon: "fa-solid fa-star",
    content: `
      <div class="form-group">
        <label>${loc("CPRHQ.Award.amount")}</label>
        <div class="form-fields"><input type="number" name="amount" min="1" step="1" value="10" autofocus></div>
      </div>
      <div class="form-group">
        <label>${loc("CPRHQ.Award.reason")}</label>
        <div class="form-fields"><input type="text" name="reason" placeholder="${loc("CPRHQ.Award.reasonHint")}"></div>
      </div>`
  });
  if ( !data ) return;

  const amount = Math.floor(Number(data.amount));
  if ( !Number.isFinite(amount) || amount <= 0 ) {
    ui.notifications.warn("CPRHQ.Award.invalid", { localize: true });
    return;
  }
  const hq = getHQ(entry);
  const reason = data.reason?.trim();
  await updateHQ(entry, { ip: { unspent: hq.ip.unspent + amount, earned: hq.ip.earned + amount } }, {
    log: {
      type: "award",
      text: reason ? game.i18n.format("CPRHQ.Award.logReason", { reason }) : loc("CPRHQ.Award.log"),
      delta: `+${amount}`
    }
  });
  Hooks.callAll(`${MODULE_ID}.awardIP`, entry, amount);
}

/**
 * GM: HQ settings — status, mode, and direct IP corrections. Every change is logged.
 */
export async function settingsDialog(entry) {
  if ( !game.user.isGM ) return;
  const hq = getHQ(entry);
  const f = hq.schema.fields;
  const data = await promptForm({
    title: `${loc("CPRHQ.Settings.title")}: ${entry.name}`,
    icon: "fa-solid fa-gear",
    label: loc("CPRHQ.Save"),
    buttonIcon: "fa-solid fa-floppy-disk",
    content: `
      ${group(f.status, hq.status, "status")}
      ${group(f.mode, hq.mode, "mode")}
      <p class="hint">${loc("CPRHQ.Settings.modeHint")}</p>
      <hr>
      ${group(f.ip.fields.unspent, hq.ip.unspent, "ip.unspent")}
      ${group(f.ip.fields.earned, hq.ip.earned, "ip.earned")}
      <p class="hint">${loc("CPRHQ.Settings.ipHint")}</p>`
  });
  if ( !data ) return;

  const log = [];
  if ( data.status !== hq.status ) log.push({
    type: "status",
    text: game.i18n.format("CPRHQ.Settings.logStatus", { from: loc(HQ_STATUSES[hq.status]), to: loc(HQ_STATUSES[data.status]) })
  });
  if ( data.mode !== hq.mode ) log.push({
    type: "status",
    text: game.i18n.format("CPRHQ.Settings.logMode", { to: loc(HQ_MODES[data.mode]) })
  });
  for ( const key of ["unspent", "earned"] ) {
    const before = hq.ip[key];
    const after = Number(data.ip?.[key]);
    if ( !Number.isFinite(after) || after === before ) continue;
    log.push({
      type: "correction",
      text: game.i18n.format("CPRHQ.Settings.logIP", { field: loc(`CPRHQ.Field.ip${key.capitalize()}`), from: before, to: after }),
      delta: `${after > before ? "+" : "−"}${Math.abs(after - before)}`
    });
  }
  if ( !log.length ) return;
  await updateHQ(entry, { status: data.status, mode: data.mode, ip: data.ip }, { log });
}

/** One tier block in the custom improvement dialog. */
function customTierRow(index, tier = {}) {
  const label = index === 0 ? loc("CPRHQ.Level.improvement") : game.i18n.format("CPRHQ.Level.upgradeN", { n: index });
  return `
    <fieldset class="custom-tier">
      <legend>${label} <button type="button" class="custom-tier-remove" data-tooltip="CPRHQ.Custom.removeTier"><i class="fa-solid fa-xmark"></i></button></legend>
      <input type="text" name="tiers.${index}.summary" value="${esc(tier.summary)}" placeholder="${loc("CPRHQ.Custom.tierSummary")}">
      <textarea name="tiers.${index}.text" rows="3" placeholder="${loc("CPRHQ.Custom.tierText")}">${esc(tier.text)}</textarea>
    </fieldset>`;
}

/**
 * GM: create or edit a custom improvement: name, icon, roles, a general description, and one block per tier
 * (a short summary for cards plus the full text; newlines are kept). The first tier is the Improvement,
 * every further tier an Upgrade.
 * @param {JournalEntry} entry
 * @param {object} [existing]  Custom improvement source data to edit
 */
export async function customImprovementDialog(entry, existing) {
  if ( !game.user.isGM ) return;
  const tiers = existing?.tiers?.length ? existing.tiers : [{}];
  const data = await DialogV2.prompt({
    classes: ["cpr-hq-dialog", "cpr-hq-custom"],
    window: { title: loc(existing ? "CPRHQ.Custom.editTitle" : "CPRHQ.Custom.createTitle"), icon: "fa-solid fa-star" },
    position: { width: 560 },
    content: `
      <div class="form-group">
        <label>${loc("CPRHQ.Custom.name")}</label>
        <div class="form-fields"><input type="text" name="name" value="${esc(existing?.name ?? "")}" required autofocus></div>
      </div>
      <div class="form-group">
        <label>${loc("CPRHQ.Custom.icon")}</label>
        <div class="form-fields"><input type="text" name="icon" value="${esc(existing?.icon ?? "fa-solid fa-star")}"></div>
        <p class="hint">${loc("CPRHQ.Custom.iconHint")}</p>
      </div>
      <div class="form-group">
        <label>${loc("CPRHQ.Custom.roles")}</label>
        <div class="form-fields"><input type="text" name="roles" value="${esc(existing?.roles ?? "")}" placeholder="Crew, Solo"></div>
        <p class="hint">${loc("CPRHQ.Custom.rolesHint")}</p>
      </div>
      <div class="form-group stacked">
        <label>${loc("CPRHQ.Custom.description")}</label>
        <textarea name="description" rows="3" placeholder="${loc("CPRHQ.Custom.descriptionHint")}">${esc(existing?.description ?? "")}</textarea>
      </div>
      <div class="custom-tiers">${tiers.map((t, i) => customTierRow(i, t)).join("")}</div>
      <button type="button" class="custom-tier-add"><i class="fa-solid fa-plus"></i> ${loc("CPRHQ.Custom.addTier")}</button>
      <p class="hint">${loc("CPRHQ.Custom.tiersHint")}</p>`,
    rejectClose: false,
    modal: true,
    render: (event, element) => {
      const list = element.querySelector(".custom-tiers");
      // Renumber names and labels after adding/removing so tiers stay in order.
      const renumber = () => {
        const values = [...list.querySelectorAll(".custom-tier")].map(f => ({
          summary: f.querySelector("input").value, text: f.querySelector("textarea").value
        }));
        list.innerHTML = values.map((t, i) => customTierRow(i, t)).join("");
      };
      element.querySelector(".custom-tier-add").addEventListener("click", () => {
        list.insertAdjacentHTML("beforeend", customTierRow(list.children.length));
        list.lastElementChild.querySelector("input").focus();
      });
      list.addEventListener("click", ev => {
        const button = ev.target.closest(".custom-tier-remove");
        if ( !button || (list.children.length <= 1) ) return;
        button.closest(".custom-tier").remove();
        renumber();
      });
    },
    ok: {
      label: loc("CPRHQ.Save"), icon: "fa-solid fa-floppy-disk",
      callback: (event, button) => foundry.utils.expandObject(new FormDataExtended(button.form).object)
    }
  });
  if ( !data ) return;
  const name = data.name?.trim();
  const tierList = Object.values(data.tiers ?? {})
    .map(t => ({ summary: String(t.summary ?? "").trim(), text: String(t.text ?? "").trim() }))
    .map(t => ({ summary: t.summary || t.text.split("\n")[0].slice(0, 120), text: t.text }))
    .filter(t => t.summary);
  if ( !name || !tierList.length ) {
    ui.notifications.warn("CPRHQ.Custom.invalid", { localize: true });
    return;
  }
  return saveCustomImprovement(entry, {
    key: existing?.key, name, icon: data.icon?.trim(), roles: data.roles?.trim(),
    description: data.description?.trim() ?? "", tiers: tierList
  });
}

/** Yes/no confirmation; resolves true only on an explicit yes. */
export async function confirmDialog(title, content) {
  const result = await DialogV2.confirm({
    classes: ["cpr-hq-dialog"],
    window: { title: loc(title) },
    content: `<p>${content}</p>`,
    rejectClose: false,
    modal: true
  });
  return result === true;
}

/** Ask the GM for the reduced monthly rent when Rent Reduction is first bought. Null if cancelled. */
export async function reducedRentDialog(currentRent) {
  const data = await promptForm({
    title: loc("CPRHQ.Imp.rentReduction.name"),
    icon: "fa-solid fa-percent",
    label: loc("CPRHQ.Action.purchase"),
    buttonIcon: "fa-solid fa-cart-shopping",
    content: `
      <p>${loc("CPRHQ.ReducedRent.prompt")}</p>
      <div class="form-group">
        <label>${loc("CPRHQ.Field.reducedRent")}</label>
        <div class="form-fields"><input type="number" name="rent" min="0" step="1" value="${currentRent}" autofocus></div>
      </div>
      <p class="hint">${game.i18n.format("CPRHQ.ReducedRent.current", { rent: currentRent })}</p>`
  });
  if ( !data ) return null;
  const rent = Math.floor(Number(data.rent));
  return Number.isFinite(rent) && rent >= 0 ? rent : null;
}

/**
 * GM: mark a crew member as a Team Member and pick who they work for (usually an Exec).
 * Resolves to { teamMember, sponsor } or null if cancelled.
 */
export async function teamMemberDialog(entry, uuid) {
  const hq = getHQ(entry);
  const member = hq.crew.find(m => m.uuid === uuid);
  if ( !member ) return null;
  const options = hq.crew
    .filter(m => (m.uuid !== uuid) && !m.teamMember)
    .map(m => ({ uuid: m.uuid, name: fromUuidSync(m.uuid)?.name }))
    .filter(o => o.name)
    .map(o => `<option value="${o.uuid}" ${o.uuid === member.sponsor ? "selected" : ""}>${esc(o.name)}</option>`)
    .join("");
  const data = await promptForm({
    title: `${loc("CPRHQ.Crew.teamMember")}: ${fromUuidSync(uuid)?.name ?? ""}`,
    icon: "fa-solid fa-user-tie",
    label: loc("CPRHQ.Save"),
    buttonIcon: "fa-solid fa-floppy-disk",
    content: `
      <div class="form-group">
        <label>${loc("CPRHQ.Crew.teamMember")}</label>
        <div class="form-fields"><input type="checkbox" name="teamMember" ${member.teamMember ? "checked" : ""}></div>
      </div>
      <div class="form-group">
        <label>${loc("CPRHQ.Crew.sponsor")}</label>
        <div class="form-fields"><select name="sponsor"><option value=""></option>${options}</select></div>
        <p class="hint">${loc("CPRHQ.Crew.sponsorHint")}</p>
      </div>`
  });
  if ( !data ) return null;
  return { teamMember: !!data.teamMember, sponsor: data.teamMember ? (data.sponsor ?? "") : "" };
}

/** GM: add a manual Activity entry (a note or a correction). */
export async function logEntryDialog(entry) {
  if ( !game.user.isGM ) return;
  const data = await promptForm({
    title: loc("CPRHQ.Activity.add"),
    icon: "fa-solid fa-pen",
    label: loc("CPRHQ.Save"),
    buttonIcon: "fa-solid fa-floppy-disk",
    content: `
      <div class="form-group">
        <label>${loc("CPRHQ.Activity.type")}</label>
        <div class="form-fields"><select name="type">
          <option value="note">${loc("CPRHQ.Log.note")}</option>
          <option value="correction">${loc("CPRHQ.Log.correction")}</option>
          <option value="money">${loc("CPRHQ.Log.money")}</option>
        </select></div>
      </div>
      <div class="form-group">
        <label>${loc("CPRHQ.Activity.text")}</label>
        <div class="form-fields"><input type="text" name="text" required autofocus></div>
      </div>
      <div class="form-group">
        <label>${loc("CPRHQ.Activity.delta")}</label>
        <div class="form-fields"><input type="text" name="delta" placeholder="+40, −1,500eb"></div>
        <p class="hint">${loc("CPRHQ.Activity.deltaHint")}</p>
      </div>`
  });
  const text = data?.text?.trim();
  if ( !text ) return;
  await updateHQ(entry, {}, { log: { type: data.type, text, delta: data.delta?.trim() ?? "" } });
}

/**
 * GM: review a bill before sending. Every amount can be edited and anyone left out. With BangMe! it can go out as
 * invoices instead of deducting.
 * @param {object} config
 * @param {string} config.title
 * @param {string} [config.note]     Hint shown above the table
 * @param {string[]} config.columns  Keys of BILL_COLUMNS
 * @param {{uuid, name, wealth, charges: object, tips?: object}[]} config.lines
 * @returns {Promise<{month: string, mode: "deduct"|"invoice", lines: {uuid, charges: object}[]}|null>}
 */
export async function billReviewDialog({ title, note, columns, lines }) {
  const rows = lines.map((l, i) => `
    <tr>
      <td><input type="checkbox" name="lines.${i}.include" checked></td>
      <td>${esc(l.name)}<input type="hidden" name="lines.${i}.uuid" value="${l.uuid}">
        ${l.wealth !== null ? `<br><small>${game.i18n.format("CPRHQ.Bill.wealth", { eb: l.wealth })}</small>` : ""}</td>
      ${columns.map(c => `<td><input type="number" name="lines.${i}.charges.${c}" value="${l.charges[c] ?? 0}" min="0" step="1"
        ${l.tips?.[c] ? `data-tooltip="${esc(l.tips[c])}"` : ""}></td>`).join("")}
    </tr>`).join("");

  const data = await promptForm({
    title,
    icon: "fa-solid fa-file-invoice-dollar",
    label: loc("CPRHQ.Bill.send"),
    buttonIcon: "fa-solid fa-paper-plane",
    width: 420 + (columns.length * 100),
    content: `
      <div class="form-group">
        <label>${loc("CPRHQ.Bill.month")}</label>
        <div class="form-fields"><input type="text" name="month" value="${esc(billingMonth())}" required></div>
      </div>
      ${invoiceAgent() ? `<div class="form-group">
        <label>${loc("CPRHQ.Bill.mode")}</label>
        <div class="form-fields"><select name="mode">
          <option value="deduct">${loc("CPRHQ.Bill.modeDeduct")}</option>
          <option value="invoice" selected>${loc("CPRHQ.Bill.modeInvoice")}</option>
        </select></div>
      </div>` : ""}
      ${note ? `<p class="hint">${note}</p>` : ""}
      <table class="cpr-hq-bill-table">
        <thead><tr><th></th><th>${loc("CPRHQ.Bill.member")}</th>${columns.map(c => `<th>${loc(BILL_COLUMNS[c])}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  });
  if ( !data ) return null;
  const month = data.month?.trim();
  if ( !month ) {
    ui.notifications.warn("CPRHQ.Bill.noMonth", { localize: true });
    return null;
  }
  const chosen = Object.values(data.lines ?? {}).filter(l => l.include)
    .map(l => ({ uuid: l.uuid, charges: Object.fromEntries(columns.map(c => [c, Math.max(0, Math.floor(Number(l.charges?.[c]) || 0))])) }));
  return chosen.length ? { month, mode: data.mode || "deduct", lines: chosen } : null;
}

/** GM: review and send an HQ's rent bill (split equally between the full crew). */
export async function billDialog(entry) {
  if ( !game.user.isGM ) return;
  const hq = getHQ(entry);
  const lines = proposeBill(hq);
  if ( !lines.length ) return ui.notifications.warn("CPRHQ.Bill.noCrew", { localize: true });
  const bill = await billReviewDialog({
    title: game.i18n.format("CPRHQ.Bill.title", { hq: entry.name }),
    // The bill also reminds the crew of monthly rolls they make themselves (Morale Boost Humanity).
    note: [game.i18n.format("CPRHQ.Bill.rentNote", { rent: hq.effectiveRent, n: lines.length }),
      ...billNotes(hq).map(n => `<i class="fa-solid fa-hand-holding-heart"></i> ${esc(n)}`)].join("<br>"),
    columns: ["rent"],
    lines
  });
  if ( bill ) return sendBill(entry, bill);
}

/** Name and type for a new journal page. Resolves to {name, type} or null. */
export async function pageDialog() {
  const types = ["text", "image", "video", "pdf"]
    .map(t => `<option value="${t}">${esc(loc(CONFIG.JournalEntryPage.typeLabels[t] ?? t))}</option>`).join("");
  const data = await promptForm({
    title: loc("CPRHQ.Pages.title"),
    icon: "fa-solid fa-file-circle-plus",
    label: loc("CPRHQ.CreatePage"),
    buttonIcon: "fa-solid fa-plus",
    content: `
      <div class="form-group">
        <label>${loc("CPRHQ.Pages.name")}</label>
        <div class="form-fields"><input type="text" name="name" required autofocus></div>
      </div>
      <div class="form-group">
        <label>${loc("CPRHQ.Pages.type")}</label>
        <div class="form-fields"><select name="type">${types}</select></div>
      </div>
      <p class="hint">${loc("CPRHQ.Pages.hint")}</p>`
  });
  return data ? { name: data.name ?? "", type: data.type ?? "text" } : null;
}
