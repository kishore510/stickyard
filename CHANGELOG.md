# Changelog

## 0.1.0 (slice 0: setup)

- npm workspaces: `web/`, `worker/`, `shared/`.
- `shared/`: `PROTOCOL_VERSION = 1`, Zod schemas for `hello` / `welcome` / `error`, `parseMessage` (4 KiB cap, safe JSON parse, schema validation, never throws).
- `worker/`: `GET /health`, `GET /ws` with an Origin allow-list (403 before upgrade), routed to one placeholder SQLite-backed Durable Object using the WebSocket Hibernation API. Replies `welcome`, `version_mismatch`, `bad_message` or `too_large`.
- `web/`: connection-check screen (connecting / connected / please reload / cannot connect), hash routing (`#/`), Worker URL config, `stickyard:` storage-key helper, design tokens (light/dark, `dvh`, safe areas, 44px touch target).
- CI: typecheck, test and build on every push/PR; Pages and Worker deploy on `main`; manual dispatch.
- Docs: CLAUDE.md, README, docs/LIMITS.md.
