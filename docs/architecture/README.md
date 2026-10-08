# Architecture notes

Detail for each area of Stickyard, one file per area. CLAUDE.md stays short and points here: read the matching file before changing that area, and update it in the same change (docs ship with the code).

| File | Read before touching |
|---|---|
| [shell.md](shell.md) | App shell, tokens, sheets, routes, Help, What's new, About, storage keys, welcome screen, top bar and board bar |
| [rooms.md](rooms.md) | Room codes, Worker checks, secrets, limits, the room Durable Object, expiry and burial, host token, lock, timer relay |
| [notes.md](notes.md) | Note protocol and storage, size, colour and text style, inline editing, z-order |
| [canvas.md](canvas.md) | React Flow canvas, palette and Properties panels, selection, marquee, arrange and grid, delete keys, Duplicate, Export, panel defaults, navigation (fit, zoom to selection, minimap, jump) |
| [frames.md](frames.md) | Frames, frame title style, templates, frame multi-select |
| [editing.md](editing.md) | `itemsAdd` (create with content), undo/redo history, Clear board |
| [connection.md](connection.md) | Reconnect, resync, presence (avatars, toasts), live cursors, last known pointers |
| [facilitation.md](facilitation.md) | Timer and lock UI, End session, dot voting (relay and UI) |
| [shapes.md](shapes.md) | Text labels and shapes, one stacking space with notes, emoji picker |

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
| Reconnect and presence (v0.13.0) | connection.md |
| Live cursors, protocol v14 (v0.19.0) | connection.md |
| Navigation: last known pointers (v0.24.0) | connection.md |
| Create with content, protocol v11 (slice create with content) | editing.md |
| Undo and redo (v0.12.0, part 2) | editing.md |
| Clear board (v0.12.0, part 3) | editing.md |
| Facilitation UI (v0.16.0) | facilitation.md |
| Dot voting, protocol v13 (v0.17.0) | facilitation.md |
| Dot voting UI (v0.18.0) | facilitation.md |
| Frames, protocol v9 (slice frames) | frames.md |
| Frame title styling, protocol v10 (slice frame title styling) | frames.md |
| Templates (slice templates) | frames.md |
| Frame multi-select (v0.20.0) | frames.md |
| Board size (v0.23.0) | frames.md, shapes.md |
| Notes and protocol v3 (slice 2) | notes.md |
| Note size, colour and text style, protocol v4 (slice 2.7) | notes.md |
| Title alignment, protocol v5 (slice 2.7.1) | notes.md |
| Title styling, protocol v6 (slice 2.7.2) | notes.md |
| Inline editing (slice 2.9) | notes.md |
| Z-order, protocol v8 (slice z-order) | notes.md |
| Rooms and protocol v2 (slice 1) | rooms.md |
| Room expiry (v0.14.0) | rooms.md |
| Host, lock, timer, protocol v12 (v0.15.0) | rooms.md |
| Shapes, protocol v15 (v0.21.0) | shapes.md |
| App shell conventions (slice 0.5) | shell.md |
| Welcome screen (v0.8.1) | shell.md |
| Board bar in the top bar (v0.15.1) | shell.md |
