import assert from "node:assert/strict";
import test from "node:test";
import { browserKey, deliver, feedback, imagePoint, regionBetween, saveNote, unsentNotes } from "../mods/loupe/model.js";

const capture = { kind: "element", url: "https://example.com/preview", viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 120 }, selector: "#save", html: '<button id="save">Save</button>', screenshot: "/tmp/loupe-example.png" };
const note = { id: "note-1", revision: 1, comment: "Increase the contrast", capture };

test("picking accounts for scale and letterboxing and ignores empty margins", () => {
  const bounds = { width: 1000, height: 500 }, viewport = { width: 800, height: 600 };
  assert.equal(imagePoint({ x: 10, y: 250 }, bounds, viewport), null);
  assert.deepEqual(imagePoint({ x: 500, y: 250 }, bounds, viewport), { x: 400, y: 300 });
  assert.equal(imagePoint({ x: 500, y: 500 }, bounds, viewport), null);
  assert.equal(imagePoint({ x: 0, y: 0 }, { width: 0, height: 0 }, viewport), null);
  assert.deepEqual(regionBetween({ x: 80, y: 90 }, { x: 20, y: 30 }), { x: 20, y: 30, width: 60, height: 60 });
});

test("editing increments the revision so successful delivery preserves concurrent edits", () => {
  const initial = saveNote([], capture, " First comment ", "one");
  const edited = saveNote(initial, capture, "Revised comment", "one");
  const current = saveNote(edited, capture, "Another issue", "two");
  assert.equal(initial[0].comment, "First comment");
  assert.deepEqual(unsentNotes(current, initial).map((item) => item.id), ["one", "two"]);
  assert.deepEqual(unsentNotes(current, edited).map((item) => item.id), ["two"]);
  assert.throws(() => saveNote([], capture, "  ", "three"), /comment/);
});

test("feedback keeps the page, selector and transferred screenshot beside each comment", () => {
  const output = feedback([note, { ...note, id: "two", comment: "Second comment", capture: { ...capture, kind: "page", selector: null } }], ["/remote/first.png", "/remote/second.png"]);
  assert.ok(output.indexOf("Increase the contrast") < output.indexOf("Second comment"));
  assert.ok(output.includes("https://example.com/preview"));
  assert.ok(output.includes("Selector: #save"));
  assert.ok(output.includes("/remote/first.png"));
  assert.ok(!output.includes(capture.screenshot));
  const withFence = feedback([{ ...note, capture: { ...capture, html: "<pre>```</pre>" } }], ["/image.png"]);
  const fence = withFence.match(/^(`{3,})html$/m)?.[1];
  assert.ok(fence && fence.length > 3);
  assert.ok(withFence.split("\n").includes(fence));
});

test("delivery fixes the destination and snapshots notes before asynchronous transfers", async () => {
  const notes = [{ ...note }], calls = [];
  const sent = await deliver(notes, "machine/t7", async (args) => {
    calls.push(args);
    if (args[0] === "put") {
      notes[0].comment = "Edited while transferring";
      notes[0].revision++;
      return { code: 0, stdout: JSON.stringify({ path: "/remote/copied.png" }), stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  });
  assert.equal(calls[0][2], "machine/t7");
  assert.equal(calls[1][1], "machine/t7");
  assert.ok(calls[1][2].includes("Increase the contrast"));
  assert.ok(!calls[1][2].includes("Edited while transferring"));
  assert.equal(unsentNotes(notes, sent).length, 1);
});

test("failed transfers never submit partial feedback and refused sends retain notes", async () => {
  const calls = [];
  await assert.rejects(deliver([note], "t1", async (args) => {
    calls.push(args);
    return { code: 1, stdout: "", stderr: "machine unavailable" };
  }), /machine unavailable/);
  assert.equal(calls.length, 1);
  await assert.rejects(deliver([note], "t1", async (args) => args[0] === "put"
    ? { code: 0, stdout: '{"path":"/copy.png"}', stderr: "" }
    : { code: 9, stdout: "", stderr: "agent is blocked" }), /blocked/);
  assert.equal(note.revision, 1);
  await assert.rejects(deliver([note], "", async () => assert.fail()), /Choose an agent/);
});

test("browser keyboard input distinguishes characters from navigation and shortcuts", () => {
  assert.deepEqual(browserKey({ key: "a", key_char: "A", modifiers: { shift: true } }), { text: "A" });
  assert.deepEqual(browserKey({ key: "left", modifiers: { control: true } }), { key: "Control+ArrowLeft" });
  assert.deepEqual(browserKey({ key: "enter", modifiers: {} }), { key: "Enter" });
});
