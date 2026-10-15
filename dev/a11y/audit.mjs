// npm run a11y (dev only): an accessibility pass over the app at 360, 768 and 1280 px, light and
// dark. Starts a local relay (wrangler dev on 127.0.0.1, obviously fake secrets, throwaway storage)
// and the Vite dev server, seeds a generic room from Node, then drives Chromium: axe-core on each
// surface (welcome, Help, About, the room with its menu, sheets, palette, Properties, selection,
// reactions, arrows, groups, QR share, and the voting, silent, lock and follow strips), a keyboard
// walk (focus order and visible focus), 44 px touch targets on phones, reduced motion and live
// announcements. Writes dev/a11y/out/report.json (gitignored) and prints a summary.
// Never points at the deployed Worker or the Pages site: both URLs are checked to be local.
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(import.meta.dirname, "out");
const RELAY = "http://127.0.0.1:8797";
const WEB = "http://127.0.0.1:5174";
for (const url of [RELAY, WEB]) {
  const u = new URL(url);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("a11y audit only runs locally");
}
// Obviously fake, local only.
const SIGNING_KEY = "a11y-signing-key-not-a-secret";
const SIZES = [
  { name: "360", width: 360, height: 740 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 800 },
];
const THEMES = ["light", "dark"];
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const children = [];
function start(cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...env } });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push({ child, log: () => log });
}
const stopAll = () => children.forEach(({ child }) => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // gone
  }
});
async function waitFor(url, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not start\n${children.map((c) => c.log().slice(-1500)).join("\n")}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => b.toString("base64url");

function fakeRoom() {
  const id = b64(randomBytes(16));
  const sig = b64(createHmac("sha256", SIGNING_KEY).update(`stickyard-room-v1:${id}`).digest().subarray(0, 16));
  return { id, code: `${id}.${sig}`, hostToken: b64(createHmac("sha256", SIGNING_KEY).update(`stickyard-host-v1:${id}`).digest()) };
}

/** A raw protocol socket from Node (the seeder, "Sam", who is host). */
async function rawSocket(code) {
  const ws = new WebSocket(`${RELAY.replace("http", "ws")}/ws?room=${encodeURIComponent(code)}`, { headers: { Origin: "http://localhost:5174" } });
  const queue = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].ok(m);
    else queue.push(m);
  };
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error("seed socket failed"));
  });
  const next = (type) => {
    const i = queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((ok) => waiters.push({ type, ok }));
  };
  return { send: (m) => ws.send(JSON.stringify(m)), next, close: () => ws.close() };
}

async function seed(room) {
  const s = await rawSocket(room.code);
  s.send({ type: "hello", protocolVersion: JSON.parse(await (await fetch(`${RELAY}/health`)).text()).protocolVersion });
  await s.next("welcome");
  s.send({ type: "join", name: "Sam", key: b64(randomBytes(16)) });
  await s.next("joined");
  s.send({ type: "claimHost", token: room.hostToken });
  await s.next("hostGranted");
  const NOTE = { w: 160, h: 160, fontSize: "m", bold: false, italic: false, textColor: "auto", align: "left", titleAlign: "left", titleFontSize: "m", titleBold: false, titleItalic: false, titleTextColor: "auto" };
  const FRAME = { titleFontSize: "m", titleBold: true, titleItalic: false, titleTextColor: "auto", titleAlign: "left" };
  const colors = ["yellow", "pink", "blue", "green", "orange", "purple"];
  s.send({
    type: "itemsAdd",
    clientRef: "seed",
    frames: [{ ref: "f1", x: 900, y: 500, w: 900, h: 500, title: "Went well", color: "green", ...FRAME }],
    notes: colors.map((color, i) => ({ ref: `n${i}`, x: 950 + (i % 3) * 270, y: 580 + Math.floor(i / 3) * 200, ...NOTE, color, text: `Idea ${i + 1}\nShort details` })),
    shapes: [{ ref: "s1", kind: "rect", x: 2000, y: 600, w: 200, h: 120, text: "Decision", fill: "neutral", stroke: "neutral", strokeWidth: "thin", strokeStyle: "solid", fontSize: "m", bold: false, italic: false, underline: false, textColor: "auto", align: "center", valign: "middle" }],
  });
  const added = await s.next("itemsAdded");
  const ids = added.notes.map((n) => n.note.id);
  s.send({ type: "claimVoter", key: b64(randomBytes(16)) });
  await s.next("voterGranted");
  for (const key of ["thumbs_up", "heart"]) {
    s.send({ type: "reactionSet", noteId: ids[0], key, on: true });
    await s.next("reactionMine");
  }
  s.send({ type: "connectorAdd", clientRef: "a1", start: { item: ids[0], anchor: "auto" }, end: { item: ids[1], anchor: "auto" }, route: "straight", dash: "solid", width: "medium", ink: "neutral", startHead: "none", endHead: "arrow" });
  await s.next("connectorAdded");
  s.send({ type: "groupCreate", clientRef: "g1", label: "Themes", color: "blue", members: [ids[3], ids[4]] });
  await s.next("groupCreated");
  return s;
}

/** Runs axe on the page and returns its violations, trimmed. */
async function axe(page, surface) {
  await page.evaluate(AXE);
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 20).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 160), summary: n.failureSummary?.split("\n").slice(0, 3).join(" ") })), count: v.nodes.length }));
  });
  return result.map((v) => ({ surface, ...v }));
}

/** Tab through the page: what gets focus, in order, and whether focus is visible. */
async function keyboardWalk(page, steps = 45) {
  const seen = [];
  await page.locator("body").focus().catch(() => {});
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "";
      const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name, visible, onScreen: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 };
    });
    seen.push(info);
  }
  return seen;
}

/** Interactive elements smaller than 44 x 44 px (phones). */
async function smallTargets(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="radio"], [role="checkbox"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (el.closest(".react-flow__node, .react-flow__edge, [data-connector-id]")) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || el.closest('[aria-hidden="true"]')) return false;
        return r.width < 44 || r.height < 44;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}] ${Math.round(r.width)}x${Math.round(r.height)}`;
      }),
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const persist = mkdtempSync(join(tmpdir(), "stickyard-a11y-"));
  start("npx", ["wrangler", "dev", "--ip", "127.0.0.1", "--port", "8797", "--persist-to", persist, "--var", "CREATE_PASSCODE:a11y-passcode", "--var", `ROOM_SIGNING_KEY:${SIGNING_KEY}`, "--var", "CREATION_ENABLED:true"], join(ROOT, "worker"));
  // The dev page talks to this local relay (web/src/config.ts reads VITE_WORKER_URL).
  start("npx", ["vite", "--host", "127.0.0.1", "--port", "5174", "--strictPort"], join(ROOT, "web"), { VITE_WORKER_URL: RELAY });
  const report = { violations: [], keyboard: {}, smallTargets: {}, reducedMotion: {}, announcements: {}, followStrip: {} };
  try {
    await waitFor(`${RELAY}/health`);
    await waitFor(`${WEB}/`);
    const browser = await chromium.launch({ executablePath: existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined });
    try {
      for (const theme of THEMES) {
        for (const size of SIZES) {
          const tag = `${size.name}-${theme}`;
          if (process.env.A11Y_ONLY && !process.env.A11Y_ONLY.split(",").includes(tag)) continue;
          const room = fakeRoom();
          const sam = await seed(room);
          const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, hasTouch: size.width < 768, reducedMotion: "reduce" });
          await context.addInitScript(({ theme }) => {
            localStorage.setItem("stickyard:theme", theme);
            localStorage.setItem("stickyard:name", "Alex");
            // Every live-region change, for the announcements check.
            window.__live = [];
            new MutationObserver((list) => {
              for (const m of list) {
                const region = (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('[aria-live], [role="status"], [role="alert"], [role="log"]');
                if (!region) continue;
                const text = region.textContent?.trim();
                if (text) window.__live.push({ at: Date.now(), politeness: region.getAttribute("aria-live") ?? region.getAttribute("role"), text: text.slice(0, 120), id: region.id || region.getAttribute("data-live") || region.className.slice(0, 40) });
              }
            }).observe(document, { subtree: true, childList: true, characterData: true });
          }, { theme });
          const page = await context.newPage();
          const v = report.violations;

          await page.goto(`${WEB}/#/`);
          await page.waitForLoadState("networkidle");
          v.push(...(await axe(page, `welcome ${tag}`)));
          for (const hash of ["#/help", "#/about"]) {
            await page.goto(`${WEB}/${hash}`);
            await page.waitForTimeout(600);
            v.push(...(await axe(page, `${hash} ${tag}`)));
          }

          await page.goto(`${WEB}/#/room/${room.code}`);
          await page.waitForTimeout(800);
          v.push(...(await axe(page, `join form ${tag}`)));
          await page.getByRole("button", { name: "Join", exact: true }).click();
          await page.locator(".react-flow__node").first().waitFor({ timeout: 20_000 });
          await page.waitForTimeout(1500);
          v.push(...(await axe(page, `room ${tag}`)));
          report.keyboard[tag] = await keyboardWalk(page);
          await page.keyboard.press("Escape");
          if (size.width < 768) report.smallTargets[tag] = await smallTargets(page);

          // Selection: a note selected (Properties from md up; the editor sheet on phones), then the reaction picker.
          const note = page.locator('[aria-roledescription="note"]').first();
          if (size.width >= 768) {
            if (size.width < 1024) await page.keyboard.press("]");
            await note.click();
            await page.waitForTimeout(400);
            v.push(...(await axe(page, `note selected ${tag}`)));
            await page.locator("[data-reactions] [data-reaction-add]").first().click().catch(() => {});
          } else {
            await note.tap();
            await page.waitForTimeout(500);
            v.push(...(await axe(page, `note editor sheet ${tag}`)));
            await page.locator("[data-reactions-section] [data-reaction-add]").first().tap().catch(() => {});
          }
          await page.waitForTimeout(400);
          v.push(...(await axe(page, `reaction picker ${tag}`)));
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          if (size.width < 768) await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
          if (size.width >= 768) {
            // Two notes: the selection bar.
            await page.keyboard.press("Control+a");
            await page.waitForTimeout(400);
            v.push(...(await axe(page, `selection ${tag}`)));
            await page.keyboard.press("Escape");
            // The group chip and the Stencils tab.
            await page.locator("[data-group-chip]").first().click().catch(() => {});
            await page.waitForTimeout(300);
            v.push(...(await axe(page, `group selected ${tag}`)));
            await page.keyboard.press("Escape");
            await page.locator('aside[aria-label="Palette"] [role="tab"]', { hasText: "Stencils" }).click().catch(() => {});
            await page.waitForTimeout(300);
            v.push(...(await axe(page, `stencils tab ${tag}`)));
          }

          // Menu, Participants, Share session.
          await page.getByRole("button", { name: /^Menu/ }).click();
          await page.waitForTimeout(300);
          v.push(...(await axe(page, `menu ${tag}`)));
          await page.getByRole("menuitem", { name: "Participants" }).click();
          await page.waitForTimeout(500);
          v.push(...(await axe(page, `participants ${tag}`)));
          // Follow Sam from Participants, if offered: the follow strip.
          const follow = page.getByRole("button", { name: /Follow/ }).first();
          if (await follow.count()) {
            await follow.click();
            await page.waitForTimeout(500);
          }
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
          report.followStrip[tag] = await page.getByText(/^Following /).count();
          v.push(...(await axe(page, `following ${tag}`)));
          await page.getByRole("button", { name: /^Menu/ }).click();
          await page.getByRole("menuitem", { name: "Share session" }).click();
          await page.locator("svg[data-qr]").waitFor({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(300);
          v.push(...(await axe(page, `share ${tag}`)));
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
          // Export board (v0.40.0): the sheet from the menu, phones too.
          await page.getByRole("button", { name: /^Menu/ }).click();
          await page.getByRole("menuitem", { name: "Export board" }).click();
          await page.locator("[data-export-sheet]").waitFor({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(300);
          v.push(...(await axe(page, `export ${tag}`)));
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);

          // The host (Sam) runs the session: a vote, then a silent round, the lock and a timer.
          const liveFrom = await page.evaluate(() => Date.now());
          sam.send({ type: "voteStart", budget: 3 });
          await page.waitForTimeout(800);
          v.push(...(await axe(page, `voting strip ${tag}`)));
          sam.send({ type: "voteStop" });
          await page.waitForTimeout(800);
          v.push(...(await axe(page, `voting results ${tag}`)));
          sam.send({ type: "voteClear" });
          sam.send({ type: "silentStart" });
          await page.waitForTimeout(800);
          v.push(...(await axe(page, `silent strip ${tag}`)));
          sam.send({ type: "silentReveal" });
          sam.send({ type: "lockSet", locked: true });
          sam.send({ type: "timerStart", durationMs: 120_000 });
          await page.waitForTimeout(800);
          v.push(...(await axe(page, `locked with timer ${tag}`)));
          sam.send({ type: "lockSet", locked: false });
          sam.send({ type: "say", text: "Hello from Sam" });
          await page.waitForTimeout(1500);
          report.announcements[tag] = (await page.evaluate(() => window.__live)).filter((a) => a.at >= liveFrom);

          // Reduced motion: anything still animating (longer than 10 ms) with the preference on.
          await page.getByRole("button", { name: /^Menu/ }).click();
          await page.waitForTimeout(50);
          report.reducedMotion[tag] = await page.evaluate(() =>
            document.getAnimations().flatMap((a) => {
              const t = a.effect?.getTiming?.();
              const d = typeof t?.duration === "number" ? t.duration : 0;
              const el = a.effect?.target;
              return d > 10 ? [`${a.animationName ?? a.transitionProperty ?? "animation"} ${d}ms on ${el?.tagName?.toLowerCase()}.${String(el?.className ?? "").slice(0, 40)}`] : [];
            }),
          );
          await page.keyboard.press("Escape");
          await context.close();
          sam.close();
          console.log(`checked ${tag}`);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    stopAll();
    rmSync(persist, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
  const byRule = new Map();
  for (const x of report.violations) {
    const key = `${x.impact} ${x.id}: ${x.help}`;
    const entry = byRule.get(key) ?? { surfaces: new Set(), targets: new Set() };
    entry.surfaces.add(x.surface);
    for (const n of x.nodes) entry.targets.add(n.target);
    byRule.set(key, entry);
  }
  console.log(`\naxe violations by rule (${report.violations.length} surface hits):`);
  for (const [key, e] of byRule) console.log(`- ${key}\n    surfaces: ${[...e.surfaces].join(", ")}\n    targets: ${[...e.targets].slice(0, 8).join(" | ")}`);
  for (const [tag, list] of Object.entries(report.smallTargets)) console.log(`\nunder 44 px at ${tag}: ${list.length}\n  ${list.join("\n  ")}`);
  for (const [tag, walk] of Object.entries(report.keyboard)) {
    const hidden = walk.filter((s) => s && !s.visible).map((s) => `${s.tag}[${s.name}]`);
    console.log(`\nkeyboard ${tag}: ${walk.filter(Boolean).length} stops, without visible focus: ${[...new Set(hidden)].join(", ") || "none"}`);
  }
  for (const [tag, list] of Object.entries(report.reducedMotion)) console.log(`reduced motion ${tag}: ${list.length ? list.join("; ") : "nothing animates"}`);
  console.log(`follow strip shown: ${JSON.stringify(report.followStrip)}`);
  for (const [tag, list] of Object.entries(report.announcements)) console.log(`announcements ${tag}: ${list.map((a) => `[${a.politeness}] ${a.text}`).join(" / ")}`);
}

main().catch((error) => {
  stopAll();
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
