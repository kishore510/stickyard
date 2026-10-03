# Phase plan: Stickyard

Last updated: 3 October 2026

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
| 2.8 Multi-select and arrange | Marquee and multi-select, floating selection bar (align, distribute, match size), group move/delete, batch update message. Protocol v6 | Not started |
| 3 Presence | Live cursors (throttled, never stored), join/leave toasts, avatar stack. Protocol v7 | Not started |
| 4 Reconnect | Resync after drops, offline queue | Not started |
| 5 Persistence | Room expiry and clear messaging (basic note persistence exists since slice 2) | Not started |
| 6 Facilitation | Shared timer, lock board, silent brainstorm + reveal, dot voting, host token, facilitator-defined note palette | Not started |
| Z-order | Bring to front / send to back (a z field: stored-schema change, own branch). Required before or with 7a | Not started |
| 7a Text box and shapes | Text box and basic shapes (rectangle, oval, diamond), reusing 2.7's sizing and colour work | Not started |
| 7b Arrows | (i) Free endpoints and a line style; (ii) endpoints bound to notes and shapes, re-routed when a bound object moves, with a rule for deleting a bound object | Not started |
| 7c Structure | Group boxes, columns/templates (retro, 2x2), grouping, Stencils tab and Save as stencil, export (PNG/Markdown) | Not started |
| 8 Phone view | Phone participant view, QR join | Not started |
| 9 Hardening | Message-rate limits, load test, accessibility pass | Not started |
| 10 AI | Summary and sentiment analysis, explicit buttons, add-only | Optional, last |
| Later | Yjs migration, anonymous mode, PWA | Parked |

## Order and principles

- Each rung gives a working result. Stop at any rung and still have something that works.
- Success criterion for the core: two phones and a laptop editing the same board reliably.
- Build slice 2 by hand (last-write-wins) before considering Yjs, so the problem Yjs solves is understood.
- Test on the live deployment; merge and deploy each slice, roll back if needed (single user).
- Every new object type (timer, text box, group box) needs its own protocol/schema change with a version bump, caps and tests. The palette gets its tile with one registry entry; no placeholder tiles for things that don't exist.
- Each protocol or stored-schema change is its own slice and branch (2.7, 2.8, 3 are separate for that reason).
- Protocol numbers: 2.8 is v6 and 3 is v7. Numbers after v7 are assigned when each slice starts, not in advance.

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

### 2.8 Multi-select and arrange (protocol v6)
- Selection set from 2.6 becomes real: marquee on the Select tool, Shift/Ctrl-click to toggle, Ctrl+A. Dragging one selected note moves the whole selection.
- Floating selection bar at the top of the canvas, like Chalkline: Align (left, centre, right, top, middle, bottom), Distribute (horizontal, vertical), Match size (width, height, both). Pure, tested layout functions.
- Properties panel shows "N selected" with delete (confirm) and mixed-value display.
- One batch message for multi-note changes (move, resize, delete), capped in entries and bytes: each entry validated, each note gets its own rev bump, one SQLite transaction, one broadcast. It counts as one message for the rate budget.
- Phone: multi-select is out of scope.
- Save as stencil waits for slice 7. Z-order is not in 2.8 (see the Z-order slice, before or with 7a); a layers panel is backlog.

### 3 Presence (protocol v7)
- `cursor { x, y }` in board units, max ~15/s, only when position changed, only while another participant is present, paused when the tab is hidden or the pointer leaves the board. Phones receive only.
- Server: separate cursor rate budget, forward to others only, zero SQLite writes (tested), sender identity, name and colour always from the socket's participant record, clamped to the board.
- Client: remote cursors hide after ~5 s idle and on leave/disconnect, cleared on reconnect; labels plain text, truncated; motion in its own memoised layer so notes don't re-render.
- Join/leave toasts; avatar stack in the top bar opens the Participants sheet.
- LIMITS.md: record measured request cost per active user; confirm idle rooms still hibernate.
- Phone sending its own touch position: possible later option, not in this slice.

### 4 Reconnect
- Detect drop, show state, reconnect with backoff, full resync on rejoin, queue changes made offline and reconcile.
- Show a clear "relay is over its daily limit" state instead of reconnecting in a loop.
- A full snapshot is up to ~260 KB per reconnect; note the request budget impact.

### 5 Persistence and expiry
- Rooms expire after a set idle time; clear messaging about it. (Basic note persistence already exists.)

### 6 Facilitation
- Timer (start time + duration, local countdown), lock board, silent brainstorm with reveal, dot voting with a vote budget.
- Host token issued at creation; facilitator role and what happens if the host leaves; "end session".
- Facilitator-defined note palette: host-only, a small list of { id, colorKey, label } stored in the room, chosen from a larger fixed set of token colours (12 to 16), not arbitrary hex. Caps on entries and label length; labels are untrusted plain text. Stored-schema change in its own branch.
- Timer tile appears in the palette under a Facilitation category.

### Z-order (before or with 7a)
- Bring to front / send to back, because shapes will overlap notes. Needs a z field: a stored-schema change in its own branch.

### 7a Text box and basic shapes
- Text box, and a small fixed set of shapes: rectangle, oval, diamond. Reuses the sizing and colour work from 2.7.
- Each object type is its own protocol change with a version bump, caps and tests. Its palette tile is one registry entry in a new category; no placeholder tiles before the object exists.

### 7b Arrows
- Step (i): arrows with free endpoints and a line style.
- Step (ii): endpoints bound to notes and shapes, re-routed when a bound object moves, and a rule for what happens when a bound object is deleted.
- Connectors get their own palette category, again one entry per tile.

### 7c Structure
- Group box objects (their own protocol change), templates: retro, 2x2, start/stop/continue, affinity grouping.
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
- Shapes and arrows (7a/7b) before or after facilitation (6): not decided. The slice order above is unchanged.
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
