---
title: Connection
order: 3
summary: What the connection check means, and what to do about "Please reload".
keywords: connection, connect, relay, server, connected, reload, offline, error, protocol, version, websocket
---
The start page checks that your browser can reach the **relay**: the server that will pass changes between everyone in a session.

## What the check shows

- **Connecting…**: trying to reach the relay.
- **Connected (protocol v1)**: the relay answered. The protocol number is the version of the message format. Your page and the relay must use the same one.
- **Please reload**: Stickyard has been updated since you opened this page, so your copy is out of date. Choose **Reload page** to get the latest version.
- **Cannot connect**: the relay didn't answer within 10 seconds, or the connection dropped. Check your internet connection, then choose **Try again**.

> Some work or school networks block live connections (WebSockets). If the check fails on one network but works on another, that's the likely cause.

## Reporting a problem

Open **About** from the menu and choose **Copy details**. It copies the version, build, protocol and browser, and nothing else, ready to paste into a bug report.
