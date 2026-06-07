import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readPackageJson() {
  try {
    return require("../package.json");
  } catch {
    return {};
  }
}

const packageJson = readPackageJson();

export const PLUGIN_NAME = packageJson.name || "texting-sim";
export const PLUGIN_VERSION = packageJson.version || "0.0.0";
