// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "@stickyard/shared";
import { CODE, button, cleanupUi, click, inRoom, installUi, named, sam, settle } from "./helpers/ui";
import { roomLink } from "../src/rooms/link";
import { encodeQr, qrPath } from "../src/share/qr";

/*
 * QR join (v0.32.0, web only): a "Share session" sheet with a QR code of the join link, the link
 * as text, Copy link and a Large toggle. Opened from Session in the menu and from Invite in
 * Participants (everyone who can copy the link today). Generic fixtures only (Sam, test-room).
 */

beforeEach(installUi);
afterEach(cleanupUi);

const q = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector);
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const shareDialog = () => dialogs().find((d) => d.querySelector("h2")?.textContent === "Share session");
const qr = () => q<SVGSVGElement>("svg[data-qr]");
const joinLink = () => roomLink(CODE, window.location.origin, import.meta.env.BASE_URL);

async function key(k: string) {
  await act(async () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
  await settle();
}

async function openParticipants() {
  await click(q('header [aria-label^="Participants"]'));
}

async function openFromMenu() {
  await click(q('header button[aria-label^="Menu"]'));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.includes("Share session"));
  await click(item);
}

/** Every attribute name in the SVG and its children. */
const attributeNames = (el: Element): string[] => [...el.attributes].map((a) => a.name).concat([...el.children].flatMap(attributeNames));

describe("Share session: where it opens", () => {
  it("Participants > Invite has Share session for everyone (a guest here), next to Copy link", async () => {
    await inRoom({ isWide: false });
    await openParticipants();
    const invite = q('section[aria-labelledby="invite-heading"]');
    expect(button("Copy link", invite!)).toBeDefined();
    await click(button("Share session", invite!));
    expect(shareDialog()).toBeDefined();
  });

  it("the menu's Session group has Share session (a wide screen, a guest)", async () => {
    await inRoom({ isWide: true });
    await openFromMenu();
    expect(shareDialog()).toBeDefined();
  });

  it("not offered outside a session", async () => {
    await inRoom();
    expect(shareDialog()).toBeUndefined();
  });
});

describe("Share session: the code", () => {
  it("shows a QR code of exactly the join link Copy link copies, the link as text, and Copy link", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await inRoom();
    await openFromMenu();
    const sheet = shareDialog()!;
    const svg = qr();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("QR code for the join link");
    expect(q("path", svg!)?.getAttribute("d")).toBe(qrPath(encodeQr(joinLink())!));
    expect(q("[data-share-link]", sheet)?.textContent).toBe(joinLink());
    await click(button("Copy link", sheet));
    expect(writeText).toHaveBeenCalledWith(joinLink());
    const status = q('[role="status"]', sheet);
    expect(status?.textContent).toContain("Link copied");
  });

  it("the SVG has no external references, scripts or event attributes", async () => {
    await inRoom();
    await openFromMenu();
    const svg = qr()!;
    const names = attributeNames(svg);
    expect(names.filter((n) => n.startsWith("on"))).toEqual([]);
    expect(names.filter((n) => /href|src/.test(n))).toEqual([]);
    expect(svg.querySelectorAll("script, image, use, foreignObject, a, style").length).toBe(0);
    expect(svg.outerHTML).not.toMatch(/url\(|https?:|javascript:/);
  });

  it("dark modules on a light panel, the same in light and dark themes", async () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      await inRoom();
      await openFromMenu();
      const svg = qr()!;
      expect(q("rect", svg)?.getAttribute("style")).toContain("var(--sy-brand-ink)");
      expect(q("path", svg)?.getAttribute("style")).toContain("var(--sy-note-fg)");
      await cleanupUi();
      installUi();
    }
  });

  it("hostile names and room content never reach the sheet's markup", async () => {
    const hostile: Participant = { ...sam, name: '<img src=x onerror="alert(1)">Sam' };
    await inRoom({ others: [hostile] });
    await openFromMenu();
    const sheet = shareDialog()!;
    expect(sheet.querySelectorAll("img, script, iframe").length).toBe(0);
    expect(sheet.innerHTML).not.toContain("onerror");
    expect(sheet.textContent).not.toContain("Sam");
  });
});

describe("Share session: the sheet", () => {
  it("Escape closes only the share sheet; focus returns to the Share session button in Participants", async () => {
    await inRoom({ isWide: false });
    await openParticipants();
    const opener = button("Share session")!;
    opener.focus();
    await click(opener);
    expect(shareDialog()).toBeDefined();
    expect(shareDialog()!.contains(document.activeElement)).toBe(true);
    await key("Escape");
    expect(shareDialog()).toBeUndefined();
    expect(dialogs().some((d) => d.querySelector("h2")?.textContent === "Participants")).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("the close button closes it and focus returns to the menu button", async () => {
    await inRoom();
    await openFromMenu();
    await click(named("Close", shareDialog()!));
    expect(shareDialog()).toBeUndefined();
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Menu/);
  });

  it("Large makes the code fill the sheet, and toggles back", async () => {
    await inRoom();
    await openFromMenu();
    const large = button("Large", shareDialog()!)!;
    expect(large.getAttribute("aria-pressed")).toBe("false");
    await click(large);
    expect(large.getAttribute("aria-pressed")).toBe("true");
    expect(shareDialog()!.dataset.large).toBe("true");
    expect(qr()?.getAttribute("data-large")).toBe("true");
    await click(large);
    expect(shareDialog()!.dataset.large).toBeUndefined();
  });

  it("a link too long for a QR code: the link, Copy link, and a message; no throw", async () => {
    const { ShareBody } = await import("../src/share/ShareSheet");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const long = `https://example.test/${"x".repeat(600)}#/room/test-room`;
    await act(async () => root.render(<ShareBody link={long} />));
    expect(q("svg[data-qr]", host)).toBeNull();
    expect(q("[data-qr-fallback]", host)?.textContent).toMatch(/too long/i);
    expect(q("[data-share-link]", host)?.textContent).toBe(long);
    expect(button("Copy link", host)).toBeDefined();
    await act(async () => root.unmount());
  });

  it("the link and room code never reach a log, and nothing is stored", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await inRoom();
    const stored = { local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage).sort() };
    await openFromMenu();
    await click(button("Copy link", shareDialog()!));
    await click(button("Large", shareDialog()!));
    await key("Escape");
    const logged = spies.flatMap((s) => s.mock.calls.flat().map((a) => String(a)));
    expect(logged.filter((line) => line.includes(CODE) || line.includes(joinLink()))).toEqual([]);
    expect({ local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage).sort() }).toEqual(stored);
  });
});
