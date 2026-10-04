# Phase plan: Stickyard

Last updated: 4 October 2026

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
| 4 Reconnect | Backoff, full resync applying both snapshots, "relay over its daily limit" state, clears undo history; no offline edit queue | Not started |
| 5 (trimmed) Idle expiry | Durable Object alarm deletes an idle room's storage and leaves a tombstone, so an old link says the session has expired. Stored-schema change | Not started |
| 6 (part) Timer and lock board | Two sessions: (a) protocol v12 + stored schema (minimal host token, lock flag, timer, End session); (b) UI | Not started |
| 3a Presence: avatars and toasts | Avatar stack in the top bar, join/leave toasts. Probably no protocol change (uses `participant_joined`/`participant_left`) | Not started |
| 6 (part) Dot voting | Two sessions: vote budget per person enforced by the server, host start/stop, results display | Not started |
| Export PNG/Markdown | One session, so a retro leaves something behind | Not started |
| 9 (trimmed) Hardening | Load test and accessibility pass (message-rate limits already exist since slice 2) | Not started |
| 6 (part) Silent brainstorm with reveal | The server withholds other people's note text until the host reveals it (snapshot and broadcast paths change). Riskiest slice | Not started |
| 3b Presence: live cursors | Live cursors (throttled, never stored). Protocol change | Deferred |
| 7a Text box and shapes | Text box and basic shapes (rectangle, oval, diamond), reusing 2.7's sizing and colour work | Not started |
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
- Every new object type (frame, timer, text box, group box) needs its own protocol/schema change with a version bump, caps and tests. The palette gets its tile with one registry entry; no placeholder tiles for things that don't exist.
- Each protocol or stored-schema change is its own slice and branch (2.7, 2.7.1, 2.7.2, 2.8, z-order, frames, 3b are separate for that reason).
- Protocol numbers are assigned when each slice starts, not in advance (v11 is the current one, since create with content; the bar, undo and clear work in v0.12.0 was web only).
- Order from here (decided 4 October 2026): Reconnect (4), Idle expiry (trimmed 5), Timer and lock board (two sessions), Presence 3a, Dot voting (two sessions), Export PNG/Markdown, Hardening (trimmed 9), then Silent brainstorm with reveal, then 3b cursors, 7a, 7b, 7c (remaining), 8, 10. Slice numbers are kept as names; the table above is in build order.
- Estimate to a demo-able retro tool (through trimmed hardening): about 11 to 13 Claude Code sessions, one per prompt, plus about 20% for reruns.

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
- Notes persisted in the Durable Object's SQLite on commits only (add, edit, final move, delete). No expiry yet.
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
- Built as planned below, mouse-first: left-drag on empty canvas is a marquee, right/middle drag pans, touch and pen still pan (decided by pointer type). One `noteBatch` message (move/resize/delete entries, 50 a batch) with per-entry errors; final batches in one transaction; a separate per-socket entries budget. Editing colour or style for several notes at once is not in it (fields show Mixed, disabled). See CLAUDE.md "Multi-select and protocol v7".

- Selection set from 2.6 becomes real: marquee on the Select tool, Shift/Ctrl-click to toggle, Ctrl+A. Dragging one selected note moves the whole selection.
- Floating selection bar at the top of the canvas, like Chalkline: Align (left, centre, right, top, middle, bottom), Distribute (horizontal, vertical), Match size (width, height, both). Pure, tested layout functions.
- Properties panel shows "N selected" with delete (confirm) and mixed-value display.
- One batch message for multi-note changes (move, resize, delete), capped in entries and bytes: each entry validated, each note gets its own rev bump, one SQLite transaction, one broadcast. It counts as one message for the rate budget.
- Phone: multi-select is out of scope.
- Save as stencil waits for slice 7. Z-order is not in 2.8 (see the Z-order slice, done in v0.8.0); a layers panel is backlog.

### 2.9 Inline note editing (web only) — done, v0.7.1
- From md up (mouse, pen, keyboard) a note's text is edited on the note: two plain textareas styled like the note, placeholders "Type a title" / "Type body", the existing draft mechanism, noteEdit on commit. New notes, double-click (title or body) and Enter start it; Properties stays in sync and is used for off-screen notes and finger taps. Phones keep the sheet.

### 3a Presence: avatars and toasts
- Split from slice 3. Avatar stack in the top bar (participant colours, overflow count) opens the Participants sheet; join/leave toasts.
- Probably no protocol change: `joined`, `participant_joined` and `participant_left` already carry what is needed. Confirm against the code when the slice starts.

### 3b Presence: live cursors (protocol change, deferred)
- Split from slice 3. Comes after the remaining facilitation work.
- `cursor { x, y }` in board units, max ~15/s, only when position changed, only while another participant is present, paused when the tab is hidden or the pointer leaves the board. Phones receive only.
- Server: separate cursor rate budget, forward to others only, zero SQLite writes (tested), sender identity, name and colour always from the socket's participant record, clamped to the board.
- Client: remote cursors hide after ~5 s idle and on leave/disconnect, cleared on reconnect; labels plain text, truncated; motion in its own memoised layer so notes don't re-render.
- LIMITS.md: record measured request cost per active user; confirm idle rooms still hibernate.
- Phone sending its own touch position: possible later option, not in this slice.

### 4 Reconnect
- Detect a drop, show it, reconnect with backoff, full resync on rejoin. Resync applies both snapshots: the notes `snapshot`, then `framesSnapshot` (up to 18,306 bytes since v10); the board counts as joined after the first.
- Show a clear "relay is over its daily limit" state instead of reconnecting in a loop.
- A reconnect clears undo history (ids and revs can't be trusted). Also fix the known v0.12.0 bug: when a waiting undo entry is dropped after 10 s, the bar's Undo/Redo buttons don't refresh.
- Decided: no offline edit queue. Editing stays blocked while disconnected.
- Payload: keep the existing figure, about 412.6 KiB per person on a full board with a full set of frames (422,535 bytes, two messages; see LIMITS.md); note the request budget impact.

### 5 (trimmed) Idle expiry
- When the last socket leaves, the room sets a Durable Object alarm N days ahead; a join cancels it. When it fires, the room deletes its own storage and leaves a small tombstone, so a validly signed old link says "this session has expired" instead of showing an empty board.
- Why now: idle rooms cost almost nothing in compute (hibernation), but their data and links never die, and there is no way to list or sweep rooms.
- Open: check current Cloudflare alarm billing and limits before writing the prompt; decide the tombstone's design. Own branch; stored-schema change.

### 6 Facilitation (split)
- Timer and lock board, two sessions:
  - (a) Protocol v12 + stored schema, tests first: a minimal host token issued at creation, a lock flag, the timer as start time + duration (each client counts down locally), and End session (broadcast, close sockets, delete storage, tombstone).
  - (b) UI: a Timer tile under a Facilitation palette category, a lock control, banners, host-only gating, Help.
  - Decided: a minimal host token is included, because a lock anyone can undo is not a lock.
- Dot voting, two sessions: a vote budget per person enforced by the server, host start/stop, a results display.
- Silent brainstorm with reveal: after export. The server must withhold other people's note text until the host reveals it, which changes the snapshot and broadcast paths. Riskiest slice; own branch.
- Facilitator-defined note palette (host-only, a small list of { id, colorKey, label } from a fixed set of token colours, caps on entries and label length, labels untrusted plain text): no slot yet; see the backlog.

### Export PNG/Markdown
- One session, so a retro leaves something behind. Moved out of 7c.

### 9 (trimmed) Hardening
- Load test and accessibility pass only. Message-rate limits and malformed-message tests already exist; keyboard support and reduced motion are handled slice by slice.

### Z-order (protocol v8) — done, v0.8.0
- Bring to front / send to back, because frames and shapes will overlap notes. Notes gain a server-assigned `z` (bounded ±100,000; renumbered at the bound); stored schema 4 -> 5 backfills z from creation order, so nothing looks different. One `notesOrder` message (front | back, up to 50 ids, chunked in stacking order beyond that), one transaction, one `notesOrdered` broadcast; only notes whose z changes are written. Selecting, dragging and resizing no longer raise a note (React Flow's elevate-on-select off). Order buttons in Properties, the phone editor and the selection bar; no shortcut. See CLAUDE.md "Z-order, protocol v8".
- Not in it: forward/backward one step, a layers panel (backlog). Tab order and the minimap still follow creation order.

### Frames (protocol v9) — done, v0.9.0
- A named, resizable, coloured area that always sits behind notes, in its own `frames` table (schema 6). Palette tile (md and up), title typed in the header, colour and size in Properties, delete never removes notes. Phones show frames only.
- Decided: dragging a frame carries the notes whose centre is inside it (computed when the drag starts, never stored), by one delta clamped for the whole group, in one transaction with one `frameMoved`; Alt moves it alone; more than 50 inside moves it alone with a notice.
- Frames come in their own `framesSnapshot` right after the notes snapshot (the notes snapshot was too close to its 400 KiB tripwire to carry them). See CLAUDE.md "Frames, protocol v9".


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
- Known small bug, to fix in the Reconnect session: when a waiting undo entry is dropped after 10 s, the bar buttons don't refresh.
- Clear board: in Properties when nothing is selected. One confirm with counts. Notes first in batches of 50, then frames (one `frameDelete` every 50 ms). One history entry, so a single undo restores it, through a paced restore with a visible "Restoring N of M…" status. A full-board restore at the 4 KiB cap is 105 messages (about 10.5 s).

### 7a Text box and basic shapes
- Text box, and a small fixed set of shapes: rectangle, oval, diamond. Reuses the sizing and colour work from 2.7.
- Each object type is its own protocol change with a version bump, caps and tests. Its palette tile is one registry entry in a new category; no placeholder tiles before the object exists.

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
- Cloudflare alarm billing and limits: check before writing the idle-expiry prompt.
- Tombstone design for expired rooms: what it stores, how long it stays, and what an old link shows.

## Backlog (no slot yet)

- Anonymous notes mode
- Saved boards / board history (needs a storage decision)
- Reactions and comments on notes
- Templates created by users
- Revocable invite codes per friend
- Spin-offs reusing the relay (planning poker, vote room)
- Phone sends its touch position as a cursor while a finger is down
- Layers panel, and forward/backward one step
- Frame multi-select: marquee picks up frames, delete them together. Bigger than it looks: arrange, Properties and batches assume notes only
- Frame-aware Grid (frames as grid containers)
- Undoable order changes (needs a new message; the server owns z)
- Bar height tidy-up (possible 0.12.1)
- Facilitator-defined note palette (host-only; from the old slice 6 notes)
