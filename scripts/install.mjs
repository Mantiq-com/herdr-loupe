import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--app-home") throw new Error("Usage: npm run install:mod -- --app-home <Herdr app directory>");
  const appHome = path.resolve(args[1]), destination = path.join(appHome, "mods", "loupe");
  const launcher = path.join(appHome, "loupe", "launcher.json");
  for (const file of [destination, launcher]) {
    try { await fs.lstat(file); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error(`${file} already exists. Review the installed files before updating them; the installer does not overwrite them.`);
  }
  await fs.mkdir(path.join(appHome, "mods"), { recursive: true });
  await fs.mkdir(destination);
  for (const name of ["main.js", "model.js", "mod.json"]) {
    await fs.copyFile(new URL(`../mods/loupe/${name}`, import.meta.url), path.join(destination, name));
  }
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, JSON.stringify({ helper: [process.execPath, fileURLToPath(new URL("../bin/herdr-loupe.mjs", import.meta.url))] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Installed Loupe in ${destination}.`);
  console.log("Merge keys.json into your Herdr key bindings, or open a tab with mod: loupe. Keep this repository at its current location; the helper runs from here.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
