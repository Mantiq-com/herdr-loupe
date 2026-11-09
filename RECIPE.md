# Loupe

Loupe reviews a rendered web page in Herdr and returns comments to an explicitly
selected coding agent. Its browser runs on the computer running the Herdr app.

## Interface

The native mod has an address bar, browser controls, annotation modes, a preview,
and a review sidebar. The sidebar contains saved comments, the current comment
editor, the receiving agent, and Send.

The mod is focusable and can live in a tab, a split pane, or a layout block. Optional
props are `url` and `folder`. The initial agent is the previously focused agent,
or the first available agent. An explicit selection stays fixed during delivery.
The example keys open a new tab; they do not toggle or reuse an existing copy.

## Browser and transport

Herdr draws native GPUI elements and exposes no browser widget. A Node helper uses
Playwright to launch installed Chromium with a temporary profile and its sandbox
enabled. The helper receives navigation, input, inspection, and capture requests
through an authenticated loopback HTTP server. Its port is assigned by the OS.
The connection descriptor is private and must never be logged.

The mod starts the helper in a terminal it owns. It begins only after Open or
Start Loupe is clicked, so `herdr-app check` starts no browser. The installer writes
the resolved Node and repository paths only to the app home's local launcher file.
Each startup attempt gets a fresh session so a previous failure cannot mask a retry.
After a lost connection, Open starts a new browser and preserves the current draft.

The helper serializes browser operations. The mod also queues its requests and
avoids overlapping periodic refreshes. Every 500 ms it captures the viewport;
unchanged image bytes do not produce a disk write.

The frame has a stable path under `mods/loupe-media/<view>/viewport.png`.
This directory deliberately has no `main.js`. Herdr 0.1.14 watches its image changes
and invalidates cached pixels without loading it as a mod or reloading Loupe.
Frames are written atomically, and only one current frame is retained per view.
The view owns that file across helper restarts. A disconnected helper closes its
browser but keeps the pixels until the view releases them, so Herdr never has to
reload a displayed image from a deleted file.

## Selection and feedback

Pointer coordinates are translated through the displayed image's scale and margins
into Chromium viewport pixels. Element inspection uses `elementFromPoint`, including
open shadow roots. Annotation mode does not forward the click to the page.

An element capture includes a selector, a bounded HTML fragment and text, relevant
computed styles, URL, viewport, scroll position, bounds, and a cropped screenshot.
Region captures omit element details; page captures include the visible viewport.
Capture requests reject selections whose page, scroll, or viewport has moved.

Notes have stable IDs and revisions. Send takes an immutable snapshot, transfers
each image with `hc put`, and sends the resulting prompt with `hc send`. A failed
transfer does not submit partial feedback. On success, only matching note IDs and
revisions are removed, preserving additions and saved edits made during delivery.
Feedback keeps code fragments inside fences long enough to contain their backticks.

## Persistence and lifecycle

Drafts are keyed by a hash of the working folder. The mod saves comments, pending
captures, editing state, and the last URL. Multiple copies for the same folder
share that draft; use one active review per folder.

Herdr gives closing mods a short deadline. The mod therefore starts a one-shot
helper invocation through `exec` to save the final draft and close the browser.
An already started exec can finish after the mod closes. An unused helper also
expires after 30 seconds. Helper shutdown removes session connection data; closing
the view releases its frame files, including when its helper has already stopped.

Saved drafts retain their annotation images. On a draft save, unreferenced captures
older than a day are removed. These files are private but unencrypted. Transferred
images remain on the receiving terminal's machine under herdr-core's file handling.

## Verification

`npm test` is the normal gate. It checks real Chromium navigation and capture,
coordinate mapping, revision-aware delivery, draft recovery, loopback access
control, a real `hc` transfer/send, helper cleanup, and the native mod checker.

`npm run test:visual` uses Xvfb and an isolated app home and core. It verifies browser
input, native screenshot repaint, element/region/page comments, editing, and delivery
to an app-managed disposable agent. Its screenshots are inspection artifacts, not
golden files. All app, browser, display, terminal, and fixture-server processes
belong to the test and are closed afterward.

Tests create their scratch directory when needed. A missing dependency or any
failed test/check exits nonzero; no browser or core check is silently skipped.
