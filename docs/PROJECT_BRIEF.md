# Project Brief: Stickyard

Last updated: 4 October 2026 (thread 9). Update the status table and session log at the end of every thread, then re-upload.

## 1. Purpose

A personal, for-fun build project: a real-time collaborative whiteboard of sticky notes for workshops and retros. Join by link or QR code and a typed name, no accounts. Learning goal: build a collaboration app properly (rooms, presence, sync, reconnect, persistence, abuse limits). Optional AI later (summary, sentiment analysis).

Positioning hypothesis: the retro and workshop board you can start in 10 seconds with no sign-in. Wedge = frictionless joining plus facilitation (silent brainstorm, timer, voting, structured outcome). Checked against Miro on 3 October 2026 and the wedge holds: Miro Lite needs no sign-in, but its board expires after 24 hours unless you sign up, and sharing is a separate step. Stickyard's counterpoint is a link plus a typed name, and facilitation.

## 2. Non-goals

- Beating Miro, Mural or Microsoft Whiteboard
- Freehand ink, or a large shape library. (A small fixed set of shapes and connectors for planning is in scope.)
- Accounts, verified identity, enterprise admin
- Work use or organisation-specific content. Examples and fixtures stay generic.
- Huge rooms (cap is small and enforced)
- Anything that needs file uploads or integrations

## 3. Key decisions (initial; revise as we go)

| Area | Decision |
|---|---|
| Repo | New repo, separate from Chalkline. Public (needed for free GitHub Pages). One repo: `web/`, `worker/`, `shared/` |
| Front end | Vite, React, TypeScript strict, Zustand, Tailwind, Vitest. Canvas is React Flow (`@xyflow/react`, slice 2.5), controlled: notes stay in our own store |
| Relay | Cloudflare Worker + one Durable Object per room, SQLite-backed, WebSocket Hibernation API, free plan |
| Hosting | GitHub Pages via Actions for web; `wrangler deploy` for worker; hash routes (`#/room/CODE`) |
| Worker URL | Free `workers.dev` address, held in one config constant so it can move |
| Protocol | Zod message schemas in `shared/`, used by both sides. Protocol version in the join handshake; friendly "please reload" on mismatch |
| Sync | v1 server-authoritative, last-write-wins, optimistic client updates. Yjs considered later, after feeling the problem |
| Identity | Room code + typed name. Names are unverified and the UI says so. Server assigns colour and ids; never trust client-claimed name/colour/id |
| Room creation | Joining is open with the link; creating is gated by a create passcode held as a Worker secret (constant-time compare, rate-limited failures, never logged). Room codes are long, random and HMAC-signed; the Worker verifies the signature before addressing any Durable Object |
| Abuse control | Per-IP and global daily room-creation caps; `CREATION_ENABLED` kill switch (Worker secret, flipped by a workflow) stops new rooms without a redeploy; per-room caps on size, notes, message size and message rate |
| Host | Creator receives a separate host token for lock, timer and end session (slice 6). The link alone can't do that. Decided 4 October 2026: a minimal token, in the timer and lock slice |
| Room lifetime | Rooms expire after a set idle time, cleared by the room's own alarm, with a tombstone and a clear message for old links; the host can end a session |
| Undo | Per user, in memory only, skips other people's changes, cleared on reconnect. About > Privacy says undo history is memory-only and restored items are recorded as added by the restorer's visit |
| Secrets | `CREATE_PASSCODE` and `ROOM_SIGNING_KEY` only as GitHub secrets pushed to Worker secrets by the deploy job, and `.dev.vars` (gitignored). Tests use fake values. GitHub secret scanning and push protection on |
| Security | Worker checks `Origin` (Pages origin + localhost dev; stops other websites, not scripts); Zod-validates every message; long unguessable room codes; no secrets in the repo |
| Storage keys | Prefixed with the app name (shared `github.io` origin); nothing sensitive in browser storage |
| Cursors | Throttled (~15/s), never stored |
| Timer | Sent as start time + duration; each client counts down locally |
| Cost control | Free plan acts as a cap; check current Cloudflare limits before designing around any number |
| Dev environment | Raspberry Pi 5 (arm64) is a build machine only. Verify wrangler works on arm64 in slice 0; fallback is a deployed dev Worker |
| Verification | `npx tsc --noEmit`, `npm test`, `npm run build` (web and worker) |
| Design | Tokens (CSS variables), light and dark, mobile-first, pointer events, 44px touch targets, no hover-only features, `dvh` and safe-area insets |
| AI (late) | Optional, explicit buttons only, summary and sentiment, add-only. Key handling decided at that phase (BYO client key vs Worker-held key) |

## 4. Working rules

- One slice at a time, on its own branch (`phase-...`). Never commit directly to `main` (except the very first commit). Stop for review at the end of each slice.
- Each protocol or stored-schema change = version bump + compatibility handling + tests, in its own branch.
- Never put real secrets in files, tests, logs or prompts. If one is ever committed, rotate it immediately; deleting the file is not enough because it stays in git history.
- Definition of done: `tsc`, tests and build pass; every message validates against the shared schema; works at 360, 768 and 1280px in light and dark; primary actions reachable by touch; no hard-coded colours or sizes outside the token file; CHANGELOG.md updated and version bumped; short summary of what was built, what differed from assumptions, and what was left out.
- Claude Code may build more than asked; always review against the slice scope.
- After the one-time credential setup, Claude Code handles repo, CI, secrets and deploys itself (see section 10).
- Big multi-part prompts may run on a GitHub runner instead of the Pi: no Chalkline source there, the full test suites run normally, a PR is opened and never merged by Claude Code.
- On the Pi, worker tests run file by file when memory is short, and a browser can't always be run.

## 5. Claude Code prompt skeleton

```
Read CLAUDE.md. <Slice name>, on a `phase-...` branch. Do NOT start <list of other slices>.

First read the current <relevant code areas>. Where they differ from what is assumed below, follow the existing code and list the differences in your final summary.

[If protocol/schema change] THIS IS A PROTOCOL OR SCHEMA CHANGE. Bump the version, add compatibility handling and tests. Keep it in this branch only.

## Protocol / data
## Behaviour (numbered)
## UI (touch: 44px targets, bottom sheet on phone, both themes, 360/768/1280px)
## Cross-cutting (optimistic updates, reconnect, permissions, abuse limits, accessibility)
## Tests first
## Fixtures

Keep tsc, tests and build green. Stop for review with a summary of what was built, what differed from these assumptions, and what was left out.
```

## 6. Status

| Slice | Scope | Status |
|---|---|---|
| 0 | Repo, CI, Pages deploy, Worker deploy, secrets hygiene, protocol version, Origin check | Done (v0.1.0, PR #1) |
| 0.5 | App shell and design system: top bar, menu, Help / What's new / About sheets, theme, tokens from Chalkline | Done (v0.2.0) |
| 1 | Echo room, gated room creation, signed room codes | Done (v0.3.0, protocol v2) |
| 2 | Shared stickies, last-write-wins | Done (v0.4.0, protocol v3) |
| 2.5 to 2.7 | Board UX, panels, note size, colour and text style | Done (v0.5.0 to v0.6.0, protocol v4); see PHASE_PLAN.md |
| 2.7.1 | Separate title and body alignment | Done (v0.6.1, protocol v5, stored schema 3) |
| 2.7.2 | Separate title and body styling | Done (v0.6.2, protocol v6, stored schema 4) |
| 2.8 | Multi-select and arrange, batch message | Done (v0.7.0, protocol v7) |
| 2.9 | Inline note editing | Done (v0.7.1, web only) |
| Z-order | Bring to front / send to back | Done (v0.8.0, protocol v8, stored schema 5) |
| Welcome | Welcome screen with the new logo mark | Done (v0.8.1, web only) |
| Frames | Named areas behind notes that carry their notes | Done (v0.9.0, protocol v9, stored schema 6) |
| Frame title styling | Size, bold, italic, alignment and ink for frame titles | Done (v0.9.1, protocol v10, stored schema 7) |
| Templates | Retro, Start Stop Continue, 2x2 Impact and Effort, Sprint planning, from frames | Done (v0.10.0, web only) |
| Delete polish | Delete key on a selection, one confirm with the count, multi-delete report | Done (v0.10.1, web only) |
| Selection fixes | Frame + Delete, clearer multi-select (outline, ticks, selection box) | Done (v0.10.2, web only) |
| Arrange grid | Lay out a selection in rows and columns (Columns stepper, Auto) | Done (v0.10.3, web only) |
| Create with content | Add notes and frames with full content in one `itemsAdd`, packed by size; templates in one step | Done (v0.11.0, protocol v11, PR #25) |
| Bar, Duplicate, Undo/Redo, Clear board | Permanent floating bar, Duplicate, per-user undo/redo, Clear board (four parts, one branch) | Done (v0.12.0, web only, PR #26) |
| Reconnect and presence | Automatic reconnect with backoff, full resync, "relay may be over its daily limit" state, unsaved-change notice; avatar stack and join/leave toasts | Done (v0.13.0, web only, PR #28) |
| Idle expiry | Rooms nobody has been in for 7 days are deleted by their own alarm; a tombstone makes old links say "Session expired" (close code 4410) | Done (v0.14.0, PR #30, no protocol bump) |
| Host groundwork (6a) | Host token, lock, timer and End session in the relay and web plumbing; no visible host UI yet | Done (v0.15.0, protocol v12, PR #31) |
| Board bar in the top bar | Board actions in the top bar, reasons as tooltips, Arrange behind one button | Done (v0.15.1, web only) |
| Facilitation UI (6b) | Timer for everyone; host Timer tile, Lock board, End session; guest banner and greyed-out controls while locked; Host badges | Done (v0.16.0, web only, PR #33) |
| Dot voting groundwork (6c-a) | Anonymous voters, budgets, rounds and reveal in the relay; web plumbing; no visible voting UI yet | Done (v0.17.0, protocol v13, PR #35) |
| Next | Dot voting UI, export, trimmed hardening, then silent brainstorm | Not started; see PHASE_PLAN.md |
| 3 onwards | See PHASE_PLAN.md | See PHASE_PLAN.md |

## 7. Open decisions

- Name availability for Stickyard (GitHub, npm, domain, existing products). Name chosen: Stickyard
- Canvas: decided in slice 2.5, React Flow (controlled). Revisit only if performance with many movers is poor
- v1 target: retros/brainstorms (suggested) vs general canvas
- AI key handling
- Visual identity: decided in slice 0.5 (Chalkline's warm neutral + blue accent, Inter, sticky-note mark); revisit only if it needs its own identity
- Per-friend invite codes (revocable) vs one shared create passcode
- ~~Real-world comparison~~: done 3 October 2026, against Miro (not Microsoft Whiteboard). See the positioning note in section 1
- ~~Host token for timer and lock~~: decided 4 October 2026. A minimal host token is issued at creation in the timer and lock slice
- ~~Create with content message size~~: decided 4 October 2026. `MAX_MESSAGE_BYTES` stays 4 KiB; the web packs items by actual size
- ~~Cloudflare alarm billing and limits~~: checked 4 October 2026 for the idle-expiry slice; see LIMITS.md
- ~~Shapes and arrows (slices 7a and 7b) before or after facilitation (slice 6)~~: decided 3 October 2026 (thread 6). Order: Z-order, Frames, Templates, Timer and lock board (cut-down 6), Reconnect (4), 3a avatars and toasts, Persistence and expiry (5), remaining facilitation, 3b live cursors, 7a, 7b, 7c, 8, 9, 10. See PHASE_PLAN.md

## 8. Thread habits

Start a thread with the slice and what I want (for example "Slice 1, write the Claude Code prompt"). If it depends on earlier work, paste Claude Code's last summary, especially its "differed from assumptions" list. End a thread by asking for the session log line and status changes, then update and re-upload this file. Paste code or diffs when I want a review; the project holds the plan, not live code.

## 9. Session log

- Thread 1: Chose the idea (collaborative sticky-note whiteboard), architecture (GitHub Pages + Cloudflare Worker/Durable Objects), and drafted this brief. Next: slice 0 prompt.
- Thread 2: Wrote the slice 0 prompt (including repo creation and secrets hygiene). Decided the room-creation model: open join, passcode-gated creation, signed room codes, kill switch, host token. Next: run slice 0, then slice 1 prompt.
- Thread 3: Slice 0 merged to main (PR #1) and deployed. Slice 0.5 (app shell and design system) built from Chalkline's patterns: top bar with menu and theme toggle, Help / What's new / About as hash-routed sheets, tokens and Inter bundled locally, v0.2.0. Next: slice 1 prompt.
- Thread 4: Slice 1 built tests-first (red commit, then green): protocol v2 (join/say/echo, participants), passcode-gated `POST /rooms` with a limiter Durable Object (hashed client keys, lockout, daily caps), HMAC-signed room codes verified before any Durable Object, `CREATION_ENABLED` kill switch via a workflow, secrets pushed from GitHub secrets by the deploy job, name sheet and echo room UI, v0.3.0. Next: slice 2 prompt.
- Thread 5 (3 October 2026): Slices 2.7 (v0.6.0, protocol v4) and 2.7.1 title alignment (v0.6.1, protocol v5, stored schema 3) merged; Miro comparison done; scope now allows a small set of shapes and connectors (slice 7 split into 7a/7b/7c, z-order required before or with 7a). Next: slice 2.8 prompt.
- Thread 6 (3 October 2026): Slices 2.7.2 title styling (v0.6.2, protocol v6, stored schema 4), 2.8 multi-select and arrange (v0.7.0, protocol v7) and 2.9 inline editing (v0.7.1, web only) merged. Re-ordered the plan: slice 3 split into 3a (avatars, toasts) and 3b (live cursors, deferred); new Frames and Templates slices after z-order; slice 6 split, with timer and lock board early; shapes-versus-facilitation question closed. Docs-only tidy of CLAUDE.md and the changelog. Next: z-order slice prompt.
- Thread 6, later (3 October 2026): Z-order merged and deployed (v0.8.0, protocol v8, stored schema 5). Frames stopped before building: with 30 frames and 60-character titles the worst-case snapshot (419,360 bytes) would breach the 400 KiB tripwire, so it needs a decision first. Welcome screen with the new logo mark built (v0.8.1, web only). Next: decide how frames fit the snapshot budget, then the frames prompt.
- Thread 6, later (4 October 2026): Frames merged and deployed (v0.9.0, protocol v9, schema 6). Frame title styling built (v0.9.1, protocol v10, schema 7): it stopped first because the framesSnapshot worst case (18,306 bytes) broke the 16 KiB test cap; decided to raise that cap to 20 KiB with a 10% rule. Frame-only dark-theme inks added. Merged and deployed.
- Thread 6, later (4 October 2026): Templates built (v0.10.0, web only): four templates in a Templates palette category, applied as paced frame adds, then a resize and a style edit per frame once confirmed. Merged and deployed. Next: timer and lock board.
- Thread 7 (4 October 2026): Delete polish finished after an editor crash mid-build (v0.10.1, web only): Delete on a selection, one confirm with the count, a report of how a multi-note delete went. A racy worker z-order test fixed (CI only). Then, from user feedback, selection fixes (v0.10.2, web only): frame + Delete works (the title no longer takes the selecting click), a 0.10.1 regression where a click on the canvas focused `<main>` and Delete was ignored (found by checking in Chromium; happy-dom hid it), and a clearer multi-select. Both merged and deployed. Next: timer and lock board.
- Thread 8 (4 October 2026): Arrange grid built tests-first (v0.10.3, web only): Arrange > Grid in the selection bar lays a selection out in rows and columns in reading order, with a Columns stepper and Auto; a grid too big for the board moves nothing and says why. The editor crashed after the PR was opened; picked up from git and the open PR, then merged and deployed. Next: timer and lock board.
- Thread 9 (4 October 2026): Grid merged (v0.10.3). Create with content built (protocol v11, v0.11.0): `itemsAdd` adds notes and frames with full content, packed under the 4 KiB cap; templates apply in one step. Floating bar, Duplicate, undo/redo and Clear board built on one branch as four parts (v0.12.0, web only, PR #26), merged and deployed. Idle-room cost reviewed and a trimmed expiry slice pulled forward. Order to a demo-able retro tool agreed: reconnect, expiry, timer and lock board, presence, voting, export, trimmed hardening. Next: reconnect prompt.
- Thread 9, later (4 October 2026): Reconnect and Presence 3a built on one branch in three parts, tests first (v0.13.0, web only, no protocol or schema change, PR #28): automatic reconnect with backoff and a cap, full resync, a conservative "relay may be over its daily limit" state, one notice for unsaved changes, drafts kept; avatar stack and batched join/leave toasts; the 0.12.0 stale-undo-button bug fixed. Checked in headless Chromium against a local relay (relay killed and restarted, offline/online, 360/768/1280, light and dark), which found and fixed toasts for other people's quick reconnects. Merged and deployed. Next: idle expiry prompt.
- Thread 9, later still (4 October 2026): Idle room expiry built on one branch in three parts, tests first (v0.14.0, PR #30, no protocol or schema-version bump): the last close sets a 7-day Durable Object alarm (with a 1-hour slack so come-and-go barely writes), the alarm deletes an empty room and leaves a one-row tombstone, and old links get close code 4410 and a "Session expired" page with no retries. Help, Privacy, LIMITS.md and CLAUDE.md updated. Checked in headless Chromium against a local relay. Merged and deployed. Next: timer and lock board prompt.
- Thread 9, later still (4 October 2026): Host groundwork (6a) built on one branch in three parts, tests first (v0.15.0, protocol v12, PR #31): stateless host token from room creation, claimHost, board lock with board_locked refusals for every board-changing message, a server-clock timer, End session (4411, ended_at tombstone, burial now transactional and shared with expiry); the web stores the token per room, claims host on every join and shows "Session ended"; no visible host UI yet. Probe threshold raised to 5. Merged and deployed. Then, from user feedback on the live board, the board bar moved into the top bar with reasons as hover/focus tooltips and Arrange behind one button (v0.15.1, web only), checked in Chromium at 768/1024/1280 in both themes; merged and deployed. Next: timer and lock board UI (6b).
- Thread 9, evening (4 October 2026): Facilitation UI (6b) built on one branch in three parts, tests first (v0.16.0, web only, PR #33): a timer chip everyone sees (relay clock, polite announcements at start, 1 minute and end), the host's Timer tile and picker, Lock board with a guest banner and every board control greyed out with the reason, End session, Host badges and named avatars, a phone Session section. A host-and-guest run in Chromium at 360/768/1280 in both themes found a top-bar overflow at 1280, fixed before merging. Merged and deployed. Next: dot voting.
- Thread 9, later that evening (4 October 2026): Dot voting groundwork built on one branch in three parts, tests first (v0.17.0, protocol v13, stored schema 8, PR #35): anonymous voters (an HMAC of a random per-room key from the page; the key is never stored by the relay), budgets enforced by the relay, host start/stop/clear, totals only on reveal and to late joiners, at most 40 voters a round, votes deleted with their note and at burial; the web keeps the key per room, claims on every join and keeps votes, dots left and results in state. No visible voting UI. Checked in headless Chromium against a local relay. Merged and deployed. Next: dot voting UI.

## 10. One-time manual setup

Claude Code can create the repo, enable Pages, set secrets and deploy, but needs credentials from me once:

1. GitHub: logged in on the Pi (`gh auth login`).
2. Cloudflare: one scoped API token plus account ID, created in the dashboard (slice 0 prompt makes Claude Code check current Cloudflare docs and state exactly which permissions to grant). I set them myself with `gh secret set`, never pasted into chat or files.
3. First Worker deploy: Cloudflare may ask me to register a `workers.dev` subdomain once.
4. Before slice 1: generate the create passcode (`openssl rand -base64 24`) and a signing key, store both in a password manager, and set them as GitHub secrets (`gh secret set CREATE_PASSCODE`, `gh secret set ROOM_SIGNING_KEY`); the deploy job pushes them to the Worker. The kill switch is the "Room creation switch" workflow. Create rooms from phone or Pi, not a managed work device.
