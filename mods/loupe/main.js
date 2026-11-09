import { View, div, image } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { agents, appHome, exec, focused, hc, home, nextCommand, props, readTextFile, spaces, theme } from "herdr";
import { randomUUID } from "crypto";
import { browserKey, commandResult, deliver, imagePoint, imageRect, regionBetween, saveNote, unsentNotes } from "./model.js";

function button(id, label, action, { active = false, disabled = false } = {}) {
  const t = theme();
  return div().id(id).px(10).py(6).rounded(5).text_size(12).flex_shrink(0)
    .bg(active ? t.accent : t.surface).text_color(active ? t.background : t.foreground)
    .opacity(disabled ? 0.45 : 1).cursor_pointer()
    .on_click((_, cx) => { cx.stop_propagation(); if (!disabled) action(cx); }).child(label);
}

export default class Loupe extends View {
  init(_props, cx) {
    const focus = focused(), available = agents(), properties = props() ?? {};
    this.folder = properties.folder || focus?.cwd || spaces().find((space) => space.active)?.folder || home();
    this.target = available.find((agent) => agent.address === (focus?.agent || focus?.terminal))?.address || available[0]?.address || null;
    this.session = null;
    this.view = randomUUID();
    this.connection = null;
    this.helper = ["herdr-loupe"];
    this.starting = false;
    this.closed = false;
    this.queue = Promise.resolve();
    this.requests = 0;
    this.frame = null;
    this.bounds = { width: 1000, height: 700 };
    this.viewport = { width: 1000, height: 700 };
    this.mode = "browse";
    this.hover = null;
    this.hovering = false;
    this.drag = null;
    this.notes = [];
    this.pending = null;
    this.editing = null;
    this.error = null;
    this.message = null;
    this.sending = false;
    this.refreshing = false;
    this.restored = false;
    this.draftDirty = false;
    this.focus = cx.focus_handle();
    this.address = InputState.new({ placeholder: "http://localhost:3000 or /path/to/preview.html", value: properties.url || "" });
    this.comment = TextareaState.new({ placeholder: "What should change?", rows: 4 });
    this.address.on("submit", (_, cx) => this.open(cx));
    this.comment.on("change", (_, cx) => { this.draftDirty = true; cx.notify(); });
    cx.timer.every(500, (cx) => {
      if (this.connection && !this.closed && !this.refreshing && !this.requests) {
        this.task(cx, async (cx) => {
          this.refreshing = true;
          try {
            if (this.draftDirty) await this.persist();
            await this.refresh();
          } finally { this.refreshing = false; cx.notify(); }
        });
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.focus.focus();
        if (command === "annotate") { this.mode = this.mode === "browse" ? "element" : "browse"; this.hover = null; cx.notify(); }
        if (command === "send") this.send(cx);
      }
    });
  }

  task(cx, operation) {
    cx.spawn(async (cx) => {
      try { await operation(cx); } catch (error) { if (!this.closed) this.error = error.message || String(error); }
      if (!this.closed) cx.notify();
    });
  }

  request(endpoint, body = {}) {
    const connection = this.connection;
    if (!connection) return Promise.reject(new Error("Start a preview first."));
    this.requests++;
    const result = this.queue.then(async () => {
      let response;
      try {
        response = await fetch(connection.endpoint + endpoint, {
          method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      } catch (error) {
        if (this.connection === connection) { this.connection = null; this.frame = null; }
        throw new Error(`Loupe’s browser connection was lost. Click Open to restart it. ${error.message}`);
      }
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Loupe helper returned ${response.status}`);
      return value;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.requests--; });
  }

  async start(cx) {
    if (this.connection) return;
    this.starting = true;
    cx.notify();
    try {
      const configuration = await readTextFile(`${appHome()}/loupe/launcher.json`);
      if (configuration !== null) {
        const configured = JSON.parse(configuration).helper;
        if (!Array.isArray(configured) || !configured.length || configured.some((item) => typeof item !== "string" || !item)) {
          throw new Error("loupe/launcher.json must contain a nonempty helper command array.");
        }
        this.helper = configured;
      }
      this.session = randomUUID();
      const launched = JSON.parse(commandResult(await hc(["run", "--json", "--bg", "--rm", "--no-parent", "--no-notify", "--name", `loupe-${this.session.slice(0, 8)}`,
        "--", ...this.helper, "--app-home", appHome(), "--session", this.session, "--view", this.view, "--folder", this.folder]), "Could not start Loupe"));
      if (!launched.address) throw new Error("Herdr returned no terminal address for Loupe’s helper.");
      const directory = `${appHome()}/loupe/sessions/${this.session}`;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (this.closed) return;
        const failed = await readTextFile(`${directory}/error.json`);
        if (failed) throw new Error(JSON.parse(failed).error);
        const ready = await readTextFile(`${directory}/connection.json`);
        if (ready) { this.connection = JSON.parse(ready); break; }
        await cx.sleep(100);
      }
      if (!this.connection) throw new Error("Loupe’s browser did not start within 15 seconds. Check its helper terminal and launcher configuration.");
      if (!this.restored) {
        const draft = await this.request("/draft/read");
        this.notes = draft.notes;
        this.pending = draft.pending;
        this.editing = draft.editing ?? null;
        this.comment.set_value(draft.comment);
        this.restoredUrl = draft.url;
        this.restored = true;
      } else {
        await this.persist();
      }
    } finally { this.starting = false; }
  }

  open(cx) {
    if (this.starting) return;
    const requested = this.address.value().trim();
    this.error = null;
    this.task(cx, async (cx) => {
      await this.start(cx);
      if (this.closed) return;
      const url = requested || this.restoredUrl;
      if (url) {
        await this.request("/command", { action: "navigate", url });
        await this.refresh();
        await this.persist();
      } else {
        await this.refresh();
        this.address.focus();
      }
    });
  }

  async refresh() {
    const frame = await this.request("/frame", { viewport: this.viewport });
    if (this.closed) return;
    this.frame = frame;
    if (this.frame.url !== "about:blank") this.restoredUrl = this.frame.url;
  }

  command(action, cx, extra = {}) {
    if (!this.connection) return;
    this.error = null;
    this.hover = null;
    this.task(cx, async () => {
      await this.request("/command", { action, ...extra });
      await this.refresh();
      this.draftDirty = true;
    });
  }

  draft() {
    return { version: 1, notes: this.notes, pending: this.pending, editing: this.editing, comment: this.comment.value(), url: this.restoredUrl || "" };
  }

  async persist() {
    const draft = this.draft();
    await this.request("/draft/save", draft);
    if (JSON.stringify(draft) === JSON.stringify(this.draft())) this.draftDirty = false;
  }

  point(event) {
    return this.frame && event.local_position && event.bounds ? imagePoint(event.local_position, event.bounds, this.frame.viewport) : null;
  }

  capture(cx, selection) {
    if (!this.frame || this.frame.url === "about:blank") return;
    if (this.pending && !this.editing && this.comment.value().trim()) {
      this.error = "Save or cancel the current comment before selecting another element.";
      cx.notify();
      return;
    }
    const expected = { url: this.frame.url, viewport: this.frame.viewport, scroll: this.frame.scroll };
    this.task(cx, async () => {
      const captured = await this.request("/capture", { ...selection, expected });
      this.pending = captured;
      this.editing = null;
      this.comment.set_value("");
      await this.persist();
      this.comment.focus();
    });
  }

  save(cx) {
    if (!this.pending) return;
    try {
      this.notes = saveNote(this.notes, this.pending, this.comment.value(), this.editing || this.pending.id);
      this.pending = null;
      this.editing = null;
      this.comment.set_value("");
      this.draftDirty = true;
      this.error = null;
    } catch (error) { this.error = error.message; }
    cx.notify();
  }

  send(cx) {
    if (this.sending || !this.notes.length || !this.target) return;
    const target = this.target;
    this.sending = true;
    this.error = null;
    this.message = null;
    this.task(cx, async () => {
      try {
        const sent = await deliver(this.notes, target, hc);
        this.notes = unsentNotes(this.notes, sent);
        await this.persist();
        this.message = `Sent ${sent.length} ${sent.length === 1 ? "comment" : "comments"} to ${target}.`;
      } finally { this.sending = false; }
    });
  }

  async close() {
    this.closed = true;
    if (this.session) {
      const args = [...this.helper.slice(1), "--close", "--app-home", appHome(), "--session", this.session, "--view", this.view, "--folder", this.folder];
      if (this.restored) args.push("--draft", JSON.stringify(this.draft()));
      const result = await exec(this.helper[0], args);
      commandResult(result, "Could not save and close Loupe");
    }
  }

  preview(cx) {
    const t = theme();
    const root = div().id("loupe-preview").relative().flex_1().min_w(0).min_h(0).overflow_hidden().bg(t.background)
      .track_focus(this.focus).key_context("LoupeBrowser")
      .on_size_change((size, cx) => {
        this.bounds = size;
        const next = { width: Math.max(200, Math.min(3840, Math.round(size.width))), height: Math.max(160, Math.min(2160, Math.round(size.height))) };
        if (JSON.stringify(next) !== JSON.stringify(this.viewport)) { this.viewport = next; cx.notify(); }
      })
      .on_key_down((event, cx) => {
        if (!this.connection) return;
        cx.stop_propagation();
        if (event.key === "escape") { this.drag = null; this.hover = null; this.mode = "browse"; cx.notify(); }
        else if (this.mode === "browse") this.command("key", cx, browserKey(event));
      })
      .on_scroll_wheel((event, cx) => {
        if (this.connection) { cx.stop_propagation(); this.command("scroll", cx, { x: -event.delta.x, y: -event.delta.y, point: this.point(event) }); }
      })
      .on_mouse_down("left", (event, cx) => {
        const point = this.point(event);
        if (!point) return;
        cx.stop_propagation();
        this.focus.focus();
        if (this.mode === "browse") this.command("click", cx, { point });
        else if (this.mode === "region" || event.modifiers.shift) { this.drag = { start: point, end: point }; cx.notify(); }
        else this.capture(cx, { kind: "element", point });
      })
      .on_mouse_up("left", (event, cx) => {
        if (!this.drag) return;
        const point = this.point(event) || this.drag.end;
        const rect = regionBetween(this.drag.start, point);
        this.drag = null;
        if (rect.width >= 2 && rect.height >= 2) this.capture(cx, { kind: "region", rect });
        cx.notify();
      })
      .on_hover((hovered, cx) => { if (!hovered) { this.hover = null; this.drag = null; cx.notify(); } })
      .on_mouse_move((event, cx) => {
        const point = this.point(event);
        if (this.drag && point) { this.drag.end = point; cx.notify(); return; }
        if (this.mode !== "element" || !point || this.hovering || this.requests) return;
        this.hovering = true;
        this.task(cx, async () => {
          try { this.hover = await this.request("/inspect", { point }); }
          finally { this.hovering = false; }
        });
      });
    if (this.frame) {
      const fit = imageRect(this.bounds, this.frame.viewport);
      root.child(image(this.frame.image).absolute().left(fit.x).top(fit.y).w(fit.width).h(fit.height));
      const rect = this.drag ? regionBetween(this.drag.start, this.drag.end) : this.hover?.rect;
      if (rect && this.mode !== "browse") root.child(div().absolute().left(fit.x + rect.x * fit.scale).top(fit.y + rect.y * fit.scale)
        .w(rect.width * fit.scale).h(rect.height * fit.scale).border_1().border_color(t.accent));
    } else {
      root.child(v_flex().size_full().items_center().justify_center().gap(12)
        .child(div().text_size(24).text_color(t.foreground).child("Look closely. Leave clear feedback."))
        .child(div().text_size(13).text_color(t.muted).child("Open a web address or a local HTML artifact to start reviewing."))
        .child(button("loupe-start", this.starting ? "Starting Chromium…" : "Start Loupe", (cx) => this.open(cx), { active: true, disabled: this.starting })));
    }
    return root;
  }

  sidebar(cx) {
    const t = theme();
    const panel = v_flex().w(320).flex_shrink(0).h_full().min_h(0).bg(t.surface).p(14).gap(12)
      .child(h_flex().justify_between().child(div().text_size(15).font_weight(600).child("Review notes")).child(div().text_color(t.muted).child(String(this.notes.length))));
    const list = v_flex().id("loupe-notes").flex_1().min_h(0).overflow_y_scroll().gap(8);
    if (!this.notes.length) list.child(div().text_color(t.muted).text_size(13).child("Choose Annotate, then click an element. Shift-drag to mark a region."));
    for (const [index, note] of this.notes.entries()) {
      list.child(v_flex().id(`note-${note.id}`).p(10).gap(6).rounded(6).bg(t.background)
        .child(div().text_size(11).text_color(t.muted).child(`${index + 1}. ${note.capture.selector || note.capture.kind}`))
        .child(div().text_size(13).child(note.comment))
        .child(h_flex().gap(6)
          .child(button(`edit-${note.id}`, "Edit", (cx) => { this.pending = note.capture; this.editing = note.id; this.comment.set_value(note.comment); this.draftDirty = true; this.comment.focus(); cx.notify(); }))
          .child(button(`delete-${note.id}`, "Delete", (cx) => {
            this.notes = this.notes.filter((item) => item.id !== note.id);
            if (this.editing === note.id) { this.pending = null; this.editing = null; this.comment.set_value(""); }
            this.draftDirty = true; cx.notify();
          }))));
    }
    panel.child(list);
    if (this.pending) {
      panel.child(div().text_size(11).text_color(t.muted).child(this.pending.selector || `${this.pending.kind} annotation`))
        .child(image(this.pending.image).w_full().h(100))
        .child(Textarea.new(this.comment).h(100))
        .child(h_flex().gap(6).child(button("loupe-save", this.editing ? "Save changes" : "Add comment", (cx) => this.save(cx), { active: true }))
          .child(button("loupe-cancel", "Cancel", (cx) => { this.pending = null; this.editing = null; this.comment.set_value(""); this.draftDirty = true; cx.notify(); })));
    }
    panel.child(div().text_size(11).text_color(t.muted).child("SEND FEEDBACK TO"));
    const targets = agents();
    if (!targets.length) panel.child(div().text_color(t.muted).text_size(12).child("Start a coding agent in Herdr to send feedback."));
    for (const agent of targets) panel.child(button(`target-${agent.address}`, `${agent.program.name} · ${agent.address}`, (cx) => { this.target = agent.address; cx.notify(); }, { active: this.target === agent.address }));
    panel.child(button("loupe-send", this.sending ? "Sending…" : "Send to agent", (cx) => this.send(cx), {
      active: true, disabled: this.sending || !this.notes.length || !targets.some((agent) => agent.address === this.target),
    }));
    return panel;
  }

  render(cx) {
    const t = theme();
    return v_flex().id("loupe").size_full().min_w(0).min_h(0).text_color(t.foreground).bg(t.background)
      .child(h_flex().h(52).flex_shrink(0).px(14).gap(8).bg(t.surface)
        .child(div().text_size(16).font_weight(600).child("Loupe"))
        .child(button("loupe-back", "Back", (cx) => this.command("back", cx), { disabled: !this.connection }))
        .child(button("loupe-forward", "Forward", (cx) => this.command("forward", cx), { disabled: !this.connection }))
        .child(button("loupe-reload", "Reload", (cx) => this.command("reload", cx), { disabled: !this.connection }))
        .child(Input.new(this.address).flex_1().min_w(100))
        .child(button("loupe-open", this.starting ? "Starting…" : "Open", (cx) => this.open(cx), { active: true, disabled: this.starting })))
      .child(h_flex().h(42).flex_shrink(0).px(14).gap(8)
        .child(button("loupe-browse", "Browse", (cx) => { this.mode = "browse"; this.hover = null; cx.notify(); }, { active: this.mode === "browse" }))
        .child(button("loupe-annotate", "Annotate", (cx) => { this.mode = "element"; cx.notify(); }, { active: this.mode === "element" }))
        .child(button("loupe-region", "Region", (cx) => { this.mode = "region"; cx.notify(); }, { active: this.mode === "region" }))
        .child(button("loupe-page", "Note on page", (cx) => this.capture(cx, { kind: "page" }), { disabled: !this.connection }))
        .child(div().text_size(11).text_color(t.muted).child(this.frame?.title || "Web artifact review")))
      .child(h_flex().items_stretch().flex_1().min_h(0).child(this.preview(cx)).child(this.sidebar(cx)))
      .child(h_flex().h(30).flex_shrink(0).px(14).bg(t.surface).justify_between()
        .child(div().text_size(11).text_color(this.error ? t.ansi1 : t.muted).child(this.error || this.message || this.frame?.error || "Select an element, explain the change, and send your review."))
        .child(div().text_size(11).text_color(t.muted).child(this.frame ? `${this.frame.viewport.width} × ${this.frame.viewport.height}` : "")));
  }
}
