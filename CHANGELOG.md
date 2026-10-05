# Changelog

All notable changes to Stickyard, newest first. The format follows Keep a Changelog. Versions are 0.x: a minor bump for each slice and a patch bump for each follow-up fix. This file is shown in the app under **What’s new**, so entries are written for the people using it.

## [0.18.0] - 2026-10-05

### Added
- Dot voting. The host starts a round and chooses how many dots each person gets (1 to 20, 5 to start with). Everyone then places their dots on the notes they like best, more than one on a note if they want.
- While a round is open, a strip under the top bar says how many dots you have left. Your own dots show on each note you voted on, and only you see them.
- To vote, select a note and use **Add a dot** and **Remove a dot** under it. They're also in **Properties**, and in the note's editor on a phone. On a keyboard, press **D** on a note to add a dot and **Shift+D** to take one off.
- When the host chooses **Stop and reveal**, everyone sees each note's total and which notes were **Top voted**. A **Results** list puts the notes in order of dots, and choosing one takes you to that note. It's in **Properties** with nothing selected, or behind **Show results** on the strip on a phone.
- Votes are anonymous: nobody, the host included, sees who voted for what.
- Voting works on a phone and while the board is locked.
- The host's voting controls are in **Session** in the top bar on a wider screen, and in **Session** in **Participants** on a phone. Starting a new round clears the previous one, and **Clear votes** removes every vote and turns voting off.
- Help has a new topic, **Dot voting**.

## [0.17.0] - 2026-10-04

### Changed
- Groundwork for dot voting. Nothing new is visible yet: the dots, counts and results come in a later release. In it, the host will start a round, everyone will spread a few dots over the notes they like best, and the totals will show only when the host closes the vote. Nobody will see who voted for what.
- Stickyard now keeps a random voting key for each session you join, on this device, so your dots count once even after a reload or in a second tab. It's removed when the session ends or expires.
- About > Privacy now describes the voting key and how votes are stored without names.
- After this update, pages opened before it say **please reload** when they try to join, as with earlier updates.

## [0.16.0] - 2026-10-04

### Added
- A timer everyone can see. While one runs, the top bar shows the time left, the same for everyone. It says **Last minute** near the end and **Time's up** when it's done. Screen readers hear when it starts, at 1 minute left and when time's up.
- The session's host (whoever started it, on that device) can start a timer from **Timer** under **Facilitation** in the palette. Choose 1, 3, 5, 10, 15 or 30 minutes, or type any length up to 3 hours. The host can also restart or stop it. On a phone, the host's controls are in a **Session** section of the **Participants** panel.
- The host can **Lock board**, so only hosts can change it. Everyone else sees a short message saying the board is locked and that they can still chat and look around.
- The host can **End session** (in **Properties** with nothing selected, or **Session** on a phone). After one question, the board is deleted for everyone and they all see **Session ended**.
- Hosts are marked: **Host** next to their name in **Participants**, and a small crown on their face in the top bar.
- Help has a new topic, **Running a session**.

### Changed
- While the board is locked, buttons and tiles that would change it are greyed out for everyone but the host and say "The board is locked by the host."

## [0.15.1] - 2026-10-04

### Changed
- On a wider screen, the board's buttons (Undo, Redo, Duplicate, Delete, Bring to front, Send to back) now sit in the top bar, between the Stickyard mark and the menu, instead of in a panel over the board. The board has more room, and nothing covers the top of it.
- The arranging tools (align, distribute, grid, match size) are behind one **Arrange** button that opens them. **Esc** or choosing **Arrange** again closes them.
- The line of text that said why buttons were greyed out is gone. Point at a greyed-out button, or move to it with **Tab**, and a small label says why. Every other button names itself the same way.

## [0.15.0] - 2026-10-04

### Changed
- Groundwork for hosts. Nothing new is visible yet: the buttons come in a later release. Whoever starts a session becomes its host, and Stickyard remembers that on the device it was started from. In a later release, a host will be able to lock the board (so only hosts can change it), run a timer and end the session for everyone.
- If a host ends a session, opening its link says **Session ended**, with a button back to the start page, and Stickyard doesn't try to reconnect.
- About > Privacy now mentions the host key this browser keeps for sessions you start, and when it's removed. Help explains who the host is.
- After a dropped connection, Stickyard keeps trying normally for a little longer (about 30 seconds instead of 10) before it suggests the relay may be down or over its daily limit, so a short relay restart recovers by itself.
- Everyone needs this version: pages from before it are asked to reload.

## [0.14.0] - 2026-10-04

### Added
- Sessions now expire once nobody has been in them for 7 days. Their notes and frames are deleted, and opening the link says **Session expired** and why, with a button back to the start page, where you can start a new session. Stickyard doesn't keep trying to reconnect to an expired session, even if it expired while you were away.
- Help explains how long a session lasts (in **Starting and joining a session**) and what **Session expired** means (in **Connection**).

### Changed
- About > Privacy now says that a session's notes and frames are deleted automatically once nobody has been in it for 7 days, and that after that the relay keeps only the time it expired.

## [0.13.0] - 2026-10-04

### Added
- If the connection drops, Stickyard now reconnects by itself: it tries again after about 1 second, then 2, 4 and so on up to 30 seconds, eight times in all. It also tries straight away when your network comes back or you return to the tab. If it still can't get through, it says **Offline** and offers **Rejoin**, which starts again. You rejoin with the same name, without being asked.
- A status at the top of the board says what's happening: **Reconnecting…** (with which try it's on), **You're offline**, **the session is full** (with **Rejoin**), or that the relay may be unreachable or over its daily limit. In that last case it checks once a minute and says when the limit resets (00:00 UTC). The board stays on screen, read-only, until you're back.
- On a wider screen, the **Participants** button now shows the people in the session as small round faces with their initials: you first, then up to two more, then **+N** for the rest. On a phone it shows how many people are here. Either way it opens the Participants panel.
- A short message at the top of the board says who joined or left. When lots of people arrive at once it says so in one message ("5 people joined"). You don't get one for yourself, for the people already there when you join, or for someone who drops out and comes straight back.

### Changed
- After a reconnect, the board reloads from the relay, so it shows exactly what's saved.
- Changes the relay hadn't confirmed when the connection dropped are undone on your screen, and one message says how many may not have been saved. Text you were typing into a note is kept, and saved once you're back. If that note was deleted meanwhile, the board offers your text back as a new note.
- Undo and Redo start afresh after a reconnect.

### Fixed
- The Undo and Redo buttons now update when a change that was waiting to be saved is given up on after 10 seconds. Before, they could keep saying "Wait until your last change is saved."

## [0.12.0] - 2026-10-04

### Added
- A bar at the top of the board, always there on a wider screen, with **Undo** and **Redo**, **Duplicate** and **Delete**, **Bring to front** and **Send to back**, and the arrange tools. A button that can't be used right now is greyed out, and the bar says why.
- **Duplicate** (**Ctrl+D**, **Cmd+D** on a Mac): copies the selected notes, with their text, colour, style and size, a little down and to the right, and selects the copies. With a frame selected, it copies the frame on its own.
- **Undo** and **Redo** (**Ctrl+Z**, and **Ctrl+Shift+Z** or **Ctrl+Y**) for your own changes: moving, resizing, arranging, text, colour and style, frames, adding, duplicating, templates, deleting and clearing the board. Someone else's changes are never undone: if they changed something after you, undo leaves it and says so. Deleted notes come back as new copies added by you. Bring to front and Send to back can't be undone. The history lasts until you leave or reconnect. On a phone, Undo and Redo are in the bottom bar.
- **Clear board** in Properties (with nothing selected) deletes every note and frame after one question. The board says how it went, and one Undo brings everything back.

### Changed
- The Align, Distribute, Grid and Match size controls are now in the bar at the top of the board, which stays put instead of appearing only when two or more notes are selected.

## [0.11.0] - 2026-10-04

### Changed
- Templates now appear all at once: every frame lands straight away at its size, with its title style, for you and everyone else in the room. Before, the frames went up one at a time and took about a second to settle.
- This version changes how the app talks to the relay. If a page that was already open says to reload, reload it.

## [0.10.3] - 2026-10-04

### Added
- Grid: with two or more notes selected on a wider screen, **Arrange > Grid** lays them out in tidy rows and columns, in reading order, with an equal gap. **Columns** picks how many columns, or **Auto** chooses from the shape of the selection. If the grid wouldn't fit on the board, nothing moves and the board says why.

## [0.10.2] - 2026-10-04

### Fixed
- Clicking a frame’s title bar now selects the frame, so pressing Delete deletes it. Before, the click went into the title and Delete did nothing.
- Delete after Ctrl+A, after drawing a box round notes, or with a frame selected now works in the browser after you’ve clicked the board. In 0.10.1 it could still do nothing.

### Changed
- To change a frame’s title, double-click it, or select the frame and press Enter. Press Enter or Escape when you’re done; the frame stays selected. You can still drag a frame by its title.
- Selected notes and frames have a thicker outline. When several notes are selected, each one shows a tick in its corner and a dashed box surrounds them all, so it’s clear what’s selected.

## [0.10.1] - 2026-10-04

### Fixed
- After selecting all notes (Ctrl+A) or drawing a box round some, pressing Delete now deletes them. Before, it could do nothing.
- If a note had focus outside the notes you selected, Delete now deletes the selection, never that other note.
- Pressing Delete while you type in a note, or in the menu or chat, never deletes notes.

### Changed
- Deleting several notes always asks first and says how many, even when they’re empty.
- After deleting several notes, the board says how many were deleted. If some weren’t (because it was too quick, or the connection was lost), it says how many and why.
- When you’re not connected, Delete doesn’t ask; the board says nothing was deleted.

## [0.10.0] - 2026-10-04

### Added
- Templates: start a board from a ready-made set of frames. On a wider screen, the palette has a Templates section with Retro, Start Stop Continue, 2x2 Impact and Effort, and Sprint planning.
- Click a template to place it in the middle of your view, or drag it onto the board to place it where you let go. It always lands fully on the board, and nothing already there is moved or changed.
- When a template is in, the view fits its frames and the first one is selected. Search the palette for words like retro, matrix or sprint to find them.

### Changed
- If the board hasn't enough free frames for a template, nothing is added and the board says how many it needs and how many are free. If only part of a template could be added, the frames that were added stay and the board says so.

## [0.9.1] - 2026-10-04

### Added
- Style a frame's title: select the frame and use Title text in Properties to change its size, make it bold or italic, align it left, centre or right, and pick a text colour. The title bar gets taller for the larger sizes.

### Changed
- Frame titles look the same as before until you change them. A bold frame title is a little lighter than a bold note title.
- Every text colour is readable on every frame colour, in light and dark. In the dark theme, frame titles use lighter versions of the note text colours.
- On a phone, frames show their title styles, but still can't be changed there.
- About's Privacy now says that a frame's title style is stored with it.
- Pages from before this update show Please reload when they join a session.

## [0.9.0] - 2026-10-04

### Added
- Frames: named, coloured areas behind your notes, for example Start, Stop and Continue. On a wider screen, add one from the new Frames tile in the palette (click it, or drag it onto the board) and type its title straight away.
- Drag a frame by its title bar or border and the notes inside it come along, keeping their places. Hold Alt to move the frame on its own. A frame holding more than 50 notes moves on its own, and the board says so.
- Select a frame to change its title, colour, width and height in Properties, or resize it from its corners. Delete it from Properties or with the Delete key; its notes always stay.

### Changed
- The inside of a frame lets clicks through, so notes in a frame work exactly as before, and dragging across a frame still selects notes.
- Fit to notes now fits frames too.
- On a phone, frames are shown but can't be added or changed.
- About's Privacy now says that frames (position, size, title and colour) are stored with the session.
- Pages from before this update show Please reload when they join a session.

## [0.8.1] - 2026-10-03

### Added
- A welcome screen: the start page now shows the Stickyard logo and name, a one-line summary of what Stickyard is, Start a session and Join a session side by side on a wider screen, and three short points about what works today.

### Changed
- The start page now opens with the Stickyard logo. Starting and joining work exactly as before, and on a phone both are on screen without scrolling.
- The connection status on the start page is quieter.
- Opening a session link still goes straight to typing your name.

## [0.8.0] - 2026-10-03

### Added
- Bring to front and Send to back: where notes overlap, choose which one is in front. Select a note and use the new Order section in Properties (on a phone, in the note's editor). With several notes selected, the same two buttons are in Properties and in the bar at the top of the board; the notes move together and keep their order among themselves.
- Everyone sees the same order, and it's saved with the board.

### Changed
- A new note always goes in front of the others.
- Selecting, moving or resizing a note no longer lifts it above the notes around it, so what you see is the board's real order. A selected note can sit partly behind another; bring it to the front to see all of it.
- Existing boards keep their look: notes are stacked in the order they were added, as before.
- About's Privacy now says that each note's stacking order is stored with it.
- Pages from before this update show Please reload when they join a session.

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
- **Title and body styled separately.** A note's title (its first line) and its body each have their own size, **Bold** and **Italic**, alignment and text colour, under **Title text** and **Body text** in Properties or a phone's note editor. For example, a large bold title over smaller body text.

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
- **Text style** for each note: size (Small to Extra large), **Bold** and **Italic**, alignment (left, centre, right) and text colour. **Auto** keeps the usual dark text; every text colour stays readable on every note colour in light and dark themes. Styles apply to the whole note.
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
