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

describe("trapFocus, stacked (a sheet opened over another, v0.32.0)", () => {
  function fakeDoc() {
    const listeners = new Set<(e: KeyboardEvent) => void>();
    const doc: FocusDocument = {
      activeElement: null,
      addEventListener: (_t, l) => listeners.add(l),
      removeEventListener: (_t, l) => listeners.delete(l),
    };
    const press = (key: string) => {
      for (const l of [...listeners]) l({ key, stopPropagation: () => {}, preventDefault: () => {}, shiftKey: false } as KeyboardEvent);
    };
    return { doc, press };
  }
  const box = () => {
    const item = { focus: vi.fn() };
    return { querySelector: () => item, querySelectorAll: () => [item] };
  };

  it("only the topmost trap handles Escape; the one under it takes over once the top is released", () => {
    const { doc, press } = fakeDoc();
    const under = vi.fn();
    const top = vi.fn();
    const releaseUnder = trapFocus(box(), doc, under);
    const releaseTop = trapFocus(box(), doc, top);
    press("Escape");
    expect(top).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
    releaseTop();
    press("Escape");
    expect(under).toHaveBeenCalledTimes(1);
    releaseUnder();
  });
});
