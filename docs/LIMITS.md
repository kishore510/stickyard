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

**Batches (protocol v7, slice 2.8).** A group move, arrange or group delete goes out as `noteBatch` messages of up to `MAX_BATCH_ENTRIES` = 50 entries.
- *Writes:* a final batch of N changed notes is **N row writes** (one per moved, resized or deleted note; unchanged entries write nothing) in one SQLite transaction. Arranging all 200 notes is 200 rows (4 batches); dragging a 50-note selection and dropping it is 50 rows. A busy workshop that arranges often might add a few thousand rows a day, still well inside 100,000. A live group drag (`final: false`) writes nothing (tested).
- *Requests:* a batch is **one message** (one token from the 30/s bucket, and 1/20 of a DO request), whatever its size. The web sends a live group drag at most every 100 ms (`GROUP_MOVE_INTERVAL_MS`), so dragging a group costs about 10 messages a second, half a single-note drag.
- *Entries budget:* entries also spend a separate per-socket bucket, `BATCH_LIMITS` in `worker/src/limits.ts`: **600 entries a second, burst 1,000**. A 50-note live drag needs 500 a second; a 200-note arrange needs 200 at once. A batch over budget is dropped with `rate_limited` naming its notes (the sender rolls them back) and counts as a violation, exactly like the message bucket (20 in 10 s close the socket). Relaying is the main cost here: one live 50-entry batch fans out as a message of about 3.5 KB to each other participant.
- *Message cap:* `MAX_MESSAGE_BYTES` stays at **4 KiB**. The largest valid batch (50 resize entries with 4-digit positions and maximum sizes) is under it (`shared/test/batch.test.ts` checks), so no raise was needed. A `notesBatchApplied` of 50 results is about 5 KB, far under the 512 KiB server message cap.
- *Snapshot:* unchanged by v7 (401,829 bytes worst case; v8 adds z, see below).

**Stacking order (protocol v8, slice z-order).** Bring to front and Send to back go out as `notesOrder` messages of up to 50 note ids.
- *Writes:* only notes whose z actually changes are written, **1 row each**, in one SQLite transaction. Bringing one note to the front is 1 row; pressing it again on a note already on top is **0 rows** (tested), as is any action that leaves the order as it was. Bringing 50 notes to the front is at most 50 rows (fewer where some already sit above the rest in the right order).
- *Renumbering:* z is kept within ±100,000 (`NOTE_Z_LIMIT`). An action (or a new note) that would pass it renumbers the whole room 0..n-1 in the same transaction: up to **200 rows** once. Reaching the bound takes about 100,000 Front (or Back) presses in one room, so this is rare; at the 30/s message bucket a script needs nearly an hour of steady sending to force one, and then another 100,000 to force the next.
- *Requests:* a `notesOrder` is **one message** (one token from the 30/s bucket, 1/20 of a DO request), whatever its size, and its ids spend the same per-socket entries bucket as batches (`BATCH_LIMITS`, 600 a second, burst 1,000). Over budget: dropped with `rate_limited` naming its notes (the sender rolls them back), counted as a violation. A 200-note selection is sent as 4 messages (chunks of 50 in stacking order) and spends 200 entries.
- *Fan-out:* one `notesOrdered` to everyone, with every named note (changed or not) and any note a renumbering moved: about 60 bytes per note, at most 200 notes (about 12 KB), far under the 512 KiB server cap.
- *Message cap:* the largest `notesOrder` (50 ids) is about 1 KB, under `MAX_MESSAGE_BYTES` = 4 KiB (`shared/test/zOrder.test.ts` checks).

**Storage.** At most 30 frames × about 0.3 KB, and at most 200 notes × about 1.3 KB (slice 2.7 adds seven small columns, size and style keys; 2.7.1 one more, the title's alignment; schema 5 one integer, z) = well under 1 MB per room. Since v0.14.0 idle rooms expire (below), so storage no longer grows without bound.

**Messages out.** The web accepts server messages up to `MAX_SERVER_MESSAGE_BYTES` (512 KiB). Outgoing messages aren't billed as requests.

**Frames (protocol v9, slice frames).** Up to `MAX_FRAMES_PER_ROOM` = 30 frames per room, in their own `frames` table (schema 6).
- *Join and reconnect: two messages.* The notes `snapshot` keeps its shape and its worst case (404,229 bytes, below). Frames follow in their own `framesSnapshot`, sent in the same handler step so nothing lands between them. Worst case for the frames message: **15,096 bytes (14.7 KiB)**: 30 frames at the largest size, 60-character titles of lone surrogates (6 bytes each when escaped), the longest colour key and `rev` at `Number.MAX_SAFE_INTEGER` (protocol v9). The notes snapshot's 400 KiB tripwire and 100 KiB headroom rule are unchanged and apply to that message on its own.
- *Frame title style (protocol v10, schema 7):* five keys per frame (`titleFontSize`, `titleBold`, `titleItalic`, `titleTextColor`, `titleAlign`) add 107 bytes per frame at their longest values, so the frames message's worst case is now **18,306 bytes (17.9 KiB)**. That was over the old 16 KiB test cap, so the cap was raised to **20 KiB** (decided 4 October 2026, `shared/test/frameTitleStyle.test.ts`). Why that's fine: it's a separate message from the notes snapshot, about 3.6% of the 512 KiB server cap, and the notes snapshot's tripwire and headroom rule don't change. Rule: a new per-frame field that takes the worst case within 10% of the cap needs a decision first (the test fails above 18,432 bytes, 90% of the cap, so almost any new per-frame field trips it). Storage: five small columns per frame, under 50 bytes a row.
- *Combined reconnect payload:* **422,535 bytes (412.6 KiB)** per person on a full board with a full set of frames (404,229 + 18,306; v9 was 419,325), in two messages, each under the 512 KiB cap.
- *Reconnect storm (slice 4):* 20 people on a full board rejoining at once is now about **8.45 MB** of outgoing messages (20 × 422,535), up from about 8.39 MB in v9 (20 × 419,325) and about 8.1 MB for notes alone (20 × 404,229). Outgoing messages aren't billed as requests; this is bandwidth and CPU in one wake, not budget.
- *Writes:* adding a frame is **2 rows written** (the row and its primary-key index entry; SQLite counts both, and the same is true of adding a note). A title, colour or title style edit that changes something (any mix of fields in one message), a final resize that changes the size, and a final move of the frame alone are **1 row** each; unchanged ones write nothing. A final move that carries N notes is **1 + N rows** at most (only rows that changed), in one transaction. Live moves and resizes write nothing (tested). Deleting a frame is 1 row (plus its index entry) and never touches notes.
- *Requests:* frame messages are ordinary messages under `SOCKET_LIMITS` (30 a second, burst 40). The web throttles live frame moves and resizes like notes (`MOVE_INTERVAL_MS` / `RESIZE_INTERVAL_MS`, about 20 a second).
- *Entries budget:* the note ids a **final** `frameMove` carries (up to 50) spend `BATCH_LIMITS` entries (600 a second, burst 1,000), like a batch; over budget is `rate_limited` naming the frame and its notes (the sender rolls both back) plus a violation. Live moves carry ids too (so others see the notes follow) but don't spend entries; they're throttled and never stored.
- *Message caps:* the largest `frameMove` (50 carried ids, 4-digit position) is about 1 KB, well under `MAX_MESSAGE_BYTES` = 4 KiB, so the carry cap stays at 50. The largest `frameMoved` (50 carried notes, revs at their maximum) is 3,459 bytes.

**Snapshot size (protocol v8, slice z-order).** Worst case for a full board of 200 notes: **404,229 bytes (394.8 KiB)**, about 2.0 KB per note, leaving **117.2 KiB** (120,059 bytes) under the 512 KiB cap, still above the 100 KiB margin we want. z adds 12 bytes per note at its widest (`"z":-100000,`), 2,400 bytes per full snapshot. It is now only **5.2 KiB (5,371 bytes) under the 400 KiB tripwire** in `shared/test/noteSize.test.ts`: the next per-note field of any size will breach it, so that tripwire (or the note shape, for example shorter keys or a lower `rev` ceiling) must be revisited before adding one. The test also fails if the headroom drops below 100 KiB. (Protocol v6, slice 2.7.2: 401,829 bytes. Protocol v5, slice 2.7.1: 384,829 bytes; v6's four title style fields add 85 bytes per note at their longest values, 17,000 bytes per full snapshot. v4: 380,429; v3: 360,829.) The worst note has 280 lone surrogate characters in its text (JSON escapes each as 6 bytes, `\uXXXX`; 4-byte emoji give less), the longest keys, 4-digit positions, maximum size and `rev` at `Number.MAX_SAFE_INTEGER`. This figure is the notes snapshot alone; since protocol v9 frames come in a separate message (below).

**Create with content (protocol v11, slice create with content).** `itemsAdd` adds notes and frames with their full content (size, text, colour, every style field) in one message. Template apply used it first; since v0.12.0 Duplicate and undo restores use it too (below).
- *Writes:* each added note is **2 rows** (the row and its primary-key index entry) and each added frame **2 rows**, the same as `noteAdd` and `frameAdd` (tested: 3 notes + 2 frames = 10 rows). All of one message's inserts go in **one SQLite transaction**. If new notes would pass the z bound, the room's existing notes are renumbered in that same transaction (up to 200 extra rows, 1 each, as for `noteAdd`; as rare as before). Refused items and a message where nothing is added write nothing.
- *Requests:* an `itemsAdd` is **one message** (one token from the 30/s bucket, 1/20 of a DO request), whatever it carries (tested: 30 messages of 2 notes go through, 60 items being more than the burst of 40). The web sends at most 10 a second (`ITEMS_STEP_MS` = 100 ms, a third of the bucket), so typing or dragging alongside still fits.
- *Entries budget:* each note and frame spends **one entry** from `BATCH_LIMITS` (600 a second, burst 1,000), like batch entries. Over budget: the message is dropped with `rate_limited` naming its `clientRef` (the sender rolls back all its items) and counts as a violation. At the web's pace it spends a few hundred a second at most (10 messages of about 20 items with the shortest content), inside the 600.
- *Message cap: decided to keep `MAX_MESSAGE_BYTES` at 4 KiB* (4 October 2026). The web packs items into messages by their actual serialised size (`packItems` in `web/src/rooms/items.ts`, tested never to exceed the cap and to keep order); every single valid item fits in a message on its own. Items per message (`shared/test/itemsAdd.test.ts`): **2** notes at their largest (280 lone-surrogate characters, 6 bytes each escaped), **6** frames with the longest titles, **15** notes or **21** frames with short content (empty text, 12-character refs as the web sends). So the 50-item envelope limit only matters for a raised cap; in practice the byte cap decides. Today's templates (at most 4 frames) are one message each.
- *Fan-out:* one `itemsAdded` to everyone (refs and refusals only in the sender's copy). From a message that fits 4 KiB it is about **4 to 6 KB** (2 maximum notes: 4,183 bytes; 15 short notes: 5,633; 21 short frames: 5,963; 6 maximum frames: 3,923, with ids, revs at `Number.MAX_SAFE_INTEGER` and authors added). The largest the schema allows at all (50 maximum notes, 32-character refs, revs at the maximum) is **103,653 bytes (101.2 KiB)**, about 20% of the 512 KiB server cap (tested). A renumbering at the bound adds one `notesOrdered` (at most 12 KB) before it.
- *Snapshots:* unchanged. The notes snapshot (404,229 bytes) and the frames snapshot (18,306 bytes) and their tripwires are not touched by v11: items are stored as ordinary notes and frames.

**Bar, Duplicate, Undo and Clear board (v0.12.0, web only).** No protocol or storage change; these reuse existing messages, so the costs are the ones above.
- *Duplicate* is an `itemsAdd` (2 rows per copy, one message per packed batch, paced at 10 a second, one `BATCH_LIMITS` entry per copy). It is refused up front, sending nothing, when the board hasn't room for every copy.
- *Undo of a delete or a clear* adds the items back with `itemsAdd`, at the same cost and pace as Duplicate (new ids, new rows). Undo of a move, resize or edit sends the same final `noteBatch`, `noteEdit`, `frameMove`, `frameResize` or `frameEdit` as the original change (1 row per changed item; unchanged ones write nothing). Undo of an add is a batch delete (notes) or a `frameDelete` (frames). The history itself lives only in the page's memory: nothing is stored or sent for it.
- *Clear board* is the notes as final `noteBatch` deletes (4 messages of 50 for a full board, 200 entries, inside the burst of 1,000) and then one `frameDelete` per frame, sent every 50 ms (`CLEAR_FRAME_STEP_MS`, 20 a second): with the four batches, at most 24 messages in the first second, under `SOCKET_LIMITS` (30 a second, burst 40). Writes: 1 row (plus its index entry) per deleted note or frame, as for Delete.
- *Restoring a full board in one undo:* at the 4 KiB cap and with every note at its largest (2 per message) and every frame title at its longest (6 per message), 200 notes and 30 frames pack into **105 `itemsAdd` messages**, about **10.5 seconds** at 10 a second (`packItems`, measured). With short content (15 notes or 21 frames a message) it is about 16 messages, 1.6 seconds. Writes: 460 rows (2 per item), in one transaction per message.

**Reconnect and presence (v0.13.0, web only).** No protocol or storage change; presence uses the existing `joined`, `participant_joined` and `participant_left` messages and costs nothing extra.
- *One reconnect* is what a join costs: **1 Worker request + 1 Durable Object request** to open the socket, two small inbound messages (`hello`, `join`: 1/10 of a DO request at 20:1), and the two snapshots out: **422,535 bytes (412.6 KiB)** combined worst case on a full board with a full set of frames (404,229 + 18,306, as above). No rows are written; the room is read from memory, or from storage (a few hundred rows at most) if the object had hibernated.
- *Retry schedule and cap* (`web/src/connection/reconnect.ts`): after a drop the page tries after about 1, 2, 4, 8, 16, 30, 30 and 30 seconds (±20% jitter, so a room's pages spread out), **at most 8 tries per drop (about 2 minutes)**, then stops and offers Rejoin. Worst case per drop: 8 Worker requests and 8 DO requests (a try that never reaches the relay costs neither). From the third socket in a row that never opened, each failure adds one `GET /health` and one `GET /rooms/check` (Worker only, no DO): at most 6 of each per drop. Tries started by the browser (`online`, the tab visible again) are at least 1 s apart, and `online` starts a new sequence of at most 8. A tab hidden for more than a minute stops trying until it's visible.
- *When the relay looks down* (3 failed opens and a failing health probe): no more sockets; **one `GET /health` a minute while the tab is visible, for at most an hour** (60 Worker requests, 0 DO requests), then Offline. So a stuck or forgotten tab costs at most about 80 Worker requests and 8 DO requests per drop before it stops for good (until someone presses Rejoin or the network comes back).
- *Reconnect storm*: 20 people on a full board rejoining at once (a relay restart or deploy) is about **8.45 MB** of outgoing messages (20 × 422,535, as recorded above), 20 Worker requests and 20 DO requests, spread over a second or so by the jitter. Outgoing messages aren't billed as requests.
- *What a browser can see when the free plan's daily limit is hit* (from Cloudflare's documentation; not tested against the real limit): over the **Workers** request limit, Cloudflare answers with its own error page (error 1027) instead of running the Worker. That page has none of the relay's CORS headers, so `fetch` from the app fails exactly like an unreachable relay, and the WebSocket upgrade fails with no reason given (close code 1006). Over a **Durable Objects** limit, the Worker still runs (so `/health` works), but opening the room fails, and the browser again sees only a socket that never opened. A browser therefore can't tell "over the limit" from "unreachable", or a DO limit from any other failure to open a room. The page claims no more than that: it says the relay "may be unreachable or over its daily limit" only when `/health` also fails, and otherwise just backs off and ends at Offline.

**Idle room expiry (v0.14.0).** No protocol or stored-schema change. Constants in `worker/src/limits.ts`: `ROOM_IDLE_EXPIRY_MS` = 7 days, `ALARM_RESET_SLACK_MS` = 1 hour. (Cloudflare's alarm docs could not be re-checked from the build environment on 4 October 2026: the network blocked developers.cloudflare.com. The figures below are the ones the project owner checked that day.)
- *Alarm cost:* setting the alarm (`setAlarm`) is billed as **1 row written**; reading it (`getAlarm`) is a read. Each alarm firing is **1 DO request**. The alarm is set only when the **last** socket of a room closes, and only when there is no alarm yet or the existing one is more than 1 hour earlier than the new time (the slack rule), so a room costs **at most about 1 row written per hour** for its alarm, however often people come and go. Joining never touches it (tested: 0 rows).
- *Expiry cost:* when the alarm fires with nobody connected, `deleteAll()` empties the room (how Cloudflare bills the rows it removes, at most a few hundred, wasn't checked; it happens once per room) and **one tombstone row** is written (`meta.expired_at`; counted as 2 rows, the row and its index entry). With anyone connected the firing writes nothing.
- *Worst case, a script with a valid room link opening and closing sockets:* each socket costs what it always did (1 Worker request + 1 DO request; Origin doesn't stop scripts). Alarm writes are bounded by the slack rule at about **24 rows a day per room** (one per hour), and **1 DO request a week per room** for the firing. Room links come only from room creation, which is capped (`CREATE_LIMITS`: 50 a day), so the alarm can't be used to multiply writes across invented rooms (invalid codes never reach a Durable Object). A socket held open keeps a room alive; that is "someone is in it".
- *Tombstones:* one small row (a key and an integer) stays per expired room, forever: tens of bytes. An expired room's link opens a socket (1 Worker + 1 DO request), reads the tombstone (1 row) and is closed with 4410; nothing is written (tested).
- *Storage:* a room's notes and frames (well under 1 MB) now go 7 days after its last visit, so storage is bounded by the rooms used in the last week plus one tombstone per expired room. Rooms created before v0.14.0 get their alarm at their next last-close; ones nobody opens again keep their data until then.
