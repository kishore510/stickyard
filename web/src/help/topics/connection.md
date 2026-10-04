---
title: Connection
order: 7
summary: What the connection status means, what happens when the connection drops, and what to do about "Please reload".
keywords: connection, connect, relay, server, connected, reload, offline, online, error, protocol, version, websocket, lost, rejoin, reconnect, reconnecting, dropped, saved, unsaved, undo, limit, daily, full
---
Stickyard passes messages between everyone in a session through a **relay**: a small server. The start page shows whether your browser can reach it.

## What the status shows

- **Connecting…**: trying to reach the relay.
- **Connected (protocol v3)**: the relay answered. The protocol number is the version of the message format. Your page and the relay must use the same one.
- **Please reload**: Stickyard has been updated since you opened this page, so your copy is out of date. Choose **Reload page** to get the latest version.
- **Cannot connect**: the relay didn't answer within 10 seconds. Check your internet connection, then choose **Try again**.

## If the connection drops

- Stickyard reconnects by itself. The top of the board says **Reconnecting…** and which try it's on. It tries after about 1 second, then 2, 4 and so on up to 30 seconds, eight times in all, and straight away when your network comes back or you return to the tab. You rejoin with the same name, without being asked.
- While you're disconnected the board stays on screen but is read-only.
- If it can't get through, it says **Offline**. Choose **Rejoin** to start again. If your device has no network, it says **You're offline** and tries as soon as the network is back.
- If the session filled up (20 people) while you were away, it says so. Choose **Rejoin** when someone leaves.
- If the relay can't be reached at all, it may be down or over its free daily limit (Stickyard can't tell which from your browser). The board says so: the limit resets at 00:00 UTC, and Stickyard checks once a minute while the tab is open. You can choose **Rejoin** at any time.

## What happens to your changes

- There's no offline queue. Changes the relay hadn't confirmed when the connection dropped are undone on your screen, and one message says how many may not have been saved. Adding a template, clearing the board, and deleting or undoing several things each say how far they got.
- Text you were typing into a note is kept. Once you're back it's saved as usual. If someone deleted that note meanwhile, the board shows your text and offers **Add as a new note**.
- When you're back, the board reloads from the relay, so it shows exactly what's saved, including what others changed meanwhile.
- **Undo** and **Redo** start afresh after a reconnect: you can't undo what you did before the connection dropped.
- Chat messages you'd already received stay. Messages can't be sent while you're disconnected.

> Some work or school networks block live connections (WebSockets). If joining fails on one network but works on another, that's the likely cause.

## Reporting a problem

Open **About** from the menu and choose **Copy details**. It copies the version, build, protocol and browser, and nothing else, ready to paste into a bug report.
