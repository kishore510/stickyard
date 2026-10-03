# Changelog

All notable changes to Stickyard, newest first. The format follows Keep a Changelog. Versions are 0.x: a minor bump for each slice and a patch bump for each follow-up fix. This file is shown in the app under **What’s new**, so entries are written for the people using it.

## [0.7.1] - 2026-10-03

### Added
- **Edit notes in place** on a wider screen: type straight onto the note, in the note's own size, weight, colour and alignment. A note added from the palette starts ready to type; double-click a note's title or body to edit that part, or press **Enter** on a selected note. Empty parts show **Type a title** and **Type body** as hints (never saved).
- While editing: **Enter** or **Tab** moves from the title to the body, **Enter** in the body saves, **Shift+Enter** adds a line, and **Esc** or clicking elsewhere saves. Pasted text is plain text, and the 280-character limit covers title and body together.

### Changed
- Properties still shows and edits the text, in step with the note. It's where a note opens when it's off screen or tapped with a finger on a tablet. Phones keep the editor sheet.

## [0.7.0] - 2026-10-03

### Added
- **Select several notes** on a wider screen: drag across an empty part of the board to draw a marquee, **Shift**- or **Ctrl**-click notes to add or remove them, or press **Ctrl+A** for all of them. **Esc** clears the selection.
- **Move them together**: drag any selected note and the rest follow, keeping their arrangement and stopping together at the board's edge. The arrow keys move the whole selection too.
- **Arrange** from a bar at the top of the board: align edges or centres, distribute three or more with equal gaps, or match the first selected note's width, height or both.
- **Delete several at once** from Properties (which shows how many are selected, with **Mixed** where their colour, style or size differ) or with the **Delete** key.

### Changed
- With a mouse, dragging an empty part of the board now draws a marquee. Drag with the **right** or **middle** button to move around instead (or use **Hand**, or hold **Space**). Phones, fingers and pens still move around as before. The board no longer shows the browser's right-click menu.
- Resize handles show only when a single note is selected.
- Pages from before this update show **Please reload** when they join a session.

## [0.6.2] - 2026-10-03

### Added
- **Title and body styled separately.** A note's title (its first line) and its body each have their own size, **Bold**, *Italic*, alignment and text colour, under **Title text** and **Body text** in Properties or a phone's note editor. For example, a large bold title over smaller body text.

### Changed
- Existing notes keep their look: each title starts with the size, weight, slant and text colour the whole note had.
- About's **Privacy** now says that text style is stored for the title and the body separately.
- Pages from before this update show **Please reload** when they join a session.

## [0.6.1] - 2026-10-03

### Added
- **Title and body alignment, separately.** A note's title (its first line) and its body can each be aligned left, centre or right, from **Text** in Properties or a phone's note editor.

### Changed
- Existing notes keep their look: each title starts with the alignment the whole note had.
- Pages from before this update show **Please reload** when they join a session.

## [0.6.0] - 2026-10-03

### Added
- **Resize notes.** Select a note and drag a corner (or an edge) to make it bigger or smaller; the opposite corner stays put. Notes go from 96 to 480 wide and tall and always stay on the board. Others see it change size as you drag.
- **Width and Height** fields in Properties (and in a phone's note editor) for exact sizes.
- **Alt+arrow keys** resize the focused note (**Shift** for bigger steps); the arrow keys on their own still move it.
- **Change a note's colour** at any time from the swatches in Properties or the phone editor.
- **Text style** for each note: size (Small to Extra large), **Bold**, *Italic*, alignment (left, centre, right) and text colour. **Auto** keeps the usual dark text; every text colour stays readable on every note colour in light and dark themes. Styles apply to the whole note.
- Chat messages now show **when they arrived** (with the full date when you point at the time).
- On a wider screen, **chat can be resized** with the grip at its top left (or the arrow keys); double-click the grip to reset. This browser remembers the size.

### Changed
- Pages from before this update show **Please reload** when they join a session. Reload to get the new version; your notes are kept and start at the usual size and style.
- About's **Privacy** now mentions that note size and text style are stored with the note, and that the chat size stays in this browser.

### Fixed
- On a wider screen, the menu (the three bars at the top right) no longer opens behind the Properties panel.

## [0.5.1] - 2026-10-03

### Added
- **Palette** on the left of a wider screen: one tile per note colour under **Notes**. Click a tile to add a note in the middle of the view, or drag it onto the board to drop it where you want. A search box filters the tiles.
- **Properties** on the right of a wider screen: select a note to see and edit its **Title** (the first line) and **Body** (the rest), with a character count, its colour and who added it, and **Delete note**. With nothing selected, it shows how many notes the board has.
- **Selecting notes**: click a note (or move to it with **Tab**) to select it; click an empty part of the board or press **Esc** to clear it.
- Both panels can be **collapsed** (the **<<** / **>>** button, or **[** and **]**) and **resized** by dragging their inner edge or with the arrow keys. This browser remembers their widths and whether they're collapsed. The board keeps the same spot in the middle when they change.
- On a phone, the round **+** button (**Add note**) opens a drawer from the bottom with search and a row of colour tiles: tap one to add a note, or press and hold it and drag it onto the board. A note's editor has the same Title, Body, colour and author fields as Properties, and **Delete note**.
- A collapsed palette keeps a small tile per colour, so you can still add notes. Dragging a panel's edge well past its narrowest collapses it.

### Changed
- **Select** and **Hand** are now a two-way switch in the bar at the bottom (on a phone too, next to **+** and **Fit to notes**). The tool rail and the separate colour button are gone: the palette's tiles choose the colour.
- The panels, drawer and bars now look and behave like Chalkline's, so the two apps feel the same.
- About's **Privacy** now mentions the side panels' layout, which stays in this browser.

### Fixed
- With **Hand** on, double-clicking a note (or pressing **Enter** on it) now opens it for editing. Before, clicks went straight past the note to the board.

## [0.5.0] - 2026-10-03

### Added
- **A full-screen board.** The board now fills the screen under the top bar, like a whiteboard, with a clear edge so you can see where it ends. Nothing on the page scrolls.
- **Zoom.** Pinch, or hold **Ctrl** and scroll. On a wider screen, the bar at the bottom has zoom out, the zoom level (choose it to go back to 100%), zoom in, **Fit to notes**, **Hand** and an **Overview map** in the corner.
- **Fit to notes** shows all the notes at once. A session now opens fitted to its notes.
- **Tools on the left** on a wider screen: **Select**, **Hand** and **Add note**, with the note colour below. On a phone, one bar at the bottom has the colour, **Add note**, **Fit to notes** and **Hand**.
- **Hand** makes every drag move the board, even over a note. On a computer, you can also hold **Space** and drag.
- **Keyboard shortcuts:** **+** and **-** zoom, **0** goes to 100%, **F** fits, **V** is Select, **H** is Hand, **N** adds a note and **M** shows the overview map.
- **Participants**: the people button at the top lists who's in the session, with **Copy link** and **Leave session**.
- **Chat**: a chat button (at the top on a phone, at the bottom right on a wider screen), with a dot when there are messages you haven't seen.
- Help: new **Participants** and **Chat** topics; **Notes** covers panning, zooming, fit and shortcuts.

### Changed
- Grab a note anywhere to drag it, with a mouse or a finger. A tap never moves a note by accident.
- Tap a note to edit it. With a mouse, double-click it (a single click no longer opens it).
- Scrolling with a mouse wheel or trackpad now moves around the board; hold **Ctrl** to zoom.
- Dragging a note near the edge of the screen moves the board along with it.
- New notes appear in the middle of what you can see, a little lower and to the right if a note is already there.
- The message box and the list of people have moved off the page, into **Chat** and **Participants**. **Copy link** and **Leave** are in **Participants**.
- About's **Privacy** says that your place on the board, the zoom, and the tool and colour you pick aren't stored or sent.

## [0.4.0] - 2026-10-03

### Added
- **Shared notes.** Every session now has a board of sticky notes. Pick a colour and choose **Add note** in the bar at the bottom of the screen; the note appears where you're looking, ready to type in.
- Tap or click a note to edit it. **Enter** saves and **Shift+Enter** starts a new line. Notes can be up to 280 characters.
- Drag notes to move them. Everyone sees notes move as they're dragged.
- Delete a note from its editor or with the **Delete** key. You're asked first if it has text.
- Move around the board by dragging an empty part of it, or by scrolling.
- Keyboard support: **Tab** to a note, **Enter** to edit, **arrow keys** to move (hold **Shift** for bigger steps), **Delete** to delete.
- If two people change the same note, the last change saved wins. What you're typing is never replaced while you type.
- Notes are kept by the relay, so the board is still there when people leave and come back. A board holds up to 200 notes.
- Help: a new topic, **Notes**.

### Changed
- The message format between the app and the relay is now protocol v3. A page left open from an earlier version asks you to reload.
- While the connection is lost, the board stays on screen but can't be changed until you rejoin.
- About's **Privacy** now says what the relay stores for notes.

## [0.3.0] - 2026-10-03

### Added
- **Sessions.** Join one by opening its link, or by pasting the link or its code into **Join a session** on the start page. Type a name and you're in.
- **Start a session** with the create passcode. Your password manager can fill it in; Stickyard never stores it. After several wrong tries, starting is paused for a while, and there's a daily limit on new sessions.
- In a session: the list of **people** in it, each with a coloured dot next to their name; a **message** box whose messages appear for everyone straight away; **Copy link** to invite others; and **Leave**.
- Clear messages when a link isn't valid, a session is full (20 people), the connection drops (with **Rejoin**), or your page is out of date.
- A notice when joining that names aren't verified and anyone with the link can join.
- Help: a new topic, **Starting and joining a session**.

### Changed
- The start page now has **Start a session** and **Join a session**, with a short connection status line below them.
- The message format between the app and the relay is now protocol v2. A page left open from an earlier version asks you to reload.
- Help's **Names and identity** and About's **Privacy** now describe how sessions work. This browser now also remembers the last name you joined with.

## [0.2.0] - 2026-10-03

### Added
- A top bar with the Stickyard mark, a **menu** and a **theme** button (light, dark or follow your device). Your theme choice is remembered in this browser.
- **Help**: search, a quick start, and topics on names and identity, the connection check, and touch and keyboard use.
- **What’s new**: these release notes. A small dot on the menu button means there’s a version you haven’t looked at yet.
- **About**: the version, build, protocol and relay, a **Copy details** button for bug reports, what Stickyard does with your data, and credits.
- Help, What’s new and About open as sheets: from the bottom on phones, from the side on wider screens. Each has its own link (for example `#/help`), so the browser’s Back button closes them.
- A “Skip to content” link for keyboard users.

### Changed
- A new look: warm neutral background, blue accent, rounded cards, and the Inter typeface, bundled with the app.
- The connection check now sits inside the app.

## [0.1.0] - 2026-10-02

### Added
- A connection check on the start page: it shows whether your browser can reach the Stickyard relay, and asks you to reload if your page is out of date.
- The relay server, which only accepts connections from the Stickyard site and checks every message it receives.
- Light and dark themes that follow your device.
