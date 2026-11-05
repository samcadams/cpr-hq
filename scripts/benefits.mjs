import { CATALOGUE } from "./data/improvements.mjs";
import { getDefinitions } from "./improvements.mjs";
import { crewHQsOf } from "./crew-notes.mjs";
import { getHQ } from "./hq.mjs";

const esc = value => Handlebars.escapeExpression(value ?? "");

/**
 * Benefits currently granted by an HQ's catalogue improvements: every benefit on an owned tier,
 * minus those replaced by a later owned tier. Nothing applies while access is lost or the HQ is destroyed.
 * Custom improvements carry no machine-readable benefits.
 * @returns {object[]}  Benefit specs from data/improvements.mjs, each with `source` (improvement key) and `rank`
 */
export function activeBenefits(hq) {
  if ( !hq.hasAccess ) return [];
  const result = [];
  for ( const [key, def] of Object.entries(CATALOGUE) ) {
    const rank = hq.rankOf(key);
    if ( !rank ) continue;
    // Repeatable tiers (Rent Reduction) reuse the last tier's benefits for every extra rank.
    const tiers = Array.from({ length: rank }, (_, i) => def.benefits[Math.min(i, def.benefits.length - 1)] ?? []);
    const owned = tiers.flatMap((tier, i) => tier.map(b => ({ ...b, source: key, rank: i + 1 })));
    const replaced = new Set(owned.filter(b => b.replaces).map(b => b.replaces));
    result.push(...owned.filter(b => !replaced.has(b.id)));
  }
  return result;
}

/** Total "heal as if BODY were higher" bonus for the crew (Medbay +2, Morale Boost #2 +1). */
export function healingBonus(hq) {
  return activeBenefits(hq).filter(b => b.type === "healing").reduce((sum, b) => sum + b.value, 0);
}

/** Monthly Lifestyle cost change for the crew (Morale Boost −50eb). */
export function lifestyleModifier(hq) {
  return activeBenefits(hq).filter(b => b.type === "lifestyle").reduce((sum, b) => sum + b.value, 0);
}

/* -------------------------------------------- */
/*  Per-member                                  */
/* -------------------------------------------- */

/** Lower-cased names of every Role the actor has, e.g. Set{"solo", "fixer"}. */
export function actorRoles(actor) {
  const roles = new Set((actor?.itemTypes?.role ?? []).map(r => r.name.toLowerCase()));
  const active = actor?.system.roleInfo?.activeRole;
  if ( active ) roles.add(active.toLowerCase());
  return roles;
}

/** The Team Member the Workstation makes full crew ("Improved Team Member"), as a crew uuid, or "". */
export function improvedTeamMember(hq) {
  return (hq.rankOf("workstation") > 0) ? (hq.facilities?.workstation?.member ?? "") : "";
}

/** Full crew get HQ benefits: everyone except Team Members, unless the Workstation improved them. */
export function isFullCrew(hq, member) {
  return !!member && (!member.teamMember || (member.uuid === improvedTeamMember(hq)));
}

/** Does a custom improvement's roles string ("Crew, Solo") cover this member? Blank or "Crew" = everyone. */
export function customRolesMatch(rolesString, member, actor) {
  const wanted = String(rolesString ?? "").split(",").map(r => r.trim().toLowerCase()).filter(Boolean);
  if ( !wanted.length || wanted.includes("crew") ) return true;
  if ( wanted.includes("tenants") && member.tenant ) return true;
  const roles = actorRoles(actor);
  return wanted.some(r => roles.has(r));
}

/**
 * Benefits that apply to one crew member.
 * Team Members are not full crew and get nothing, except the Workstation's Improved Team Member.
 * @param {HQDataModel} hq
 * @param {object} member  Crew entry ({uuid, tenant, teamMember})
 * @param {Actor} actor
 */
export function memberBenefits(hq, member, actor) {
  if ( !member || !actor || !isFullCrew(hq, member) ) return [];
  const roles = actorRoles(actor);
  return activeBenefits(hq).filter(b => b.roles.some(r =>
    (r === "crew") || ((r === "tenants") && member.tenant) || roles.has(r)
  ));
}

/**
 * A character's "heal as if BODY were higher" bonus (Medbay, Morale Boost) from the HQs they're full crew of.
 * Only the best HQ counts: you rest in one place.
 * @param {Actor} actor
 * @returns {{label: string, value: number}|null}  The HQ's name and its bonus
 */
export function healingOf(actor) {
  let best = null;
  for ( const entry of crewHQsOf(actor) ) {
    const hq = getHQ(entry);
    const member = hq.crew.find(m => m.uuid === actor.uuid);
    const value = memberBenefits(hq, member, actor).filter(b => b.type === "healing").reduce((sum, b) => sum + b.value, 0);
    if ( value && (!best || (value > best.value)) ) best = { label: entry.name, value };
  }
  return best;
}

/** True for benefits that go to the whole crew (as opposed to one Role, or tenants). */
export function isCrewWide(b) {
  return b.roles.includes("crew");
}

/**
 * Chips for the benefits panel. Numeric benefits of the same type are combined.
 * kind: "auto" (applied to the sheet), "roll" (roll-dialog option), "info" (rules to remember)
 * @param {object[]} benefits
 * @param {object} options
 * @param {HQDataModel} options.hq     Used for improvement names and tier text, including GM text edits
 * @param {boolean} [options.compact]  Short labels (GM overview); the full text moves to the tooltip
 */
export function benefitChips(benefits, { hq, compact = false } = {}) {
  const defs = new Map(getDefinitions(hq).map(d => [d.key, d]));
  const name = b => defs.get(b.source)?.name ?? b.source;
  const tier = b => {
    const tiers = defs.get(b.source)?.tiers ?? [];
    return tiers[Math.min(b.rank, tiers.length) - 1] ?? { summary: "", text: "" };
  };
  // Tooltip: improvement name, the tier's summary, and its full text.
  const tipFor = b => {
    const t = tier(b);
    const parts = [`<strong>${esc(name(b))}</strong>`, esc(t.summary)];
    if ( t.text && (t.text !== t.summary) ) parts.push(`<span class="tip-long">${esc(t.text)}</span>`);
    return parts.join("<br>");
  };
  const of = type => benefits.filter(b => b.type === type);
  const chips = [];
  // Chips that come only from Morale Boost wear its smiley.
  const iconFor = (list, icon) => list.every(b => b.source === "moraleBoost") ? "fa-solid fa-face-smile" : icon;

  const luck = of("luck");
  if ( luck.length ) chips.push({
    kind: "auto", icon: iconFor(luck, "fa-solid fa-clover"),
    label: game.i18n.format("CPRHQ.Chip.luck", { n: luck.reduce((s, b) => s + b.value, 0) }),
    tip: luck.map(tipFor).join("<hr>")
  });
  const heal = of("healing");
  if ( heal.length ) chips.push({
    kind: "info", icon: iconFor(heal, "fa-solid fa-heart-pulse"),
    label: game.i18n.format("CPRHQ.Chip.healing", { n: heal.reduce((s, b) => s + b.value, 0) }),
    tip: heal.map(tipFor).join("<hr>")
  });
  const lifestyle = of("lifestyle");
  if ( lifestyle.length ) chips.push({
    kind: "info", icon: iconFor(lifestyle, "fa-solid fa-utensils"),
    label: game.i18n.format("CPRHQ.Chip.lifestyle", { n: lifestyle.reduce((s, b) => s + b.value, 0) }),
    tip: `${lifestyle.map(tipFor).join("<hr>")}<br><em>${game.i18n.localize("CPRHQ.Chip.lifestyleTip")}</em>`
  });
  for ( const b of of("humanity") ) chips.push({
    kind: "info", icon: iconFor([b], "fa-solid fa-hand-holding-heart"),
    label: game.i18n.format("CPRHQ.Chip.humanity", { formula: b.formula.replace("floor(1d6/2)", "1d6/2").replace("2d6kh", "2d6 keep highest") }),
    tip: tipFor(b)
  });
  for ( const b of benefits.filter(x => (x.type === "skill") || (x.type === "roleAbility")) ) {
    const skills = b.skills ?? [b.label];
    chips.push({
      kind: b.situational ? "roll" : "auto",
      icon: iconFor([b], b.situational ? "fa-solid fa-dice-d10" : "fa-solid fa-plus"),
      label: (skills.length > 2)
        ? game.i18n.format("CPRHQ.Chip.skillGroup", { n: b.value, name: name(b) })
        : `+${b.value} ${skills.join(", ")}`,
      tip: `${tipFor(b)}<br><em>${esc(skills.join(", "))}</em>${b.situational ? `<br><em>${game.i18n.localize("CPRHQ.Chip.rollTip")}</em>` : ""}`
    });
  }
  // Rules to remember (no numbers): the player strip leaves these out.
  for ( const b of of("note") ) chips.push({
    kind: "info", note: true, icon: "fa-solid fa-circle-info",
    label: compact ? name(b) : `${name(b)}: ${tier(b).summary}`,
    tip: tipFor(b)
  });
  return chips;
}
