# Stickyard

A real-time collaborative sticky-note whiteboard for workshops and retros. Join by link and a typed name, no accounts.

Personal learning project. Front end on GitHub Pages, relay on a Cloudflare Worker with one Durable Object per room.

See [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md), [docs/PHASE_PLAN.md](docs/PHASE_PLAN.md) and [docs/LIMITS.md](docs/LIMITS.md).

**Status:** slice 0.5 (app shell and design system, v0.2.0). The home page is still the connection check (Pages → WebSocket → Worker → Durable Object → handshake reply), now inside the app shell with Help, What's new and About.

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

Endpoints: `GET /health` returns `{ "ok": true, "protocolVersion": 1 }`. `GET /ws` is the WebSocket (Origin-checked).

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

No secrets are ever committed. Later slices will add these, set only with `wrangler secret put` (production) or `worker/.dev.vars` (local, gitignored):

| Secret | Slice | Purpose |
|---|---|---|
| `CREATE_PASSCODE` | 1 | Gates room creation |
| `ROOM_SIGNING_KEY` | 1 | HMAC key for signed room codes |

CI deploy credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) live only in GitHub Actions secrets. Tests use obviously fake values. GitHub secret scanning and push protection are on. If a secret is ever committed, rotate it: deleting the file doesn't remove it from history.
