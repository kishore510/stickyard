# Changelog

All notable changes to Stickyard, newest first. The format follows Keep a Changelog. Versions are 0.x: a minor bump for each slice and a patch bump for each follow-up fix. This file is shown in the app under **What’s new**, so entries are written for the people using it.

## [0.28.0] - 2026-10-08

### Added
- **Silent brainstorm.** The host can start a silent round (**Session** in the top bar, choose **Silent brainstorm**; on a phone, **Session** in **Participants**). While it runs, every note people add stays hidden from everyone but the person who wrote it, the host included, until the host chooses **Reveal notes**. Then everyone sees them all at once. It's a way to collect ideas without anyone anchoring on the first one.
- A strip under the top bar says a round is on, how many notes you've written and how many there are in total, and how many you have left when you're close to the limit of 40.
- Your hidden notes say **Only you** above them, and **Properties** says "Only you can see this note until the host reveals the notes." With nothing selected, **Properties** counts the notes you can see and the hidden ones.
- **Start silent round** and **Reveal notes** each ask once first, saying what will happen: only the host's device can reveal, so keep it open; the reveal is for everyone at once and can't be undone.
- While a round runs, frames can't be moved (their grip says why), and **Clear board**, **Start voting** and **Export** are off. Voting that was already open stays open for the notes everyone can see.
- After the reveal your view stays where it is; if some new notes are out of view, the board offers **Fit to notes**.
- A new Help topic, **Silent brainstorm**, and a section in **Running a session**.

### Changed
- About > Privacy says that silent brainstorm keeps nothing in your browser beyond the same per-session key dot voting uses.

## [0.27.0] - 2026-10-08

### Changed
- Groundwork for silent brainstorm. Nothing new is visible yet: the buttons come in a later release. Your page now sends the relay the random key this browser keeps for each session (the one dot voting uses) when you join or reconnect, and keeps track of the hidden notes you've written. While a host's silent round runs (once they can start one), the controls that can't work then are off and say why: Clear board, moving frames, starting a vote, and Export. The board's note count includes everyone's hidden notes, and you can write up to 40 of your own.

## [0.26.0] - 2026-10-08

### Changed
- Groundwork for silent brainstorm. Nothing new is visible yet: the buttons come in a later release. When you join or come back to a session during a silent round, the relay now tells your page which of the hidden notes are yours, so a reload or a second tab keeps track of them.
- After this update, pages opened before it say **please reload** when they try to join, as with earlier updates.

## [0.25.0] - 2026-10-08

### Changed
- Groundwork for silent brainstorm. Nothing new is visible yet: the buttons come in a later release. In it, the host will start a silent round: everyone adds notes that only they can see, with one count for everybody of how many there are, until the host reveals them all at once.
- The relay can now be told, when a page joins, the random key this browser already keeps for each session (the one dot voting uses), so a silent round will know which hidden notes are yours, even after a reload or in a second tab. The page starts sending it when the silent brainstorm buttons arrive.
- About > Privacy now describes what the relay will keep for hidden notes, and that it's removed when they're revealed.
- After this update, pages opened before it say **please reload** when they try to join, as with earlier updates.

## [0.24.0] - 2026-10-08

### Added
- **Zoom to selection.** On a wider screen the bar at the bottom has a **Zoom to selection** button (or press **S**): the view fits the notes, frames and shapes you've selected, never closer than 100%. With nothing selected it's off and says why.
- **Go to someone's pointer.** In **Participants**, **Go to** beside a person's name takes your view to where their pointer was last seen on the board, keeping your zoom (or zooming in to 50% if you're further out), and the board says "Moved to Sam's pointer." It's off, with "No pointer position seen yet.", until their pointer has been over the board since you joined (people on a phone don't share one). It works on a phone, and with other people's cursors switched off. Only the last position is kept, in this page's memory; it's forgotten when they leave or you reconnect.
- **Click the overview map** to go to that part of the board. Dragging in it still moves around.

### Changed
- **Fit to notes with something far away.** If fitting everything would make it too small to read (below 25%), **Fit to notes** shows the biggest group of items instead and the board says "Some items are out of view.", with **Show all** to see everything. Otherwise it's exactly as before. A session also opens this way.
- **More room on a tablet.** On a window narrower than 1024 pixels, the palette and Properties start collapsed, so the board opens much closer (at 768 pixels wide, our sample board opens at 39% instead of 16%). Open them with their buttons or **[** and **]**; once you open or collapse one, this browser remembers your choice, as before.
- With both panels open on a narrow window, the bar at the bottom takes two rows instead of running under the panels.
- Fit, zoom, map clicks and **Go to** slide briefly; with reduced motion they're instant.

## [0.23.0] - 2026-10-08

### Changed
- **A bigger board.** The board is now 6400 × 4000, twice as wide and twice as tall: four times the room. Everything already on a board stays exactly where it was.
- New notes, shapes, frames and templates still appear in the middle of what you're looking at. An empty board opens at its middle, at 100%.
- Zooming right out still stops at 10%, so on a phone or a narrow window you see part of the board at a time rather than all of it; pan, the overview map (on a wider screen) and **Fit to notes** get you around. Note, frame and shape sizes are unchanged.
- Everyone in a session needs this version: an older open page is asked to reload.

## [0.22.0] - 2026-10-08

### Added
- **Export.** On a wider screen, with nothing selected, **Properties** has an **Export** section with **Export PNG** and **Export Markdown**. Hosts and guests can both use it, also on a locked board or while disconnected.
- **Export PNG** saves a picture of every note, frame and shape at full size, whatever you're zoomed to, in the theme you're using, with a margin round the edge. Revealed vote totals and **Top voted** are in it; pointers, selection outlines, handles, the minimap and your own dots aren't. Very large boards are scaled down so the image opens on phones and tablets too.
- **Export Markdown** saves the board as text: a section per frame with the notes inside it (top to bottom, then left to right), then the notes outside any frame, then the text in labels and shapes. Once the host has revealed the votes, each note shows its dots and a **Results** list comes last. Colours and authors aren't included.
- Files are named by the date only, like `stickyard-board-2026-10-07.png`: never the room code or anyone's name. Exports are made in your browser and nothing is uploaded.

## [0.21.0] - 2026-10-07

### Added
- **Text and shapes.** On a wider screen the palette has a **Shapes** section: **Text**, **Rectangle**, **Oval** and **Diamond**. Click one to add it in the middle of the view, or drag it onto the board. Its text is ready to type.
- Type in a shape by double-clicking it, or select it and press **Enter**. **Enter** starts a new line; **Esc** or clicking elsewhere saves. A shape holds up to 500 characters, and its text stays inside an oval's or a diamond's outline.
- A **Text** label has no fill or border, just words. While it's empty it shows a faint outline and the word "Text" so you can find it.
- **Properties** for a shape: its text, a text style with seven sizes (up to three heading sizes), **Bold**, **Italic**, **Underline**, left, centre or right, top, middle or bottom, and a text colour; for shapes, a **Fill**, **Border colour**, **Border width** and **Border style** (solid or dashed); **Width** and **Height**; and **Bring to front** or **Send to back**.
- With several shapes selected, **Properties** changes the text style, fill and border of all of them at once.
- Shapes work with everything else: select them with notes and frames (click, **Shift**-click, a marquee, **Ctrl+A**), drag or arrow-key them together, align, distribute, grid and match size them with notes, duplicate them, delete them, and undo any of it. A frame brings the shapes inside it when you drag it.
- A board holds up to 50 shapes. Every text colour stays readable on every fill, in light and dark.
- **Emoji**: a smiley button beside text you're editing on the board, and beside the text fields in **Properties** (a note's title and body, a shape's text, a frame's title), opens 48 emoji to add where you're typing. It works with the keyboard too, and each emoji counts as one character.

### Changed
- Notes and shapes share one front-to-back order: **Bring to front** and **Send to back** work on both, and frames stay behind everything.
- A frame carries at most 50 notes and shapes together; a frame holding more moves on its own, as before.
- Phones show shapes, with their styles, but can't add or change them yet.
- Everyone in a session needs this version: an older open page is asked to reload.

### Fixed
- **Ctrl+A** then **Delete** now deletes everything on the board (notes, frames and shapes) wherever you last clicked. Before, with a note or shape focused it deleted only the notes, or only that shape, and with a palette tile or Properties focused it did nothing.

## [0.20.0] - 2026-10-05

### Added
- Select several frames, or frames and notes together, on a wider screen. **Shift**-click or **Ctrl**-click (**Cmd**-click on a Mac) a frame's title bar or border to add it to the selection; a plain click still selects just that frame.
- A marquee now picks up every frame it fully surrounds, as well as the notes it touches. **Ctrl+A** (**Cmd+A**) selects every note and frame.
- Selected frames get the same tick as selected notes, and the dashed box goes round the whole selection.
- Drag any selected frame or note to move everything selected. Each frame brings the notes inside it (a note inside two selected frames goes with the first you selected), and everything stops together at the edge of the board. Hold **Alt** as you start to leave the notes inside the frames behind. The arrow keys move the selection the same way. One **Undo** puts it all back.
- **Delete** on a selection with frames asks once, with how many notes and frames, and how many notes inside the frames aren't selected and will stay. The board then says how it went, and one **Undo** brings everything back.
- **Align**, **Distribute**, **Grid** and **Match size** work on frames when only frames are selected. Frames that move bring their notes; **Match size** only resizes the frames.
- With two or more frames selected, **Properties** changes the **Colour** and **Title text** of all of them at once. It sums up a mixed selection, for example "3 notes, 2 frames selected", with a bin to delete it.
- **Duplicate** copies frames and mixed selections. Frames are copied on their own (the notes inside only if they're selected too), and the copies keep their arrangement.

### Changed
- With notes and frames selected together, the arranging tools are off and the Arrange panel says why. **Bring to front** and **Send to back** act on the selected notes; with only frames selected they're off, because frames always sit behind notes.
- The Help topics for notes and for touch and keyboard describe selecting, moving and deleting frames together.

## [0.19.0] - 2026-10-05

### Added
- See other people's pointers on the board, live. Each shows as a small arrow in that person's colour with their name beside it. It moves as they move their mouse, fades after a few seconds without movement, and disappears when their pointer leaves the board.
- Your own pointer is shared while your mouse is over the board on a wider screen, and only when someone else is in the session. Phones and touch screens show other people's pointers but don't share one.
- Two switches in **Participants**, under **Cursors**: **Show other people's cursors** and **Share my cursor**. Both start on, and this browser remembers your choice.
- Pointers are passed on live and never stored. About > Privacy and the **Participants** help topic say so.

### Changed
- After this update, pages opened before it say **please reload** when they try to join, as with earlier updates.

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
