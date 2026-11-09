import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deliver } from "../mods/loupe/model.js";
import { isolatedCore, scratchDirectory, until } from "./runtime.mjs";

test("real hc transfers screenshots and sends feedback only to the selected disposable terminal", async () => {
  const directory = await scratchDirectory("core-");
  const core = await isolatedCore(directory);
  try {
    const received = path.join(directory, "received.txt");
    const target = await core.json(["run", "--bg", "--no-parent", "--no-notify", "--", process.execPath, fileURLToPath(new URL("agent.mjs", import.meta.url)), received]);
    const waited = await core.hc(["wait", target.address]);
    assert.equal(waited.code, 0, waited.stderr);
    const screenshot = path.join(directory, "selection.png");
    await fs.writeFile(screenshot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6kAAAAASUVORK5CYII=", "base64"));
    const note = { id: "delivery", revision: 1, comment: "Increase the button contrast", capture: { kind: "element", url: "https://example.com/preview", selector: "#save", viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 }, screenshot } };
    const sent = await deliver([note], target.address, core.hc);
    assert.equal(sent.length, 1);
    const text = await until(async () => {
      try { const value = await fs.readFile(received, "utf8"); return value.includes("Screenshot:") && value.includes("Increase the button contrast") ? value : null; }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }, "feedback in the disposable terminal");
    const copiedPath = text.match(/Screenshot: ([^\r\n\u001b]+)/)[1];
    assert.deepEqual(await fs.readFile(copiedPath), await fs.readFile(screenshot));
    assert.equal(text.includes("Selector: #save"), true);
  } finally {
    await core.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("helper CLI saves its final draft and closes its browser through the same hc lifecycle as the mod", async () => {
  const directory = await scratchDirectory("life-");
  const core = await isolatedCore(directory);
  try {
    const appHome = path.join(directory, "app"), session = randomUUID();
    const cli = fileURLToPath(new URL("../bin/herdr-loupe.mjs", import.meta.url));
    const common = ["--app-home", appHome, "--session", session, "--view", session, "--folder", directory];
    const terminal = await core.json(["run", "--bg", "--no-parent", "--no-notify", "--", process.execPath, cli, ...common]);
    const connection = await until(async () => {
      try { const failed = JSON.parse(await fs.readFile(path.join(appHome, "loupe", "sessions", session, "error.json"), "utf8")); throw new Error(failed.error); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      try { return JSON.parse(await fs.readFile(path.join(appHome, "loupe", "sessions", session, "connection.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }, "the helper connection");
    const response = await fetch(connection.endpoint + "/frame", { method: "POST", headers: { Authorization: `Bearer ${connection.token}` }, body: "{}" });
    assert.equal(response.status, 200);
    const draft = { version: 1, notes: [], pending: null, comment: "Unfinished review", url: "https://example.com" };
    const closed = await core.run(process.execPath, [cli, "--close", ...common, "--draft", JSON.stringify(draft)]);
    assert.equal(closed.code, 0, closed.stderr);
    await until(async () => (await core.json(["get", terminal.address])).state === "finished", "helper termination");
    const files = await fs.readdir(path.join(appHome, "loupe", "drafts"));
    assert.equal(JSON.parse(await fs.readFile(path.join(appHome, "loupe", "drafts", files[0]), "utf8")).comment, draft.comment);
    await assert.rejects(fs.stat(path.join(appHome, "mods", "loupe-media", session)), { code: "ENOENT" });
  } finally {
    await core.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
