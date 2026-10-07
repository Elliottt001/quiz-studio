import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildPages(output = join(root, "dist-pages")) {
  mkdirSync(join(output, "brand"), { recursive: true });
  const expected = new Set([".nojekyll", "brand", "index.html"]);
  for (const entry of readdirSync(output)) {
    if (!expected.has(entry)) throw new Error(`Unexpected Pages artifact: ${entry}`);
  }
  copyFileSync(join(root, "pages", "index.html"), join(output, "index.html"));
  for (const name of ["infinity-ribbon.webp", "xlab-mark.webp"]) {
    copyFileSync(join(root, "public", "brand", name), join(output, "brand", name));
  }
  writeFileSync(join(output, ".nojekyll"), "");
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Pages static introduction built: ${buildPages()}`);
}
