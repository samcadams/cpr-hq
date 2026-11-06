import { MODULE_ID, TEMPLATE_ROOT } from "./constants.mjs";
import { TABLE_RULES, SETTING_GROUPS } from "./rules.mjs";
import { activitiesDialog } from "./downtime/editor.mjs";
import { presetsDialog } from "./apps/downtime.mjs";
import { upkeepSwitchedOn } from "./upkeep.mjs";
import { BILLED_BY } from "./trauma.mjs";
import { isHQ } from "./hq.mjs";
import { queueSync, crewEffects, removeCrewEffects } from "./effects.mjs";

const { HandlebarsApplicationMixin, ApplicationV2, DialogV2 } = foundry.applications.api;

const loc = key => game.i18n.localize(key);

/** Redraw what a table rule can change: every open cpr-hq window (HQ sheets, Downtime, Workshop) and actor sheet. */
const redraw = foundry.utils.debounce(() => {
  for ( const app of foundry.applications.instances.values() ) {
    if ( app.rendered && (app.options.classes?.includes("cpr-hq") || (app.document instanceof Actor)) ) app.render();
  }
  for ( const app of Object.values(ui.windows) ) if ( app instanceof ActorSheet ) app.render();
}, 100);

/** Display only: the active GM may clear the crew benefit effects already on sheets (Training Practice stays). */
async function offerRemoveEffects() {
  if ( !game.users.activeGM?.isSelf ) return;
  const n = crewEffects().length;
  if ( !n ) return;
  const yes = await DialogV2.confirm({
    window: { title: loc("CPRHQ.Chip.removeTitle"), icon: "fa-solid fa-user-minus" },
    content: `<p>${game.i18n.format("CPRHQ.Chip.removeConfirm", { n })}</p>`,
    rejectClose: false
  });
  if ( !yes ) return;
  await removeCrewEffects();
  ui.notifications.info("CPRHQ.Chip.removed", { localize: true });
}

/**
 * Per-rule onChange (key -> fn(value)), on every client; each redraws after. Agent billing is per client, so
 * every client hands it over (or back: null lets the Agent bill again).
 */
const ON_CHANGE = {
  upkeep: on => on && upkeepSwitchedOn(),
  billAgentPlans: on => {
    const module = game.modules.get("cpr-sam-agent");
    const agent = module?.active ? module.api : null;
    agent?.trauma?.handOffBilling?.(on ? BILLED_BY : null);
    agent?.subscriptions?.handOffBilling?.(on ? BILLED_BY : null);
  },
  crewEffects: mode => {
    if ( mode === "auto" ) for ( const entry of game.journal ) if ( isHQ(entry) ) queueSync(entry);
    if ( mode === "display" ) return offerRemoveEffects();
  }
};

/** A Configure Settings button that opens one of the module's dialogs instead of a window of its own. */
function launcher(open) {
  return class extends ApplicationV2 {
    async render() {
      open();
      return this;
    }
  };
}

/** The settings, grouped in setup order, labels localized now. */
function settingsGroups() {
  return SETTING_GROUPS.map(g => ({
    ...g, keys: [...g.keys],
    label: loc(`CPRHQ.Settings.group.${g.id}.label`), hint: loc(`CPRHQ.Settings.group.${g.id}.hint`)
  }));
}

/** One form field for a registered setting. */
function ruleField(key) {
  const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
  const value = game.settings.get(MODULE_ID, key);
  const field = { key, id: `cpr-hq-rule-${key}`, name: loc(setting.name), hint: loc(setting.hint), value };
  if ( setting.type === Boolean ) return { ...field, checkbox: true };
  if ( setting.choices ) return { ...field, choices: Object.entries(setting.choices)
    .map(([choice, label]) => ({ value: choice, label: loc(label), selected: String(choice) === String(value) })) };
  if ( setting.type === Number ) return { ...field, number: true, range: setting.range ?? {} };
  return { ...field, text: true };
}

/** GM: the Table rules form, from Configure Settings. Sections are the groups the Table rules menu edits. */
class TableRulesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cpr-hq-table-rules",
    tag: "form",
    classes: ["cpr-hq-table-rules"],
    window: { title: "CPRHQ.Settings.menu.tableRules.name", icon: "fa-solid fa-scale-balanced", contentClasses: ["standard-form"] },
    position: { width: 600 },
    form: { handler: TableRulesApp.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/settings/table-rules.hbs`, scrollable: [""] }
  };

  async _prepareContext() {
    const groups = settingsGroups().filter(g => g.menu === "tableRules")
      .map(g => ({ ...g, fields: g.keys.map(ruleField) }));
    return { groups };
  }

  /** Save the values that changed. */
  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    for ( const group of SETTING_GROUPS.filter(g => g.menu === "tableRules") ) {
      for ( const key of group.keys ) {
        if ( !(key in data) ) continue;
        const { type } = game.settings.settings.get(`${MODULE_ID}.${key}`);
        const value = (type === Boolean) ? !!data[key] : (type === Number) ? Number(data[key]) : String(data[key] ?? "");
        if ( value !== game.settings.get(MODULE_ID, key) ) await game.settings.set(MODULE_ID, key, value);
      }
    }
  }
}

/** init: the table rules and the Configure Settings menus (in setup order). */
export function registerTableSettings() {
  const menu = (key, icon, type) => game.settings.registerMenu(MODULE_ID, key, {
    name: `CPRHQ.Settings.menu.${key}.name`, label: `CPRHQ.Settings.menu.${key}.label`,
    hint: `CPRHQ.Settings.menu.${key}.hint`, icon, type, restricted: true
  });
  menu("editActivities", "fa-solid fa-list-check", launcher(activitiesDialog));
  menu("editPresets", "fa-solid fa-house-user", launcher(presetsDialog));
  menu("tableRules", "fa-solid fa-scale-balanced", TableRulesApp);

  for ( const [key, rule] of Object.entries(TABLE_RULES) ) {
    game.settings.register(MODULE_ID, key, {
      name: `CPRHQ.Settings.${key}.name`, hint: `CPRHQ.Settings.${key}.hint`,
      scope: "world", config: false, type: rule.type, default: rule.default,
      ...(rule.choices ? { choices: Object.fromEntries(rule.choices.map(c => [c, `CPRHQ.Settings.${key}.${c}`])) } : {}),
      ...(rule.range ? { range: rule.range } : {}),
      onChange: value => {
        ON_CHANGE[key]?.(value);
        redraw();
      }
    });
  }
}

/** api.settings: the module's settings grouped in setup order (labels localized when read). */
export const settingsAPI = {
  get groups() { return settingsGroups(); }
};
