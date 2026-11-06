# CPR HQ: crew headquarters for Cyberpunk RED

Crew Headquarters for Cyberpunk RED, based on the No Place Like Home DLC. Requires Foundry VTT v12,
Cyberpunk RED Core 0.92.4+ and [socketlib](https://foundryvtt.com/packages/socketlib).

## HQ sheet

GMs create an HQ with the **Create HQ** button in the Journal directory (or convert an existing
Journal Entry). The sheet tracks:

- **HQ IP**, Improvements and Upgrades from the DLC catalogue, plus custom Improvements. Each
  Improvement's description can be edited per HQ.
- **Crew**: full crew, tenants and Team Members, with the benefits each one gets. Benefits are
  written to character sheets as Active Effects (by the GM's client); NPC and faction HQs only show
  them.
- **Housing and rent**: buy or rent from the Real Estate table. Rent is split equally between the
  full crew by default (see Settings).
- **Facilities**: Lockup, Studio, Training Area, Garage, Medbay, Workstation, Workshop and the rest.

## Downtime and Lifestyle

One window for each character's downtime schedule and monthly Lifestyle bill. Drag activities from
the palette onto the days; the GM settles the round. Healing, Humanity and costs are shown for the
GM to apply. Tech work hours go to the Tech's Workshop.

The monthly "not billed yet" reminder needs [Simple Calendar](https://foundryvtt.com/packages/foundryvtt-simple-calendar).

## Tech Workshop

Opened from the **Workshop** button on Tech character sheets, or the HQ's Workshop page. Techs
propose Fabricate, Invent, Upgrade and Repair projects, and the GM approves them. Approved projects
go on the bench and use the hours from downtime Tech work (a day of work is 8 or 16 hours, a module setting). An HQ
Workshop adds bench slots. Rolls use CPR's own Role Ability roll, and the GM decides each result
with Succeed or Fail. Projects are rows you can sort and filter; click one for its details. The
Designs view lists finished inventions and fabrications, with Fabricate again to make another.

## Agent integration

With the Functional Agent module (cpr-sam-agent) active, Trauma Team plans show on the
Lifestyle cards and are charged on the Lifestyle bill.

## Settings

In Configure Settings → CPR HQ (GM only, the whole world), in setup order:

- **Edit Downtime activities** and **Edit Lifestyle presets** open the same editors as the Downtime
  window and Lifestyle & Housing.
- **Table rules** groups the rules your table may want differently. Every default is how the module
  has always worked.
  - *Upkeep*: **Gear upkeep** (Breaking Your Stuff) on or off. Off: no upkeep status on gear, no
    Gear Maintenance activity, no malfunctions. Natural-1 malfunctions and neglect only count while
    it's on.
  - *Billing*: **Bill Trauma Team and app subscriptions** on the Lifestyle bill (with the Agent
    module; off hands their billing back to the Agent), and the **rent split** the Bill month dialog
    starts with: equal, all to the first crew member, or none (you fill it in).
  - *Crew benefits*: **automatic** (benefits kept on character sheets as Active Effects), **manual**
    (a GM **Sync benefits** button on the HQ sheet) or **display only** (no effects; switching to it
    offers to remove the existing ones).
  - *Downtime*: the whole **Downtime system** (off: no planner, Past Days or settling; Lifestyle &
    Housing stay), **every hour must be planned** before submitting, the **short-sleep** hours (0 =
    no rule), the **default sleep** (e.g. `22:00-06:00`) and whether settling ticks **Fatigued**.
  - *Workshop*: the **work day** (8 or 16 h), which projects get the **halfway Maker check**
    (inventions, every project, or none), and the **Workshop roles** (comma list, default `tech`).
- **Content folder** for the full Improvement texts (below).

## Macros

The **HQ Macros** compendium has an "Open Downtime / Lifestyle" macro, and a GM-only "Update Role
Descriptions" macro that rewrites the ten core Role items (in Items and on characters) with some flavor
and a summary of the Role Ability. It only replaces descriptions that are still the system's stock
text. The Role and Role Ability names link to your Core rulebook journals when the world has Journal
Entries named "Soul and the New Machine" (a page per Role) and "Getting it Done" (pages named
"Solo: Combat Awareness" and so on); without them they stay plain text. From your own macros:

```js
const api = game.modules.get("cpr-hq").api;
api.openDowntime();       // GM: every player character. Player: your own character.
api.openWorkshop(actor);  // A Tech's Workshop window
```

Modules can add their own HQ sheet pages with `api.registerSection` (or the `cpr-hq.registerSections`
hook). Settling downtime fires `cpr-hq.downtimeSettled` and, for each HQ, `cpr-hq.applyTime`.

## Full Improvement texts

The module doesn't ship the books' text. Each Improvement tier shows a short summary, and Lifestyle
and Housing show short notes. If you own *No Place Like Home* and the Core rulebook, you can add the
full texts yourself: put a `cpr-hq.json` file in the content folder (module setting, default
`Data/cpr-sam-agent-content/`, the folder the Agent module uses for its own drop-in content) and
reload. Each tier then opens to its full text. The file has the same shape as `lang/en.json` and
holds only the strings you want to replace, for example:

```json
{ "CPRHQ": {
  "Imp": { "medbay": { "tiers": { "0": { "text": "Full text of the Medbay Improvement…" } } } },
  "Lifestyle": { "desc": { "kibble": "Full text of the Kibble Lifestyle…" } },
  "Housing": { "crammed": "…", "uncomfortableHint": "…" }
} }
```

Tier numbers start at 0 (the Improvement itself), then 1 for the first Upgrade. Any HQ's texts can also be
edited on its sheet.

## AI disclosure

This module was written with Claude (Anthropic's AI) under human direction and testing.

## Building the macro compendium

The HQ Macros compendium is built from the JSON in `packs/_source/hq-macros`; the LevelDB files in
`packs/hq-macros` are not in git. After cloning or editing a macro source, run `npm install` and
`npm run build:packs` with the world closed. `npm run release` builds `cpr-hq.zip` (with the
compendium) and its `module.json` from the committed code.

## License

Copyright (C) 2026 samcadams

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for details.

The license covers this module's code and text. Cyberpunk RED, its setting, and the names used from
it belong to R. Talsorian Games.

CPR HQ is unofficial content provided under the Homebrew Content Policy of R. Talsorian Games and is
not approved or endorsed by RTG.
