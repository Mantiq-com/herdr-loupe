# Loupe for Herdr

Review web artifacts, add visual annotations, and send feedback to a coding agent
without leaving [Herdr](https://herdr.dev).

Loupe displays a Chromium preview inside a native Herdr pane. Browse the page,
switch to **Annotate**, and click an element to explain what should change.
**Send to agent** sends your comments, screenshots, selectors, HTML, and computed
styles to the agent you choose.

- Open a running app by URL or an HTML file from disk, including its relative assets.
- Follow links, type into forms, scroll, and use back, forward, and reload.
- Highlight an element, draw a rectangular region, or comment on the whole viewport.
- Edit or delete notes before sending. Drafts and unfinished comments survive closing.
- Choose the receiving agent explicitly. A change in focus does not redirect a send.
- Transfer screenshots to the receiving terminal's machine through Herdr.

## Requirements

- Herdr app 0.1.14 or later, and herdr-core with `hc put` and `hc send`.
- Node.js 20 or later and npm.
- Chromium or Chrome installed through your system package manager.

The tested environment uses Herdr app 0.1.14, herdr-core 0.1.19, Node 24, and
Chromium 157 on Linux. Other platforms have not been validated.
Loupe uses `playwright-core` and does not download a browser.

## Install

Run these commands from this repository:

```sh
npm ci
npm run install:mod -- --app-home "${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}"
```

The installer copies the mod and writes a local `loupe/launcher.json` containing
the actual Node executable and helper path. Keep this repository in place:
the helper and its dependency run from here. The installer refuses to overwrite
an existing mod or launcher configuration.

Merge the sections of [keys.json](keys.json) into your Herdr key bindings.
`ctrl-shift-l` opens Loupe in a new tab. You can also open it explicitly:

```sh
herdr-app do tab.new '{"name":"Loupe","mod":"loupe"}'
```

To put Loupe beside an agent instead:

```sh
herdr-app do pane.split '{"direction":"right","mod":"loupe"}'
```

The helper searches `PATH` for Chromium or Chrome. If necessary, set
`LOUPE_CHROMIUM` in the environment Herdr's core starts with, or configure a local
launcher command that sets it. The helper keeps Chromium's sandbox enabled.

To update an installation, run `npm ci`, review the installed mod against
`mods/loupe`, then copy the changed source files into the installed mod.
The existing launcher remains valid while the repository stays at the same path.

## Review an artifact

1. Enter an HTTP(S) URL or a local `.html`/`.htm` path and click **Open**.
   Relative paths start at the working folder where Loupe was opened.
   Starting Loupe with an empty address restores that folder's previous review.
2. Use **Browse** to interact with the page.
3. Choose **Annotate** and click an element. Use **Region**, or Shift-drag while
   annotating, to mark an area. **Note on page** captures the visible viewport.
4. Write a comment and choose **Add comment**. Existing notes offer **Edit** and
   **Delete**.
5. Select a receiving agent and click **Send to agent**, or press `ctrl-enter`.

`ctrl-shift-a` switches between Browse and Annotate while Loupe has focus.
Escape returns the preview to Browse mode. Browser keyboard input follows a click
inside the preview; comments use their own native editor.

If the helper stops or its connection is lost, click **Open** to restart the
browser. Loupe keeps the current review notes and unfinished comment.

Sending submits a prompt immediately. Loupe respects Herdr's refusal to send to
an agent waiting for permission; it never uses `--force`. Failed sends leave notes
in place. Edits saved while delivery is underway remain after the older versions
are sent. If delivery reports an uncertain outcome, inspect the agent before retrying.

## Limits

The preview is a sequence of screenshots, refreshed every 500 ms while the helper
is available, rather than a native browser widget. It supports basic clicking,
scrolling, and keyboard input. Browser tabs, popups, downloads, browser clipboard
integration, and dragging page controls are not supported. JavaScript dialogs are
dismissed. Use your regular browser for those interactions.

Element selection inside an iframe identifies the iframe itself. Selectors inside
an open shadow root are relative to that root. Source file and line resolution is
not implemented. Screenshots and regions describe the visible viewport.

The browser runs locally in a separate temporary profile. A remote app needs an
already reachable URL or tunnel. PDFs, slides, Office files, and remote Chromium
hosting are outside this version.

## What it runs and stores

Loupe starts its own Node helper through `hc`, and that helper starts its own
sandboxed Chromium. Closing Loupe saves its draft and asks that helper to stop.
A helper that receives no requests for 30 seconds also closes its browser.
It does not stop your other terminals, browsers, or servers.

The helper binds an automatically chosen loopback port. Requests require a
per-session token; browser-origin requests are refused. The helper exposes browser
and draft operations, not shell execution or agent delivery. Delivery happens in
the mod through `hc` after you click Send.

Files live under the selected Herdr app home:

| Location | Contents |
|---|---|
| `loupe/launcher.json` | Local helper command and paths |
| `loupe/sessions/` | Private connection information for running helpers |
| `loupe/drafts/` | Review drafts, keyed by working folder |
| `loupe/captures/` | Annotation screenshots |
| `mods/loupe-media/` | The current preview frame for each Loupe view |

Drafts and screenshots may contain private page content. They are stored locally
without encryption. Screenshots referenced by drafts are retained; unreferenced
captures older than a day are removed when a draft is saved. Session frames are
removed when their view closes, and survive a helper restart. A forced process
termination or failed startup can leave temporary files.
`hc put` also creates screenshot copies beside the receiving terminal.

Use one active Loupe review per working folder: copies opened for the same folder
share its draft. Each opening starts a separate browser profile.

## Development

```sh
npm test
npm run test:visual
```

`npm test` runs the browser, model, private-core delivery, and lifecycle tests,
then `herdr-app check mods/loupe`. Chromium, `hc`, and `herdr-app` must be on PATH.
The tests create their own Herdr core and disposable terminal; they do not use
your running core.

The Linux visual test also needs Xvfb, xdotool, and ImageMagick. It starts its own
display and app home, exercises the native review interface, and keeps screenshots
in the gitignored `tmp/` directory. On NixOS, xdotool can be supplied ephemerally:

```sh
nix shell nixpkgs#xdotool --command npm run test:visual
```

[RECIPE.md](RECIPE.md) describes the implementation and its constraints.
