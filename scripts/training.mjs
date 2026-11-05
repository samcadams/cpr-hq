import { MODULE_ID } from "./constants.mjs";
import { isHQ, getHQ } from "./hq.mjs";
import { actorRoles, isFullCrew } from "./benefits.mjs";
import { skillKeys } from "./effects.mjs";

/**
 * Training Area Practice (NPLH p. 6): a settled Training block gives +1 on the chosen skill until the crew next gets
 * Group IP (Award HQ IP for that crew, or the GM's "Mission IP received" button for everyone) or the character Practices
 * again. Upgraded: Solos Practice two.
 *
 * Storage: flags.cpr-hq.practice {skills, since} on the actor, plus one Active Effect flagged flags.cpr-hq.practice.
 * That effect has no flags.cpr-hq.hq, so syncHQ (effects.mjs) leaves it alone.
 * Without a Training Area the block stays a plain activity and the GMs get a whisper.
 */

const FLAG = "practice";
const SYSTEM_ID = "cyberpunk-red-core";
const TRAINING = "training";

/**
 * The best Training Area this character can use: full crew of an accessible HQ with one installed.
 * Faction HQs never auto-apply effects.
 * @returns {{entry: JournalEntry, rank: number}|null}
 */
function trainingAccess(actor) {
  let best = null;
  for ( const entry of game.journal ) {
    if ( !isHQ(entry) ) continue;
    const hq = getHQ(entry);
    const rank = hq.rankOf("trainingArea");
    if ( !rank || !hq.hasAccess || hq.isFaction ) continue;
    if ( !isFullCrew(hq, hq.crew.find(m => m.uuid === actor.uuid)) ) continue;
    if ( !best || (rank > best.rank) ) best = { entry, rank };
  }
  return best;
}

/** How many skills this character Practices at once: two for a Solo with the upgraded Training Area. */
export function practiceSlots(actor) {
  if ( !actor ) return 1;
  return ((trainingAccess(actor)?.rank >= 2) && actorRoles(actor).has("solo")) ? 2 : 1;
}

/** The skills in a Training block's detail ("Handgun, Evasion"). */
export function practiceSkills(detail) {
  return String(detail ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

function practiceEffects(actor) {
  return actor.effects.filter(e => e.getFlag(MODULE_ID, FLAG));
}

/** Replace the character's Practice with these skills. */
async function setPractice(actor, skills, since, entry) {
  const old = practiceEffects(actor).map(e => e.id);
  if ( old.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", old);
  const keys = skills.flatMap(skill => skillKeys(actor, skill));
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: game.i18n.format("CPRHQ.Training.effect", { skills: skills.join(", ") }),
    img: "icons/svg/upgrade.svg",
    origin: entry.uuid,
    disabled: false,
    changes: keys.map(key => ({ key, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "1" })),
    flags: {
      [MODULE_ID]: { [FLAG]: true },
      [SYSTEM_ID]: {
        changes: {
          cats: Object.fromEntries(keys.map((_, i) => [String(i), "skill"])),
          situational: Object.fromEntries(keys.map((_, i) => [String(i), { isSituational: false, onByDefault: false }]))
        }
      }
    }
  }]);
  await actor.setFlag(MODULE_ID, FLAG, { skills, since });
}

/** GM: the crew got Group IP; these characters' Practice ends (default: everyone). Returns how many lost one. */
export async function clearPractice(actors = game.actors) {
  let count = 0;
  for ( const actor of actors ) {
    const effects = practiceEffects(actor).map(e => e.id);
    const flagged = actor.getFlag(MODULE_ID, FLAG);
    if ( !effects.length && !flagged ) continue;
    if ( effects.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", effects);
    if ( flagged ) await actor.unsetFlag(MODULE_ID, FLAG);
    count++;
  }
  return count;
}

/** Whisper the GMs that this Training gave nothing. */
function warnNoArea(actor, skills) {
  const gms = ChatMessage.getWhisperRecipients("GM");
  if ( !gms.length ) return;
  return ChatMessage.create({
    whisper: gms.map(u => u.id),
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="cpr-hq-chat"><p><i class="fa-solid fa-triangle-exclamation"></i> ${game.i18n.format("CPRHQ.Training.noArea", {
      actor: Handlebars.escapeExpression(actor.name), skills: Handlebars.escapeExpression(skills.join(", ")) })}</p></div>`
  });
}

/** A settled round: each character's last Training with a skill chosen is their Practice. */
async function onSettled(round, actors) {
  for ( const actor of actors ) {
    const entry = (actor.getFlag(MODULE_ID, "downtimeHistory") ?? []).findLast(r => r.roundId === round.id);
    const block = (entry?.blocks ?? []).filter(b => (b.activity === TRAINING) && practiceSkills(b.detail).length)
      .sort((a, b) => a.start - b.start).at(-1);
    if ( !block ) continue;
    const skills = practiceSkills(block.detail);
    const access = trainingAccess(actor);
    if ( !access ) await warnNoArea(actor, skills);
    else await setPractice(actor, skills.slice(0, practiceSlots(actor)), entry.start + (entry.days * 86400), access.entry);
  }
}

/** Award HQ IP is the crew's Group IP: that HQ's crew stop Practicing. */
async function onAwardIP(entry) {
  const crew = getHQ(entry).crew.map(m => fromUuidSync(m.uuid)).filter(Boolean);
  const n = await clearPractice(crew);
  if ( n ) ui.notifications.info(game.i18n.format("CPRHQ.Training.cleared", { n }));
}

/** Register the hooks that start Practice (on the GM who settles) and end it (on the GM who awards). */
export function registerTrainingHooks() {
  Hooks.on(`${MODULE_ID}.downtimeSettled`, (round, actors) => onSettled(round, actors));
  Hooks.on(`${MODULE_ID}.awardIP`, entry => onAwardIP(entry));
}
