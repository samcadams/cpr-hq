export const HQ_MODES = {
  crew: "CPRHQ.Mode.crew",
  faction: "CPRHQ.Mode.faction"
};

export const HQ_STATUSES = {
  unclaimed: "CPRHQ.Status.unclaimed",
  active: "CPRHQ.Status.active",
  suspended: "CPRHQ.Status.suspended",
  destroyed: "CPRHQ.Status.destroyed"
};

/** Activity log entry types; the Activity page filters on these. */
export const LOG_TYPES = {
  award: "CPRHQ.Log.award",
  purchase: "CPRHQ.Log.purchase",
  upgrade: "CPRHQ.Log.upgrade",
  loss: "CPRHQ.Log.loss",
  status: "CPRHQ.Log.status",
  correction: "CPRHQ.Log.correction",
  crew: "CPRHQ.Log.crew",
  money: "CPRHQ.Log.money",
  facility: "CPRHQ.Log.facility",
  note: "CPRHQ.Log.note"
};

export const HQ_TENURES = {
  owned: "CPRHQ.Tenure.owned",
  rented: "CPRHQ.Tenure.rented",
  patron: "CPRHQ.Tenure.patron"
};

/**
 * Validated shape of the Headquarters data stored at flags.cpr-hq.hq on a JournalEntry.
 * Barebones for now; feature fields are added as features land, with schemaVersion bumps and migrateData steps.
 */
export default class HQDataModel extends foundry.abstract.DataModel {
  static SCHEMA_VERSION = 2;

  static defineSchema() {
    const f = foundry.data.fields;
    const count = (label, initial = 0) => new f.NumberField({
      required: true, nullable: false, integer: true, min: 0, initial, label
    });

    return {
      schemaVersion: new f.NumberField({
        required: true, nullable: false, integer: true, initial: this.SCHEMA_VERSION
      }),
      mode: new f.StringField({
        required: true, blank: false, choices: HQ_MODES, initial: "crew", label: "CPRHQ.Field.mode"
      }),
      status: new f.StringField({
        required: true, blank: false, choices: HQ_STATUSES, initial: "unclaimed", label: "CPRHQ.Field.status"
      }),
      profile: new f.SchemaField({
        img: new f.FilePathField({ categories: ["IMAGE"], blank: true, label: "CPRHQ.Field.img" }),
        location: new f.StringField({ required: true, blank: true, label: "CPRHQ.Field.location" }),
        tenure: new f.StringField({
          required: true, blank: false, choices: HQ_TENURES, initial: "rented", label: "CPRHQ.Field.tenure"
        }),
        owner: new f.StringField({ required: true, blank: true, label: "CPRHQ.Field.owner" }),
        description: new f.HTMLField({ required: true, blank: true, label: "CPRHQ.Field.description" })
      }),
      housing: new f.SchemaField({
        rent: count("CPRHQ.Field.rent"),
        reducedRent: count("CPRHQ.Field.reducedRent"),
        beds: count("CPRHQ.Field.beds", 1),
        stash: new f.StringField({ required: true, blank: true, label: "CPRHQ.Field.stash", hint: "CPRHQ.Field.stashHint" })
      }),
      ip: new f.SchemaField({
        unspent: count("CPRHQ.Field.ipUnspent"),
        earned: count("CPRHQ.Field.ipEarned")
      }),
      crew: new f.ArrayField(new f.SchemaField({
        uuid: new f.StringField({ required: true, blank: false }),
        tenant: new f.BooleanField({ required: true, initial: false }),
        teamMember: new f.BooleanField({ required: true, initial: false }),
        // uuid of the crew member (usually an Exec) this Team Member works for
        sponsor: new f.StringField({ required: true, blank: true })
      })),
      // Ranks and notes per improvement key: { [key]: { rank, notes } }. Written only through improvements.mjs.
      improvements: new f.ObjectField({ required: true }),
      custom: new f.ArrayField(new f.SchemaField({
        key: new f.StringField({ required: true, blank: false }),
        name: new f.StringField({ required: true, blank: false, label: "CPRHQ.Custom.name" }),
        icon: new f.StringField({ required: true, blank: true, initial: "fa-solid fa-star", label: "CPRHQ.Custom.icon" }),
        roles: new f.StringField({ required: true, blank: true, label: "CPRHQ.Custom.roles" }),
        description: new f.StringField({ required: true, blank: true, label: "CPRHQ.Custom.description" }),
        // One entry per rank: a short summary for cards plus the full text (newlines allowed)
        tiers: new f.ArrayField(new f.SchemaField({
          summary: new f.StringField({ required: true, blank: false }),
          text: new f.StringField({ required: true, blank: true })
        })),
        // uuid of the hidden backing Item whose Active Effects this improvement grants (see custom-effects.mjs)
        effectItem: new f.StringField({ required: true, blank: true })
      })),
      billing: new f.SchemaField({
        // Month label of the last bill sent, e.g. "March 2045"; drives the "not billed yet" alert
        lastMonth: new f.StringField({ required: true, blank: true })
      }),
      calendar: new f.SchemaField({
        // In-game seconds Simple Calendar has advanced that the GM hasn't applied or dismissed yet
        pending: new f.NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 }),
        // Simple Calendar timestamp the pending time started from; the top bar shows this date until it's applied
        since: new f.NumberField({ required: true, nullable: true, initial: null })
      }),
      // Per-improvement facility state
      facilities: new f.SchemaField({
        // Garage: vehicle Items (uuids) parked here
        garage: new f.SchemaField({
          vehicles: new f.ArrayField(new f.StringField({ required: true, blank: false }))
        }),
        // Lockup: actors held in the cell(s)
        lockup: new f.SchemaField({
          prisoners: new f.ArrayField(new f.SchemaField({
            uuid: new f.StringField({ required: true, blank: false }),
            since: new f.StringField({ required: true, blank: true })
          }))
        }),
        // Workstation: the Team Member (uuid) who becomes full crew
        workstation: new f.SchemaField({
          member: new f.StringField({ required: true, blank: true })
        })
      }),
      // Set when an Upgraded Workstation is lost: no other purchases until it is restored (DLC rule).
      workstationLock: new f.BooleanField({ required: true, initial: false }),
      log: new f.ArrayField(new f.SchemaField({
        id: new f.StringField({ required: true, blank: false }),
        time: new f.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
        date: new f.StringField({ required: true, blank: true }),
        type: new f.StringField({ required: true, blank: false, choices: LOG_TYPES, initial: "note" }),
        text: new f.StringField({ required: true, blank: true }),
        delta: new f.StringField({ required: true, blank: true }),
        user: new f.StringField({ required: true, blank: true })
      }))
    };
  }

  /** @override */
  static migrateData(source) {
    // v2: custom improvement tiers were plain strings (one line per tier).
    for ( const c of source.custom ?? [] ) {
      if ( Array.isArray(c.tiers) ) c.tiers = c.tiers.map(t => (typeof t === "string") ? { summary: t, text: "" } : t);
    }
    return super.migrateData(source);
  }

  get isFaction() {
    return this.mode === "faction";
  }

  get hasAccess() {
    return this.status === "active" || this.status === "unclaimed";
  }

  /** Current rank of an improvement (0 = not installed). */
  rankOf(key) {
    const rank = Number(this.improvements?.[key]?.rank);
    return Number.isInteger(rank) && rank > 0 ? rank : 0;
  }

  /** Rent actually charged: the reduced rent while Rent Reduction is installed. */
  get effectiveRent() {
    return this.rankOf("rentReduction") > 0 ? this.housing.reducedRent : this.housing.rent;
  }

  /** Original beds plus one per Rent Reduction Upgrade. */
  get effectiveBeds() {
    return this.housing.beds + Math.max(0, this.rankOf("rentReduction") - 1);
  }
}
