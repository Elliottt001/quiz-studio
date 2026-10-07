import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function buildAssets(source, output) {
  mkdirSync(output, { recursive: true });
  cpSync(source, output, { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAssets(resolve("public"), resolve("dist"));
  console.log("Built local browser assets in dist/");
}
