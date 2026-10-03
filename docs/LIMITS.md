# Cloudflare free-plan limits

Checked **2 October 2026** against the live Cloudflare docs. Re-check before designing around any number. Nothing here is designed around yet. These are notes only.

Sources:
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Durable Objects pricing (free allowances): https://developers.cloudflare.com/durable-objects/platform/pricing/
- DO WebSockets / hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Workers WebSocket API: https://developers.cloudflare.com/workers/runtime-apis/websockets/

## Workers (Free)

| Limit | Value | Notes |
|---|---|---|
| Requests | 100,000 / day, resets 00:00 UTC | Over the limit: error 1027 (or fail-open bypass, which doesn't apply to a workers.dev relay) |
| CPU time | 10 ms per HTTP request | Wall-clock time waiting on I/O doesn't count |
| Memory | 128 MB per isolate | |
| Subrequests | 50 per request | |
| Script size | 64 MiB uncompressed (dry-run build today: 771 KiB, 121 KiB gzip) | |
| Workers per account | 100 | |
| Env vars | 64 per Worker, 5 KB each | |
| URL / request headers | 16 KB / 128 KB | |
| WebSocket messages | Opening a WebSocket counts as one request; messages through it do **not** count as Worker requests | From the pricing page |

## Durable Objects (Free)

| Limit | Value | Notes |
|---|---|---|
| Backend | SQLite-backed only on Free | Matches our design |
| Requests | 100,000 / day | Incoming WebSocket messages are billed **20:1** (100 messages = 5 requests) |
| Duration | 13,000 GB-s / day | Billed at 128 MB per active object, so roughly **28.9 object-hours/day** awake. Hibernated objects (and idle objects eligible for hibernation) are not billed for duration |
| SQLite rows read | 5,000,000 / day | |
| SQLite rows written | 100,000 / day | |
| SQLite storage | 5 GB per account, 10 GB per object | |
| Classes | 100 (Free) | |
| CPU per request | 30 s default (configurable to 5 min) | Includes each WebSocket message |
| Row / string / BLOB size | 2 MB | |
| SQL statement length | 100 KB; 100 bound params; 100 columns per table | |
| Key + value (KV API) | 2 MB combined | |
| WebSocket connections | 32,768 per object with the Hibernation API | CPU and memory are the practical limit long before that |
| WebSocket message received | 32 MiB; larger closes the socket with 1009 | Our own cap is `MAX_MESSAGE_BYTES` = 4 KiB |
| `serializeAttachment` | 16,384 bytes per socket | Survives hibernation; lost on close |
| Over any free limit | "further operations of that type will fail with an error" until 00:00 UTC | Hard stop, not a bill. That's the cost cap from the brief, but the UI will need to handle it |

## Flags: numbers that could threaten the plan

1. **Live cursors vs DO requests.** At about 20 cursor messages per second per user and 20:1 billing, one active user costs about 1 request/s (3,600 per hour). Ten people moving cursors for an hour is about 36,000 of the 100,000 daily DO requests. A few workshops a day fit, but cursors are the biggest consumer by far. Consider sending cursors only while moving, lower rates on phones, and coalescing.
2. **SQLite rows written (100k/day).** If every drag batch or keystroke is persisted, a busy session could use thousands of writes. Persist on drop / debounce, not per movement message (slice 2/5 decision).
3. **Duration (~29 object-hours/day awake).** A room with steady cursor traffic never hibernates. Fine for a few rooms a day, tight if rooms are left open with an active tab sending heartbeats. Avoid app-level heartbeats (pings get auto-pongs without waking the object) and let idle rooms hibernate.
4. **Daily hard stop.** When any allowance runs out, operations fail until 00:00 UTC. That's acceptable for a hobby project, but slice 4 (reconnect) should show a clear "relay is over its daily limit" state rather than reconnecting in a loop, which would make it worse.
5. **Worker CPU 10 ms per request.** Fine for routing, Origin checks and HMAC verification of room codes (slice 1). Keep heavy work in the Durable Object, which gets 30 s.

Nothing else looks close: storage, connection count and message size are far above what this app needs.

## Slice 1: what rooms and the limiter cost

Estimates against the free allowances above (checked 2 October 2026).

**Limiter Durable Object (room creation).** Every `POST /rooms` that passes the Origin, config, kill-switch and body checks makes one RPC call to the single `Limiter` object: **1 DO request**. It reads a few rows (lockout, failure counts, today's creations) on every call, but **writes only when a counter changes**: a failed passcode (1 insert, plus 1 lockout row on the 5th), or a granted creation (1 upsert). Old rows are pruned in the same calls. Refused attempts (locked out, over a cap) write nothing. Worst case per day is bounded by the caps: about 50 creations and roughly 50 failures an hour, so well under 2,000 row writes/day even under steady guessing.

**Room codes.** Verified in the Worker with one HMAC before any Durable Object is addressed, so invented or tampered codes cost one Worker request and **zero** DO requests. `GET /rooms/check` (used only after a socket fails to open) is the same.

**Echo traffic.** A room stores nothing (no rows read or written). Each socket opening is 1 Worker request + 1 DO request. Inbound WebSocket messages bill at 20:1, so 100 `say` messages ≈ 5 DO requests; the fan-out to other sockets is outgoing and not billed as requests. The per-socket token bucket (5/s, burst 10) caps one socket at about 0.25 DO requests/s (≈ 900/hour). Per-socket state lives in the WebSocket attachment, so idle rooms hibernate and use no duration.

**Residual risk.** None of this stops a script from spending the **daily request budget** (100,000 Worker requests, 100,000 DO requests): Origin checks don't apply to scripts, invalid codes are cheap but still count as Worker requests, and a valid room link can be used to open many sockets. If that happens, the free plan **fails closed**: requests error until 00:00 UTC, then everything recovers. No bill, no data at risk; the app is simply unavailable for the rest of the day.

## Slice 2: what notes cost

Estimates against the free allowances above (checked 2 October 2026; not re-checked for slice 2).

**Writes (100,000 rows/day).** Only commits write: an add, an edit that changes the text, colour or style, a drop that changes the position, a resize release that changes the size, a delete. Each is **1 row**. Dragging and resizing in progress write nothing (tested). A busy workshop (20 people, 50 notes each edited and moved a few times) is a few thousand row writes. Plus 1 row when a room's tables are first created.

**Reads (5,000,000 rows/day).** Notes are read once when the Durable Object wakes (up to 200 rows, plus 1 for the schema version) and then served from memory. A room that hibernates and wakes often re-reads them each time.

**Requests.** A drag or a resize sends about 20 messages a second (20:1 billing → about 1 DO request/s per person dragging). The per-socket bucket is now 30/s with a burst of 40 (it was 5/s), so a script on one socket can spend up to about 1.5 DO requests/s. Twenty violations within 10 seconds close the socket.

**Storage.** At most 200 notes × about 1.3 KB (slice 2.7 adds seven small columns: size and style keys) = well under 1 MB per room. Rooms don't expire yet (slice 5), so storage grows with the number of rooms that have notes.

**Messages out.** The web accepts server messages up to `MAX_SERVER_MESSAGE_BYTES` (512 KiB). Outgoing messages aren't billed as requests.

**Snapshot size (protocol v4, slice 2.7).** Worst case for a full board of 200 notes: **380,429 bytes (371.5 KiB)**, about 1.9 KB per note, leaving about 140 KiB under the 512 KiB cap. The worst note has 280 lone surrogate characters in its text (JSON escapes each as 6 bytes, `\uXXXX`; 4-byte emoji give 268 KB), the longest keys, 4-digit positions, maximum size and `rev` at `Number.MAX_SAFE_INTEGER`. The same board under protocol v3 was 360,829 bytes: size and style add about 98 bytes per note (about 19.6 KB per full snapshot). The earlier "about 260 KB" figure assumed emoji, not this worst case. `shared/test/noteSize.test.ts` fails if the worst case grows past 400 KiB. Matters for slice 4: a reconnect storm of 20 people on a full board is about 7.4 MB of outgoing snapshots.
