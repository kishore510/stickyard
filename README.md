# Stickyard

A real-time collaborative sticky-note whiteboard for workshops and retros. Join by link and a typed name, no accounts.

Personal learning project. Front end on GitHub Pages, relay on a Cloudflare Worker with one Durable Object per room.

See [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md), [docs/PHASE_PLAN.md](docs/PHASE_PLAN.md) and [docs/LIMITS.md](docs/LIMITS.md).

**Status:** v0.21.0 (protocol v15). Start a session with the create passcode, share its link, and join by link and name. On the board: sticky notes with size, colour and text style, frames, text labels and shapes (rectangle, oval, diamond), templates, multi-select and arrange (notes, shapes and frames), z-order, duplicate, undo/redo, chat, automatic reconnect, and presence (avatars, join/leave messages). Sessions expire after 7 days with nobody in them. The session's host (whoever started it, on that device) can run a timer everyone sees, lock the board, and end the session. The host can also run anonymous dot voting: everyone spreads a few dots over the notes, and the totals and a results list show when the host stops the round. Everyone sees other people's pointers, with their names, while they move over the board (switchable in Participants). See [CHANGELOG.md](CHANGELOG.md) for what each version added.

## Layout

| Folder | What |
|---|---|
| `web/` | Vite + React + TypeScript + Zustand + Tailwind front end. Design tokens in `web/src/styles/tokens.css` |
| `worker/` | Cloudflare Worker + SQLite-backed Durable Object (WebSocket Hibernation API) |
| `shared/` | Zod message schemas and `PROTOCOL_VERSION`, used by both sides |

npm workspaces at the root; `shared/` is consumed as TypeScript source (no build step).

## Local development

Requires Node 24 (see `.nvmrc`; `nvm use`). Works on a Raspberry Pi 5 (arm64), including local `wrangler dev`.

```sh
npm install
cp worker/.dev.vars.example worker/.dev.vars   # then fill in your own local values (gitignored)

# terminal 1: relay on http://127.0.0.1:8787
cd worker && npx wrangler dev --ip 127.0.0.1 --port 8787

# terminal 2: web on http://127.0.0.1:5173
cd web && npx vite --host 127.0.0.1
```

In dev the web app talks to `http://127.0.0.1:8787` by default. To point it elsewhere (for example a deployed Worker), create `web/.env.local` (gitignored) with:

```sh
VITE_WORKER_URL=https://stickyard.<your-subdomain>.workers.dev
```

The production Worker URL is a single constant in `web/src/config.ts`.

Checks (same as CI):

```sh
npm run typecheck   # tsc --noEmit in shared, web, worker
npm test            # vitest; worker tests run inside workerd
npm run build       # web build + worker dry-run bundle
```

`worker/.dev.vars` holds local-only values for `CREATE_PASSCODE`, `ROOM_SIGNING_KEY` and `CREATION_ENABLED=true`. Use made-up values, never the production ones. Tests use their own obviously fake values (`worker/vitest.config.ts`).

Endpoints (all browser calls are Origin-checked; see below):

| Endpoint | What |
|---|---|
| `GET /health` | `{ "ok": true, "protocolVersion": <PROTOCOL_VERSION> }` (10 at v0.10.2). No Durable Object. Used for the start page's status line |
| `POST /rooms` | Body `{ "passcode": "..." }` (max 1 KB). `200 { code }`, `401 invalid_passcode`, `429 rate_limited` + `Retry-After`, `503 creation_disabled` / `not_configured`, `400` / `413` |
| `GET /rooms/check?room=<code>` | `200` if the code's signature is valid, else `404`. No Durable Object |
| `GET /ws?room=<code>` | The room WebSocket. Origin, then signature, then the room's Durable Object. Invalid codes: one generic `404` |
| `GET /ws` (no code) | Only answers a v1 `hello` with `version_mismatch` so old cached pages say "please reload" |

Room codes are `<id>.<sig>`: 16 random bytes and a 128-bit HMAC-SHA256 of `stickyard-room-v1:<id>` keyed by `ROOM_SIGNING_KEY`, both base64url. Abuse limits (passcode lockout, daily creation caps, per-socket message rate) are in `worker/src/limits.ts`; the participant cap and text limits are in `shared/src/protocol.ts`.

## Deploy

All deploys run from GitHub Actions (`.github/workflows/ci.yml`):

- **Every push / PR:** typecheck, test, build.
- **Push to `main`:** deploy `web/` to GitHub Pages (base path `/<repo>/`) and `wrangler deploy` the Worker.
- **Manual (`workflow_dispatch`, any branch):** deploys the Worker; tick "deploy_pages" to also deploy Pages (only from branches the `github-pages` environment allows, by default `main`).

```sh
gh workflow run ci.yml --ref <branch>
gh workflow run ci.yml --ref main -f deploy_pages=true
```

The Worker deploy needs two repository secrets, set by you (never pasted anywhere else):

```sh
gh secret set CLOUDFLARE_API_TOKEN    # prompts for the value; nothing lands in shell history
gh secret set CLOUDFLARE_ACCOUNT_ID
```

The Cloudflare API token needs only **Account → Workers Scripts → Edit**, scoped to this one account (enough for Worker + Durable Object migrations + workers.dev). Deployed relay: `https://stickyard.kishore510.workers.dev`.

The allowed browser origin for `/ws` is `ALLOWED_ORIGINS` in `worker/wrangler.jsonc`. `localhost` / `127.0.0.1` over http on any port are always allowed for dev. This stops other websites using the relay from a browser. It does not stop scripts, which can fake the header.

Manual Origin check (use `--http1.1`; over HTTP/2 there is no `Upgrade` header, so you'd get 426):

```sh
WS=(--http1.1 -s -o /dev/null -w "%{http_code}\n" -H "Upgrade: websocket" -H "Connection: Upgrade" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
curl -m 5 "${WS[@]}" -H "Origin: https://kishore510.github.io" https://stickyard.kishore510.workers.dev/ws  # 101 (then times out: socket stays open)
curl "${WS[@]}" -H "Origin: https://evil.example" https://stickyard.kishore510.workers.dev/ws               # 403
```

## Secrets

No secrets are ever committed. The Worker needs two:

| Secret | Purpose |
|---|---|
| `CREATE_PASSCODE` | Gates starting a session (compared in constant time, never logged) |
| `ROOM_SIGNING_KEY` | HMAC key for room codes, and for hashing client IPs in the limiter |

If either is missing, creating **and** joining are refused (503); `/health` still works.

They are stored as **GitHub Actions secrets** with the same names, and the deploy job pushes them to the Worker (`wrangler secret bulk`, reading JSON from stdin; the values are never on a command line, on disk or in the log). Set or rotate them on the Pi; each command prompts for the value, so it never lands in shell history:

```sh
gh secret set CREATE_PASSCODE
gh secret set ROOM_SIGNING_KEY
gh workflow run ci.yml --ref main   # re-deploys and pushes the new values
```

Rotating `ROOM_SIGNING_KEY` invalidates every existing room link. Rotating `CREATE_PASSCODE` only affects starting new sessions.

The same Cloudflare API token (**Account → Workers Scripts → Edit**) covers deploys and secrets. CI deploy credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) live only in GitHub Actions secrets. Locally, `worker/.dev.vars` (gitignored, see `worker/.dev.vars.example`) holds made-up values. Tests use obviously fake values. GitHub secret scanning and push protection are on. If a secret is ever committed, rotate it: deleting the file doesn't remove it from history.

## Kill switch (stop new sessions)

`CREATION_ENABLED` is also a Worker secret. Starting sessions works only when it is exactly `true`; anything else (including unset) returns `503 creation_disabled`. Existing sessions keep working either way.

Flip it from a phone in under a minute, no code change: **GitHub mobile app → stickyard → Actions → Room creation switch → Run workflow → on/off**. Or from the Pi:

```sh
gh workflow run creation-switch.yml -f creation=off
gh workflow run creation-switch.yml -f creation=on
```

Secrets survive later deploys, so the setting sticks until the switch is run again.

## What Cloudflare may log

Our code logs nothing about requests (a test forbids `console.` in `worker/src`). Workers observability is on, so Cloudflare keeps short-term invocation logs with request metadata: the URL (for `/ws` and `/rooms/check` this includes the **room code**), method, status, headers such as `Origin` and `User-Agent`, approximate location, and possibly the client IP. The create passcode is only ever in a POST body, which is not logged.
