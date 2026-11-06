import { MODULE_ID } from "./constants.mjs";
import { getHQ, isHQ, updateHQ } from "./hq.mjs";
import { currentMonthLabel } from "./calendar.mjs";
import { formatNumber } from "./utils.mjs";
import { activeBenefits } from "./benefits.mjs";
import { traumaAgent } from "./trauma.mjs";
import { appsAgent } from "./apps-subs.mjs";
import { rule, splitRent } from "./rules.mjs";

/**
 * Monthly billing. Nothing is automatic: the GM reviews a proposed bill and sends it.
 *  - HQ bill (HQ sheet): the HQ's rent, split between the full crew (table rule: equally by default).
 *  - Lifestyle bill (Downtime/Lifestyle): each character's Lifestyle and Housing rent (see lifestyle.mjs).
 * Other modules (e.g. a phone app) can listen for the `cpr-hq.billed` hook to deliver bills in-world.
 * Either bill can go out as BangMe! invoices with the Agent module (api.money.invoice): nothing moves until each
 * character pays, and anyone who can't get one (no Agent, no wallet, no signal) is deducted as usual.
 */

/** Marks our invoices; an HQ bill's also says which log row shows them (see hqInvoiceTag). */
const INVOICE_TAG = "cpr-hq-bill";

/** The Agent's API, if the module is active, can send invoices and BangMe! is switched on. */
export function invoiceAgent() {
  const module = game.modules.get("cpr-sam-agent");
  const api = module?.active ? module.api : null;
  if ( !api?.money?.invoice ) return null;
  return api.feature("app_bangme") ? api : null;
}

/** Bill columns, in display order. */
export const BILL_COLUMNS = {
  rent: "CPRHQ.Bill.rent",
  housing: "CPRHQ.Bill.housing",
  lifestyle: "CPRHQ.Bill.lifestyle",
  trauma: "CPRHQ.Bill.trauma",
  apps: "CPRHQ.Bill.apps"
};

/**
 * The Lifestyle bill's columns: Housing and Lifestyle, Trauma Team with the Agent module, and Apps (subscriptions)
 * while its App Store is on; those two only while the table bills them here (billAgentPlans).
 */
export const lifestyleBillColumns = () => ["housing", "lifestyle",
  ...(rule("billAgentPlans") && traumaAgent() ? ["trauma"] : []), ...(rule("billAgentPlans") && appsAgent() ? ["apps"] : [])];

/** The month a new bill is for: Simple Calendar's current month, else blank for the GM to fill in. */
export function billingMonth() {
  return currentMonthLabel() ?? "";
}

/**
 * Proposed HQ bill: the effective rent split between every full crew member (Team Members aren't billed), as the
 * rentSplit table rule says (equal: any remainder goes to the first members; first; none).
 * @returns {{uuid, name, wealth, charges: {rent}}[]}
 */
export function proposeBill(hq) {
  const members = hq.crew.filter(m => !m.teamMember)
    .map(m => ({ member: m, actor: fromUuidSync(m.uuid) }))
    .filter(x => x.actor);
  const charges = splitRent(hq.effectiveRent, members.length, rule("rentSplit"));
  return members.map(({ actor }, i) => ({
    uuid: actor.uuid, name: actor.name, wealth: actor.system.wealth?.value ?? null, charges: { rent: charges[i] }
  }));
}

const sumTotals = results => results.reduce((sum, r) => sum + r.total, 0);

/** What an invoice says it's for, with the breakdown when there's more than one charge on it. */
function invoiceMemo(reason, charges) {
  const parts = Object.entries(charges).filter(([, eb]) => eb > 0);
  if ( parts.length < 2 ) return reason;
  return `${reason} (${parts.map(([c, eb]) => `${game.i18n.localize(BILL_COLUMNS[c])} ${formatNumber(eb)}eb`).join(", ")})`;
}

/** The tag of an HQ bill's invoices: where the bill's log row is, and its month. */
const hqInvoiceTag = (entry, logId, month) => [INVOICE_TAG, entry.id, logId, month].join(":");

/** The text of an HQ bill's log row: who has paid so far. */
function invoiceLogText(month, invoices) {
  const who = invoices.map(({ actorId, status }) => game.i18n.format("CPRHQ.Bill.invoiceMember", {
    name: game.actors.get(actorId)?.name ?? "?", status: game.i18n.localize(`CPRHQ.Bill.invoiceStatus.${status}`)
  }));
  return game.i18n.format("CPRHQ.Bill.logInvoice", { month, who: who.join(", ") });
}

/** An invoice from an HQ bill was answered: bring its log row up to date (active GM's client). */
async function onInvoiceSettled({ tag }) {
  const [prefix, entryId, logId, ...month] = String(tag ?? "").split(":");
  if ( (prefix !== INVOICE_TAG) || !logId ) return;
  const entry = game.journal.get(entryId);
  if ( !isHQ(entry) ) return;
  const log = getHQ(entry).toObject().log;
  const row = log.find(e => e.id === logId);
  if ( !row ) return;
  row.text = invoiceLogText(month.join(":"), game.modules.get("cpr-sam-agent").api.money.invoices({ tag }));
  await updateHQ(entry, { log });
}

/** Keep HQ bills' log rows current as their invoices are answered. */
export function registerBillingHooks() {
  Hooks.on("cpr-sam-agent.invoiceSettled", onInvoiceSettled);
}

/**
 * Deduct charges from each character's eb (CPR ledger, with a reason), or invoice them, and post the bill to chat.
 * @param {object} bill
 * @param {string} bill.title     Chat card heading and invoice sender, e.g. the HQ name or "Lifestyle & Housing"
 * @param {string} bill.month
 * @param {string} bill.reason    Ledger reason
 * @param {string[]} bill.columns Keys of BILL_COLUMNS present on this bill
 * @param {{uuid, charges: Record<string, number>}[]} bill.lines
 * @param {string} [bill.invoiceTag]  Send invoices with this tag instead of deducting, where possible
 * @returns {Promise<{results: object[], grand: number}|null>}
 */
async function chargeAndPost({ title, month, reason, columns, lines, notes = [], invoiceTag = null }) {
  const agent = invoiceTag ? invoiceAgent() : null;
  const results = [];
  for ( const line of lines ) {
    const actor = await fromUuid(line.uuid);
    const charges = Object.fromEntries(columns.map(c => [c, Math.max(0, Math.floor(Number(line.charges?.[c]) || 0))]));
    const total = Object.values(charges).reduce((a, b) => a + b, 0);
    if ( !actor || !total ) continue;
    let after = null;
    const invoiced = !!agent?.money.canInvoice(actor) && agent.hasSignal(actor);
    if ( invoiced ) {
      await agent.money.invoice({ to: actor, from: title, amount: total, memo: invoiceMemo(reason, charges), tag: invoiceTag });
    } else if ( actor.deltaLedgerProperty ) {
      const before = actor.system.wealth?.value ?? 0;
      actor.deltaLedgerProperty("wealth", -total, reason);
      after = before - total;
    }
    results.push({ uuid: actor.uuid, name: actor.name, charges, total, after, invoiced, short: (after !== null) && (after < 0) });
  }
  if ( !results.length ) return null;
  const grand = sumTotals(results);
  const fallback = agent ? results.filter(r => !r.invoiced) : [];
  if ( fallback.length ) {
    ui.notifications.info(game.i18n.format("CPRHQ.Bill.invoiceFallback", { names: fallback.map(r => r.name).join(", ") }));
  }

  await ChatMessage.implementation.create({
    speaker: { alias: title },
    content: await renderTemplate(`modules/${MODULE_ID}/templates/chat/bill.hbs`, {
      title, month, grand: formatNumber(grand), notes,
      how: game.i18n.localize(`CPRHQ.Bill.${!results.some(r => r.invoiced) ? "chatDeduct" : (fallback.length ? "chatMixed" : "chatInvoice")}`),
      columns: columns.map(c => BILL_COLUMNS[c]),
      lines: results.map(r => ({
        ...r, cells: columns.map(c => formatNumber(r.charges[c])), total: formatNumber(r.total)
      }))
    })
  });
  return { results, grand };
}

/**
 * Reminders printed under an HQ bill: monthly benefits the players roll themselves (Morale Boost Humanity).
 * @returns {string[]}
 */
export function billNotes(hq) {
  return activeBenefits(hq).filter(b => b.type === "humanity").map(b => game.i18n.format("CPRHQ.Bill.humanityNote", {
    formula: b.formula.replace("floor(1d6/2)", "1d6/2").replace("2d6kh", "2d6 keep highest")
  }));
}

/**
 * Send an HQ's rent bill.
 * @param {JournalEntry} entry
 * @param {{month: string, mode?: "deduct"|"invoice", lines: {uuid, charges: {rent}}[]}} bill
 */
export async function sendBill(entry, { month, mode = "deduct", lines }) {
  if ( !game.user.isGM ) return;
  const hq = getHQ(entry);
  const logId = foundry.utils.randomID();
  const sent = await chargeAndPost({
    title: entry.name, month, columns: ["rent"], lines, notes: billNotes(hq),
    reason: game.i18n.format("CPRHQ.Bill.reason", { hq: entry.name, month }),
    invoiceTag: mode === "invoice" ? hqInvoiceTag(entry, logId, month) : null
  });
  if ( !sent ) return;
  const invoiced = sent.results.filter(r => r.invoiced);
  const deducted = sent.results.filter(r => !r.invoiced);
  const log = [];
  if ( deducted.length ) log.push({
    type: "money",
    text: game.i18n.format("CPRHQ.Bill.logDeduct", { month, n: deducted.length }),
    delta: `${formatNumber(sumTotals(deducted))}eb`
  });
  if ( invoiced.length ) log.push({
    id: logId,
    type: "money",
    text: invoiceLogText(month, invoiced.map(r => ({ actorId: fromUuidSync(r.uuid)?.id, status: "pending" }))),
    delta: `${formatNumber(sumTotals(invoiced))}eb`
  });
  await updateHQ(entry, { billing: { lastMonth: month } }, { log });
  /**
   * A month's bill was sent. Payload is plain data so other modules (e.g. an in-world phone) can deliver it.
   * kind: "hq" (rent) or "lifestyle" (Lifestyle + Housing). mode: "deduct" or "invoice"; with invoices, each
   * line says whether it was `invoiced` (so unpaid) or deducted.
   */
  Hooks.callAll(`${MODULE_ID}.billed`, entry, { kind: "hq", month, mode, lines: sent.results, total: sent.grand, rent: hq.effectiveRent });
}

/**
 * Send a Lifestyle bill (Lifestyle + Housing, and Trauma Team and Apps with the Agent module) for any characters. Doesn't
 * need an HQ.
 * @param {{month: string, mode?: "deduct"|"invoice", lines: {uuid, charges: {lifestyle, housing, trauma?, apps?}}[]}} bill
 */
export async function sendLifestyleBill({ month, mode = "deduct", lines }) {
  if ( !game.user.isGM ) return;
  const title = game.i18n.localize("CPRHQ.Lifestyle.billTitle");
  const sent = await chargeAndPost({
    title, month, columns: lifestyleBillColumns(), lines,
    reason: game.i18n.format("CPRHQ.Lifestyle.billReason", { month }),
    invoiceTag: mode === "invoice" ? INVOICE_TAG : null
  });
  if ( !sent ) return;
  Hooks.callAll(`${MODULE_ID}.billed`, null, { kind: "lifestyle", month, mode, lines: sent.results, total: sent.grand });
}
