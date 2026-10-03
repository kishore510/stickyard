# Project Brief: Stickyard

Last updated: 3 October 2026 (thread 6). Update the status table and session log at the end of every thread, then re-upload.

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
| Host | Creator receives a separate host token for lock, timer and end session (slice 6). The link alone can't do that |
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
| 3 onwards | See PHASE_PLAN.md | See PHASE_PLAN.md |

## 7. Open decisions

- Name availability for Stickyard (GitHub, npm, domain, existing products). Name chosen: Stickyard
- Canvas: decided in slice 2.5, React Flow (controlled). Revisit only if performance with many movers is poor
- v1 target: retros/brainstorms (suggested) vs general canvas
- AI key handling
- Visual identity: decided in slice 0.5 (Chalkline's warm neutral + blue accent, Inter, sticky-note mark); revisit only if it needs its own identity
- Per-friend invite codes (revocable) vs one shared create passcode
- ~~Real-world comparison~~: done 3 October 2026, against Miro (not Microsoft Whiteboard). See the positioning note in section 1
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

## 10. One-time manual setup

Claude Code can create the repo, enable Pages, set secrets and deploy, but needs credentials from me once:

1. GitHub: logged in on the Pi (`gh auth login`).
2. Cloudflare: one scoped API token plus account ID, created in the dashboard (slice 0 prompt makes Claude Code check current Cloudflare docs and state exactly which permissions to grant). I set them myself with `gh secret set`, never pasted into chat or files.
3. First Worker deploy: Cloudflare may ask me to register a `workers.dev` subdomain once.
4. Before slice 1: generate the create passcode (`openssl rand -base64 24`) and a signing key, store both in a password manager, and set them as GitHub secrets (`gh secret set CREATE_PASSCODE`, `gh secret set ROOM_SIGNING_KEY`); the deploy job pushes them to the Worker. The kill switch is the "Room creation switch" workflow. Create rooms from phone or Pi, not a managed work device.
