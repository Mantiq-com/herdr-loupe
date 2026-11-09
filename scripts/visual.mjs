import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import http from "node:http";
import { createHash } from "node:crypto";
import { isolatedCore, scratchDirectory, until } from "../test/runtime.mjs";

const directory = await scratchDirectory("visual-");
const core = await isolatedCore(directory);
let display, app, appLog, fixture, env;
try {
  const appHome = path.join(directory, "app"), received = path.join(directory, "received.txt");
  const installed = await core.run(process.execPath, ["scripts/install.mjs", "--app-home", appHome]);
  assert.equal(installed.code, 0, installed.stderr);
  await fs.mkdir(path.join(appHome, "layouts"), { recursive: true });
  await fs.writeFile(path.join(appHome, "shared.json"), JSON.stringify({ layout: "loupe-test", "frame.welcomed": "loupe-test" }));
  fixture = http.createServer(async (request, response) => {
    const name = request.url === "/preview.html" ? "preview.html" : request.url === "/preview.css" ? "preview.css" : null;
    if (!name) { response.writeHead(404); response.end(); return; }
    try {
      response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "text/html");
      response.end(await fs.readFile(path.resolve("test", name)));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const url = `http://127.0.0.1:${fixture.address().port}/preview.html`;
  await fs.writeFile(path.join(appHome, "layouts", "loupe-test.json"), JSON.stringify({ id: "root", type: "block", theme: "graphite", content: { mod: "loupe", props: { folder: path.resolve("test"), url } } }));
  display = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1440x960x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "inherit", "pipe"] });
  const displayNumber = (await once(display.stdio[3], "data"))[0].toString().trim();
  env = { ...core.env, DISPLAY: `:${displayNumber}`, WAYLAND_DISPLAY: "", HERDR_APP_HOME: appHome, DO_NOT_TRACK: "1", HERDR_TELEMETRY: "0" };
  appLog = await fs.open(path.join(directory, "app.log"), "w");
  app = spawn("herdr-app", [], { env, stdio: ["ignore", appLog.fd, appLog.fd] });
  const run = async (command, args) => {
    const result = await core.run(command, args, { env });
    if (result.code !== 0) throw new Error(`${command}: ${result.stderr}`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.stdout;
  };
  const imageSignature = async (file, rect = { width: 31, height: 40, x: 40, y: 228 }) => {
    const geometry = `${rect.width}x${rect.height}+${rect.x}+${rect.y}`;
    const result = await core.run("magick", [file, "-crop", geometry, "-depth", "8", "rgba:-"], { env, encoding: "buffer" });
    assert.equal(result.code, 0, result.stderr.toString());
    if (result.stderr.length) process.stderr.write(result.stderr);
    assert.equal(result.stdout.length, rect.width * rect.height * 4);
    return createHash("sha256").update(result.stdout).digest("hex");
  };
  const status = () => run("herdr-app", ["status"]).then(JSON.parse);
  await until(async () => {
    if (app.exitCode !== null) throw new Error(`Herdr exited: ${await fs.readFile(path.join(directory, "app.log"), "utf8")}`);
    const result = await core.run("herdr-app", ["status"], { env });
    return result.code === 0;
  }, "the private Herdr window", 20000);
  await run("herdr-app", ["do", "space.new", JSON.stringify({ name: "Loupe test", folder: directory,
    argv: [process.execPath, fileURLToPath(new URL("../test/agent.mjs", import.meta.url)), received] })]);
  const target = await until(async () => (await core.json(["ls"])).terminals[0], "the disposable agent");
  const ready = await core.hc(["wait", target.address]);
  assert.equal(ready.code, 0, ready.stderr);
  const tool = process.env.LOUPE_XDOTOOL || "xdotool";
  const window = (await run(tool, ["search", "--sync", "--pid", String(app.pid)])).trim().split("\n")[0];
  await run(tool, ["windowmove", window, "0", "0"]);
  await run(tool, ["windowsize", window, "1440", "960"]);
  await run(tool, ["windowfocus", window]);
  console.log(`Visual test directory: ${directory}`);
  assert.deepEqual((await status()).errors, []);
  await run("herdr-app", ["shot", path.join(directory, "initial.png")]);
  if (process.argv.includes("--inspect")) {
    console.log("Private preview ready; send a newline to close it.");
    process.stdin.resume();
    await once(process.stdin, "data");
    process.stdin.pause();
  } else {
    const footer = { width: 1000, height: 29, x: 14, y: 931 };
    const initialFooter = await imageSignature(path.join(directory, "initial.png"), footer);
    const launcherFile = path.join(appHome, "loupe", "launcher.json");
    const launcher = await fs.readFile(launcherFile, "utf8");
    const configured = JSON.parse(launcher);
    await fs.writeFile(launcherFile, JSON.stringify({ helper: ["env", `LOUPE_CHROMIUM=${path.join(directory, "missing-chromium")}`, ...configured.helper] }));
    await run(tool, ["mousemove", "--window", window, "1400", "26", "click", "1"]);
    const sessions = path.join(appHome, "loupe", "sessions");
    const failedSession = await until(async () => {
      let entries;
      try { entries = await fs.readdir(sessions); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      for (const session of entries) {
        try { const failure = JSON.parse(await fs.readFile(path.join(sessions, session, "error.json"), "utf8")); if (failure.error.includes("missing-chromium")) return session; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return null;
    }, "the missing-browser error");
    await until(async () => {
      await run("herdr-app", ["shot", path.join(directory, "startup-error.png")]);
      return await imageSignature(path.join(directory, "startup-error.png"), footer) !== initialFooter;
    }, "the startup error shown in Herdr");
    await fs.writeFile(launcherFile, launcher);
    await run(tool, ["mousemove", "--window", window, "1400", "26", "click", "1"]);
    let connection = await until(async () => {
      let entries;
      try { entries = await fs.readdir(sessions); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      for (const session of entries) {
        if (session === failedSession) continue;
        try {
          const errorFile = JSON.parse(await fs.readFile(path.join(sessions, session, "error.json"), "utf8"));
          throw new Error(errorFile.error);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        try { return { ...JSON.parse(await fs.readFile(path.join(sessions, session, "connection.json"), "utf8")), session }; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return null;
    }, "Chromium started by the pane", 20000);
    const call = async (endpoint, body = {}) => {
      const response = await fetch(connection.endpoint + endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    };
    const click = (x, y) => run(tool, ["mousemove", "--window", window, String(x), String(y), "click", "1"]);
    const editor = { width: 292, height: 70, x: 1134, y: 650 };
    let emptyEditor;
    const focusEditor = async () => {
      await until(async () => {
        await run("herdr-app", ["shot", path.join(directory, "editor.png")]);
        return await imageSignature(path.join(directory, "editor.png"), editor) !== emptyEditor;
      }, "the native comment editor shown");
      await click(1270, 680);
      await run(tool, ["key", "ctrl+a"]);
    };
    const saveComment = async (text) => {
      await focusEditor();
      await run(tool, ["type", "--clearmodifiers", text]);
      await until(async () => (await call("/draft/read")).comment === text, "the comment entered in the native editor");
      await click(1180, 785);
      return until(async () => (await call("/draft/read")).notes.find((note) => note.comment === text), "the saved annotation");
    };
    await until(async () => (await call("/inspect", { point: { x: 55, y: 153 } }))?.selector === "#count", "the loaded HTML page");
    await until(async () => {
      const media = path.join(appHome, "mods", "loupe-media");
      for (const session of await fs.readdir(media)) {
        try { return await fs.stat(path.join(media, session, "viewport.png")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return null;
    }, "the embedded preview frame");
    await run("herdr-app", ["shot", path.join(directory, "preview.png")]);
    emptyEditor = await imageSignature(path.join(directory, "preview.png"), editor);
    const beforeClick = await imageSignature(path.join(directory, "preview.png"));
    await click(55, 247);
    await until(async () => (await call("/inspect", { point: { x: 55, y: 153 } }))?.text === "1", "a browser click forwarded from the pane");
    await until(async () => {
      await run("herdr-app", ["shot", path.join(directory, "updated.png")]);
      return await imageSignature(path.join(directory, "updated.png")) !== beforeClick;
    }, "the refreshed screenshot painted by Herdr");
    await click(150, 247);
    await run(tool, ["type", "--clearmodifiers", "Alice Smith"]);
    await until(async () => (await call("/inspect", { point: { x: 120, y: 212 } }))?.text === "Alice Smith", "keyboard input forwarded to the web form");
    await click(118, 72);
    await click(55, 247);
    await until(async () => (await call("/draft/read")).pending?.selector === "#count", "an element annotation picked inside Herdr");
    await run("herdr-app", ["shot", path.join(directory, "capture.png")]);
    const saved = await saveComment("Increase the button contrast.");
    await run("herdr-app", ["shot", path.join(directory, "saved.png")]);
    assert.equal(saved.capture.selector, "#count");
    assert.equal((await call("/inspect", { point: { x: 55, y: 153 } })).text, "1");
    await click(1165, 223);
    await until(async () => (await call("/draft/read")).editing === saved.id, "the annotation editor");
    const edited = await saveComment("Improve the button contrast.");
    assert.equal(edited.revision, 2);
    await click(190, 72);
    await run(tool, ["mousemove", "--window", window, "100", "400", "mousedown", "1", "mousemove", "--window", window, "300", "500", "mouseup", "1"]);
    await until(async () => (await call("/draft/read")).pending?.kind === "region", "a region drawn inside Herdr");
    const region = await saveComment("Give this area more spacing.");
    assert.equal(Math.round(region.capture.rect.width), 200);
    assert.equal(Math.round(region.capture.rect.height), 100);
    await click(275, 72);
    await until(async () => (await call("/draft/read")).pending?.kind === "page", "a page annotation");
    await saveComment("Keep the page layout consistent.");
    await run("herdr-app", ["shot", path.join(directory, "review.png")]);
    const beforeDisconnect = await imageSignature(path.join(directory, "review.png"), footer);
    const previousSessions = new Set(await fs.readdir(sessions));
    await call("/close");
    await until(async () => {
      await run("herdr-app", ["shot", path.join(directory, "disconnected.png")]);
      return await imageSignature(path.join(directory, "disconnected.png"), footer) !== beforeDisconnect;
    }, "the lost connection shown in Herdr");
    await click(1400, 26);
    connection = await until(async () => {
      for (const session of await fs.readdir(sessions)) {
        if (previousSessions.has(session)) continue;
        try { return { ...JSON.parse(await fs.readFile(path.join(sessions, session, "connection.json"), "utf8")), session }; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return null;
    }, "the browser restarted from Open");
    await until(async () => (await call("/inspect", { point: { x: 55, y: 153 } }))?.selector === "#count", "the page restored after helper loss");
    assert.equal((await call("/draft/read")).notes.length, 3);
    await click(1280, 858);
    await click(1280, 900);
    const delivered = await until(async () => {
      try { const text = await fs.readFile(received, "utf8"); return text.includes("Keep the page layout consistent.") ? text : null; }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }, "the visual review delivered to the disposable agent");
    assert.ok(delivered.includes("Improve the button contrast."));
    assert.ok(delivered.includes("Give this area more spacing."));
    assert.ok(delivered.includes("Selector: #count"));
    await until(async () => (await call("/draft/read")).notes.length === 0, "successful delivery clearing only the sent notes");
    await run("herdr-app", ["shot", path.join(directory, "sent.png")]);
    await click(275, 72);
    await until(async () => (await call("/draft/read")).pending?.kind === "page", "an unfinished page comment");
    await focusEditor();
    await run("herdr-app", ["shot", path.join(directory, "before-final-disconnect.png")]);
    const lastFooter = await imageSignature(path.join(directory, "before-final-disconnect.png"), footer);
    await call("/close");
    await until(async () => {
      await run("herdr-app", ["shot", path.join(directory, "final-disconnect.png")]);
      return await imageSignature(path.join(directory, "final-disconnect.png"), footer) !== lastFooter;
    }, "the final disconnected state");
    await focusEditor();
    await run(tool, ["type", "--clearmodifiers", "Unfinished review after disconnect."]);
    await run("herdr-app", ["do", "layout.switch", '{"name":"main"}']);
    const finalDraft = await until(async () => {
      for (const file of await fs.readdir(path.join(appHome, "loupe", "drafts"))) {
        if (!file.endsWith(".json")) continue;
        const draft = JSON.parse(await fs.readFile(path.join(appHome, "loupe", "drafts", file), "utf8"));
        if (draft.comment === "Unfinished review after disconnect.") return draft;
      }
      return null;
    }, "the unfinished comment saved while closing a disconnected view");
    assert.equal(finalDraft.pending.kind, "page");
    assert.equal(finalDraft.notes.length, 0);
    assert.deepEqual(await fs.readdir(path.join(appHome, "mods", "loupe-media")), []);
  }
  const log = await fs.readFile(path.join(directory, "app.log"), "utf8");
  assert.doesNotMatch(log, /render failed|Embedded resource not found|Failed to load asset/);
  assert.deepEqual((await status()).errors, []);
} catch (error) {
  if (app && app.exitCode === null) {
    const captured = await core.run("herdr-app", ["shot", path.join(directory, "failure.png")], { env });
    if (captured.code !== 0) process.stderr.write(captured.stderr);
  }
  throw error;
} finally {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await once(app, "exit"); }
  if (appLog) await appLog.close();
  if (display && display.exitCode === null) { display.kill("SIGTERM"); await once(display, "exit"); }
  if (fixture) { fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve)); }
  await core.close();
}
if (!process.argv.includes("--inspect")) console.log("Native browsing, live repaint, annotations, editing, recovery, and feedback delivery passed.");
