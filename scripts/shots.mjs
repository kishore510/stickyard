// npm run shots: screenshots of the welcome page and a seeded room at 360, 768 and 1280 px,
// in light and dark, into shots/ (gitignored). Starts a local relay (wrangler dev, fake
// secrets, throwaway storage) and the Vite dev server, then drives Chromium.
//
// Chromium: CHROMIUM_PATH, else /opt/pw-browsers/chromium when present, else Playwright's own.
// Extra pages: SHOTS_HASHES="#/help,#/about" (each shot over the welcome page).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "shots");
const RELAY = "http://127.0.0.1:8787";
const WEB = "http://127.0.0.1:5173";
// Obviously fake, local only (never a real secret).
const PASSCODE = "shots-passcode";
const SIGNING_KEY = "shots-signing-key-not-a-secret";
const SIZES = [
  { name: "360", width: 360, height: 740 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];
const EXTRA = (process.env.SHOTS_HASHES ?? "").split(",").filter(Boolean);

const children = [];
function start(cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push({ child, log: () => log, cmd: `${cmd} ${args[0] ?? ""}` });
  return child;
}
function stopAll() {
  for (const { child } of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function waitFor(url, label, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = children.map((c) => `--- ${c.cmd}\n${c.log().slice(-2000)}`).join("\n");
  throw new Error(`${label} did not start (${url})\n${tail}`);
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
}

/** Creates a room and fills it with generic content, from a page on the dev origin. */
async function seedRoom(page) {
  await page.goto(`${WEB}/`);
  return page.evaluate(
    async ({ relay, passcode, sharedPath }) => {
      const p = await import(/* @vite-ignore */ `/@fs${sharedPath}`);
      const res = await fetch(`${relay}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (!res.ok) throw new Error(`POST /rooms ${res.status}`);
      const { code, hostToken } = await res.json();
      const ws = new WebSocket(`${relay.replace("http", "ws")}/ws?room=${encodeURIComponent(code)}`);
      const next = (type) =>
        new Promise((ok, fail) => {
          const on = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === type) {
              ws.removeEventListener("message", on);
              ok(m);
            } else if (m.type === "error") fail(new Error(`relay error ${m.code}`));
          };
          ws.addEventListener("message", on);
        });
      await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
      ws.send(JSON.stringify({ type: "hello", protocolVersion: p.PROTOCOL_VERSION }));
      await next("welcome");
      ws.send(JSON.stringify({ type: "join", name: "Sam" }));
      await next("snapshot");
      const note = (ref, x, y, color, text) => ({ ref, x, y, ...p.NOTE_DEFAULTS, color, text });
      const shape = (ref, kind, x, y, text) => ({ ref, kind, x, y, ...p.shapeDefaults(kind), text });
      const frame = (ref, x, y, color, title) => ({ ref, x, y, w: 640, h: 400, color, title, ...p.FRAME_DEFAULTS });
      ws.send(
        JSON.stringify({
          type: "itemsAdd",
          clientRef: "shots",
          frames: [frame("f1", 1000, 600, "green", "Went well"), frame("f2", 1700, 600, "pink", "To improve")],
          notes: [
            note("n1", 1040, 680, "yellow", "Pairing\nShort reviews helped"),
            note("n2", 1240, 680, "green", "Demo day 🎉"),
            note("n3", 1740, 680, "pink", "Flaky tests\nTwo reruns a day"),
            note("n4", 1940, 760, "blue", "Long stand-ups"),
          ],
          shapes: [
            shape("s1", "text", 1000, 500, "Sprint retro"),
            shape("s2", "rect", 1040, 1060, "Decision: keep pairing"),
            shape("s3", "oval", 1740, 1060, "Owner?"),
            shape("s4", "diamond", 2140, 1060, "Ship?"),
          ],
        }),
      );
      await next("itemsAdded");
      ws.close();
      return { code, hostToken, roomId: code.split(".")[0] };
    },
    { relay: RELAY, passcode: PASSCODE, sharedPath: join(ROOT, "shared/src/index.ts") },
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const persist = mkdtempSync(join(tmpdir(), "stickyard-shots-"));
  start(
    "npx",
    [
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "8787",
      "--persist-to",
      persist,
      "--var",
      `CREATE_PASSCODE:${PASSCODE}`,
      "--var",
      `ROOM_SIGNING_KEY:${SIGNING_KEY}`,
      "--var",
      "CREATION_ENABLED:true",
    ],
    join(ROOT, "worker"),
  );
  start("npx", ["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], join(ROOT, "web"));
  try {
    await waitFor(`${RELAY}/health`, "Relay (wrangler dev)");
    await waitFor(`${WEB}/`, "Vite");
    const browser = await chromium.launch({ executablePath: chromiumPath() });
    try {
      const seedPage = await browser.newPage();
      const room = await seedRoom(seedPage);
      await seedPage.close();
      const written = [];
      for (const theme of THEMES) {
        for (const size of SIZES) {
          const context = await browser.newContext({
            viewport: { width: size.width, height: size.height },
            colorScheme: theme,
            hasTouch: size.width < 768,
          });
          await context.addInitScript(
            ({ theme, roomId, hostToken }) => {
              localStorage.setItem("stickyard:theme", theme);
              localStorage.setItem("stickyard:name", "Alex");
              localStorage.setItem(`stickyard:host:${roomId}`, hostToken);
            },
            { theme, roomId: room.roomId, hostToken: room.hostToken },
          );
          const page = await context.newPage();
          const shot = async (name) => {
            const file = join(OUT, `${name}-${size.name}-${theme}.png`);
            await page.screenshot({ path: file });
            written.push(file);
          };

          await page.goto(`${WEB}/#/`);
          await page.waitForLoadState("networkidle");
          await shot("welcome");
          for (const hash of EXTRA) {
            await page.goto(`${WEB}/${hash}`);
            await page.waitForTimeout(600);
            await shot(hash.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "page");
          }

          await page.goto(`${WEB}/#/room/${room.code}`);
          await page.getByRole("button", { name: "Join", exact: true }).click();
          await page.locator(".react-flow__node").first().waitFor({ timeout: 20_000 });
          await page.waitForTimeout(1500); // first fit and fonts
          await shot("room");
          await context.close();
        }
      }
      console.log(`${written.length} screenshots in ${OUT}:`);
      for (const file of written) console.log(`  ${file.slice(ROOT.length + 1)}`);
    } finally {
      await browser.close();
    }
  } finally {
    stopAll();
    rmSync(persist, { recursive: true, force: true });
  }
}

main().catch((error) => {
  stopAll();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
