#!/usr/bin/env node
import path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { startService } from "../lib/server.mjs";
import { atomicJson } from "../lib/browser.mjs";

const options = {};
let closing = false;
try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: herdr-loupe [--close] --app-home <directory> --session <uuid> --view <uuid> --folder <directory> [--draft <json>]\n\nLOUPE_CHROMIUM selects a system Chromium executable. The Herdr mod starts and stops this helper.");
  } else {
    closing = args.includes("--close");
    if (closing) args.splice(args.indexOf("--close"), 1);
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!["--app-home", "--session", "--view", "--folder", "--draft"].includes(flag) || !value) throw new Error("Use --help for Loupe’s helper arguments.");
      options[flag.slice(2)] = value;
    }
    if (closing) {
      if (!options["app-home"] || !path.isAbsolute(options["app-home"]) || !/^[a-f0-9-]{36}$/.test(options.session ?? "") || !/^[a-f0-9-]{36}$/.test(options.view ?? "") || !options.folder) throw new Error("Closing Loupe requires its app home, session and view UUIDs, and folder.");
      if (options.draft) {
        const workspace = createHash("sha256").update(options.folder).digest("hex").slice(0, 24);
        const draft = JSON.parse(options.draft);
        if (draft.version !== 1 || !Array.isArray(draft.notes)) throw new Error("The annotation draft has an unsupported format.");
        await fs.mkdir(path.join(options["app-home"], "loupe", "drafts"), { recursive: true, mode: 0o700 });
        await atomicJson(path.join(options["app-home"], "loupe", "drafts", `${workspace}.json`), draft);
      }
      let descriptor;
      try { descriptor = JSON.parse(await fs.readFile(path.join(options["app-home"], "loupe", "sessions", options.session, "connection.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      try {
        if (descriptor) {
          const response = await fetch(descriptor.endpoint + "/close", { method: "POST", headers: { Authorization: `Bearer ${descriptor.token}` }, body: '{"releaseFrame":true}', signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error((await response.json()).error);
        }
      } finally {
        await fs.rm(path.join(options["app-home"], "mods", "loupe-media", options.view), { recursive: true, force: true });
      }
    } else {
      const service = await startService({ appHome: options["app-home"], session: options.session, view: options.view, folder: options.folder });
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => {
        service.close({ releaseFrame: false }).catch((error) => { console.error(`Loupe cleanup failed: ${error.message}`); process.exitCode = 1; });
      });
      console.log("Loupe browser ready.");
    }
  }
} catch (error) {
  if (!closing && options["app-home"] && path.isAbsolute(options["app-home"]) && /^[a-f0-9-]{36}$/.test(options.session ?? "")) {
    const directory = path.join(options["app-home"], "loupe", "sessions", options.session);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(directory, "error.json"), { error: error.message });
  }
  console.error(`Loupe could not ${closing ? "close" : "start"}: ${error.message}`);
  process.exitCode = 1;
}
