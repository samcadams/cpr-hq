import { isHQ, getHQ, updateHQ } from "./hq.mjs";
import { healingBonus, lifestyleModifier, isFullCrew, improvedTeamMember } from "./benefits.mjs";
import { pruneFacilities } from "./facilities.mjs";
import { formatNumber } from "./utils.mjs";

/** Actor types that can be crew. Containers are stashes, not people. */
export const CREW_TYPES = ["character", "mook"];

/** The Role text shown under the name on the character sheet, as written there. */
function roleLabel(actor) {
  return String(actor.system.roleInfo?.activeRole ?? "").trim();
}

/** Non-GM users who own the actor, for the "played by" line. */
function players(actor) {
  return game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.name);
}

/**
 * Display data for every crew member. Missing actors are kept (so the GM can remove them) but flagged.
 */
export function crewViews(hq) {
  const heal = healingBonus(hq);
  const lifestyleMod = lifestyleModifier(hq);
  const byUuid = new Map(hq.crew.map(m => [m.uuid, fromUuidSync(m.uuid)]));
  const improved = improvedTeamMember(hq);

  // Deleted actors are pruned by the deleteActor hook; skip any that slip through.
  return hq.crew.filter(member => byUuid.get(member.uuid)).map(member => {
    const actor = byUuid.get(member.uuid);
    const body = actor.system.stats?.body?.value ?? 0;
    const lifestyle = actor.system.lifestyle?.lifeStyle;
    const sponsor = member.sponsor ? byUuid.get(member.sponsor) : null;
    const owners = players(actor);
    return {
      ...member,
      name: actor.name,
      img: actor.img,
      role: member.teamMember
        ? game.i18n.format((member.uuid === improved) ? "CPRHQ.Crew.improvedOf" : "CPRHQ.Crew.teamMemberOf", { name: sponsor?.name ?? "—" })
        : roleLabel(actor),
      improved: member.uuid === improved,
      player: owners.join(", ") || game.i18n.localize("CPRHQ.Crew.npc"),
      // Only worth showing when an HQ improvement changes natural healing.
      // Team Members aren't full crew, so HQ benefits (healing included) don't reach them.
      healsAs: (heal && isFullCrew(hq, member)) ? body + heal : null,
      healTooltip: (heal && isFullCrew(hq, member)) ? game.i18n.format("CPRHQ.Crew.healsTip", { body, bonus: heal }) : null,
      lifestyle: lifestyle ? {
        description: lifestyle.description?.replace(/<[^>]*>/g, "").trim() || "—",
        cost: formatNumber(Math.max(0, lifestyle.cost + lifestyleMod)),
        baseCost: lifestyleMod ? formatNumber(lifestyle.cost) : null
      } : null,
      // CPR's sheet has no Lifestyle control, so the crew panel edits it (GM or owner).
      canEditLifestyle: !!lifestyle && actor.isOwner,
      isViewer: game.user.character?.uuid === member.uuid,
      canView: actor.testUserPermission(game.user, "LIMITED")
    };
  });
}

/* -------------------------------------------- */
/*  Mutations (GM)                              */
/* -------------------------------------------- */

function crewSource(entry) {
  return getHQ(entry).toObject().crew;
}

/** Add an actor to the crew. Ignores duplicates and non-crew actor types. */
export async function addCrew(entry, actor) {
  if ( !CREW_TYPES.includes(actor?.type) ) {
    return ui.notifications.warn("CPRHQ.Crew.wrongType", { localize: true });
  }
  const crew = crewSource(entry);
  if ( crew.some(m => m.uuid === actor.uuid) ) return;
  crew.push({ uuid: actor.uuid, tenant: false, teamMember: actor.type === "mook", sponsor: "" });
  await updateHQ(entry, { crew }, {
    log: { type: "crew", text: game.i18n.format("CPRHQ.Crew.logJoin", { name: actor.name }) }
  });
}

export async function removeCrew(entry, uuid, { name } = {}) {
  const crew = crewSource(entry);
  const member = crew.find(m => m.uuid === uuid);
  if ( !member ) return;
  name ??= fromUuidSync(uuid)?.name ?? "";
  // Anyone this member sponsored loses their sponsor.
  const next = crew.filter(m => m.uuid !== uuid).map(m => m.sponsor === uuid ? { ...m, sponsor: "" } : m);
  const changes = { crew: next };
  // A departing Improved Team Member frees the Workstation slot.
  if ( getHQ(entry).facilities.workstation.member === uuid ) changes.facilities = { workstation: { member: "" } };
  await updateHQ(entry, changes, {
    log: { type: "crew", text: game.i18n.format("CPRHQ.Crew.logLeave", { name }) }
  });
}

/** Patch one crew member's flags. */
export async function updateCrewMember(entry, uuid, changes) {
  const crew = crewSource(entry).map(m => m.uuid === uuid ? { ...m, ...changes } : m);
  await updateHQ(entry, { crew });
}

/** Toggle tenancy, warning (not blocking) when tenants would exceed the HQ's beds. */
export async function toggleTenant(entry, uuid) {
  const hq = getHQ(entry);
  const member = hq.crew.find(m => m.uuid === uuid);
  if ( !member ) return;
  if ( !member.tenant ) {
    const tenants = hq.crew.filter(m => m.tenant).length;
    if ( tenants >= hq.effectiveBeds ) {
      ui.notifications.warn(game.i18n.format("CPRHQ.Crew.overBeds", { beds: hq.effectiveBeds }));
    }
  }
  await updateCrewMember(entry, uuid, { tenant: !member.tenant });
}

/**
 * A deleted actor leaves every HQ crew it was in, and stops being any HQ's stash.
 * Runs on the active GM only, so it happens once.
 */
export async function pruneDeletedActor(actor) {
  if ( !game.users.activeGM?.isSelf ) return;
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) ) continue;
    const hq = getHQ(entry);
    if ( hq.crew.some(m => m.uuid === actor.uuid) ) await removeCrew(entry, actor.uuid, { name: actor.name });
    if ( hq.housing.stash === actor.uuid ) await updateHQ(entry, { housing: { stash: "" } });
    await pruneFacilities(entry, actor.uuid);
  }
}

/** A deleted vehicle Item leaves every Garage it was parked in (active GM). */
export async function pruneDeletedItem(item) {
  if ( !game.users.activeGM?.isSelf || (item.type !== "vehicle") ) return;
  for ( const entry of game.journal ) {
    if ( isHQ(entry) && getHQ(entry).facilities.garage.vehicles.includes(item.uuid) ) await pruneFacilities(entry, item.uuid);
  }
}
