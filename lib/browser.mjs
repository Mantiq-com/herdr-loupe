import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

async function chromiumExecutable() {
  if (process.env.LOUPE_CHROMIUM) {
    await fs.access(process.env.LOUPE_CHROMIUM, constants.X_OK);
    return process.env.LOUPE_CHROMIUM;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, constants.X_OK);
        return candidate;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
      }
    }
  }
  throw new Error("Chromium was not found. Install it through your system package manager or set LOUPE_CHROMIUM to its executable.");
}

export async function targetUrl(input, folder) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Enter a URL or an HTML file path.");
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return new URL(value).href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("file:")) throw new Error("Open an HTTP(S) URL or a local HTML file.");
  const file = new URL(value, pathToFileURL(`${path.resolve(folder)}${path.sep}`));
  if (!/\.html?$/i.test(file.pathname)) throw new Error("Local previews must be HTML files (.html or .htm).");
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error("The selected path is not an HTML file.");
  return file.href;
}

export async function atomicJson(file, data) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function viewportSize(value) {
  if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || value.width < 200 || value.height < 160 || value.width > 3840 || value.height > 2160) {
    throw new Error("The preview viewport must be between 200 × 160 and 3840 × 2160 pixels.");
  }
  return { width: value.width, height: value.height };
}

function point(value, viewport) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)
    || value.x < 0 || value.y < 0 || value.x >= viewport.width || value.y >= viewport.height) {
    throw new Error("Select a point inside the preview.");
  }
  return { x: value.x, y: value.y };
}

function elementAt({ x, y }) {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const child = element.shadowRoot.elementFromPoint(x, y);
    if (!child || child === element) break;
    element = child;
  }
  if (!element) return null;
  const parts = [];
  for (let node = element; node instanceof Element; node = node.parentElement) {
    if (node.id && node.getRootNode().querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.localName === node.localName) : [];
    parts.unshift(node.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ""));
  }
  const box = element.getBoundingClientRect(), computed = getComputedStyle(element);
  const styles = {};
  for (const property of ["color", "background-color", "font-family", "font-size", "font-weight", "line-height", "display", "position", "padding", "margin", "border", "border-radius", "gap", "width", "height"]) styles[property] = computed.getPropertyValue(property);
  return {
    selector: parts.join(" > "), tag: element.localName,
    text: (element.innerText ?? element.textContent ?? "").slice(0, 400),
    html: element.outerHTML.slice(0, 4000), styles,
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    shadow: element.getRootNode() instanceof ShadowRoot,
  };
}

export class PreviewBrowser {
  static async open({ appHome, view, folder = process.cwd() }) {
    const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true, chromiumSandbox: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(15000);
      const preview = new PreviewBrowser(browser, context, page, appHome, view, folder);
      await fs.mkdir(preview.frameDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(preview.captureDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(preview.draftFile), { recursive: true, mode: 0o700 });
      return preview;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  constructor(browser, context, page, appHome, view, folder) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.appHome = appHome;
    this.folder = folder;
    this.frameDirectory = path.join(appHome, "mods", "loupe-media", view);
    this.captureDirectory = path.join(appHome, "loupe", "captures");
    const workspace = createHash("sha256").update(folder).digest("hex").slice(0, 24);
    this.draftFile = path.join(appHome, "loupe", "drafts", `${workspace}.json`);
    this.framePath = path.join(this.frameDirectory, "viewport.png");
    this.frameHash = null;
    this.frameId = 0;
    this.navigationError = null;
    this.closed = false;
    this.page.on("dialog", (dialog) => dialog.dismiss().catch((error) => { this.navigationError = error.message; }));
    this.context.on("page", (popup) => {
      if (popup === this.page) return;
      popup.close().catch((error) => { this.navigationError = error.message; });
      this.navigationError = "This page opened a new window. Open its destination in Loupe’s address bar instead.";
    });
  }

  async state() {
    return {
      url: this.page.url(), title: await this.page.title(), viewport: this.page.viewportSize(),
      scroll: await this.page.evaluate(() => ({ x: scrollX, y: scrollY })),
      error: this.navigationError,
    };
  }

  async frame(viewport) {
    if (viewport) {
      const size = viewportSize(viewport);
      if (JSON.stringify(size) !== JSON.stringify(this.page.viewportSize())) await this.page.setViewportSize(size);
    }
    const bytes = await this.page.screenshot({ type: "png", caret: "hide" });
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== this.frameHash) {
      const temporary = path.join(this.frameDirectory, ".viewport.tmp");
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, this.framePath);
      this.frameHash = hash;
      this.frameId++;
    }
    return { ...await this.state(), frameId: this.frameId, image: path.relative(this.appHome, this.framePath) };
  }

  async inspect(input) {
    const location = point(input, this.page.viewportSize());
    return this.page.evaluate(elementAt, location);
  }

  async capture(input) {
    const state = await this.state();
    if (input.expected && (input.expected.url !== state.url
      || JSON.stringify(input.expected.viewport) !== JSON.stringify(state.viewport)
      || JSON.stringify(input.expected.scroll) !== JSON.stringify(state.scroll))) {
      throw new Error("The page moved. Refresh the preview and select the element again.");
    }
    const kind = input.kind;
    if (!["element", "region", "page"].includes(kind)) throw new Error("Choose an element, region, or page annotation.");
    const element = kind === "element" ? await this.inspect(input.point) : null;
    if (kind === "element" && !element) throw new Error("No element was found at that point.");
    let rect = kind === "element" ? element.rect : input.rect;
    if (kind !== "page") {
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error("Select a visible region.");
      const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
      const right = Math.min(state.viewport.width, rect.x + rect.width), bottom = Math.min(state.viewport.height, rect.y + rect.height);
      rect = { x: left, y: top, width: right - left, height: bottom - top };
      if (rect.width < 1 || rect.height < 1) throw new Error("The selected region is outside the viewport.");
    }
    const id = randomUUID(), screenshot = path.join(this.captureDirectory, `${id}.png`);
    const clip = kind === "page" ? undefined : rect;
    const bytes = await this.page.screenshot({ type: "png", clip, caret: "hide" });
    await fs.writeFile(screenshot, bytes, { mode: 0o600 });
    return { id, kind, url: state.url, viewport: state.viewport, scroll: state.scroll, ...element, rect: rect ?? null, screenshot, image: path.relative(this.appHome, screenshot) };
  }

  async readDraft() {
    try {
      return JSON.parse(await fs.readFile(this.draftFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, notes: [], pending: null, comment: "", url: "" };
      throw new Error(`Could not restore the draft: ${error.message}`);
    }
  }

  async saveDraft(draft) {
    if (draft?.version !== 1 || !Array.isArray(draft.notes)) throw new Error("The annotation draft has an unsupported format.");
    await atomicJson(this.draftFile, draft);
    const drafts = await fs.readdir(path.dirname(this.draftFile));
    const keep = new Set();
    for (const name of drafts.filter((name) => name.endsWith(".json"))) {
      const saved = JSON.parse(await fs.readFile(path.join(path.dirname(this.draftFile), name), "utf8"));
      for (const note of saved.notes ?? []) keep.add(path.basename(note.capture.screenshot));
      if (saved.pending) keep.add(path.basename(saved.pending.screenshot));
    }
    for (const name of await fs.readdir(this.captureDirectory)) {
      if (!/^[0-9a-f-]{36}\.png$/.test(name) || keep.has(name)) continue;
      const file = path.join(this.captureDirectory, name);
      // Another window can have a capture that has not reached its draft yet.
      if (Date.now() - (await fs.stat(file)).mtimeMs > 24 * 60 * 60 * 1000) await fs.unlink(file);
    }
    return { saved: true };
  }

  async command(input) {
    this.navigationError = null;
    switch (input.action) {
      case "navigate": await this.page.goto(await targetUrl(input.url, this.folder), { waitUntil: "domcontentloaded" }); break;
      case "back": await this.page.goBack({ waitUntil: "domcontentloaded" }); break;
      case "forward": await this.page.goForward({ waitUntil: "domcontentloaded" }); break;
      case "reload": await this.page.reload({ waitUntil: "domcontentloaded" }); break;
      case "click": {
        const location = point(input.point, this.page.viewportSize());
        await this.page.mouse.click(location.x, location.y);
        break;
      }
      case "scroll": {
        if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error("Scroll distances must be finite numbers.");
        if (input.point) { const location = point(input.point, this.page.viewportSize()); await this.page.mouse.move(location.x, location.y); }
        await this.page.mouse.wheel(input.x, input.y);
        break;
      }
      case "key":
        if (typeof input.text === "string") await this.page.keyboard.insertText(input.text);
        else if (typeof input.key === "string") await this.page.keyboard.press(input.key);
        else throw new Error("A keyboard event needs text or a key.");
        break;
      default: throw new Error("Unknown browser command.");
    }
    return this.state();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.context.close(); } finally { await this.browser.close(); }
  }
}
