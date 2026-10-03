---
title: Connection
order: 7
summary: What the connection status means, and what to do about "Please reload".
keywords: connection, connect, relay, server, connected, reload, offline, error, protocol, version, websocket, lost, rejoin
---
Stickyard passes messages between everyone in a session through a **relay**: a small server. The start page shows whether your browser can reach it.

## What the status shows

- **Connecting…**: trying to reach the relay.
- **Connected (protocol v3)**: the relay answered. The protocol number is the version of the message format. Your page and the relay must use the same one.
- **Please reload**: Stickyard has been updated since you opened this page, so your copy is out of date. Choose **Reload page** to get the latest version.
- **Cannot connect**: the relay didn't answer within 10 seconds. Check your internet connection, then choose **Try again**.

## In a session

- If the connection drops, the session says **Connection lost**. Choose **Rejoin** to go back in.

> Some work or school networks block live connections (WebSockets). If joining fails on one network but works on another, that's the likely cause.

## Reporting a problem

Open **About** from the menu and choose **Copy details**. It copies the version, build, protocol and browser, and nothing else, ready to paste into a bug report.
