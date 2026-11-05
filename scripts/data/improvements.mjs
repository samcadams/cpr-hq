/**
 * HQ Improvement catalogue, transcribed from "No Place Like Home" (R. Talsorian Games DLC).
 *
 * Rank 0 = not installed, rank 1 = the Improvement, rank 2+ = Upgrades.
 * Tier text lives in lang/en.json under CPRHQ.Imp.<key>.tiers.<n>.{text,summary}, where n is rank - 1.
 *
 * `benefits` describe what each tier grants in a machine-readable way so the benefits engine
 * (My Benefits + managed Active Effects) can apply them later:
 *   - skill:     +value to skills for roles; situational = roll-dialog checkbox (off by default).
 *                Variant skills ("Martial Arts", "Play Instrument") match every variant the actor has.
 *   - roleAbility: +value to a role ability bonus key: the slug of the ability CPR rolls (bonuses.surgerySkill;
 *     plain bonuses.surgery is a rank CPR never rolls)
 *   - luck:      +value LUCK for the whole crew (Exec Improved Team Members included)
 *   - healing:   heal naturally as if BODY were +value higher
 *   - lifestyle: monthly Lifestyle cost change (eb)
 *   - humanity:  monthly Humanity recovery roll
 *   - beds:      +value beds
 *   - note:      narrative only; shown as text
 * `replaces` names the benefit id (from an earlier tier) that this one supersedes.
 */

export const IMPROVEMENT_COST = 40;
export const UPGRADE_COST = 40;

export const ROLES = {
  crew: "CPRHQ.Role.crew",
  exec: "CPRHQ.Role.exec",
  fixer: "CPRHQ.Role.fixer",
  lawman: "CPRHQ.Role.lawman",
  media: "CPRHQ.Role.media",
  medtech: "CPRHQ.Role.medtech",
  netrunner: "CPRHQ.Role.netrunner",
  nomad: "CPRHQ.Role.nomad",
  rockerboy: "CPRHQ.Role.rockerboy",
  solo: "CPRHQ.Role.solo",
  tech: "CPRHQ.Role.tech",
  tenants: "CPRHQ.Role.tenants"
};

const INVESTIGATION_SKILLS = ["Composition", "Criminology", "Cryptography", "Deduction", "Education", "Forgery",
  "Library Search", "Photography/Film"];
const LOUNGE_SKILLS = ["Bribery", "Bureaucracy", "Business", "Conversation", "Human Perception", "Persuasion", "Trading"];
const STUDIO_SKILLS = ["Acting", "Composition", "Play Instrument", "Paint/Draw/Sculpt", "Photography/Film"];
export const PRACTICE_SKILLS = ["Athletics", "Archery", "Autofire", "Brawling", "Evasion", "Handgun", "Heavy Weapons",
  "Martial Arts", "Melee Weapon", "Shoulder Arms"];

/** @type {Record<string, object>} */
export const CATALOGUE = {
  evidenceWall: {
    icon: "fa-solid fa-magnifying-glass",
    maxRank: 2,
    roles: ["lawman", "media"],
    benefits: [
      [{ id: "investigate", type: "skill", roles: ["lawman", "media"], skills: INVESTIGATION_SKILLS, value: 2, situational: true }],
      [{ id: "investigateLawman", type: "skill", roles: ["lawman"], skills: INVESTIGATION_SKILLS, value: 3, situational: true, replaces: "investigate" },
        { id: "investigateMedia", type: "skill", roles: ["media"], skills: INVESTIGATION_SKILLS, value: 2, situational: true },
        { id: "credibility", type: "note", roles: ["media"] }]
    ]
  },
  garage: {
    icon: "fa-solid fa-car",
    maxRank: 2,
    roles: ["crew", "nomad"],
    benefits: [
      [{ id: "car", type: "note", roles: ["crew"] }],
      [{ id: "respec", type: "note", roles: ["nomad"] }]
    ]
  },
  lockup: {
    icon: "fa-solid fa-lock",
    maxRank: 2,
    roles: ["crew", "lawman"],
    benefits: [
      [{ id: "cell", type: "note", roles: ["crew"] }],
      [{ id: "interrogation", type: "skill", roles: ["lawman"], skills: ["Interrogation"], value: 2, situational: true }]
    ]
  },
  lounge: {
    icon: "fa-solid fa-couch",
    maxRank: 2,
    roles: ["fixer", "media"],
    benefits: [
      [{ id: "meetings", type: "skill", roles: ["fixer"], skills: LOUNGE_SKILLS, value: 2, situational: true }],
      [{ id: "setup", type: "note", roles: ["fixer", "media"] }]
    ]
  },
  medbay: {
    icon: "fa-solid fa-kit-medical",
    maxRank: 2,
    roles: ["crew", "medtech"],
    benefits: [
      [{ id: "healing", type: "healing", roles: ["crew"], value: 2 },
        { id: "medicine", type: "skill", roles: ["medtech"], skills: ["First Aid", "Paramedic"], value: 2, situational: true },
        // Surgery is a Medtech Role Ability in CPR, not a skill; the sheet rolls "Surgery Skill" (bonuses.surgerySkill)
        { id: "surgery", type: "roleAbility", roles: ["medtech"], key: "bonuses.surgerySkill", label: "Surgery", value: 2, situational: true }],
      [{ id: "drugs", type: "note", roles: ["medtech"] }]
    ]
  },
  moraleBoost: {
    icon: "fa-solid fa-face-smile",
    maxRank: 11,
    roles: ["crew"],
    benefits: [
      [{ id: "lifestyle", type: "lifestyle", roles: ["crew"], value: -50 }],
      [{ id: "humanity", type: "humanity", roles: ["crew"], formula: "floor(1d6/2)" }],
      [{ id: "healing", type: "healing", roles: ["crew"], value: 1 }],
      [{ id: "luck1", type: "luck", roles: ["crew"], value: 1 }],
      [{ id: "humanity2", type: "humanity", roles: ["crew"], formula: "1d6", replaces: "humanity" }],
      // Fixers: +2 Trading when negotiating pay (roll-dialog option); everyone else haggles as Operator 5
      [{ id: "trading", type: "skill", roles: ["fixer"], skills: ["Trading"], value: 2, situational: true },
        { id: "haggle", type: "note", roles: ["crew"] }],
      [{ id: "hustle", type: "note", roles: ["crew"] }],
      [{ id: "luck2", type: "luck", roles: ["crew"], value: 1 }],
      [{ id: "hustle2", type: "note", roles: ["crew"], replaces: "hustle" }],
      [{ id: "humanity3", type: "humanity", roles: ["crew"], formula: "2d6kh", replaces: "humanity2" }],
      [{ id: "custom", type: "note", roles: ["crew"] }]
    ]
  },
  rentReduction: {
    icon: "fa-solid fa-percent",
    // Upgrades add a bed each, up to double the original beds; see maxRankFor().
    maxRank: null,
    roles: ["tenants"],
    requiresRent: true,
    benefits: [
      [{ id: "rent", type: "note", roles: ["tenants"] }],
      [{ id: "bed", type: "beds", roles: ["tenants"], value: 1 }]
    ]
  },
  serverRoom: {
    icon: "fa-solid fa-server",
    maxRank: 2,
    roles: ["crew", "netrunner"],
    benefits: [
      [{ id: "netArch", type: "note", roles: ["crew"] }],
      [{ id: "maker", type: "note", roles: ["netrunner"] }]
    ]
  },
  studio: {
    icon: "fa-solid fa-microphone",
    maxRank: 2,
    roles: ["rockerboy"],
    benefits: [
      [{ id: "art", type: "skill", roles: ["rockerboy"], skills: STUDIO_SKILLS, value: 2, situational: true }],
      [{ id: "refine", type: "note", roles: ["rockerboy"] }]
    ]
  },
  trainingArea: {
    icon: "fa-solid fa-bullseye",
    maxRank: 2,
    roles: ["crew", "solo"],
    benefits: [
      [{ id: "practice", type: "note", roles: ["crew"] }],
      [{ id: "practice2", type: "note", roles: ["solo"] }]
    ]
  },
  workshop: {
    icon: "fa-solid fa-screwdriver-wrench",
    maxRank: 2,
    roles: ["tech"],
    benefits: [
      [{ id: "second", type: "note", roles: ["tech"] }],
      [{ id: "third", type: "note", roles: ["tech"] }]
    ]
  },
  workstation: {
    icon: "fa-solid fa-desktop",
    maxRank: 2,
    roles: ["exec"],
    benefits: [
      [{ id: "teamMember", type: "note", roles: ["exec"] }],
      [{ id: "loyal", type: "note", roles: ["exec"] }]
    ]
  }
};

/** Max rank for an improvement on a given HQ. Rent Reduction: 1 + original beds (doubling cap). */
export function maxRankFor(key, def, hq) {
  if ( key === "rentReduction" ) return 1 + Math.max(0, hq.housing.beds);
  return def.maxRank ?? 2;
}
