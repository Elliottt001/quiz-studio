import { createHash } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "node_modules/nes.css");

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? filesIn(join(directory, entry.name))
      : [join(directory, entry.name)]);
}

export function buildPlatform(source = join(root, "public/platform"),
  output = join(root, "dist-platform")) {
  const font = join(source, "fonts/fusion-pixel-zh-hans.woff2");
  const ofl = join(source, "licenses/Fusion-OFL.txt");
  const nesCss = join(vendor, "css/nes.min.css");
  const nesLicense = join(vendor, "LICENSE");
  if (!existsSync(font) || readFileSync(font).subarray(0, 4).toString() !== "wOF2"
    || !existsSync(ofl) || !existsSync(nesCss) || !existsSync(nesLicense)) {
    throw new Error("缺少中文版像素字体、许可证或 NES.css");
  }
  const sourceFiles = filesIn(source).sort();
  const hash = createHash("sha256");
  for (const file of [...sourceFiles, nesCss, nesLicense]) {
    if (!statSync(file).isFile()) throw new Error(`资源不是普通文件: ${file}`);
    hash.update(relative(root, file));
    hash.update(readFileSync(file));
  }
  const version = hash.digest("hex").slice(0, 12);
  const prefix = `/platform/assets/${version}`;
  const assetRoot = join(output, "assets", version);
  mkdirSync(assetRoot, { recursive: true });
  for (const folder of ["css", "js", "fonts", "licenses"]) {
    const from = join(source, folder);
    if (existsSync(from)) cpSync(from, join(assetRoot, folder), { recursive: true });
  }
  mkdirSync(join(assetRoot, "css"), { recursive: true });
  mkdirSync(join(assetRoot, "licenses"), { recursive: true });
  copyFileSync(nesCss, join(assetRoot, "css/nes.min.css"));
  copyFileSync(nesLicense, join(assetRoot, "licenses/NES-MIT.txt"));
  for (const [name, target] of [
    ["index.html", "index.html"],
    ["organizer.html", "organizer.html"],
    ["player.html", "player.html"]
  ]) {
    const html = readFileSync(join(source, name), "utf8");
    writeFileSync(join(output, target), html.replaceAll("__ASSET_ROOT__", prefix));
  }
  writeFileSync(join(output, "assets.json"), JSON.stringify({
    version,
    theme: `${prefix}/css/theme.css`,
    layout: `${prefix}/css/layout.css`,
    nes: `${prefix}/css/nes.min.css`,
    font: `${prefix}/fonts/fusion-pixel-zh-hans.woff2`,
    licenses: [`${prefix}/licenses/NES-MIT.txt`, `${prefix}/licenses/Fusion-OFL.txt`]
  }, null, 2));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built platform assets in ${buildPlatform()}`);
}
