---
title: AI features
order: 14
summary: Add your own Anthropic API key in Settings, where it's kept and how to remove it; Test key; Set up board from a prompt; and Summarise board (host only): what each sends, what you see first, and undo.
keywords: ai, anthropic, summary, summarise, summarize, sentiment, themes, actions, overview, claude, api key, key, settings, test key, remember, session, cost, billing, models, haiku, sonnet, privacy, set up, setup, prompt, generate, template, retro, planning, preview
---
## Your own key

- AI features use your own Anthropic API key, and you pay Anthropic for what you use. Stickyard has no AI server and no key of its own.
- There are two AI features so far: **Set up board from a prompt** and **Summarise board** (both below).
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

## Summarise board (host only)

- Only the host can use it. In a shared session it sends everyone's notes to Anthropic under one person's key, and the others aren't told, so for everyone else **Summarise board** is off with the reason: “Only the host can send the board to AI.” It's also off during a silent round (“Silent brainstorm is on.”), because the page only sees its own hidden notes then; it's back after the reveal. A locked board doesn't stop the host.
- Open the menu in a session and choose **Summarise board**, or use the button in Properties when nothing is selected. Without a key saved it says to add one first, with **Open Settings**.
- It summarises the whole board or, if notes or frames are selected, your choice of the whole board or the selection (the selected notes and the notes in the selected frames). **Deeper analysis** uses the larger model (Claude Sonnet 5.5) instead of Claude Haiku 5.5: slower, and it costs more.
- **What's sent**: only note text and frame titles, grouped by frame. No names, authors, ids, colours, positions or votes are sent, and nor are reactions or chat. Hidden notes in a silent round are never sent. Check before sending says how many notes and frame titles go, and reminds you that these notes were written by everyone in this session and go to Anthropic using your key. Nothing is sent until you press **Send**.
- Limits: at most 200 notes and 24,000 characters of text in one go. Over that, **Send** is off and the page says how many notes to deselect. A board with no text says “Nothing to summarise.”
- The result is text only: an overview, up to 6 themes (each with how many notes), the sentiment (overall, with the count of positive, neutral, negative and mixed notes counted by the page, and a label for each frame), and up to 6 possible actions. **Show note** selects a note it's based on and shows it on the board.
- It's written by AI from short notes and can be wrong: check it against the board. It says when it was made and from how many notes; the board may have changed since.
- It's never stored: it stays in this page's memory until you leave the session or reload. To keep it: **Copy for documents** copies it with its headings and lists, ready to paste into a document such as Word (where the browser can't copy formatting, it copies plain text and says so); **Copy as Markdown** copies it as Markdown, for tools that read Markdown; or **Add to board** (below), after which Export board includes it. You can also select the text and copy it. **Try again** sends a new request (another charge) through the check page.
- **Add to board** only adds: one frame called “AI summary (draft)” next to what's on the board, holding a note for the overview, each theme, each action and the sentiment, all one colour. Nothing is replaced or cleared, and one undo removes all of it. It's off when the board hasn't room (it says how many fit), and if the connection dropped, you stopped being the host or a silent round started since you sent it.

## Requests and cost

- Nothing is sent until you press Send, and nothing is ever retried by itself: you choose **Retry**.
- A request that you cancel, or that times out, may already have reached Anthropic, and a request that was already sent can still be billed.
- Anthropic's own limits apply: a rate limit, a spend limit or an empty credit balance shows its own message, with what to do next.

## Models

- AI features use two models: Claude Haiku 5.5 (small and fast) and Claude Sonnet 5.5 (larger). There's no model picker.
