import { MODULE_ID } from "./constants.mjs";
import { updateHQ } from "./hq.mjs";
import { calendarActive } from "./calendar.mjs";
import { billingMonth } from "./billing.mjs";
import { currentRound, unsettled } from "./downtime/model.mjs";

/**
 * Alert registry. Features register alerts; the sheet shows every alert whose check returns something.
 *
 * @typedef {object} HQAlertConfig
 * @property {string} id
 * @property {boolean} [gmOnly=false]
 * @property {number} [order=100]
 * @property {(hq: HQDataModel, entry: JournalEntry) => ({level: "info"|"warn"|"action", icon: string, text: string,
 *   actions?: {name: string, label: string}[]}|null)} check
 * @property {Record<string, (entry: JournalEntry, sheet: object) => any>} [handlers]  Button handlers by action name
 */

const registry = new Map();

export function registerAlert(config) {
  if ( !config?.id || (typeof config.check !== "function") ) throw new Error("HQ alerts need an id and a check().");
  registry.set(config.id, { gmOnly: false, order: 100, handlers: {}, ...config });
}

export function unregisterAlert(id) {
  registry.delete(id);
}

/** Alerts to show this user for an HQ, in order. */
export function getAlerts(hq, entry) {
  return [...registry.values()]
    .filter(a => game.user.isGM || !a.gmOnly)
    .sort((a, b) => a.order - b.order)
    .map(a => {
      try {
        const alert = a.check(hq, entry);
        return alert ? { id: a.id, level: "info", actions: [], ...alert } : null;
      } catch ( err ) {
        console.error(`${MODULE_ID} | Alert "${a.id}" failed`, err);
        return null;
      }
    })
    .filter(Boolean);
}

export function runAlertAction(id, name, entry, sheet) {
  return registry.get(id)?.handlers[name]?.(entry, sheet);
}

/* -------------------------------------------- */
/*  Calendar time bank                          */
/* -------------------------------------------- */

/** Improvements whose facilities count in-game time (Workshop banking, Lockup days, Studio weeks). */
export const TIME_IMPROVEMENTS = ["workshop", "lockup", "studio"];

const DAY = 86400;

/** "7 days", "1 day", "5 hours". */
export function formatSpan(seconds) {
  if ( seconds >= DAY ) {
    const days = Math.round(seconds / DAY * 10) / 10;
    return game.i18n.format(days === 1 ? "CPRHQ.Time.day" : "CPRHQ.Time.days", { n: days });
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  return game.i18n.format(hours === 1 ? "CPRHQ.Time.hour" : "CPRHQ.Time.hours", { n: hours });
}

export function usesTime(hq) {
  return (hq.status === "active") && TIME_IMPROVEMENTS.some(k => hq.rankOf(k) > 0);
}

/* -------------------------------------------- */
/*  Built-in alerts                             */
/* -------------------------------------------- */

export function registerCoreAlerts({ billDialog }) {
  registerAlert({
    id: "access",
    order: 10,
    check: hq => {
      if ( hq.status === "suspended" ) return { level: "warn", icon: "fa-solid fa-door-closed", text: game.i18n.localize("CPRHQ.Alert.suspended") };
      if ( hq.status === "destroyed" ) return { level: "warn", icon: "fa-solid fa-house-crack", text: game.i18n.localize("CPRHQ.Alert.destroyed") };
      return null;
    }
  });

  // In-game days since the last settled downtime: they need a downtime round (Downtime/Lifestyle tab).
  registerAlert({
    id: "downtime",
    gmOnly: true,
    order: 20,
    check: () => {
      const round = currentRound();
      if ( round ) return {
        level: "info", icon: "fa-solid fa-hourglass-half",
        text: game.i18n.format(round.status === "open" ? "CPRHQ.Alert.downtimeOpen" : "CPRHQ.Alert.downtimePlanning", { n: round.days }),
        actions: [{ name: "open", label: "CPRHQ.Alert.openDowntime" }]
      };
      const { days, seconds } = unsettled();
      if ( !days ) return null;
      return {
        level: "action", icon: "fa-solid fa-hourglass-half",
        text: game.i18n.format("CPRHQ.Alert.downtime", { span: formatSpan(seconds) }),
        actions: [{ name: "open", label: "CPRHQ.Alert.openDowntime" }]
      };
    },
    handlers: { open: (entry, sheet) => sheet?.changeTab("downtime", "page") }
  });

  // A new HQ has never been billed: offer the first month once. Dismissing it counts the current month as handled,
  // so the regular monthly reminder takes over from the next month.
  registerAlert({
    id: "firstBill",
    gmOnly: true,
    order: 29,
    check: hq => {
      if ( hq.billing.lastMonth || !hq.crew.some(m => !m.teamMember) || (hq.status === "destroyed") ) return null;
      return {
        level: "action", icon: "fa-solid fa-file-invoice-dollar",
        text: game.i18n.localize("CPRHQ.Alert.firstBill"),
        actions: [{ name: "review", label: "CPRHQ.Alert.review" }, { name: "dismiss", label: "CPRHQ.Alert.dismiss" }]
      };
    },
    handlers: {
      review: entry => billDialog(entry),
      dismiss: entry => updateHQ(entry, { billing: { lastMonth: billingMonth() || "—" } })
    }
  });

  registerAlert({
    id: "unbilled",
    gmOnly: true,
    order: 30,
    check: hq => {
      const month = billingMonth();
      if ( !hq.billing.lastMonth ) return null;
      if ( !calendarActive() || !month || (month === hq.billing.lastMonth) ) return null;
      if ( !hq.crew.some(m => !m.teamMember) || (hq.status === "destroyed") ) return null;
      return {
        level: "action", icon: "fa-solid fa-file-invoice-dollar",
        text: game.i18n.format("CPRHQ.Alert.unbilled", { month }),
        actions: [{ name: "review", label: "CPRHQ.Alert.review" }]
      };
    },
    handlers: { review: entry => billDialog(entry) }
  });

  registerAlert({
    id: "workstation",
    order: 40,
    check: hq => hq.workstationLock
      ? { level: "warn", icon: "fa-solid fa-desktop", text: game.i18n.localize("CPRHQ.Blocked.workstation") }
      : null
  });

  registerAlert({
    id: "beds",
    gmOnly: true,
    order: 50,
    check: hq => {
      const tenants = hq.crew.filter(m => m.tenant).length;
      return tenants > hq.effectiveBeds
        ? { level: "warn", icon: "fa-solid fa-bed", text: game.i18n.format("CPRHQ.Alert.beds", { tenants, beds: hq.effectiveBeds }) }
        : null;
    }
  });
}
