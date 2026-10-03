# Changelog

All notable changes to Stickyard, newest first. The format follows Keep a Changelog. Versions are 0.x: a minor bump for each slice and a patch bump for each follow-up fix. This file is shown in the app under **What’s new**, so entries are written for the people using it.

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
