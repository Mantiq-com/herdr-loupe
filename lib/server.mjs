import http from "node:http";
import path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PreviewBrowser, atomicJson } from "./browser.mjs";

export async function startService({ appHome, session, view, folder }) {
  if (!appHome || !path.isAbsolute(appHome)) throw new Error("--app-home must name an absolute directory.");
  if (!/^[a-f0-9-]{36}$/.test(session)) throw new Error("--session must be a UUID.");
  if (!/^[a-f0-9-]{36}$/.test(view)) throw new Error("--view must be a UUID.");
  const directory = path.join(appHome, "loupe", "sessions", session);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const preview = await PreviewBrowser.open({ appHome, view, folder });
  const token = randomBytes(32).toString("hex");
  let lastRequest = Date.now(), closing = false, queue = Promise.resolve(), lease, shutdown;
  const close = ({ releaseFrame = true } = {}) => {
    if (!shutdown) {
      closing = true;
      clearInterval(lease);
      server.close();
      server.closeIdleConnections();
      shutdown = (async () => {
        await queue;
        try { await preview.close(); } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      })();
    }
    return shutdown.then(async () => {
      if (releaseFrame) await fs.rm(preview.frameDirectory, { recursive: true, force: true });
    });
  };
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const server = http.createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.origin || request.headers.authorization !== `Bearer ${token}`) {
      request.resume();
      reply(403, { error: "This request is not authorized to control Loupe." });
      return;
    }
    lastRequest = Date.now();
    try {
      if (request.method !== "POST") { reply(405, { error: "Use POST." }); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { reply(413, { error: "The request exceeds 2 MiB." }); return; }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const result = await serialize(async () => {
        if (closing) throw new Error("Loupe is closing.");
        switch (request.url) {
          case "/frame": return preview.frame(input.viewport);
          case "/command": return preview.command(input);
          case "/inspect": return preview.inspect(input.point);
          case "/capture": return preview.capture(input);
          case "/draft/read": return preview.readDraft();
          case "/draft/save": return preview.saveDraft(input);
          case "/close": return { closing: true };
          default: throw new Error("Unknown Loupe endpoint.");
        }
      });
      reply(200, result);
      if (request.url === "/close") void close({ releaseFrame: input.releaseFrame === true }).catch((error) => { console.error(`Loupe cleanup failed: ${error.message}`); process.exitCode = 1; });
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  server.requestTimeout = 20000;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const descriptor = { version: 1, endpoint, token };
    await atomicJson(path.join(directory, "connection.json"), descriptor);
    lease = setInterval(() => {
      if (Date.now() - lastRequest > 30000) void close({ releaseFrame: false }).catch((error) => { console.error(`Loupe cleanup failed: ${error.message}`); process.exitCode = 1; });
    }, 5000);
    lease.unref();
    return { descriptor, preview, close };
  } catch (error) {
    server.close();
    await preview.close();
    throw error;
  }
}
