import { describe, expect, it, vi } from "vitest";
import { tabTarget, trapFocus, type FocusDocument } from "../src/lib/focusTrap";

describe("tabTarget", () => {
  const items = ["a", "b", "c"];
  it("wraps from last to first and first to last", () => {
    expect(tabTarget(items, "c", false)).toBe("a");
    expect(tabTarget(items, "a", true)).toBe("c");
  });
  it("lets the browser move focus in the middle", () => {
    expect(tabTarget(items, "b", false)).toBeNull();
  });
  it("pulls focus back in from outside", () => {
    expect(tabTarget(items, "elsewhere", false)).toBe("a");
    expect(tabTarget(items, "elsewhere", true)).toBe("c");
  });
});

describe("trapFocus", () => {
  it("focuses in, calls onEscape, and restores focus on release", () => {
    const opener = { focus: vi.fn() };
    const first = { focus: vi.fn() };
    let listener: ((e: KeyboardEvent) => void) | undefined;
    const doc: FocusDocument = {
      activeElement: opener,
      addEventListener: (_t, l) => (listener = l),
      removeEventListener: () => (listener = undefined),
    };
    const onEscape = vi.fn();
    const release = trapFocus({ querySelector: () => first, querySelectorAll: () => [first] }, doc, onEscape);
    expect(first.focus).toHaveBeenCalled();
    listener?.({ key: "Escape", stopPropagation: () => {} } as KeyboardEvent);
    expect(onEscape).toHaveBeenCalled();
    release();
    expect(opener.focus).toHaveBeenCalled();
    expect(listener).toBeUndefined();
  });
});
