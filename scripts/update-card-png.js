#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { embedCharacterCardJsonInPng } from "../src/utils/png.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/update-card-png.js <name> [--dir card-makefiles] [--out <card.png>] [--no-legacy-chara]",
    "  node scripts/update-card-png.js --png <card.png> --json <card.json> [--out <card.png>] [--no-legacy-chara]",
    "",
    "Examples:",
    "  npm run card:update -- SarahMiller",
    "  npm run card:update-png -- --png card.png --json card-makefiles/SarahMiller.json",
    "",
    "Embeds JSON into the PNG Character Card V3 ccv3 tEXt chunk.",
    "By default it also writes legacy chara for older importers.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--no-legacy-chara") {
      out.legacyChara = false;
      continue;
    }
    if (!item.startsWith("--")) {
      out.positional.push(item);
      continue;
    }
    const key = item.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args.positional[0];
  const baseDir = path.resolve(args.dir || "card-makefiles");
  if (name && !args.png && !args.json) {
    args.png = path.join(baseDir, `${name}.png`);
    args.json = path.join(baseDir, `${name}.json`);
  }
  if (!args.png || !args.json) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const pngPath = path.resolve(args.png);
  const jsonPath = path.resolve(args.json);
  const outPath = path.resolve(args.out || args.png);
  const card = JSON.parse(await readFile(jsonPath, "utf8"));
  const png = await readFile(pngPath);
  const updated = embedCharacterCardJsonInPng(png, card, {
    legacyChara: args.legacyChara !== false,
  });
  await writeFile(outPath, updated);
  console.log(`Updated ${outPath}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
