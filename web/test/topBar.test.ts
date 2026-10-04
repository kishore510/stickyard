// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { deleteKeyTarget, onBoardBar } from "../src/canvas/deleteKey";
import { boardShortcut } from "../src/canvas/shortcuts";

/*
 * Since v0.15.1 the board actions sit in the top bar, outside the board's element. Keys pressed
 * with focus there (after clicking Duplicate, say) still act on the board; other top-bar
 * controls (the menu) still don't.
 */

function setup() {
  const board = document.createElement("section");
  const bar = document.createElement("div");
  bar.setAttribute("data-board-bar", "");
  const inBar = document.createElement("button");
  bar.append(inBar);
  const menu = document.createElement("button");
  document.body.append(board, bar, menu);
  return { board, inBar, menu };
}

const key = (k: string, target: EventTarget, extra: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  target,
  defaultPrevented: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe("the board bar counts as the board for keys", () => {
  it("onBoardBar is true only inside [data-board-bar]", () => {
    const { inBar, menu } = setup();
    expect(onBoardBar(inBar)).toBe(true);
    expect(onBoardBar(menu)).toBe(false);
    expect(onBoardBar(null)).toBe(false);
  });

  it("Delete with focus on a bar button deletes the selection; on the menu it doesn't", () => {
    const { board, inBar, menu } = setup();
    const state = { multi: true, selection: 2, frameSelected: false, modal: false, board };
    expect(deleteKeyTarget(key("Delete", inBar), state)).toBe("notes");
    expect(deleteKeyTarget(key("Delete", menu), state)).toBeNull();
  });

  it("Ctrl+Z with focus on a bar button is Undo; on the menu it isn't", () => {
    const { board, inBar, menu } = setup();
    const state = { multi: true, modal: false, board };
    expect(boardShortcut(key("z", inBar, { ctrlKey: true }), state)).toBe("undo");
    expect(boardShortcut(key("z", menu, { ctrlKey: true }), state)).toBeNull();
  });
});
