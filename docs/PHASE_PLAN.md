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
| 6 (part) Timer and lock board | Cut-down slice 6: shared timer and lock board only | Not started |
| 4 Reconnect | Resync after drops, offline queue | Not started |
| 3a Presence: avatars and toasts | Avatar stack in the top bar, join/leave toasts. Probably no protocol change (uses `participant_joined`/`participant_left`) | Not started |
| 5 Persistence | Room expiry and clear messaging (basic note persistence exists since slice 2) | Not started |
| 6 (rest) Facilitation | Silent brainstorm + reveal, dot voting, host token, facilitator-defined note palette | Not started |
| 3b Presence: live cursors | Live cursors (throttled, never stored). Protocol change | Deferred |
| 7a Text box and shapes | Text box and basic shapes (rectangle, oval, diamond), reusing 2.7's sizing and colour work | Not started |
| 7b Arrows | (i) Free endpoints and a line style; (ii) endpoints bound to notes and shapes, re-routed when a bound object moves, with a rule for deleting a bound object | Not started |
| 7c Structure (remaining) | Group boxes, affinity grouping, Stencils tab and Save as stencil, export (PNG/Markdown). Frames and templates moved to their own slices | Not started |
| 8 Phone view | Phone participant view, QR join | Not started |
| 9 Hardening | Message-rate limits, load test, accessibility pass | Not started |
| 10 AI | Summary and sentiment analysis, explicit buttons, add-only | Optional, last |
| Later | Yjs migration, anonymous mode, PWA | Parked |

## Order and principles

- Each rung gives a working result. Stop at any rung and still have something that works.
- Success criterion for the core: two phones and a laptop editing the same board reliably.
- Build slice 2 by hand (last-write-wins) before considering Yjs, so the problem Yjs solves is understood.
- Test on the live deployment; merge and deploy each slice, roll back if needed (single user).
- Every new object type (frame, timer, text box, group box) needs its own protocol/schema change with a version bump, caps and tests. The palette gets its tile with one registry entry; no placeholder tiles for things that don't exist.
- Each protocol or stored-schema change is its own slice and branch (2.7, 2.7.1, 2.7.2, 2.8, z-order, frames, 3b are separate for that reason).
- Protocol numbers are assigned when each slice starts, not in advance (v10 is the current one, since frame title styling; templates were web only).
- Order after 2.9 (decided 3 October 2026): Z-order, Frames, Templates, Timer and lock board (cut-down 6), Reconnect (4), 3a, Persistence and expiry (5), remaining facilitation (6), 3b cursors, 7a, 7b, 7c (remaining), 8, 9, 10. Slice numbers are kept as names; the table above is in build order.

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
- Detect drop, show state, reconnect with backoff, full resync on rejoin, queue changes made offline and reconcile.
- Show a clear "relay is over its daily limit" state instead of reconnecting in a loop.
- A full snapshot is up to about 395 KiB (404,229 bytes, worst case for 200 notes since protocol v8; see LIMITS.md) per reconnect; note the request budget impact.
- A reconnect sends two messages: the notes `snapshot`, then `framesSnapshot` (up to 18,306 bytes since v10); resync must apply both, and treat the board as joined after the first.

### 5 Persistence and expiry
- Rooms expire after a set idle time; clear messaging about it. (Basic note persistence already exists.)

### 6 Facilitation
- Split in two. A cut-down slice comes early (after templates): shared timer (start time + duration, local countdown) and lock board. The rest comes after persistence: silent brainstorm with reveal, dot voting with a vote budget.
- Host token issued at creation; facilitator role and what happens if the host leaves; "end session".
- Facilitator-defined note palette: host-only, a small list of { id, colorKey, label } stored in the room, chosen from a larger fixed set of token colours (12 to 16), not arbitrary hex. Caps on entries and label length; labels are untrusted plain text. Stored-schema change in its own branch.
- Timer tile appears in the palette under a Facilitation category.

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
- Possible later change: one message that adds a template's frames at their size and style in one step (a protocol change), so others see no settling and it can't be partly applied.

### Delete polish (web only) — done, v0.10.1
- Delete (or Backspace) with notes selected and nothing else focused deletes them all; a focused note outside the selection deletes the selection, never itself. Never from a field, a sheet, the top bar or chat, or on phones.
- Several notes always ask once, with the count. Not connected: no confirm, and the board says nothing was deleted.
- The board reports how a multi-note delete went once the relay has answered for every note: all deleted, or how many weren't and why (too quick, refused, connection lost). Chunks of 50 as before; no protocol change.

### Selection fixes (web only) — done, v0.10.2
- User report: selecting a frame and pressing Delete did nothing (the click focused the title input that filled the header), and a multi-selection was hard to see.
- A frame's title takes presses only while it's being edited: a click selects the frame (and drags it); double-click, Enter on the selected frame, or Tab edits the title.
- Fixed a 0.10.1 regression found in a real browser: a click on the canvas focuses the app's `<main>`, which the Delete rule didn't count as the board's.
- Selection: thicker accent outline; with several notes, a tick badge on each and a dashed box round them all.

### 7a Text box and basic shapes
- Text box, and a small fixed set of shapes: rectangle, oval, diamond. Reuses the sizing and colour work from 2.7.
- Each object type is its own protocol change with a version bump, caps and tests. Its palette tile is one registry entry in a new category; no placeholder tiles before the object exists.

### 7b Arrows
- Step (i): arrows with free endpoints and a line style.
- Step (ii): endpoints bound to notes and shapes, re-routed when a bound object moves, and a rule for what happens when a bound object is deleted.
- Connectors get their own palette category, again one entry per tile.

### 7c Structure
- Group box objects (their own protocol change), affinity grouping. (Templates and frames moved to their own slices before reconnect.)
- Stencils tab in the left panel with packaged areas (sprint planning, brainstorming area and similar), and Save as stencil from a selection.
- Export to Markdown and PNG.

### 8 Phone view
- Add a note, vote, see the timer. Big canvas is for the shared screen. QR join.

### 9 Hardening
- Load test, message-rate limits, malformed-message tests, accessibility pass, keyboard support, reduced motion.

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

## Backlog (no slot yet)

- Anonymous notes mode
- Saved boards / board history (needs a storage decision)
- Reactions and comments on notes
- Templates created by users
- Revocable invite codes per friend
- Spin-offs reusing the relay (planning poker, vote room)
- Phone sends its touch position as a cursor while a finger is down
- Layers panel
