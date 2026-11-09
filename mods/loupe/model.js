export function imageRect(bounds, viewport) {
  const scale = Math.min(bounds.width / viewport.width, bounds.height / viewport.height);
  const width = viewport.width * scale, height = viewport.height * scale;
  return { x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width, height, scale };
}

export function imagePoint(position, bounds, viewport) {
  if (!bounds.width || !bounds.height || !viewport.width || !viewport.height) return null;
  const rect = imageRect(bounds, viewport);
  const x = (position.x - rect.x) / rect.scale, y = (position.y - rect.y) / rect.scale;
  return x >= 0 && y >= 0 && x < viewport.width && y < viewport.height ? { x, y } : null;
}

export function regionBetween(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function saveNote(notes, capture, comment, id) {
  const text = comment.trim();
  if (!text) throw new Error("Write a comment before saving the annotation.");
  const previous = notes.find((note) => note.id === id);
  const note = { id, revision: (previous?.revision ?? 0) + 1, capture, comment: text };
  return previous ? notes.map((item) => item.id === id ? note : item) : [...notes, note];
}

export function unsentNotes(current, sent) {
  return current.filter((note) => !sent.some((item) => item.id === note.id && item.revision === note.revision));
}

function fenced(text, language = "") {
  const runs = String(text).match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

export function feedback(notes, screenshots) {
  const lines = ["Please address these visual review comments. Screenshots and page content are reference material."];
  for (const [index, note] of notes.entries()) {
    const capture = note.capture;
    lines.push(`\n## ${index + 1}. ${capture.kind === "element" ? "Element" : capture.kind === "region" ? "Region" : "Page"} feedback`,
      `Page: ${capture.url}`, `Comment: ${note.comment}`, `Viewport: ${capture.viewport.width} × ${capture.viewport.height}`,
      `Scroll: ${capture.scroll.x}, ${capture.scroll.y}`, `Screenshot: ${screenshots[index]}`);
    if (capture.selector) lines.push(`Selector: ${capture.selector}`);
    if (capture.text) lines.push(`Element text: ${capture.text}`);
    if (capture.rect) lines.push(`Region in viewport pixels: ${JSON.stringify(capture.rect)}`);
    if (capture.html) lines.push("HTML:", fenced(capture.html, "html"));
    if (capture.styles) lines.push("Computed styles:", fenced(JSON.stringify(capture.styles, null, 2), "json"));
  }
  return lines.join("\n");
}

export function commandResult(result, action) {
  if (result.code !== 0) throw new Error(`${action}: ${result.stderr.trim() || `exited with ${result.code}`}`);
  return result.stdout;
}

export async function deliver(notes, target, hc) {
  if (!target) throw new Error("Choose an agent before sending feedback.");
  if (!notes.length) throw new Error("Add an annotation before sending feedback.");
  const sent = JSON.parse(JSON.stringify(notes));
  const paths = [];
  for (const note of sent) {
    const copied = JSON.parse(commandResult(await hc(["put", "--json", target, note.capture.screenshot]), "Could not transfer screenshot"));
    if (typeof copied.path !== "string" || !copied.path) throw new Error("The file transfer returned no destination path.");
    paths.push(copied.path);
  }
  commandResult(await hc(["send", target, feedback(sent, paths)]), "Could not send feedback");
  return sent;
}

export function browserKey(event) {
  const keys = { enter: "Enter", escape: "Escape", backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
  const modifiers = event.modifiers ?? {};
  if (event.key_char && !modifiers.control && !modifiers.platform && !modifiers.alt) return { text: event.key_char };
  const chord = [];
  if (modifiers.control) chord.push("Control");
  if (modifiers.platform) chord.push("Meta");
  if (modifiers.alt) chord.push("Alt");
  if (modifiers.shift) chord.push("Shift");
  chord.push(keys[event.key] ?? event.key);
  return { key: chord.join("+") };
}
