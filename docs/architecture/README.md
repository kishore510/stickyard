# Architecture notes

Detail for each area of Stickyard, one file per area. CLAUDE.md stays short and points here: read the matching file before changing that area, and update it in the same change (docs ship with the code).

| File | Read before touching |
|---|---|
| [shell.md](shell.md) | App shell, tokens, sheets, routes, Help, What's new, About, storage keys, welcome screen, top bar and board bar, Share session (QR join) |
| [rooms.md](rooms.md) | Room codes, Worker checks, secrets, limits, the room Durable Object, expiry and burial, host token, lock, timer relay |
| [notes.md](notes.md) | Note protocol and storage, size, colour and text style, inline editing, z-order, sealed notes and the leak inventory, reactions on notes (relay and UI) |
| [canvas.md](canvas.md) | React Flow canvas, palette and Properties panels, selection, marquee, arrange and grid, delete keys, Duplicate, Export (also on phones, and the board file), Import, panel defaults, navigation (fit, zoom to selection, minimap, jump), reaction chips on the canvas |
| [frames.md](frames.md) | Frames, frame title style, templates and their palette groups, frame multi-select |
| [editing.md](editing.md) | `itemsAdd` (create with content), undo/redo history, Clear board |
| [connection.md](connection.md) | Reconnect, resync, presence (avatars, toasts), live cursors, last known pointers, following |
| [facilitation.md](facilitation.md) | Timer and lock UI, End session, dot voting (relay and UI), silent brainstorm, Bring to me |
| [shapes.md](shapes.md) | Text labels and shapes, one stacking space with notes, emoji picker |
| [stencils.md](stencils.md) | Stencils: the format, parsing stored ones as untrusted, built-ins, storage and caps, placing and Save as stencil |
| [groups.md](groups.md) | Groups: protocol and storage, membership and moves, dissolving below 2 on every delete path, gating and limits; the groups UI (box layer, chip, Properties, undo, pacing, export) |
| [connectors.md](connectors.md) | Connectors (arrows): protocol and storage, endpoints and anchors, `anchorPoint`, the delete rule, gating and limits; the arrows UI (layer, drawing, selection, Properties, pacing, undo, export) |

## Where each section lives

Sections are named after the slice that introduced them. Cross-references in quotes use these names.

| Section | File |
|---|---|
| Board UX (slice 2.5) | canvas.md |
| Palette and Properties panels (slice 2.6) | canvas.md |
| Multi-select and protocol v7 (slice 2.8) | canvas.md |
| Delete polish (v0.10.1) | canvas.md |
| Selection fixes (v0.10.2) | canvas.md |
| Arrange grid (v0.10.3) | canvas.md |
| Floating bar and Duplicate (v0.12.0, part 1) | canvas.md |
| Export (v0.22.0) | canvas.md |
| Board size, protocol v16 (v0.23.0) | canvas.md |
| Panel layout at 768 px (v0.24.0, part 1) | canvas.md |
| Navigation (v0.24.0, part 2) | canvas.md |
| Export on phones and the board file (v0.40.0, part 1 of 2) | canvas.md (pointers in shell.md, stencils.md) |
| Import (v0.40.0, part 2 of 2) | canvas.md (pointers in editing.md, stencils.md, shell.md) |
| Reconnect and presence (v0.13.0) | connection.md |
| Live cursors, protocol v14 (v0.19.0) | connection.md |
| Navigation: last known pointers (v0.24.0) | connection.md |
| Follow and Bring to me, protocol v19 (v0.30.0, part 1 of 2) | connection.md |
| Follow and Bring to me: the UI (v0.31.0, part 2 of 2) | connection.md |
| Reactions in the join step (protocol v20, v0.33.0, part 1 of 2) | connection.md |
| Follow: programmatic moves versus mine (v0.31.0) | canvas.md |
| Create with content, protocol v11 (slice create with content) | editing.md |
| Undo and redo (v0.12.0, part 2) | editing.md |
| Clear board (v0.12.0, part 3) | editing.md |
| Facilitation UI (v0.16.0) | facilitation.md |
| Dot voting, protocol v13 (v0.17.0) | facilitation.md |
| Dot voting UI (v0.18.0) | facilitation.md |
| Silent brainstorm, protocol v17 (v0.25.0, part 1 of 3) | facilitation.md |
| Silent brainstorm: which notes are mine, protocol v18 (v0.26.0) | facilitation.md |
| Silent brainstorm: web state and plumbing (v0.27.0, part 2 of 3) | facilitation.md, connection.md |
| Silent brainstorm: the UI (v0.28.0, part 3 of 3) | facilitation.md, notes.md, shell.md |
| Bring to me, protocol v19 (v0.30.0, part 1 of 2) | facilitation.md |
| Bring to me: the UI (v0.31.0, part 2 of 2) | facilitation.md, shell.md |
| Reactions reuse the voter (protocol v20, v0.33.0, part 1 of 2) | facilitation.md |
| Frames, protocol v9 (slice frames) | frames.md |
| Frame title styling, protocol v10 (slice frame title styling) | frames.md |
| Templates (slice templates) | frames.md |
| More built-in templates (v0.29.0) | frames.md |
| Frame multi-select (v0.20.0) | frames.md |
| Board size (v0.23.0) | frames.md, shapes.md |
| Notes and protocol v3 (slice 2) | notes.md |
| Note size, colour and text style, protocol v4 (slice 2.7) | notes.md |
| Title alignment, protocol v5 (slice 2.7.1) | notes.md |
| Title styling, protocol v6 (slice 2.7.2) | notes.md |
| Inline editing (slice 2.9) | notes.md |
| Z-order, protocol v8 (slice z-order) | notes.md |
| Silent brainstorm: sealed notes and the leak inventory, protocol v17 (v0.25.0, part 1) | notes.md |
| Reactions on notes, protocol v20 (v0.33.0, part 1 of 2) | notes.md |
| Reactions on notes: the UI (v0.34.0, part 2 of 2) | notes.md, shell.md, canvas.md, facilitation.md, connection.md |
| Rooms and protocol v2 (slice 1) | rooms.md |
| Room expiry (v0.14.0) | rooms.md |
| Host, lock, timer, protocol v12 (v0.15.0) | rooms.md |
| Reactions: rate bucket, caps and burial (protocol v20, v0.33.0, part 1 of 2) | rooms.md |
| Shapes, protocol v15 (v0.21.0) | shapes.md |
| Connectors, protocol v21 (v0.35.0, arrows part 1 of 2) | connectors.md (pointers in notes.md, rooms.md, connection.md) |
| Arrows: the UI (v0.36.0, arrows part 2 of 2) | connectors.md (pointers in canvas.md, editing.md) |
| Groups, protocol v22 (v0.37.0, structure part 1 of 3) | groups.md (pointers in notes.md, rooms.md, connection.md) |
| Groups: the UI (v0.38.0, structure part 2 of 3) | groups.md (pointers in canvas.md, editing.md) |
| Stencils (v0.39.0, structure part 3 of 3) | stencils.md (pointer in canvas.md) |
| Hardening: what a held note shows (v0.39.1) | notes.md (shapes and frames follow the same rule) |
| Hardening: a frame deleted mid-drag (v0.39.1) | frames.md |
| Accessibility pass (v0.39.1) | shell.md |
| Hardening: the load harness (v0.39.1) | rooms.md (numbers in docs/LIMITS.md) |
| App shell conventions (slice 0.5) | shell.md |
| Welcome screen (v0.8.1) | shell.md |
| Board bar in the top bar (v0.15.1) | shell.md |
| Silent brainstorm in the shell (v0.28.0) | shell.md |
| Follow and Bring to me in the shell (v0.31.0) | shell.md |
| Share session and QR join (v0.32.0) | shell.md |
