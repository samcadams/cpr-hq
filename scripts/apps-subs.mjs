import { BILLED_BY } from "./trauma.mjs";
import { rule } from "./rules.mjs";

/**
 * App subscriptions: monthly apps from the Agent module's App Store (cpr-sam-agent, its API's subscriptions.*).
 * The Agent keeps each character's subscriptions; players subscribe and cancel on their phone. While HQ is active
 * the Agent bills nothing itself (subscriptions.handOffBilling): the Lifestyle bill has an Apps column instead.
 */

const AGENT_ID = "cpr-sam-agent";

/** The Agent's API, if the module is active, has the subscriptions API and its App Store is switched on. */
export function appsAgent() {
  const module = game.modules.get(AGENT_ID);
  const api = module?.active ? module.api : null;
  if ( !api?.subscriptions?.state ) return null;
  return (api.pool?.on?.() ?? true) ? api : null;
}

/**
 * A character's subscriptions, with what the next Lifestyle bill charges for them: a month of the active ones
 * nobody sponsors (the Agent's own total). Null without the Agent's App Store.
 */
export function appsState(actor) {
  const agent = appsAgent();
  if ( !agent ) return null;
  const state = agent.subscriptions.state(actor) ?? {};
  const items = state.items ?? [];
  return { items, charge: Math.max(0, Math.round(Number(state.total) || 0)) };
}

/** Tooltip for the bill's Apps cell: each billed app and its price. */
export function appsTip(state) {
  return (state?.items ?? []).filter(i => (i.status === "active") && !i.sponsor)
    .map(i => `${i.name} (${i.price}eb)`).join(", ");
}

/** Card data for a character's App subscriptions block, or null without the Agent's App Store. */
export function appsCard(actor) {
  const state = appsState(actor);
  if ( !state ) return null;
  const loc = key => game.i18n.localize(key);
  return {
    items: state.items.map(i => ({
      name: i.name,
      price: i.price,
      note: i.sponsor ? game.i18n.format("CPRHQ.Apps.sponsored", { sponsor: i.sponsor })
        : (i.status === "lapsed" ? loc("CPRHQ.Apps.lapsed") : ""),
      lapsed: i.status === "lapsed"
    }))
  };
}

/**
 * Hand subscription billing to HQ's Lifestyle bill while HQ is active, and redraw Lifestyle views whenever the
 * Agent's subscriptions change.
 * @param {Function} refresh  redraws open Downtime/Lifestyle windows and HQ sheets
 */
export function registerAppsHooks(refresh) {
  Hooks.once("cpr-sam-agent.ready", agent => rule("billAgentPlans") && agent.subscriptions?.handOffBilling?.(BILLED_BY));
  Hooks.on("cpr-sam-agent.subscriptionsChanged", () => refresh());
}
