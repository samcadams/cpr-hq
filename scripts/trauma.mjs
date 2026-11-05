import { requestTrauma } from "./socket.mjs";

/**
 * Trauma Team coverage, through the Agent module (cpr-sam-agent, "CPR Functional Agent") when it's active.
 * The Agent keeps each character's subscription (its API's trauma.*), so the phone and the Lifestyle cards always
 * show the same thing: the cards read it, change it through the API, and redraw when the Agent says it changed.
 * The Lifestyle bill charges paid plans; while HQ is active the Agent bills nothing itself (trauma.handOffBilling).
 */

const AGENT_ID = "cpr-sam-agent";
export const BILLED_BY = "CPR HQ";

/** The Agent's API, if the module is active and has the Trauma Team API. */
export function traumaAgent() {
  const module = game.modules.get(AGENT_ID);
  const api = module?.active ? module.api : null;
  return api?.trauma?.update ? api : null;
}

/** What a plan costs a month: plans bill every `days` days (30 is a month). */
export const monthlyPrice = plan => Math.round((plan?.price ?? 0) * 30 / (plan?.days || 30));

/**
 * A character's coverage (the Agent's trauma.status), with what the next Lifestyle bill charges for it: a paid plan
 * that's active. Null without the Agent.
 */
export function traumaState(actor) {
  const agent = traumaAgent();
  if ( !agent ) return null;
  const status = agent.trauma.status(actor);
  const charge = (status.status === "active") && status.plan && !status.sponsor ? monthlyPrice(status.plan) : 0;
  return { ...status, charge, plans: agent.trauma.plans() };
}

/**
 * Change a character's coverage. GMs change it directly; a player's choice of plan goes through the GM.
 * @param {Actor} actor
 * @param {{plan?: string, status?: string, sponsor?: string}} changes  plan: a plan id, or "" for none
 */
export async function setTrauma(actor, changes) {
  if ( game.user.isGM ) return applyTrauma(actor, changes);
  return requestTrauma(actor, { plan: changes.plan });
}

/** GM: apply a change from a Lifestyle card through the Agent's API (an Agent alert tells the player). */
export async function applyTrauma(actor, { plan, status, sponsor }) {
  const agent = traumaAgent();
  const current = traumaState(actor);
  if ( !agent || !current ) return;
  const update = { actor: actor.id };
  if ( plan !== undefined ) {
    if ( !plan ) Object.assign(update, { status: "none", notify: game.i18n.localize("CPRHQ.Trauma.ended") });
    else {
      const chosen = current.plans.find(p => p.id === plan);
      if ( !chosen ) return;
      Object.assign(update, { plan, status: "active",
        notify: game.i18n.format("CPRHQ.Trauma.activated", { plan: chosen.name }) });
    }
  }
  if ( status !== undefined ) update.status = status;
  if ( sponsor !== undefined ) update.sponsor = String(sponsor).trim() || null;
  try {
    await agent.trauma.update(update);
  } catch(err) {
    ui.notifications.warn(err.message);
  }
}

/** Card data for a character's Trauma Team block, or null without the Agent. */
export function traumaCard(actor) {
  const state = traumaState(actor);
  if ( !state ) return null;
  const loc = key => game.i18n.localize(key);
  return {
    status: state.status,
    statusLabel: state.status === "none" ? "" : loc(`CPRHQ.Trauma.status.${state.status}`),
    plans: state.plans.map(p => ({
      id: p.id, selected: p.id === state.plan?.id,
      label: `${p.name} (${monthlyPrice(p)}eb/${loc("CPRHQ.Housing.month")})`
    })),
    note: state.plan?.note ?? "",
    memberId: state.memberId,
    sponsor: state.sponsor,
    // Players pick or drop their own plan, but not one someone else pays for.
    canChoose: actor.isOwner && (game.user.isGM || !state.sponsor),
    gm: game.user.isGM && (state.status !== "none")
      ? { lapsed: state.status === "lapsed", sponsor: state.sponsor ?? "" }
      : null
  };
}

/**
 * GM (via socket): a player's choice of plan for their own character. Only the plan, and not while someone else
 * pays for their coverage.
 */
export async function applyPlayerTrauma(actorUuid, { plan }, userId) {
  const actor = await fromUuid(actorUuid);
  const user = game.users.get(userId);
  if ( !actor || !user?.active || !actor.testUserPermission(user, "OWNER") || (typeof plan !== "string") ) return false;
  if ( traumaState(actor)?.sponsor ) return false;
  await applyTrauma(actor, { plan });
  return true;
}

/**
 * Hand Trauma Team billing to HQ's Lifestyle bill while HQ is active, and redraw Lifestyle views whenever the
 * Agent's coverage changes (from its phone, its API or here).
 * @param {Function} refresh  redraws open Downtime/Lifestyle windows and HQ sheets
 */
export function registerTraumaHooks(refresh) {
  Hooks.once("cpr-sam-agent.ready", agent => agent.trauma?.handOffBilling?.(BILLED_BY));
  Hooks.on("cpr-sam-agent.traumaChanged", () => refresh());
}
