# Changelog

All notable changes to Stickyard, newest first. The format follows Keep a Changelog. Versions are 0.x: a minor bump for each slice and a patch bump for each follow-up fix. This file is shown in the app under **What’s new**, so entries are written for the people using it.

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
