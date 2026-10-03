# Phase plan: Stickyard

Last updated: 3 October 2026

Draft roadmap. When a slice starts, rewrite its prompt against the real code (see the skeleton in PROJECT_BRIEF.md). Do not treat these notes as final prompts.

## Status at a glance

| Slice | Scope | Status |
|---|---|---|
| 0 Setup | Repo, CI, Pages deploy, Worker deploy, secrets hygiene, protocol version, Origin check | Done (v0.1.0) |
| 0.5 App shell | App shell and design system: top bar, menu, Help / What's new / About sheets, theme, tokens | Done (v0.2.0) |
| 1 Echo room | Two tabs, join by code and name; gated room creation; signed room codes | Done (v0.3.0, protocol v2) |
| 2 Shared stickies | Add/edit/move/delete, last-write-wins, optimistic updates | Not started |
| 3 Presence | Names, colours, live cursors (throttled, not stored) | Not started |
| 4 Reconnect | Resync after drops, offline queue | Not started |
| 5 Persistence | Room saved in the Durable Object; room expiry | Not started |
| 6 Facilitation | Shared timer, lock board, silent brainstorm + reveal, dot voting, host token | Not started |
| 7 Structure | Columns/templates (retro, 2x2), grouping, export (PNG/Markdown) | Not started |
| 8 Phone view | Phone participant view, QR join | Not started |
| 9 Hardening | Message-rate limits, load test, accessibility pass | Not started |
| 10 AI | Summary and sentiment analysis, explicit buttons, add-only | Optional, last |
| Later | Yjs migration, anonymous mode, PWA | Parked |

## Order and principles

- Each rung gives a working result. Stop at any rung and still have something that works.
- Success criterion for the core: two phones and a laptop editing the same board reliably.
- Build slice 2 by hand (last-write-wins) before considering Yjs, so the problem Yjs solves is understood.

## Slice notes

### 0 Setup
- Single repo: `web/`, `worker/`, `shared/` (message types and Zod schemas).
- Verify `wrangler` works on arm64; fallback is a deployed dev Worker.
- SQLite-backed Durable Object and WebSocket Hibernation from day one.
- Pages via Actions with a base-path env var; Worker via `wrangler deploy` (second Actions job using a scoped Cloudflare token stored as a GitHub secret).
- Protocol version in the join handshake; "please reload" message on mismatch.
- Origin check on the Worker (Pages origin plus localhost).
- Secrets hygiene: gitignore, fake values in tests, GitHub secret scanning and push protection.
- Check current Cloudflare free-plan limits and record them in `docs/LIMITS.md`.

### 0.5 App shell and design system
- Chalkline's design language and structure (patterns only): tokens, light/dark, Inter bundled, warm neutral + blue accent, shadcn-style components, Lucide icons, Chalkline breakpoints.
- Top bar (mark, menu with What's new dot, theme toggle); menu popover; Help, What's new and About as sheets (bottom sheet on phone, right side panel from md), hash-routed.
- Help topics as Markdown files; What's new renders CHANGELOG.md; About shows build info, Copy details, privacy and credits.
- Floating bottom bar region left for slice 2 (add note).

### 1 Echo room
- Room code in the hash route; name entry; server assigns id and colour.
- Create-room endpoint gated by passcode (constant-time compare, failed attempts rate-limited, never logged).
- Signed room codes (HMAC), verified before any Durable Object is touched.
- Creation rate limits (per IP and global daily) and `CREATION_ENABLED` kill switch.
- Type in one tab, see it in another. Name unverified notice in the UI.

### 2 Shared stickies
- Server is the source of truth; clients send intents ("move note X to here").
- Optimistic local update, confirm in the background, throttled drag batches, smoothed remote movement.
- Caps: notes per room, text length, message size, message rate.

### 3 Presence
- Join/leave badges, assigned colours, live cursors at about 20/s, not persisted.

### 4 Reconnect
- Detect drop, show state, reconnect with backoff, full resync on rejoin, queue changes made offline and reconcile.

### 5 Persistence and expiry
- Room state saved in Durable Object storage; rooms expire after a set idle time; clear messaging about it.

### 6 Facilitation
- Timer (start time + duration, local countdown), lock board, silent brainstorm with reveal, dot voting with a vote budget.
- Host token issued at creation; facilitator role and what happens if the host leaves; "end session".

### 7 Structure
- Templates: retro, 2x2, start/stop/continue, affinity grouping. Export to Markdown and PNG.

### 8 Phone view
- Add a note, vote, see the timer. Big canvas is for the shared screen. QR join.

### 9 Hardening
- Load test, message-rate limits, malformed-message tests, accessibility pass, keyboard support, reduced motion.

### 10 AI (optional)
- Summary and sentiment of board content. Explicit buttons, confirmation with size estimate, add-only output, content treated as data. Key handling decided then.

## Open questions

- Stickyard name availability
- Canvas: own vs library
- Retros/brainstorms first vs general canvas
- Yjs timing
- Real limits on the Cloudflare free plan at build time
- Visual identity: settled in slice 0.5 (Chalkline-derived)
- Per-friend invite codes

## Backlog (no slot yet)

- Anonymous notes mode
- Saved boards / board history (needs a storage decision)
- Reactions and comments on notes
- Templates created by users
- Revocable invite codes per friend
- Spin-offs reusing the relay (planning poker, vote room)
