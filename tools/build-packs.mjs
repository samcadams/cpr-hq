// Builds each compendium in packs/ from its JSON source in packs/_source/<name>.
import { readdirSync } from "node:fs";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

for (const name of readdirSync("packs/_source")) {
  await compilePack(`packs/_source/${name}`, `packs/${name}`, { log: true });
}
