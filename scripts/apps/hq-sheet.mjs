import { MODULE_ID, HQ_FLAG, TEMPLATE_ROOT } from "../constants.mjs";
import { getHQ, diffHQ, updateHQ, deleteLogEntry } from "../hq.mjs";
import { HQ_MODES, HQ_STATUSES } from "../data/hq-model.mjs";
import { REGIONS, getSection, getSections } from "./sections.mjs";
import {
  awardIPDialog, settingsDialog, customImprovementDialog, confirmDialog, reducedRentDialog, teamMemberDialog,
  logEntryDialog, billDialog, pageDialog
} from "./dialogs.mjs";
import { lifestyleActors } from "../lifestyle.mjs";
import { lifestyleBillDialog, presetsDialog } from "./downtime.mjs";
import {
  removeVehicle, stockGarage, tryEscape, removePrisoner, setImprovedTeamMember, workstationView
} from "../facilities.mjs";
import { playerBenefits } from "./core-sections.mjs";
import { addTierEffect, effectItemFor, effectsByTier, describeChanges } from "../custom-effects.mjs";
import { requestPage } from "../socket.mjs";
import { billingMonth } from "../billing.mjs";
import { getAlerts, runAlertAction, formatSpan } from "../alerts.mjs";
import { removeCrew, toggleTenant, updateCrewMember } from "../crew.mjs";
import {
  getDefinition, improvementView, advanceImprovement, loseImprovement, refundImprovement, deleteCustomImprovement,
  resetImprovementText
} from "../improvements.mjs";
import { currentDateLabel, dateLabelAt } from "../calendar.mjs";
import { unsettled, DAY } from "../downtime/model.mjs";
import { holdRender } from "../downtime/timeline.mjs";
import { formatNumber } from "../utils.mjs";
import { syncHQ } from "../effects.mjs";
import { rule } from "../rules.mjs";

const { HandlebarsApplicationMixin, DocumentSheetV2 } = foundry.applications.api;

const PAGE_GROUP = "page";

/**
 * Headquarters sheet for a JournalEntry, laid out as a command board:
 * top bar | left column of panels | center pages (tabs) | inspector (opens on demand).
 * Panels and pages come from the section registry; see sections.mjs.
 */
export default class HQJournalSheet extends HandlebarsApplicationMixin(DocumentSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["cpr-hq", "hq-sheet"],
    position: { width: 1200, height: 820 },
    window: { icon: "fa-solid fa-building", resizable: true },
    form: { submitOnChange: true },
    actions: {
      editImage: HQJournalSheet.#onEditImage,
      openPage: HQJournalSheet.#onOpenPage,
      createPage: HQJournalSheet.#onCreatePage,
      awardIP: HQJournalSheet.#onAwardIP,
      billMonth: HQJournalSheet.#onBillMonth,
      alertAction: HQJournalSheet.#onAlertAction,
      hqSettings: HQJournalSheet.#onHQSettings,
      addLogEntry: HQJournalSheet.#onAddLogEntry,
      deleteLogEntry: HQJournalSheet.#onDeleteLogEntry,
      openCrew: HQJournalSheet.#onOpenCrew,
      toggleTenant: HQJournalSheet.#onToggleTenant,
      editTeamMember: HQJournalSheet.#onEditTeamMember,
      removeCrew: HQJournalSheet.#onRemoveCrew,
      createCustom: HQJournalSheet.#onCreateCustom,
      editCustom: HQJournalSheet.#onEditCustom,
      deleteCustom: HQJournalSheet.#onDeleteCustom,
      advanceImprovement: HQJournalSheet.#onAdvanceImprovement,
      loseImprovement: HQJournalSheet.#onLoseImprovement,
      refundImprovement: HQJournalSheet.#onRefundImprovement,
      toggleEdit: HQJournalSheet.#onToggleEdit,
      openStash: HQJournalSheet.#onOpenStash,
      editLifestyle: HQJournalSheet.#onEditLifestyle,
      toggleTextEdit: HQJournalSheet.#onToggleTextEdit,
      resetText: HQJournalSheet.#onResetText,
      openItem: HQJournalSheet.#onOpenItem,
      openActor: HQJournalSheet.#onOpenActor,
      billLifestyle: HQJournalSheet.#onBillLifestyle,
      managePresets: HQJournalSheet.#onManagePresets,
      syncBenefits: HQJournalSheet.#onSyncBenefits,
      removeVehicle: HQJournalSheet.#onRemoveVehicle,
      tryEscape: HQJournalSheet.#onTryEscape,
      releasePrisoner: HQJournalSheet.#onReleasePrisoner,
      addTierEffect: HQJournalSheet.#onAddTierEffect,
      editTierEffect: HQJournalSheet.#onEditTierEffect,
      deleteTierEffect: HQJournalSheet.#onDeleteTierEffect,
      inspect: HQJournalSheet.#onInspect,
      closeInspector: HQJournalSheet.#onCloseInspector
    }
  };

  /** Fixed frame regions. Section templates are preloaded so regions can render them as partials. */
  static get PARTS() {
    const sectionTemplates = region => getSections(region).flatMap(s => [s.template, ...(s.templates ?? [])]);
    return {
      topbar: { template: `${TEMPLATE_ROOT}/sheet/topbar.hbs` },
      left: { template: `${TEMPLATE_ROOT}/sheet/left.hbs`, templates: sectionTemplates("left"), scrollable: [""] },
      center: { template: `${TEMPLATE_ROOT}/sheet/center.hbs`, templates: sectionTemplates("center"), scrollable: [".center-body"] },
      inspector: { template: `${TEMPLATE_ROOT}/sheet/inspector.hbs`, scrollable: [""] }
    };
  }

  tabGroups = { [PAGE_GROUP]: null };

  #sectionState = {};

  /**
   * Per-sheet UI state for a section (filters, search text, …) that survives re-renders.
   * @param {string} id
   * @param {object} [initial]  Used the first time the state is requested
   */
  sectionState(id, initial = {}) {
    return this.#sectionState[id] ??= { ...initial };
  }

  /** Ids of left panels currently in edit mode. */
  editing = new Set();

  /** Key of whatever is open in the inspector; null = closed. */
  inspecting = null;

  /** GM: key of the improvement whose text is being edited inline; null = none. */
  textEditing = null;

  /** A fresh, validated view of this HQ's data. */
  get hq() {
    return getHQ(this.document);
  }

  /** @override */
  render(options, _options) {
    // Wait while a Downtime timeline bar is being dragged (see holdRender).
    if ( holdRender(this, options) ) return Promise.resolve(this);
    return super.render(options, _options);
  }

  /** @override */
  get title() {
    return `${game.i18n.localize("CPRHQ.SheetTitle")}: ${this.document.name}`;
  }

  /** Faction HQs are GM-only to edit, regardless of journal ownership. */
  get isEditable() {
    if ( !super.isEditable ) return false;
    return game.user.isGM || !this.hq.isFaction;
  }

  _visibleSections(region, hq = this.hq) {
    const ctx = { hq, document: this.document, user: game.user, sheet: this };
    return getSections(region).filter(s => s.visible(ctx));
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const hq = this.hq;
    const pages = this._visibleSections("center", hq);
    if ( !pages.some(s => s.id === this.tabGroups[PAGE_GROUP]) ) this.tabGroups[PAGE_GROUP] = pages[0]?.id ?? null;

    return Object.assign(context, {
      document: this.document,
      hq,
      source: hq.toObject(),
      fields: hq.schema.fields,
      editable: this.isEditable,
      disabled: !this.isEditable,
      isGM: game.user.isGM,
      statusLabel: HQ_STATUSES[hq.status],
      modeLabel: HQ_MODES[hq.mode],
      // While calendar time is waiting to be applied, the HQ stays on the date it was last brought up to.
      ...this.#dateContext(),
      billMonthLabel: billingMonth(),
      rentLabel: formatNumber(hq.effectiveRent),
      baseRentLabel: formatNumber(hq.housing.rent),
      rentReduced: hq.rankOf("rentReduction") > 0,
      bedsLabel: hq.effectiveBeds,
      inspecting: this.inspecting,
      textEditing: this.textEditing && (this.textEditing === this.inspecting)
    });
  }

  /** The date the world's downtime is settled to; days since then still need a downtime round. */
  #dateContext() {
    // Unapplied time shows once it's at least a day (a round can only cover whole days); not without downtime.
    const { seconds, start } = unsettled();
    const heldLabel = (seconds >= DAY) && rule("downtimeSystem") ? dateLabelAt(start) : null;
    return {
      dateLabel: heldLabel ?? currentDateLabel(),
      datePending: heldLabel ? formatSpan(seconds) : null,
      dateLive: heldLabel ? currentDateLabel() : null
    };
  }

  /**
   * Left and center regions get one entry per visible section, each with its own copy of the context
   * so sections can add data without colliding.
   * @override
   */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if ( partId === "inspector" ) return this.#prepareInspector(context);
    if ( partId === "topbar" ) return { ...context, benefitStrip: this.#benefitStrip(context.hq) };
    if ( !REGIONS.includes(partId) ) return context;

    const sections = [];
    for ( const section of this._visibleSections(partId, context.hq) ) {
      const active = (partId === "center") && (this.tabGroups[PAGE_GROUP] === section.id);
      const editing = !!section.editToggle && context.editable && this.editing.has(section.id);
      const ctx = { ...context, section, editing };
      await section.prepareContext?.(ctx, this);
      const label = (typeof section.label === "function") ? section.label({ ...context, user: game.user }) : section.label;
      sections.push({
        id: section.id, label, icon: section.icon, template: section.template,
        group: PAGE_GROUP, active, cssClass: active ? "active" : "", ctx,
        editToggle: !!section.editToggle && context.editable, editing
      });
    }
    const result = { ...context, sections };
    if ( partId === "center" ) result.alerts = getAlerts(context.hq, this.document);
    return result;
  }

  /** Players see their own benefits in a strip under the HQ title, above the red line. */
  #benefitStrip(hq) {
    if ( game.user.isGM ) return null;
    const mine = playerBenefits(hq);
    return {
      placement: "above",
      actor: mine?.actor ?? "",
      chips: mine?.chips ?? [],
      empty: !mine ? game.i18n.localize("CPRHQ.Chip.notCrew") : (!mine.chips.length ? game.i18n.localize("CPRHQ.Chip.none") : ""),
      notice: !hq.hasAccess ? game.i18n.localize("CPRHQ.Chip.noAccess") : ""
    };
  }

  /** Extra improvement-specific data for the detail view (inspector or facility page). */
  _detailView(hq, def) {
    const view = improvementView(hq, def);
    if ( (def.key === "workstation") && view.installed ) view.workstation = workstationView(hq);
    if ( def.custom ) {
      // Custom improvements: the Active Effects each tier grants (GM builds them with CPR's effect sheet).
      const byTier = effectsByTier(effectItemFor(def));
      for ( const step of view.ladder ) {
        step.effects = (byTier.get(step.index) ?? []).map(e => ({ uuid: e.uuid, name: e.name, summary: describeChanges(e), disabled: e.disabled }));
      }
      view.effectsEnabled = true;
    }
    return view;
  }

  /** The inspector shows whichever improvement is open; a key that no longer exists closes it. */
  #prepareInspector(context) {
    if ( !this.inspecting ) return context;
    const def = getDefinition(context.hq, this.inspecting);
    if ( !def ) {
      this.inspecting = null;
      return context;
    }
    return { ...context, inspected: this._detailView(context.hq, def) };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const hq = context.hq;
    this.element.dataset.status = hq.status;
    this.element.dataset.mode = hq.mode;
    this.element.classList.toggle("inspector-open", !!this.inspecting);

    // Edit toggles: pressing them must not blur the field being edited. A blur submits the form and re-renders
    // under the pointer, which swallowed the first click; the toggle saves the form itself instead.
    for ( const partId of options.parts ) {
      for ( const button of this.parts[partId]?.querySelectorAll("[data-action=toggleEdit], [data-action=toggleTextEdit]") ?? [] ) {
        button.addEventListener("mousedown", event => event.preventDefault());
      }
    }

    // Improvement detail: clicking a tier's summary pins its full text open.
    for ( const partId of options.parts ) {
      for ( const summary of this.parts[partId]?.querySelectorAll(".tier-summary") ?? [] ) {
        summary.addEventListener("click", () => summary.closest(".tier-text").classList.toggle("is-open"));
      }
    }

    // Workstation: GM picks the Improved Team Member (a select, so not a click action).
    for ( const partId of options.parts ) {
      this.parts[partId]?.querySelector(".workstation-member")?.addEventListener("change", event => {
        setImprovedTeamMember(this.document, event.target.value);
      });
    }

    // Only sections inside freshly rendered parts, so listeners are never attached twice.
    for ( const partId of options.parts ) {
      for ( const el of this.parts[partId]?.querySelectorAll("[data-section-id]") ?? [] ) {
        getSection(el.dataset.sectionId)?.onRender?.(el, this);
      }
    }
  }

  /* -------------------------------------------- */
  /*  Inspector                                   */
  /* -------------------------------------------- */

  /**
   * Open the inspector on a key; opening the same key again closes it.
   * @param {string|null} key
   */
  async inspect(key) {
    // An improvement with its own page (e.g. an installed Workshop) opens that page instead.
    const page = key && this._visibleSections("center").find(s => s.improvement === key);
    if ( page ) {
      this.inspecting = null;
      this.tabGroups[PAGE_GROUP] = page.id;
    }
    else this.inspecting = (key && key !== this.inspecting) ? key : null;
    if ( this.textEditing && (this.textEditing !== this.inspecting) && !page ) this.textEditing = null;
    await this.render({ parts: ["center", "inspector"] });
  }

  /** Improvement key an action targets: its detail block (inspector or facility page), else the inspector. */
  _impKey(target) {
    return target?.closest("[data-imp-key]")?.dataset.impKey ?? this.inspecting;
  }

  /* -------------------------------------------- */
  /*  Form handling                               */
  /* -------------------------------------------- */

  /**
   * Inputs named hq.* are validated through HQDataModel and stored as a diff in the module flag.
   * Everything else (e.g. name) is a normal JournalEntry field.
   * @override
   */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    if ( !data.hq ) return data;
    this.#stripUnchangedText(data.hq);
    const diff = diffHQ(this.document, data.hq);
    delete data.hq;
    if ( !foundry.utils.isEmpty(diff) ) data.flags = { [MODULE_ID]: { [HQ_FLAG]: diff } };
    return data;
  }

  /**
   * Text edit fields start filled with the current wording; store only what differs from the original,
   * so untouched fields keep following the DLC text.
   */
  #stripUnchangedText(changes) {
    for ( const [key, imp] of Object.entries(changes.improvements ?? {}) ) {
      const o = imp?.override;
      const original = o && getDefinition(this.hq, key)?.original;
      if ( !original ) continue;
      if ( o.name?.trim() === original.name ) o.name = "";
      if ( (o.description ?? "").trim() === (original.description ?? "") ) o.description = "";
      for ( const [i, tier] of Object.entries(o.tiers ?? {}) ) {
        const base = original.tiers[i];
        if ( !base ) continue;
        if ( tier.summary?.trim() === base.summary ) tier.summary = "";
        if ( tier.text?.trim() === base.text ) tier.text = "";
      }
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onEditImage(event, target) {
    if ( !this.isEditable ) return;
    const current = this.hq.profile.img;
    const picker = new FilePicker({
      type: "image",
      current,
      callback: path => updateHQ(this.document, { profile: { img: path } })
    });
    return picker.browse(current);
  }

  static #onOpenPage(event, target) {
    const page = this.document.pages.get(target.closest("[data-page-id]")?.dataset.pageId);
    page?.sheet.render(true);
  }

  static async #onCreatePage(event, target) {
    if ( this.document.isOwner ) return JournalEntryPage.implementation.createDialog({}, { parent: this.document });
    // Crew players don't own the HQ entry: the GM's client creates the page and gives it to them.
    const data = await pageDialog();
    if ( !data ) return;
    const page = await requestPage(this.document, data);
    page?.sheet.render(true);
  }

  static #onAwardIP() {
    return awardIPDialog(this.document);
  }

  static #onAlertAction(event, target) {
    const id = target.closest("[data-alert-id]")?.dataset.alertId;
    return runAlertAction(id, target.dataset.alertAction, this.document, this);
  }

  static #onBillMonth() {
    return billDialog(this.document);
  }

  static #onHQSettings() {
    return settingsDialog(this.document);
  }

  static #onAddLogEntry() {
    return logEntryDialog(this.document);
  }

  static async #onDeleteLogEntry(event, target) {
    if ( !game.user.isGM ) return;
    const id = target.closest("[data-log-id]")?.dataset.logId;
    const ok = await confirmDialog("CPRHQ.Activity.delete", game.i18n.localize("CPRHQ.Activity.deleteConfirm"));
    if ( ok ) await deleteLogEntry(this.document, id);
  }

  static async #onOpenCrew(event, target) {
    const actor = await fromUuid(target.closest("[data-uuid]")?.dataset.uuid);
    actor?.sheet.render(true);
  }

  static #onToggleTenant(event, target) {
    if ( !game.user.isGM ) return;
    return toggleTenant(this.document, target.closest("[data-uuid]").dataset.uuid);
  }

  static async #onEditTeamMember(event, target) {
    if ( !game.user.isGM ) return;
    const uuid = target.closest("[data-uuid]").dataset.uuid;
    const changes = await teamMemberDialog(this.document, uuid);
    if ( changes ) await updateCrewMember(this.document, uuid, changes);
  }

  static async #onRemoveCrew(event, target) {
    if ( !game.user.isGM ) return;
    const uuid = target.closest("[data-uuid]").dataset.uuid;
    const name = fromUuidSync(uuid)?.name ?? "";
    const ok = await confirmDialog("CPRHQ.Crew.remove", game.i18n.format("CPRHQ.Crew.removeConfirm", { name }));
    if ( ok ) await removeCrew(this.document, uuid);
  }

  static #onCreateCustom() {
    return customImprovementDialog(this.document);
  }

  static #onEditCustom(event, target) {
    const key = this._impKey(target);
    const existing = this.hq.custom.find(c => c.key === key);
    if ( existing ) return customImprovementDialog(this.document, existing);
  }

  static async #onDeleteCustom(event, target) {
    const def = getDefinition(this.hq, this._impKey(target));
    if ( !def?.custom ) return;
    const ok = await confirmDialog("CPRHQ.Custom.delete", game.i18n.format("CPRHQ.Custom.deleteConfirm", { name: def.name }));
    if ( ok ) await deleteCustomImprovement(this.document, def.key);
  }

  static async #onAdvanceImprovement(event, target) {
    const key = this._impKey(target);
    const hq = this.hq;
    let extra = {};
    // First Rent Reduction purchase: the GM sets the reduced rent (no Real Estate categories here).
    if ( (key === "rentReduction") && !hq.rankOf(key) ) {
      const reducedRent = await reducedRentDialog(hq.housing.rent);
      if ( reducedRent === null ) return;
      extra = { housing: { reducedRent } };
    }
    const firstGarage = (key === "garage") && !hq.rankOf(key);
    await advanceImprovement(this.document, key, extra);
    // A new Garage comes with the crew's Compact Groundcar.
    if ( firstGarage && this.hq.rankOf("garage") ) await stockGarage(this.document);
  }

  static async #onLoseImprovement(event, target) {
    const def = getDefinition(this.hq, this._impKey(target));
    if ( !def ) return;
    const ok = await confirmDialog("CPRHQ.Lose.button", game.i18n.format("CPRHQ.Lose.confirm", { name: def.name }));
    if ( ok ) await loseImprovement(this.document, def.key);
  }

  static async #onRefundImprovement(event, target) {
    const def = getDefinition(this.hq, this._impKey(target));
    if ( !def ) return;
    const ok = await confirmDialog("CPRHQ.Refund.button", game.i18n.format("CPRHQ.Refund.confirm", { name: def.name }));
    if ( ok ) await refundImprovement(this.document, def.key);
  }

  static async #onToggleEdit(event, target) {
    const id = target.closest("[data-section-id]")?.dataset.sectionId;
    if ( !id || !this.isEditable ) return;
    if ( this.editing.has(id) ) {
      await this._onSubmitForm(this.options.form, event);
      this.editing.delete(id);
    }
    else this.editing.add(id);
    return this.render({ parts: ["left"] });
  }

  static async #onOpenStash() {
    const uuid = this.hq.housing.stash;
    const actor = uuid ? await fromUuid(uuid) : null;
    if ( !actor ) return ui.notifications.warn("CPRHQ.Stash.missing", { localize: true });
    return actor.sheet.render(true);
  }

  static #onInspect(event, target) {
    return this.inspect(target.closest("[data-inspect]")?.dataset.inspect ?? null);
  }

  static #onCloseInspector() {
    return this.inspect(null);
  }

  /** The crew panel's lifestyle line opens the Downtime/Lifestyle tab. */
  static #onEditLifestyle() {
    this.changeTab("downtime", PAGE_GROUP);
  }

  static async #onOpenActor(event, target) {
    const actor = await fromUuid(target.closest("[data-ls-actor]")?.dataset.lsActor);
    actor?.sheet.render(true);
  }

  static #onBillLifestyle() {
    const actors = this.hq.crew.filter(m => !m.teamMember).map(m => fromUuidSync(m.uuid)).filter(a => a?.type === "character");
    return lifestyleBillDialog(lifestyleActors({ actors }));
  }

  static #onManagePresets() {
    return presetsDialog();
  }

  /** GM, crewEffects "manual": write this HQ's crew benefit effects to the sheets now. */
  static async #onSyncBenefits() {
    if ( !game.users.activeGM?.isSelf ) return ui.notifications.warn("CPRHQ.Chip.syncActiveGM", { localize: true });
    await syncHQ(this.document, { force: true });
    ui.notifications.info("CPRHQ.Chip.synced", { localize: true });
  }

  /** GM: switch an improvement's detail (inspector or facility page) between reading and editing its text. */
  static async #onToggleTextEdit(event, target) {
    if ( !game.user.isGM ) return;
    const key = this._impKey(target);
    if ( this.textEditing === key ) await this._onSubmitForm(this.options.form, event);
    this.textEditing = (this.textEditing === key) ? null : key;
    return this.render({ parts: ["center", "inspector"] });
  }

  static async #onResetText(event, target) {
    if ( !game.user.isGM ) return;
    const def = getDefinition(this.hq, this._impKey(target));
    if ( !def ) return;
    const ok = await confirmDialog("CPRHQ.TextEdit.reset", game.i18n.format("CPRHQ.TextEdit.resetConfirm", { name: def.name }));
    if ( ok ) await resetImprovementText(this.document, def.key);
  }

  static async #onOpenItem(event, target) {
    const item = await fromUuid(target.closest("[data-uuid]")?.dataset.uuid);
    item?.sheet.render(true);
  }

  static async #onRemoveVehicle(event, target) {
    if ( !game.user.isGM ) return;
    const uuid = target.closest("[data-uuid]").dataset.uuid;
    const name = fromUuidSync(uuid)?.name ?? "";
    const ok = await confirmDialog("CPRHQ.Garage.remove", game.i18n.format("CPRHQ.Garage.removeConfirm", { name }));
    if ( ok ) await removeVehicle(this.document, uuid);
  }

  static #onTryEscape(event, target) {
    return tryEscape(this.document, target.closest("[data-uuid]").dataset.uuid);
  }

  static async #onReleasePrisoner(event, target) {
    if ( !game.user.isGM ) return;
    const uuid = target.closest("[data-uuid]").dataset.uuid;
    const name = fromUuidSync(uuid)?.name ?? "";
    const ok = await confirmDialog("CPRHQ.Lockup.release", game.i18n.format("CPRHQ.Lockup.releaseConfirm", { name }));
    if ( ok ) await removePrisoner(this.document, uuid);
  }

  static async #onAddTierEffect(event, target) {
    if ( !game.user.isGM ) return;
    const key = this._impKey(target);
    const def = getDefinition(this.hq, key);
    const index = Number(target.closest("[data-tier-index]")?.dataset.tierIndex ?? 0);
    const step = improvementView(this.hq, def).ladder[index];
    await addTierEffect(this.document, key, index, `${def.name} (${step?.label ?? ""})`);
  }

  static async #onEditTierEffect(event, target) {
    const effect = await fromUuid(target.closest("[data-effect-uuid]")?.dataset.effectUuid);
    effect?.sheet.render(true);
  }

  static async #onDeleteTierEffect(event, target) {
    if ( !game.user.isGM ) return;
    const effect = await fromUuid(target.closest("[data-effect-uuid]")?.dataset.effectUuid);
    if ( !effect ) return;
    const ok = await confirmDialog("CPRHQ.Effects.delete", game.i18n.format("CPRHQ.Effects.deleteConfirm", { name: effect.name }));
    if ( ok ) await effect.delete();
  }
}
