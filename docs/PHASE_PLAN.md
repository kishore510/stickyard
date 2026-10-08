# Phase plan: Stickyard

Last updated: 8 October 2026

Draft roadmap. When a slice starts, rewrite its prompt against the real code (see the skeleton in PROJECT_BRIEF.md). Do not treat these notes as final prompts.

## Status at a glance

| Slice | Scope | Status |
|---|---|---|
| 0 Setup | Repo, CI, Pages deploy, Worker deploy, secrets hygiene, protocol version, Origin check | Done (v0.1.0) |
| 0.5 App shell | App shell and design system: top bar, menu, Help / What's new / About sheets, theme, tokens | Done (v0.2.0) |
| 1 Echo room | Join by code and name; gated room creation; signed room codes | Done (v0.3.0, protocol v2) |
| 2 Shared stickies | Add/edit/move/delete, last-write-wins, optimistic updates, minimal SQLite persistence | Done (v0.4.0, protocol v3) |
| 2.5 Board UX | React Flow canvas, full-bleed board, view bar, minimap, floating chat, Participants sheet, tool rail, phone ribbon. Web only | Done (v0.5.0) |
| 2.6 Panels | Resizable, collapsible left palette (categories, six coloured note tiles, drag onto board) and right Properties panel; selection model as a set. Web only | Done (v0.5.1) |
| 2.7 Note size, colour and text style | Resize notes (per-note size, resize handles, Width/Height); change a note's colour; text style (size, bold, italic, text colour, left/centre/right). Protocol v4 + stored-schema migration (1 -> 2) | Done (v0.6.0) |
| 2.7.1 Title alignment | Separate alignment for a note's title and body. Protocol v5 + stored-schema migration (2 -> 3) | Done (v0.6.1) |
| 2.7.2 Title styling | Separate size, bold, italic and text colour for a note's title and body. Protocol v6 + stored-schema migration (3 -> 4) | Done (v0.6.2) |
| 2.8 Multi-select and arrange | Marquee and multi-select, floating selection bar (align, distribute, match size), group move/delete, batch update message. Protocol v7 | Done (v0.7.0) |
| 2.9 Inline note editing | Type on the note itself from md up (two styled textareas), double-click/Enter/new note start it; web only, no protocol change | Done (v0.7.1) |
| Z-order | Bring to front / send to back (a z field). Protocol v8 + stored-schema migration (4 -> 5) | Done (v0.8.0) |
| Welcome screen | Start page becomes a welcome screen with the new Stickyard mark (inline SVG, brand tokens), tagline and three points; Start and Join unchanged. Web only | Done (v0.8.1) |
| Frames | Named, resizable, coloured areas behind notes; dragging one carries the notes inside. Protocol v9 + stored schema 6 (new frames table) | Done (v0.9.0) |
| Frame title styling | Title size, bold, italic, alignment and ink for frames, in Properties. Protocol v10 + stored schema 7 (five columns with defaults); framesSnapshot test cap 16 -> 20 KiB | Done (v0.9.1) |
| Templates | Retro, Start Stop Continue, 2x2 Impact and Effort, Sprint planning, built from frames (web only, no protocol change) | Done (v0.10.0) |
| Delete polish | Delete key on a selection (after Ctrl+A or a marquee), one confirm with the count, a report of how a multi-note delete went (web only) | Done (v0.10.1) |
| Selection fixes | Frame + Delete works (a click on the title selects the frame; double-click or Enter edits it); clearer multi-select: thicker outline, a tick per note, a dashed box round the selection (web only) | Done (v0.10.2) |
| Arrange grid | Arrange > Grid in the selection bar: lay a selection out in rows and columns in reading order, with a Columns stepper and Auto (web only) | Done (v0.10.3) |
| Create with content | One `itemsAdd` message adds notes and frames with full content (size, text, colour, every style field), packed under the 4 KiB cap by actual size; templates now appear in one step. Protocol v11, web + worker, no stored-schema change | Done (v0.11.0, PR #25) |
| Floating bar, Duplicate, Undo/Redo, Clear board | One branch (`phase-bar-undo`), four parts: permanent floating bar, Duplicate, per-user undo/redo, Clear board. Web only, no protocol change | Done (v0.12.0, PR #26) |
| 4 Reconnect | Backoff, full resync applying both snapshots, "relay over its daily limit" state, clears undo history; no offline edit queue | Done (v0.13.0, PR #28, web only) |
| 3a Presence: avatars and toasts | Avatar stack in the top bar, join/leave toasts. No protocol change (uses `joined`, `participant_joined`, `participant_left`) | Done (v0.13.0, PR #28, with Reconnect, web only) |
| 5 (trimmed) Idle expiry | Durable Object alarm deletes an idle room's storage and leaves a tombstone, so an old link says the session has expired. Additive stored data (one meta key), no protocol or schema-version bump | Done (v0.14.0, PR #30) |
| 6 (part) Timer and lock board | Two sessions: (a) protocol v12 (minimal host token, lock flag, timer, End session); (b) UI | Done: (a) v0.15.0, PR #31 (relay and plumbing); (b) v0.16.0, PR #33 (web only) |
| Board bar in the top bar | Board actions moved into the top bar, reasons as hover/focus tooltips, Arrange behind one button (user feedback). Web only | Done (v0.15.1) |
| 6 (part) Dot voting | Two sessions: (a) protocol v13 (anonymous voters, budget enforced by the relay, host start/stop/clear, totals on reveal); (b) UI: dots on notes, counters, results, host controls | Done: (a) v0.17.0, PR #35 (relay and plumbing); (b) v0.18.0, PR #36 (web only) |
| 3b Presence: live cursors | Live cursors (throttled, never stored). Protocol v14 | Done (v0.19.0, PR #37; built ahead of export by choice) |
| Frame multi-select | Frames in the selection with notes: marquee (enclosed frames), Ctrl+A, Shift/Ctrl-click; group move with carry, paced delete, arrange/Grid/Match size on frames, Colour and Title text for several frames, Duplicate of mixed selections. Web only, no protocol change | Done (v0.20.0, PR #38) |
| 7a Text box and shapes | Text labels and basic shapes (rectangle, oval, diamond) with text, fill and border styles; one stacking space with notes; frames carry them; selection, arrange, duplicate, undo. Protocol v15, stored schema 9 | Done (v0.21.0, PR #39, merged and deployed 7 October 2026) |
| Export PNG/Markdown | Export PNG (100% zoom, fitted to every item, size-capped) and Export Markdown (frames, notes, labels, revealed results; escaped) from Properties. Web only, no protocol or stored-schema change | Done (v0.22.0, web only, merged and deployed 8 October 2026) |
| Board size | Board grows from 3200 x 2000 to 6400 x 4000 (2x each way). Protocol v16, no stored-schema bump; `MIN_ZOOM` stays 0.1 | Done (v0.23.0, protocol v16, merged and deployed 8 October 2026) |
| Panel layout at 768 px | Below lg the palette and Properties start collapsed unless this browser saved a choice; the view bar wraps on a narrow canvas. Web only | Done (v0.24.0, web only, merged and deployed 8 October 2026) |
| Navigation | Zoom to selection (S); Fit to notes leaves a far outlier out (Show all); Go to a person's last pointer from Participants; minimap click. Web only, no protocol change | Done (v0.24.0, web only, merged and deployed 8 October 2026) |
| 6 (part) Silent brainstorm with reveal, part 1 of 3 | Relay and shared only: sealed notes reach only their writer's sockets, one count for everyone, host start and reveal (chunks of 50, one transaction), writer id from the page's key in `join`, every outbound message filtered per recipient. Protocol v17, stored schema 10. Built before Follow by choice (8 October 2026) | Done (v0.25.0, PR #47, protocol v17, stored schema 10, relay and shared only, merged and deployed 8 October 2026) |
| 6 (part) Silent brainstorm: which notes are mine (protocol v18) | Relay and shared only: during a round the join step ends with `silentMine { ids }` to the joining socket (its writer's own sealed ids), so a page can tell its sealed notes apart after a reload, a late join or a new tab. Found at the start of part 2 (8 October 2026): from v17 alone the web couldn't | Done (v0.26.0, PR #48, protocol v18, no stored-schema change, merged and deployed 8 October 2026) |
| 6 (part) Silent brainstorm with reveal, parts 2 and 3 | Web: send the key in `join`, the host's Start / Reveal, the count, hidden notes marked as mine, the reveal applied once; Help and checks in the browser. Anonymous notes mode decided out of part 1 (backlog) | Not started |
| Follow and Bring to me | Opt-in Follow (a person's viewport relayed to their followers, never stored); host-only Bring to me as a banner with "Go there", never a forced move. Protocol v19 expected (v17 and v18 went to silent brainstorm) | Not started |
| 9 (trimmed) Hardening | Load test and accessibility pass (message-rate limits already exist since slice 2); after silent brainstorm so the load test covers its paths | Not started |
| Reactions on notes | A fixed set of emoji reactions on notes. Protocol change, about one row per reaction; comments stay in the backlog | Not started |
| More built-in templates | More templates as data entries only (no protocol change); any time, as filler between slices | Not started |
| 7b Arrows | (i) Free endpoints and a line style; (ii) endpoints bound to notes and shapes, re-routed when a bound object moves, with a rule for deleting a bound object | Not started |
| 7c Structure (remaining) | Group boxes, affinity grouping, Stencils tab and Save as stencil. Frames, templates and export moved to their own slices | Not started |
| 8 Phone view | Phone participant view, QR join | Not started |
| 10 AI | Summary and sentiment analysis, explicit buttons, add-only | Optional, last |
| Later | Yjs migration, anonymous mode, PWA | Parked |

## Order and principles

- Each rung gives a working result. Stop at any rung and still have something that works.
- Success criterion for the core: two phones and a laptop editing the same board reliably.
- Build slice 2 by hand (last-write-wins) before considering Yjs, so the problem Yjs solves is understood.
- Test on the live deployment; merge and deploy each slice, roll back if needed (single user).
- Every new object type (frame, timer, shapes, group box, connector) needs its own protocol/schema change with a version bump, caps and tests. The palette gets its tile with one registry entry; no placeholder tiles for things that don't exist.
- Each protocol or stored-schema change is its own slice and branch (2.7, 2.7.1, 2.7.2, 2.8, z-order, frames, 3b are separate for that reason).
- Protocol numbers are assigned when each slice starts, not in advance (v17 is the current one, since silent brainstorm part 1 in v0.25.0; expiry (v0.14.0), the top-bar move (v0.15.1) and the facilitation UI (v0.16.0) changed no protocol).
- Earlier order (decided 4 October 2026, replaced by the next line for everything not yet built; Reconnect and Presence 3a were built together in one session, v0.13.0; Idle expiry done in v0.14.0; Timer and lock board (a) in v0.15.0 and (b) in v0.16.0; Dot voting (a) in v0.17.0 and (b) in v0.18.0; 3b cursors brought forward to v0.19.0; Frame multi-select in v0.20.0 and 7a in v0.21.0): Export PNG/Markdown, Hardening (trimmed 9), then Silent brainstorm with reveal, then 7a, 7b, 7c (remaining), 8, 10. Slice numbers are kept as names; the table above is in build order.
- Order from here (decided 7 October 2026, thread 12; Export done in v0.22.0, Board size in v0.23.0, Panel layout and Navigation together in v0.24.0; Silent brainstorm part 1 brought ahead of Follow on 8 October 2026, thread 16, so it took protocol v17): Export PNG/Markdown, Board size (protocol v16), Panel layout at 768 px, Navigation, Silent brainstorm with reveal (protocol v17), Follow and Bring to me (now expected protocol v19), Hardening (trimmed 9, after silent brainstorm so the load test covers its paths), Reactions on notes, then 7b Arrows, 7c Structure (remaining), 8 Phone view (with QR join), 10 AI. More built-in templates has no fixed slot: it is data entries only and fills any gap between slices. The protocol numbers here are the expected ones; each is still confirmed when its slice starts.
- Working setup (7 October 2026): one fresh Claude Code session per part, at most per slice, handing over through the PR description. CLAUDE.md stays short; area detail is in `docs/architecture/`. Stale status docs fail CI (`web/test/docs.test.ts`), and `npm run shots` takes the screenshot set.
- Estimate to a demo-able retro tool (through trimmed hardening, recomputed 7 October 2026 for the order above): about 8 to 10 more Claude Code sessions, plus about 20% for reruns. One each for Export, Board size, Panel layout, Navigation and Hardening; one or two for Follow and Bring to me (protocol, then UI); two for Silent brainstorm (relay, then UI; more if Anonymous notes mode joins it). The rise from the last estimate is the new slices, not slower work (it was 2 to 4 before thread 12, 3 to 5 before the voting UI, 4 to 6 before the voting groundwork, 5 to 7 before the facilitation UI, 6 to 8 before the host groundwork, 7 to 9 before Idle expiry, 11 to 13 before Reconnect and Presence).

## Slice notes

### 0 Setup
- Single repo: `web/`, `worker/`, `shared/` (message types and Zod schemas).
- Verify `wrangler` works on arm64; fallback is a deployed dev Worker.
- SQLite-backed Durable Object and WebSocket Hibernation from day one.
- Pages via Actions with a base-path env var; Worker via `wrangler deploy` (second Actions job using a scoped Cloudflare token stored as a GitHub secret).
- Protocol version in the join handshake; "please reload" message on mismatch.
- Origin check on the Worker (Pages origin plus localhost).
- Secrets hygiene: gitignore, fake values in tests, GitHub secret scanning and push protection.
- Check current Cloudflare free-plan limits and record them in `docs/LIMITS.md`.

### 0.5 App shell and design system
- Chalkline's design language and structure (patterns only): tokens, light/dark, Inter bundled, warm neutral + blue accent, shadcn-style components, Lucide icons, Chalkline breakpoints.
- Top bar (mark, menu with What's new dot, theme toggle); menu popover; Help, What's new and About as sheets, hash-routed.
- Help topics as Markdown files; What's new renders CHANGELOG.md; About shows build info, Copy details, privacy and credits.

### 1 Echo room
- Room code in the hash route; name entry; server assigns id and colour.
- Create-room endpoint gated by passcode; signed room codes (HMAC) verified before any Durable Object is touched.
- Creation rate limits (per IP and global daily) and `CREATION_ENABLED` kill switch.
- Name unverified notice in the UI.

### 2 Shared stickies
- Server is the source of truth; clients send intents. Optimistic local update with rollback, rev-based stale rejection, throttled drag batches.
- Caps: 200 notes per room, 280 characters, message size, per-socket message rate.
- Notes persisted in the Durable Object's SQLite on commits only (add, edit, final move, delete). Idle rooms expire since v0.14.0 (slice 5, trimmed).
- Known gaps, closed in slice 2.7: colour change after adding, and per-note size.

### 2.5 Board UX
- React Flow canvas, controlled: notes stay in our store. Full-bleed board, no scrollbars, pan by gesture, pinch/Ctrl+wheel zoom, fit-to-notes, minimap from `md`.
- Left tool rail and bottom view bar on desktop; bottom ribbon on phone; one tool registry feeding both.
- Floating chat (unsaved) and a Participants sheet replace the slice 1 message box and People list.

### 2.6 Panels (palette and properties)
- Left panel is a palette modelled on Chalkline's shapes list: vertical scroll, search, collapsible, resizable, grouped into labelled categories driven by a registry.
- "Notes" category ships six tiles, one per colour (yellow, pink, blue, green, orange, purple). Click to add at the viewport centre, or drag onto the board. This replaces the separate colour picker.
- Right Properties panel (collapsible, resizable): board summary when nothing is selected; selected note shows title (first line) and body, read-only colour, author, delete. Colour change waits for 2.7.
- Panel width and collapsed state are saved in browser storage (`stickyard:` keys); About > Privacy updated.
- Phone: bottom ribbon stays; Add note opens a compact add sheet from the same registry; the editor sheet is the properties UI.
- Palette registry accepts room-state-derived items (selector returns nothing today) so facilitator-defined tiles can arrive later with no panel changes.
- Selection is stored as a set of note ids (UI sets zero or one for now); note size comes from a single lookup that returns the default constant, so 2.7 and 2.8 don't rewrite components.
- No Stencils tab until a stencil exists.
- Also diagnose and fix: editing a note while the Hand tool is active.

### 2.7 Note size, colour and text style (protocol v4) — done, v0.6.0
- Notes gain width and height in board units. Existing notes migrate to the default size (stored-schema version bump, migration tested). Min and max size constants; the server clamps so a note stays fully on the board.
- Resize handles on the selected note (corners), pointer events, 44px touch hit areas, keyboard resize. Non-final resize messages are throttled and broadcast only; persisted on the final message (same rule as moves).
- Note text wraps and clips safely at any size; the 280-character cap is unchanged.
- Optional `color` on `noteEdit`, so colour can change after adding. Properties panel enables the swatches and shows width/height fields.
- v3 clients get "please reload". Tests first, as for every protocol change.
- Added at the user's request: text style keys on `noteEdit` (font size s/m/l/xl, bold, italic, text colour with Auto, alignment left/centre/right), styles applying to the whole note. Also, outside the slice scope at the user's request: the menu stacks above the side panels, chat messages show when they arrived, and the floating chat can be resized.

### 2.7.1 Title alignment (protocol v5) — done, v0.6.1
- Notes gain `titleAlign`: the title (first line) and the body are aligned separately (left, centre, right). Stored schema 2 -> 3; existing titles take the note's existing alignment, so nothing looks different.

### 2.7.2 Title styling (protocol v6) — done, v0.6.2
- Notes gain `titleFontSize`, `titleBold`, `titleItalic`, `titleTextColor`; `fontSize`, `bold`, `italic`, `textColor` are now the body's. Stored schema 3 -> 4; existing titles copy the note's existing style, so nothing looks different. Properties and the phone editor get a Title text and a Body text section with the same fields.
- Worst-case snapshot is now 401,829 bytes (about 120 KiB under the 512 KiB cap; see LIMITS.md).

### 2.8 Multi-select and arrange (protocol v7) — done, v0.7.0
- Built as planned below, mouse-first: left-drag on empty canvas is a marquee, right/middle drag pans, touch and pen still pan (decided by pointer type). One `noteBatch` message (move/resize/delete entries, 50 a batch) with per-entry errors; final batches in one transaction; a separate per-socket entries budget. Editing colour or style for several notes at once is not in it (fields show Mixed, disabled). See docs/architecture/canvas.md "Multi-select and protocol v7".

- Selection set from 2.6 becomes real: marquee on the Select tool, Shift/Ctrl-click to toggle, Ctrl+A. Dragging one selected note moves the whole selection.
- Floating selection bar at the top of the canvas, like Chalkline: Align (left, centre, right, top, middle, bottom), Distribute (horizontal, vertical), Match size (width, height, both). Pure, tested layout functions.
- Properties panel shows "N selected" with delete (confirm) and mixed-value display.
- One batch message for multi-note changes (move, resize, delete), capped in entries and bytes: each entry validated, each note gets its own rev bump, one SQLite transaction, one broadcast. It counts as one message for the rate budget.
- Phone: multi-select is out of scope.
- Save as stencil waits for slice 7. Z-order is not in 2.8 (see the Z-order slice, done in v0.8.0); a layers panel is backlog.

### 2.9 Inline note editing (web only) — done, v0.7.1
- From md up (mouse, pen, keyboard) a note's text is edited on the note: two plain textareas styled like the note, placeholders "Type a title" / "Type body", the existing draft mechanism, noteEdit on commit. New notes, double-click (title or body) and Enter start it; Properties stays in sync and is used for off-screen notes and finger taps. Phones keep the sheet.

### 3a Presence: avatars and toasts — done, v0.13.0
- Split from slice 3. Avatar stack in the top bar (participant colours, overflow count) opens the Participants sheet; join/leave toasts.
- Built with Reconnect on one branch (PR #28). No protocol change, confirmed. From md up the Participants button is an avatar stack (you first, three faces, then +N); phones keep a count button; the accessible name gives the number of people. Toasts are batched (a burst is one summary), polite and plain text; none for yourself, the list on joining, your own reconnect's churn, or someone else's quick reconnect (a leave waits 3 s; found in a real-browser run). Trade-off: a second person with the same name as someone present gets no join toast.

### 3b Presence: live cursors — done, v0.19.0
- Done in v0.19.0 (PR #37, protocol v14, no stored-schema change), one branch in three parts, tests first. `cursor`/`cursorLeft` from pages, `cursorMoved`/`cursorGone` to the others only (id from the socket), clamped, zero storage calls, nothing scheduled. Own per-socket bucket `CURSOR_LIMITS` 15/s, burst 20 (never SOCKET_LIMITS); drops silent up to 100 in 10 s, then violations. `cursorGone` before `participant_left` and before `sessionEnded`. Web sends from md up with a mouse or hovering pen only, every 100 ms at most after a 1-unit move, only with someone else here; a separate memoised layer, counter-scaled, 5 s idle fade; Show / Share switches in Participants (stored). Cost: about 0.5 DO requests/s per person moving non-stop; worst-case script per socket rises from about 1.6 to 2.8 DO requests/s (LIMITS.md). Checked with two pages in headless Chromium at 360/768/1280 in both themes.
- The original plan, for reference:
- `cursor { x, y }` in board units, max ~15/s, only when position changed, only while another participant is present, paused when the tab is hidden or the pointer leaves the board. Phones receive only.
- Server: separate cursor rate budget, forward to others only, zero SQLite writes (tested), sender identity, name and colour always from the socket's participant record, clamped to the board.
- Client: remote cursors hide after ~5 s idle and on leave/disconnect, cleared on reconnect; labels plain text, truncated; motion in its own memoised layer so notes don't re-render.
- LIMITS.md: record measured request cost per active user; confirm idle rooms still hibernate.
- Phone sending its own touch position: possible later option, not in this slice.

### 4 Reconnect — done, v0.13.0
- Built (PR #28, web only, no protocol or stored-schema change): automatic reconnect in the same session (backoff about 1, 2, 4 ... 30 s with ±20% jitter, 8 tries, then Offline with Rejoin; tries at once on `online` or the tab becoming visible; none while hidden for more than a minute). After 3 failed opens with a failing `/health`, a "may be unreachable or over its daily limit" state with one probe a minute (at most an hour). Fatal outcomes don't retry; room full on a reconnect offers Rejoin. At the drop the board goes back to what's confirmed and one notice counts what may not have been saved; drafts survive. Snapshots replace the board on resync. The 0.12.0 stale-undo-button bug is fixed. Costs and what a browser can see at the limit: LIMITS.md.
- Observed in a real browser: a relay restart enters the limit state after about 10 s of downtime, so recovery then waits up to a minute for the next probe (or Rejoin). Possible tweak in the backlog.
- Original notes:
- Detect a drop, show it, reconnect with backoff, full resync on rejoin. Resync applies both snapshots: the notes `snapshot`, then `framesSnapshot` (up to 18,306 bytes since v10); the board counts as joined after the first.
- Show a clear "relay is over its daily limit" state instead of reconnecting in a loop.
- A reconnect clears undo history (ids and revs can't be trusted). Also fix the known v0.12.0 bug: when a waiting undo entry is dropped after 10 s, the bar's Undo/Redo buttons don't refresh.
- Decided: no offline edit queue. Editing stays blocked while disconnected.
- Payload: keep the existing figure, about 412.6 KiB per person on a full board with a full set of frames (422,535 bytes, two messages; see LIMITS.md); note the request budget impact.

### 5 (trimmed) Idle expiry — done, v0.14.0
- Built (PR #30; no protocol bump, no `SCHEMA_VERSION` bump): when the last socket closes, the room sets its alarm 7 days ahead (`ROOM_IDLE_EXPIRY_MS`), writing only when there's no alarm or it is more than 1 hour (`ALARM_RESET_SLACK_MS`) earlier, so come-and-go costs at most about one row an hour. Joining never touches the alarm (the alarm checks for open sockets instead of being cancelled). When it fires with nobody connected: `deleteAll()`, then one tombstone (`meta.expired_at`). A tombstoned room never re-initialises; every socket is accepted and closed with 4410 "expired". The web treats 4410 (only) as final on a first join or a reconnect: a "Session expired" page with a button to the start page, no retries or probes. Help and About > Privacy updated.
- Decided in the slice: the tombstone is one meta row with the expiry time, kept forever (tens of bytes per room). Rooms created before v0.14.0 get their first alarm at their next last-close; ones nobody visits again aren't swept.
- Checked in headless Chromium against a local relay: a real last-close set the alarm 7 days ahead; the expired page at 360/768/1280 in light and dark (expiry itself simulated in local storage, since a local alarm can't be fired early).
- The live Cloudflare alarm docs couldn't be re-read from the build environment (network blocked); LIMITS.md uses the figures checked by hand on 4 October 2026.
- Original notes:
- When the last socket leaves, the room sets a Durable Object alarm N days ahead; a join cancels it. When it fires, the room deletes its own storage and leaves a small tombstone, so a validly signed old link says "this session has expired" instead of showing an empty board.
- Why now: idle rooms cost almost nothing in compute (hibernation), but their data and links never die, and there is no way to list or sweep rooms.
- Open: check current Cloudflare alarm billing and limits before writing the prompt; decide the tombstone's design. Own branch; stored-schema change.

### 6 Facilitation (split)
- (a) done, v0.15.0 (PR #31, protocol v12, no stored-schema version change): stateless host token (HMAC of the room id, returned only by POST /rooms, kept per room on the creator's device), claimHost per socket, lock (non-hosts' board changes refused with board_locked; every message type classified), timer (start + duration by the server's clock, serverNow for the offset), End session (4411, ended_at tombstone through the same burial path as expiry: drop + tombstone in one transaction, then deleteAll and the tombstone again). Lock and timer are meta keys and ride on joined. The web stores the token, claims host on every join, keeps isHost/locked/timer in state, rolls back board_locked, and shows "Session ended". No visible host UI yet. The health probe threshold went from 3 to 5 in the same release.
- (b) done, v0.16.0 (PR #33, web only, no protocol or schema change): a timer chip in the top bar for everyone (relay clock via serverNow, recomputed from timestamps, ticks only while visible; "Last minute" and "Time's up" by text and tokens, no animation; polite announcements only at start, 1 minute left and end; hides 10 minutes after finishing). Host: a Timer tile under a Facilitation palette category (host only via `fromRoom`) opening a picker (presets 1–30 min, custom minutes 1 s to 3 h), Restart/Stop (Stop asks with over a minute left); Lock board toggle (pending until the relay answers, "Locked" marker); End session next to Clear board (one confirm). Guests on a locked board: a calm banner and every board control off with "The board is locked by the host." (courtesy; board_locked still rolls back). Host badge in Participants, named avatars with a crown. Phones: the host's controls in a Session section of the Participants sheet. Checked in Chromium with a host and a guest page at 360/768/1280 in both themes; that found a top-bar overflow at 1280, fixed by making History/Edit/Order icon-only and folding Order and Session into panels below xl.
- Decided in (b): host powers can't move to another device in this version (Help says so); no sound; a finished timer stays until stopped, replaced, or 10 minutes pass.
- Timer and lock board, two sessions:
  - (a) Protocol v12 + stored schema, tests first: a minimal host token issued at creation, a lock flag, the timer as start time + duration (each client counts down locally), and End session (broadcast, close sockets, delete storage, tombstone).
  - (b) UI: a Timer tile under a Facilitation palette category, a lock control, banners, host-only gating, Help.
  - Decided: a minimal host token is included, because a lock anyone can undo is not a lock.
- Dot voting, two sessions: a vote budget per person enforced by the server, host start/stop, a results display.
  - (a) done, v0.17.0 (PR #35, protocol v13, stored schema 8): a voter is an HMAC of the room id and a random key the page makes and keeps per room (the relay never stores the key; a reload, second tab or reconnect is the same voter); budget 1 to 20 (default 5) checked by the relay; several dots on one note and on your own notes allowed; at most 40 voters a round (voters_full). Host voteStart (new round, earlier votes deleted), voteStop (totals to everyone), voteClear. Anonymous: confirmations go only to the voter's own sockets, nothing to anyone else while open, and totals never say who. A note's votes go with it in the same transaction; burial drops the votes table. Votes aren't board writes, so a locked board still takes them. The web keeps the key under `stickyard:voter:<room id>`, claims on every join, and keeps my votes (optimistic, rolled back on refusal), dots left and results in state. No visible voting UI. Checked in headless Chromium against a local relay.
  - (b) done, v0.18.0 (PR #36, web only, no protocol or schema change): a voting strip under the top bar (dots left; polite announcements only at start, last dot and end), my dots as badges above notes, − / + on the selected note (a React Flow NodeToolbar, 44px at any zoom), in Properties and the phone editor sheet, D / Shift+D on a focused note; every off control says why; the lock never blocks voting. Host: budget stepper, Start / Start a new round, Stop and reveal, Clear votes in the Session group and the phone Session section. Results: Total and Top voted badges, a sorted Results list in Properties and a phone Results sheet; a row selects and reveals its note. Help topic Dot voting. Checked with a host and a guest in headless Chromium at 360/768/1280 in both themes (a narrow-panel results row fixed before merging).
- Silent brainstorm with reveal, three parts (part 1 brought ahead of Follow on 8 October 2026). Riskiest slice; own branch.
  - Part 1 done, v0.25.0 (protocol v17, stored schema 10; relay and shared only, no web UI). Decisions: notes added while a round is silent are sealed (stored with `sealed` 1 and a `writer`); notes from before, frames, shapes and chat are unaffected. The writer is an HMAC of the page's existing per-room key (the voter key) under its own domain (`stickyard-writer-v1:`, so stored writer and voter ids can't be matched), learnt from an optional `key` in `join` (the smallest change: no extra round trip, and the snapshot is built after it), kept in the socket attachment (it survives hibernation; never re-derived, since the raw key is never stored), stored only on sealed notes, never sent, and set to NULL at the reveal. Everyone (host included) sees only their own sealed notes and one total count (`silentChanged`, one small broadcast per add or delete). Someone else's sealed note is answered exactly as an unknown id. Every outbound message passes through one filter per recipient (`worker/src/sealed.ts`, driven by the `SERVER_MESSAGES` registry), so a missed path can't leak. While silent: frameMove and starting a vote are refused for everyone (`silent_active`); frame edit, resize, add and delete and shapes stay allowed; a page without a writer can't add notes (`no_writer`); 40 sealed notes per writer (`MAX_SEALED_PER_WRITER`, `sealed_full`) within the 200-note room cap; nobody can vote on a sealed note. The reveal is one transaction (1 row per note plus the flag), then `notesRevealed` chunks of 50 (same id and rev as the writer's copies), then `silentChanged`; one way, and a later round is a new round. Burial drops sealed notes with everything else. The leak table is in `docs/architecture/notes.md`.
  - Parts 2 and 3 (web, not started): send the key in `join`; Start / Reveal for the host (warn when the board is locked); the count; my hidden notes marked; apply `notesRevealed` once (dedupe by id and rev); turn off Clear board, frame drags and Start voting while silent with the reason (the relay has no delete-all message, so Clear board's run must be stopped in the page); a Help topic. About > Privacy already describes the writer id.
  - (a) Clear board must be blocked in the web while a round is active (part 2). This is a courtesy: the relay already can't delete anyone else's sealed notes through it (they are unknown ids to everyone but their writer), it would only clear the visible ones and leave the sealed ones behind.
  - (b) Rollback caution: reveal or end the round before rolling back the Worker. A Worker older than v0.25.0 doesn't know the `sealed` column and would send sealed notes to everyone.
  - (c) The stacking-order hint is accepted: notes and shapes share one z space, so while silent a visible note's z can reflect that sealed notes exist (for example a new note lands above them). Never their content, id, place, size, colour or author; the count is public anyway.
  - Host loss during a round: only the host's device can reveal, so a lost device leaves sealed notes hidden until expiry. Part 3's host UI must warn before starting a round. Host recovery (backlog) is now higher priority.
  - Accepted side channels (not leaks of note data): live cursors near a writer who is typing show where a hidden note probably is; and in a very small room, the timing of count changes can attribute a hidden note to the one person who was typing. Neither carries content, id, place, size, colour or author.
  - Anonymous notes mode stays in the backlog: after the reveal a note's author is its participant id, as for any note.
  - The host can use Bring to me (a later slice) to take everyone to the reveal.
- Facilitator-defined note palette (host-only, a small list of { id, colorKey, label } from a fixed set of token colours, caps on entries and label length, labels untrusted plain text): no slot yet; see the backlog.

### Export PNG/Markdown (done, v0.22.0)
- One session, so a retro leaves something behind. Moved out of 7c. Web only: no protocol or stored-schema change. Built in two parts on `phase-export`, tests first: Markdown (`export/markdown.ts`, pure, every room string escaped), then PNG (`export/png.ts`, html-to-image 1.11.13 pinned and loaded with a dynamic import). Both from Properties with nothing selected, md and up, for hosts and guests, locked or not, connected or not. Details in `docs/architecture/canvas.md` ("Export").
- Checked in Chromium (768 and 1280, light and dark, a board with frames, notes, shapes, revealed votes and another person's live cursor): the PNG has the Inter font, no cursor, grip, dot grid or selection marks, and is the same image whatever the zoom.
- Export on phones and Export selection only are in the backlog.

### Board size (protocol v16, done in v0.23.0)
- Built 8 October 2026 on `phase-board-size`, tests first. `BOARD_WIDTH`/`BOARD_HEIGHT` 6400 x 4000; `PROTOCOL_VERSION` 16 (v15 pages get "please reload"); no stored-schema bump (rows from the old board load unchanged, nothing written, tested). Unchanged by decision: note sizes (96 to 480), frame and shape maxima (2400 x 1600), `MIN_ZOOM` 0.1, `MAX_ZOOM` 2, `FIT_MAX_ZOOM` 1. The one literal copy found was `CursorLayer`'s fallback (`readPxToken("--sy-board-width", 3200)`), now the constants. Tests that used old-board numbers now use expressions of `BOARD_WIDTH`/`BOARD_HEIGHT`; a shared test fails if any coordinate in a worst-case message reaches 5 digits.
- Measured: frames snapshot 18,366, shapes 167,786, combined 590,381 bytes (as predicted); notes snapshot (404,229), batches, `itemsAdd` counts and `frameMove` unchanged. The frames snapshot is now 66 bytes under its 90% tripwire (18,432).
- Checked in Chromium: an empty board opens at the board's middle at 100% (360, 768 and 1280); a note dragged to the far corner auto-pans there and lands at (6240, 3840), shown in the minimap and kept after a reload. Awkward, left for Navigation and Panel layout: at 1280 the zoom-out stops near 19%, not 10% (React Flow keeps the pan extent covering the canvas, so the canvas height sets the floor); Fit to notes with a note in the far corner lands at about 12%, where text is unreadable and the corner sits under the minimap; on a phone notes in opposite corners can't both fit (fit stops at 10%); the minimap shows a small cluster in a big board.
- Decided 7 October 2026: the board grows 2x each way, from 3200 x 2000 to 6400 x 4000 (not 3x). The goal is room to work and easy navigation, not fitting the whole board on screen, so `MIN_ZOOM` stays 0.1 (at 0.1 a 6400-unit board is 640 px wide, so only screens wider than that see all of it).
- `BOARD_WIDTH` / `BOARD_HEIGHT` live once in `shared/src/protocol.ts` and are used by the relay (clamps on every add, move, resize, batch and `itemsAdd`, and the re-clamp on load) and by the web (notes size, templates placement, arrange/Grid, pan extent, the board node and its edge, the minimap, cursors, the Properties board summary). Frame and shape maximum sizes (2400 x 1600) don't depend on the board.
- Protocol v16 because a v15 page's schemas refuse positions past 3200 x 2000; mismatched pages get "please reload". No stored-schema bump: every stored position is still on a larger board, so the load-time clamp changes nothing.
- Message sizes: coordinates stay 4 digits at 6400 x 4000. The worst-case frames and shapes snapshots gain 1 byte per coordinate (their worst-case positions go from 3 to 4 digits): frames 18,306 -> 18,366 bytes (still under the 18,432-byte tripwire), shapes 167,686 -> 167,786; notes snapshot, batches, `itemsAdd` counts and `frameMove` unchanged. Tests with exact sizes or hard-coded positions (for example clamping at x 3000 or 5000) need updating; LIMITS.md gets the new figures in the slice.

### Panel layout at 768 px (done, v0.24.0)
- Built 8 October 2026 on `phase-navigation` (part 1 of 2), tests first, web only. Cause of the far-out first fit: not a timing race (the canvas was 360 px from the first measurement at 768 and the fit used it), just the narrow canvas between two open panels (palette 176 + Properties 232 at 768, `CANVAS_MIN` 360). Fix: `panels/layout.ts` `initialPanelState` / `storedPanelState`: a well-formed stored entry (width or collapsed) always wins; with none (or a malformed one), open from lg (1024) up and collapsed below it. The default is decided once when `panelStore` is made (before the board's first render), so the first fit sees the final canvas; it's never written, so only a person's own change is remembered.
- Measured in Chromium with the shots board (4 notes, 2 frames, 4 shapes) at 768 x 1024: first fit **16%** before (canvas 360 px), **39%** after (canvas 664 px); with both panels stored open it stays 16%. 1024: 29%, 1280: 48% (unchanged: panels open there).
- Both panels opened by hand at 768: the view bar (388 px with Zoom to selection) no longer fits the 360 px canvas, so it wraps onto two rows (`Bar` `flex-wrap`, `rounded-lg` when wrapped; `RoomBoard` measures the bar and sets `.sy-bar-wrapped`, which raises `--sy-above-bar` by `--sy-bar-h-wrapped` so the minimap and chat button stay above it). Nothing runs under the panels. The board keeps its centre when a panel opens, as before.

### Navigation (done, v0.24.0)
- Built 8 October 2026 on `phase-navigation` (part 2 of 2), tests first, web only, no protocol or stored-schema change. Pure rules in `canvas/navigation.ts`; view changes go through `useCanvasView`'s one `go` path (`fitItems`, `zoomTo`, `jumpTo`, `centreAt`), animated `VIEW_ANIMATION_MS` 200, 0 with reduced motion.
- Fit to notes: `fitPlan` fits everything unless that zoom (`fitZoom`, before the 10% floor) is below `FIT_READABLE_ZOOM` 0.25; then the largest cluster (items linked by edge-to-edge gaps under `CLUSTER_GAP` 600, union-find; most items, then nearest the board centre, then higher, then further left). "Some items are out of view." with **Show all** (the old floor-free fit) and Dismiss; also on the first fit. Everything readable, one cluster or an empty board: exactly as before.
- Zoom to selection: view-bar button (md up, `Focus` icon) and **S** (unused before: + - 0 F V H N M, D for dots, [ ], Delete, Ctrl combos). Off with `aria-disabled` and a visible tooltip reason (`Tool.explain`), never above `FIT_MAX_ZOOM`.
- Go to a person: Participants (one component: the bottom sheet on phones, the right panel from md) has **Go to** per other person; it closes the sheet, pans to their last known pointer at the same zoom (raised to `JUMP_MIN_ZOOM` 0.5) and says "Moved to <name>'s pointer." (plain text, 16 characters). Last positions: `cursorStore.lastSeen`, apart from the fading cursor map; kept through the fade and `cursorGone`, cleared by `CursorSink.left` (participant_left) and `clear` (joined, drop, resync). Never stored; tracked with Show cursors off.
- Minimap: was already `pannable` and `zoomable`; added click-to-centre (`onClick`, ignored after a drag past the threshold). The marquee already ignored it; checked in Chromium that a drag in it pans without a marquee or losing the selection. M unchanged.
- Checked in Chromium (1280 and 768, light and dark; two pages for Go to): the outlier board (a note at 6150, 3780) opens at 48% on the cluster with the notice; Show all goes to 12%; S on one note goes to 100%; a minimap click recentres and a drag pans. Awkward: after Show all the far-corner note sits under the minimap; the minimap still shows the whole board, so a small cluster is a speck in its corner (not cheap with React Flow 12's MiniMap, whose bounds include the board node; backlog).

### Follow and Bring to me (protocol v19 expected; v17 and v18 went to silent brainstorm)
- (a) Follow: opt-in. While at least one person follows someone, that person's viewport (x, y, zoom) is relayed to their followers only, at most about 5 a second, with its own per-socket rate bucket like `CURSOR_LIMITS` so it never starves edits. Nothing stored, nothing scheduled. Following stops when the follower pans or zooms.
- (b) Bring to me: host only. One message relayed to everyone, shown as a banner with a "Go there" button, never a forced move. Reduced-motion aware (no animated flight), rate-limited.
- Cost to work out at slice start, for LIMITS.md: viewport messages bill 20:1 like cursors.
- Open decisions: whether followers are tracked in the socket attachment; a cap on followers; phones can follow but not send.

### 9 (trimmed) Hardening
- Load test and accessibility pass only. Message-rate limits and malformed-message tests already exist; keyboard support and reduced motion are handled slice by slice.
- Comes after Silent brainstorm with reveal (order of 7 October 2026), so the load test covers the new paths (withheld text, reveal, follow and bring-to-me messages).

### Reactions on notes
- A fixed set of emoji reactions on notes (moved from the backlog to a planned slice). Protocol change and its own branch; about one stored row per reaction. Caps and the cost go in LIMITS.md at slice start. Comments on notes stay in the backlog.

### More built-in templates
- More templates as data entries in the template registry only: no protocol or schema change. Any time, as filler between slices. Templates created by users stay in the backlog (they need a storage decision, because there are no accounts).

### Z-order (protocol v8) — done, v0.8.0
- Bring to front / send to back, because frames and shapes will overlap notes. Notes gain a server-assigned `z` (bounded ±100,000; renumbered at the bound); stored schema 4 -> 5 backfills z from creation order, so nothing looks different. One `notesOrder` message (front | back, up to 50 ids, chunked in stacking order beyond that), one transaction, one `notesOrdered` broadcast; only notes whose z changes are written. Selecting, dragging and resizing no longer raise a note (React Flow's elevate-on-select off). Order buttons in Properties, the phone editor and the selection bar; no shortcut. See docs/architecture/notes.md "Z-order, protocol v8".
- Not in it: forward/backward one step, a layers panel (backlog). Tab order and the minimap still follow creation order.

### Frames (protocol v9) — done, v0.9.0
- A named, resizable, coloured area that always sits behind notes, in its own `frames` table (schema 6). Palette tile (md and up), title typed in the header, colour and size in Properties, delete never removes notes. Phones show frames only.
- Decided: dragging a frame carries the notes whose centre is inside it (computed when the drag starts, never stored), by one delta clamped for the whole group, in one transaction with one `frameMoved`; Alt moves it alone; more than 50 inside moves it alone with a notice.
- Frames come in their own `framesSnapshot` right after the notes snapshot (the notes snapshot was too close to its 400 KiB tripwire to carry them). See docs/architecture/frames.md "Frames, protocol v9".


### Frame title styling (protocol v10) — done, v0.9.1
- A frame's title gets the note title's style keys (size, bold, italic, ink, alignment) in a Properties "Title text" section. Stored schema 7 adds five columns with defaults that look like the v9 header, so existing frames are unchanged. Header height follows the size. Frame-only ink tokens, because frame headers are dark in the dark theme.
- Decided 4 October 2026: the framesSnapshot test cap goes from 16 to 20 KiB (worst case 18,306 bytes); a new per-frame field within 10% of the cap needs a decision first. See docs/LIMITS.md.

### Templates (web only) — done, v0.10.0
- Retro, Start Stop Continue, 2x2 Impact and Effort, Sprint planning, as plain data (`web/src/templates/registry.ts`), frames only (no starter notes). A Templates palette category (md and up). Applied anywhere on the board, centred on the view or the drop point and clamped; nothing existing is touched; needs enough free frame slots up front.
- Each frame is a `frameAdd`, then after the relay confirms it a final `frameResize` and one `frameEdit` for the title style, paced at 10 messages a second. A refusal part-way leaves what was made and says so; no retry. Others see each frame appear at the default size, then settle.
- Since v0.11.0 a template is one `itemsAdd` (see Create with content): its frames appear at their size and style in one step.

### Delete polish (web only) — done, v0.10.1
- Delete (or Backspace) with notes selected and nothing else focused deletes them all; a focused note outside the selection deletes the selection, never itself. Never from a field, a sheet, the top bar or chat, or on phones.
- Several notes always ask once, with the count. Not connected: no confirm, and the board says nothing was deleted.
- The board reports how a multi-note delete went once the relay has answered for every note: all deleted, or how many weren't and why (too quick, refused, connection lost). Chunks of 50 as before; no protocol change.

### Selection fixes (web only) — done, v0.10.2
- User report: selecting a frame and pressing Delete did nothing (the click focused the title input that filled the header), and a multi-selection was hard to see.
- A frame's title takes presses only while it's being edited: a click selects the frame (and drags it); double-click, Enter on the selected frame, or Tab edits the title.
- Fixed a 0.10.1 regression found in a real browser: a click on the canvas focuses the app's `<main>`, which the Delete rule didn't count as the board's.
- Selection: thicker accent outline; with several notes, a tick badge on each and a dashed box round them all.

### Arrange grid (web only) — done, v0.10.3
- Arrange > Grid in the selection bar (md and up, 2+ notes): reading order (top row first, left to right), each column as wide as its widest note and each row as tall as its tallest, a 24-unit gap, sizes unchanged, anchored at the selection's top-left and kept on the board. Running it again changes nothing.
- Columns stepper (1 to the count) or Auto (picked from the selection's shape); the choice lasts for the session. Off, with the reason shown, below 2 notes, offline, while a selected note is being moved or resized, or before new notes are saved.
- A grid larger than the board moves nothing and the board says why (too wide, too tall, too big). Uses the existing batch moves; no protocol change. Frames are not used as grid containers.

### Create with content (protocol v11) — done, v0.11.0
- Client `itemsAdd { clientRef, notes?, frames? }`: 1 to 50 items in total, each entry with a `ref` and every content field (no id, rev, z or author), the whole message within 4 KiB. Server `itemsAdded { clientRef?, notes, frames, refused }` (refs and refusals only in the sender's copy). Refusal reasons: `invalid`, `notes_full`, `frames_full`. Nothing added: an error to the sender only.
- Decided: `MAX_MESSAGE_BYTES` stays 4 KiB; the web packs items by actual serialised size. Items per message are decided by bytes, not the 50-item limit: 2 notes at their largest, 6 frames with the longest titles; 15 notes or 21 frames with short content.
- New notes get z one at a time; a renumbering at the bound is written in the same transaction (and broadcast first). 2 rows written per item.
- Fan-out worst case (50 maximum notes) is 103,653 bytes, about 20% of the 512 KiB server cap. Templates now apply in one step. No stored-schema change.

### Floating bar, Duplicate, Undo/Redo, Clear board (web only) — done, v0.12.0
- One branch (`phase-bar-undo`, PR #26), four parts, web only, no protocol change.
- Floating bar: permanent from md up. Groups History (Undo, Redo), Edit (Duplicate, Delete), Order (Bring to front, Send to back), Arrange (Align, Distribute, Grid, Match size). A command that can't be used is disabled with the reason shown as text, never hidden. Phones get only Undo and Redo, on the ribbon. Bar height at 1280 with both panels open is about 178px; a possible 0.12.1 tidy-up is in the backlog.
- Duplicate (button and Ctrl/Cmd+D): copies selected notes with full content, offset by one token and clamped as a group, on top in the originals' order; a selected frame is copied alone. Sent with `itemsAdd`; refused up front when there isn't room for every copy.
- Undo/redo rules:
  - Your own actions only. Items someone else changed since are skipped and reported.
  - Restored items get new ids and the restorer as author; ids in older history entries are remapped to them.
  - Reconnecting or leaving clears history. Depth 50 plus a size cap (about 2 MB).
  - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on the board only, never in text fields.
  - An action is recorded straight away, but its Undo stays disabled until the relay confirms it ("Wait until your last change is saved."); unanswered waits are dropped after 10 s.
  - A note being dragged, resized or typed into blocks undo. Final moves/resizes of the same notes within 500 ms merge into one step.
  - Bring to front / Send to back are not undoable in v1 (the server owns z; fixing it needs a new message, backlog). When the last action was an order change, the first Undo only shows "Order changes can't be undone." and the next press undoes the action before it. A change that only touches z, by someone else, does not block your undo.
- Known small bug, fixed in v0.13.0 (Reconnect): when a waiting undo entry was dropped after 10 s, the bar buttons didn't refresh.
- Clear board: in Properties when nothing is selected. One confirm with counts. Notes first in batches of 50, then frames (one `frameDelete` every 50 ms). One history entry, so a single undo restores it, through a paced restore with a visible "Restoring N of M…" status. A full-board restore at the 4 KiB cap is 105 messages (about 10.5 s).

### 7a Text box and basic shapes (done, v0.21.0)
- One new object, the shape: `kind` text | rect | oval | diamond (a text label is a shape with no fill and no border). Text up to 500 characters; seven text sizes (heading sizes); bold, italic, underline; horizontal and vertical alignment; fill, border colour, width and style. Keys only, tokens in both themes, every ink 4.5:1 on every fill and the board.
- Protocol v15, stored schema 9 (a `shapes` table). At most 50 shapes a room; worst-case `shapesSnapshot` 167,686 bytes (192 KiB test cap, 90% tripwire). Notes and shapes share one stacking space (`notesOrder` accepts shape ids); frames carry shapes with notes (one 50-item cap); `itemsAdd` takes shapes with a `rank` so stacking survives duplicate and undo.
- Web: md and up edits (palette Shapes category, inline text editing, Properties for one or several shapes); phones show shapes read-only. Selection, marquee, group moves, Delete, Duplicate, Order, Arrange and undo/redo cover shapes.
- Also in v0.21.0: a built-in emoji picker (48 emoji, no library) beside text edited in place (notes, shapes) and in the Properties text fields (note title and body, shape text, frame title); it inserts at the caret, keeps the caps, is keyboard operable and stays inside the canvas. And a fix: Ctrl+A then Delete removes every note, frame and shape wherever focus is (a focused note or shape, or the Palette or Properties).
- Checked in Chromium against a local Worker at 360/768/1280 in both themes (screenshots); that found the emoji panel running under Properties, fixed before merge.
- Left for later: editing shapes on phones, arrows (7b), group boxes (7c), emoji in the frame header's own title field, emoji reactions (now the "Reactions on notes" slice).

### 7b Arrows
- Step (i): arrows with free endpoints and a line style.
- Step (ii): endpoints bound to notes and shapes, re-routed when a bound object moves, and a rule for what happens when a bound object is deleted.
- Connectors get their own palette category, again one entry per tile.

### 7c Structure
- Group box objects (their own protocol change), affinity grouping. (Templates, frames and export moved to their own slices.)
- Stencils tab in the left panel with packaged areas (sprint planning, brainstorming area and similar), and Save as stencil from a selection.

### 8 Phone view
- Add a note, vote, see the timer. Big canvas is for the shared screen. QR join.

### 10 AI (optional)
- Summary and sentiment of board content. Explicit buttons, confirmation with size estimate, add-only output, content treated as data. Key handling decided then.

## Open questions

- Stickyard name availability
- Yjs timing
- Real limits on the Cloudflare free plan at build time (re-check before designing around any number)
- Retros/brainstorms first vs general canvas
- Per-friend invite codes
- Real title field on notes (currently the first line of text acts as title; a real field is a schema change, could join 2.7)
- ~~Shapes and arrows (7a/7b) before or after facilitation (6)~~: decided 3 October 2026. Frames, templates and a cut-down facilitation slice (timer, lock board) come first; the rest of facilitation comes before 7a/7b. See "Order and principles".
- Borrowed from the Miro comparison (notes, not scope changes):
  - A small floating toolbar next to a selected note (colour, delete). Candidate to share a component with the 2.8 selection bar.
  - Corner resize keeps the aspect ratio and Shift frees it (review point for 2.7, which currently resizes freely).
  - Stronger note colours: check the `--sy-note-*` tokens in light and dark; notes and palette tiles look pale next to Miro. The fix would be token-only, possibly a patch release.
- Canvas: decided, React Flow (slice 2.5). Revisit only if performance with many movers is poor.
- Visual identity: settled in slice 0.5 (Chalkline-derived)
- ~~Timer/lock host token~~: decided 4 October 2026. A minimal host token is issued at creation in the timer and lock slice, because a lock anyone can undo is not a lock.
- ~~Cloudflare alarm billing and limits~~: checked 4 October 2026 for the idle-expiry slice (setAlarm = 1 row written, a firing = 1 DO request; see LIMITS.md).
- ~~Tombstone design for expired rooms~~: decided in v0.14.0. One meta row (`expired_at`), kept forever; an old link gets close code 4410 and a "Session expired" page.

## Backlog (no slot yet)

- Anonymous notes mode (not part of silent brainstorm part 1: after a reveal a note's author is its participant id, as for any note)
- Rollback during a silent round: a Worker older than v0.25.0 doesn't know the `sealed` column and would show sealed notes to everyone; reveal (or end) a round before rolling back
- Stacking shows only counts: while silent, a visible note's z can reflect sealed notes (one stacking space, so a new note lands above them); never their content, id, place, size, colour or author
- Saved boards / board history (needs a storage decision)
- Comments on notes (reactions are now a planned slice)
- Templates created by users (needs a storage decision: there are no accounts)
- Revocable invite codes per friend
- Spin-offs reusing the relay (planning poker, vote room)
- Phone sends its touch position as a cursor while a finger is down
- Layers panel, and forward/backward one step
- Minimap world fitted to the items plus the viewport instead of the whole board (v0.24.0 left it: React Flow 12's MiniMap takes its bounds from every node, including the board node, so it needs a custom minimap or a hidden board node); and keeping Fit and Show all clear of the minimap in the corner (a far-corner item can sit under it).
- Undoable order changes (needs a new message; the server owns z)
- ~~Bar height tidy-up (possible 0.12.1)~~: done differently in v0.15.1 (the bar moved into the top bar)
- Facilitator-defined note palette (host-only; from the old slice 6 notes)
- ~~Faster recovery after a relay restart or deploy~~: done in v0.15.0 (the probe waits for 5 failed opens, about 30 s)
- Sweep rooms that were idle before v0.14.0 (they only get an expiry alarm at their next last-close)
- Host recovery: move host powers to another device (today they stay on the device that started the session). Higher priority since silent brainstorm: a lost host device leaves a silent round's sealed notes hidden until the room expires.
- Timer pause and sound (v1 has neither)
- Add and edit shapes on phones (v0.21.0 shows them read-only)
- Emoji picker in the frame header's own title field (v0.21.0 has it in Properties only)
- Export on phones
- Export selection only
