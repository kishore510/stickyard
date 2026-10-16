// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_TIME_NOTICE, FirstTimeNotice, SendCheck, estimateTokens } from "../src/ai/SendCheck";
import { LARGE_MODEL, SMALL_MODEL } from "../src/ai/models";

/*
 * The reusable check-before-sending page and the first-time notice (AI part 1, v0.42.0). Test key uses
 * the page without the notice; later AI sessions reuse both.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

async function render(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root?.render(node));
}

describe("the size estimate", () => {
  it("is characters / 3, rounded up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(2)).toBe(1);
    expect(estimateTokens(300)).toBe(100);
    expect(estimateTokens(301)).toBe(101);
  });
});

describe("SendCheck", () => {
  it("shows the model, what's sent, the estimate and where it goes; Cancel is focused", async () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    await render(<SendCheck models={[SMALL_MODEL, LARGE_MODEL]} items={["The word “Hi”", "Your key, in a request header"]} chars={600} onSend={onSend} onCancel={onCancel} />);
    const page = document.querySelector<HTMLElement>("[data-send-check]")!;
    expect(page.textContent).toContain("Claude Haiku 5.5");
    expect(page.textContent).toContain("Claude Sonnet 5.5");
    expect([...page.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["The word “Hi”", "Your key, in a request header"]);
    expect(page.textContent).toContain("About 200 tokens (an estimate: 600 characters ÷ 3)");
    expect(page.textContent).toContain("It goes straight from this browser to api.anthropic.com. Stickyard has no AI server.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => (document.activeElement as HTMLElement).click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    const send = [...page.querySelectorAll("button")].find((b) => b.textContent === "Send")!;
    expect(send.className).toContain("h-touch");
    await act(async () => send.click());
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("shows the first-time notice only when asked and not yet seen; Send marks it seen", async () => {
    const onSeen = vi.fn();
    const onSend = vi.fn();
    await render(<SendCheck models={[SMALL_MODEL]} items={["x"]} chars={1} onSend={onSend} onCancel={() => {}} notice={{ seen: false, onSeen }} />);
    expect(document.querySelector("[data-ai-notice]")?.textContent).toContain(FIRST_TIME_NOTICE);
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Send")!.click());
    expect(onSeen).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("hides the notice once seen", async () => {
    await render(<SendCheck models={[SMALL_MODEL]} items={["x"]} chars={1} onSend={() => {}} onCancel={() => {}} notice={{ seen: true, onSeen: () => {} }} />);
    expect(document.querySelector("[data-ai-notice]")).toBeNull();
  });

  it("the notice says what leaves the device, generically", async () => {
    expect(FIRST_TIME_NOTICE).toBe(
      "What you send leaves this device and goes to Anthropic's API, using your key and your account. In a shared session, board text includes what other people typed. Check your own or your organisation's rules before sending anything sensitive. Shown once.",
    );
    await render(<FirstTimeNotice />);
    expect(document.querySelector("[data-ai-notice]")?.getAttribute("role")).toBe("note");
  });
});
