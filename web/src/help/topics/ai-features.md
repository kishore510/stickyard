---
title: AI features
order: 14
summary: Add your own Anthropic API key in Settings, where it's kept and how to remove it; Test key; and Set up board from a prompt: what it sends, the preview, undo and the limits.
keywords: ai, anthropic, claude, api key, key, settings, test key, remember, session, cost, billing, models, haiku, sonnet, privacy, set up, setup, prompt, generate, template, retro, planning, preview
---
## Your own key

- AI features use your own Anthropic API key, and you pay Anthropic for what you use. Stickyard has no AI server and no key of its own.
- The first AI feature is **Set up board from a prompt** (below). More come later.
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

## Set up board from a prompt

- Open the menu in a session and choose **Set up board from a prompt**, or use the button on an empty board. Without a key saved it says to add one first, with **Open Settings**.
- Describe the session you want to run, in up to 1,000 characters, or start from an example (a retro, sprint planning, or risks for a kick-off). Then **Continue**.
- **Check before sending** shows the model (Claude Sonnet 5.5) and what's sent: only the description you type. No board content, no names and no notes are sent. Nothing is sent until you press **Send**.
- While the reply arrives you see how many characters have come in, and **Cancel** stops it (a request that was already sent can still be billed).
- A **preview** shows what would be added, frame by frame: each frame's title and colour, its notes, the counts, anything the page had to fix in the reply, and the tokens used. Nothing is added until you choose **Add to board**. **Try again** goes back to your description, kept, and sends a new request; **Cancel** adds nothing.
- **Add to board** puts it in the nearest free space to the middle of your view, without covering anything, and selects it; the view moves only if it's off screen. Frames carry their own notes when you drag them. It only adds: nothing is replaced or cleared, and one undo removes all of it.
- Limits: at most 60 items in one go (frames and notes together), at most 8 frames, and notes of at most 140 characters, in the board's own colours. Anything beyond that, or beyond what the board has room for, is left out and listed in the preview. A reply that can't be turned into a board, is cut short or is declined shows a short reason and **Retry**.
- It's off for guests on a locked board, during a silent round, while disconnected, and when the board already has 200 notes, saying why. If that changes while the reply is coming, **Add to board** says so instead of adding.

## Requests and cost

- Nothing is sent until you press Send, and nothing is ever retried by itself: you choose **Retry**.
- A request that you cancel, or that times out, may already have reached Anthropic, and a request that was already sent can still be billed.
- Anthropic's own limits apply: a rate limit, a spend limit or an empty credit balance shows its own message, with what to do next.

## Models

- AI features use two models: Claude Haiku 5.5 (small and fast) and Claude Sonnet 5.5 (larger). There's no model picker.
