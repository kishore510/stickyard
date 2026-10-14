# Load and correctness harness (dev only)

Not part of any deployed bundle: the Worker bundles only `worker/src`, the web build only `web/`.
Nothing here may ever point at the deployed Worker or the Pages site.

- `npm run load` starts a local relay (`wrangler dev` on 127.0.0.1, obviously fake secrets,
  throwaway storage under the system temp folder) and runs `scenarios/*.load.ts` against it.
- Every URL goes through `localTarget` (`target.ts`), which refuses anything but plain
  http/ws on 127.0.0.1, localhost or [::1]. Its tests run with the root `npm test`.
- Room codes and host tokens are signed by the harness with the fake key (room creation is
  capped at 5 a day per client, so it is not used).
- Simulated pages are the web's own `RoomSession` (`web/src/rooms/session.ts`) over Node's
  WebSocket with the local dev Origin; every frame each page sends and receives is recorded.
- Results go to `out/report.jsonl` (gitignored). Timings from a shared machine are rough;
  message counts, rows and correctness are what to trust.

Knobs: `LOAD_SEED` and `LOAD_ACTIONS` (burst), `LOAD_PORT` (default 8799), `LOAD_STORM_PORT`
(8798), `LOAD_DOWN_MS` (deploy downtime, default 8000).
