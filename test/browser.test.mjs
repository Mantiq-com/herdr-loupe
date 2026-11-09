import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { startService } from "../lib/server.mjs";
import { targetUrl } from "../lib/browser.mjs";
import { scratchDirectory, until } from "./runtime.mjs";

test("real Chromium preview, annotations, drafts, API boundaries and cleanup", async (t) => {
  const directory = await scratchDirectory("browser-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const appHome = path.join(directory, "app"), session = randomUUID();
  await fs.copyFile(new URL("preview.html", import.meta.url), path.join(directory, "preview.html"));
  await fs.copyFile(new URL("preview.css", import.meta.url), path.join(directory, "preview.css"));
  const service = await startService({ appHome, session, view: session, folder: directory });
  t.after(() => service.close());
  const call = async (endpoint, body = {}) => {
    const response = await fetch(service.descriptor.endpoint + endpoint, { method: "POST", headers: { Authorization: `Bearer ${service.descriptor.token}` }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  const page = service.preview.page;

  await t.test("opens HTML with relative styles and HTTP URLs", async () => {
    await call("/command", { action: "navigate", url: "preview.html" });
    assert.equal(await page.locator("body").evaluate((body) => getComputedStyle(body).marginTop), "0px");
    const server = http.createServer((_, response) => { response.end("<title>HTTP preview</title><button>HTTP button</button>"); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = `http://127.0.0.1:${server.address().port}`;
      await call("/command", { action: "navigate", url: address });
      assert.equal(await page.title(), "HTTP preview");
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await assert.rejects(targetUrl("javascript:alert(1)", directory), /HTTP/);
    await assert.rejects(targetUrl("preview.css", directory), /HTML/);
    await call("/command", { action: "navigate", url: "preview.html" });
  });

  await t.test("inspection and capture do not activate elements", async () => {
    const bounds = await page.locator("#count").boundingBox();
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const inspected = await call("/inspect", { point });
    assert.equal(inspected.selector, "#count");
    assert.ok(inspected.html.includes("button"));
    assert.ok(inspected.styles["background-color"]);
    const state = await call("/frame", { viewport: { width: 800, height: 600 } });
    const capture = await call("/capture", { kind: "element", point, expected: state });
    assert.equal(await page.locator("#count").textContent(), "0");
    assert.equal(capture.selector, "#count");
    const image = await fs.readFile(capture.screenshot);
    assert.ok(image.readUInt32BE(16) > 0);
    await call("/command", { action: "click", point });
    assert.equal(await page.locator("#count").textContent(), "1");
  });

  await t.test("forwards form input, navigation, history and reload", async () => {
    const box = await page.locator("#name").boundingBox();
    await call("/command", { action: "click", point: { x: box.x + 8, y: box.y + 8 } });
    await call("/command", { action: "key", text: "Alice Smith" });
    assert.equal(await page.locator("#name").inputValue(), "Alice Smith");
    await call("/command", { action: "navigate", url: "preview.html?second" });
    await call("/command", { action: "back" });
    assert.ok(!page.url().includes("?second"));
    await call("/command", { action: "forward" });
    assert.ok(page.url().includes("?second"));
    await call("/command", { action: "reload" });
    assert.equal(await page.locator("#count").textContent(), "0");
  });

  await t.test("scroll capture selects visible pixels and rejects a moved viewport", async () => {
    await page.locator("#below").scrollIntoViewIfNeeded();
    const state = await call("/frame");
    assert.ok(state.scroll.y > 0);
    const box = await page.locator("#below").boundingBox();
    const captured = await call("/capture", { kind: "element", point: { x: box.x + 5, y: box.y + 5 }, expected: state });
    assert.equal(captured.selector, "#below");
    const region = await call("/capture", { kind: "region", rect: { x: 0, y: 0, width: 80, height: 60 } });
    const bytes = await fs.readFile(region.screenshot);
    assert.equal(bytes.readUInt32BE(16), 80);
    assert.equal(bytes.readUInt32BE(20), 60);
    await call("/frame", { viewport: { width: 900, height: 650 } });
    await assert.rejects(call("/capture", { kind: "page", expected: state }), /page moved/);
    await assert.rejects(call("/inspect", { point: { x: -1, y: 0 } }), /inside/);
  });

  await t.test("repeated refreshes update one frame file rather than accumulating images", async () => {
    await call("/command", { action: "navigate", url: "preview.html" });
    const before = await call("/frame");
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const old = hash(await fs.readFile(service.preview.framePath));
    await page.locator("#changing").evaluate((element) => { element.textContent = "Content after refresh"; });
    const after = await call("/frame");
    assert.equal(before.image, after.image);
    assert.ok(after.frameId > before.frameId);
    assert.notEqual(hash(await fs.readFile(service.preview.framePath)), old);
    for (let i = 0; i < 5; i++) await call("/frame");
    assert.deepEqual(await fs.readdir(service.preview.frameDirectory), ["viewport.png"]);
  });

  await t.test("saved comments and unsaved editor content survive restarting the helper", async () => {
    const capture = await call("/capture", { kind: "page" });
    const draft = { version: 1, notes: [{ id: capture.id, revision: 1, capture, comment: "Review spacing" }], pending: capture, comment: "Unfinished comment — café", url: page.url() };
    await call("/draft/save", draft);
    assert.deepEqual(await call("/draft/read"), draft);
    const permissions = (await fs.stat(path.join(appHome, "loupe", "sessions", session, "connection.json"))).mode & 0o777;
    assert.equal(permissions, 0o600);
    await service.close();
    const replacement = await startService({ appHome, session: randomUUID(), view: randomUUID(), folder: directory });
    try { assert.deepEqual(await replacement.preview.readDraft(), draft); }
    finally { await replacement.close(); }
  });

  await t.test("closed sessions remove the browser and transient frames", async () => {
    assert.equal(service.preview.browser.isConnected(), false);
    await assert.rejects(fs.stat(service.preview.frameDirectory), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(appHome, "loupe", "sessions", session)), { code: "ENOENT" });
  });
});

test("helper refuses unauthenticated and browser-origin requests", async (t) => {
  const directory = await scratchDirectory("api-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = await startService({ appHome: directory, session: randomUUID(), view: randomUUID(), folder: directory });
  t.after(() => service.close());
  for (const headers of [{}, { Authorization: `Bearer ${service.descriptor.token}`, Origin: "https://example.com" }]) {
    const response = await fetch(service.descriptor.endpoint + "/command", { method: "POST", headers, body: '{"action":"navigate","url":"https://example.com"}' });
    assert.equal(response.status, 403);
  }
  assert.equal(service.preview.page.url(), "about:blank");
});

test("disconnect keeps the last displayed pixels until the view releases them", async (t) => {
  const directory = await scratchDirectory("pixels-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = await startService({ appHome: directory, session: randomUUID(), view: randomUUID(), folder: directory });
  t.after(() => service.close());
  await service.preview.frame();
  const before = await fs.readFile(service.preview.framePath);
  const response = await fetch(service.descriptor.endpoint + "/close", { method: "POST", headers: { Authorization: `Bearer ${service.descriptor.token}` }, body: "{}" });
  assert.equal(response.status, 200);
  await until(() => !service.preview.browser.isConnected(), "browser shutdown");
  assert.deepEqual(await fs.readFile(service.preview.framePath), before);
  await service.close({ releaseFrame: true });
  await assert.rejects(fs.stat(service.preview.frameDirectory), { code: "ENOENT" });
});
