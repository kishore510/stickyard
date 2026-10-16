---
title: AI features
order: 14
summary: Add your own Anthropic API key in Settings, where it's kept, how to remove it, and what Test key sends.
keywords: ai, anthropic, claude, api key, key, settings, test key, remember, session, cost, billing, models, haiku, sonnet, privacy
---
## Your own key

- AI features use your own Anthropic API key, and you pay Anthropic for what you use. Stickyard has no AI server and no key of its own.
- There are no AI feature buttons yet. This version adds the key and **Test key**; the features that use it come later.
- Open the menu and choose **Settings**, then **AI (your own key)**. It works on any screen, with or without a session.
- Create a key in the Claude Console (API keys), paste it into **Anthropic API key** and choose **Save key**. Spaces and line breaks are removed. A key that doesn't start with sk-ant- gets a hint, but it's still saved.
- The page only ever shows the key's last four characters (•••• abcd). **Show** reveals what you're typing before you save.

## Where it's kept

- **This session only** (the default): the key is kept in this tab's memory. Nothing is stored, and it's forgotten when you reload or close the tab.
- **Remember on this device**: the key is stored in this browser, unencrypted, until you remove it. A red warning comes first: anyone who uses this browser, and other pages on this web address, could read it and spend on your Anthropic account. Only choose it on a device that's yours alone.
- If this browser blocks storage (some private modes do), the key is kept for this session only, and Settings says so.
- The key is never shared with the room, a board file, a stencil, a link or an error message. Other people in a session never see it, and it never goes to Stickyard's relay.
- **Remove key** forgets it at once, in both places. **Replace key** swaps it for another.

## Test key

- **Test key** first shows what it would send. Nothing is sent until you press **Send**; **Cancel** sends nothing.
- It sends the word “Hi” once for each model to Anthropic's token-counting endpoint (count_tokens), which is free. It goes straight from this browser to api.anthropic.com.
- It works only if both models answer. If one doesn't, Settings names it, with the reason, a **Details** line (no key in it) and **Retry**. Settings shows when the last test worked or failed.
- **Cancel** while a test runs stops it; a cancelled test isn't a failure.

## Requests and cost

- Nothing is sent until you press Send, and nothing is ever retried by itself: you choose **Retry**.
- A request that you cancel, or that times out, may already have reached Anthropic, and a request that was already sent can still be billed.
- Anthropic's own limits apply: a rate limit, a spend limit or an empty credit balance shows its own message, with what to do next.

## Models

- AI features use two models: Claude Haiku 5.5 (small and fast) and Claude Sonnet 5.5 (larger). There's no model picker.
