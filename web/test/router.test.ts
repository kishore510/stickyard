import { describe, expect, it } from "vitest";
import { parentSheet, parseHash, sheetHash, type Sheet } from "../src/router";

describe("parseHash", () => {
  it.each(["", "#", "#/"])("%j is home with no sheet", (hash) => {
    expect(parseHash(hash)).toEqual({ name: "home", sheet: null });
  });

  it.each<[string, Sheet]>([
    ["#/help", { kind: "help" }],
    ["#/help/names", { kind: "help-topic", id: "names" }],
    ["#/changelog", { kind: "changelog" }],
    ["#/about", { kind: "about" }],
  ])("%j opens a sheet over home", (hash, sheet) => {
    expect(parseHash(hash)).toEqual({ name: "home", sheet });
    expect(sheetHash(sheet)).toBe(hash);
  });

  it.each(["#/room/ABC", "#/nope", "#x", "#/help/", "#/help/Bad_Id", "#/help/a/b", `#/help/${"a".repeat(65)}`])(
    "%j is not found",
    (hash) => {
      expect(parseHash(hash)).toEqual({ name: "not-found" });
    },
  );

  it("a topic's parent is Help; other sheets have none", () => {
    expect(parentSheet({ kind: "help-topic", id: "names" })).toEqual({ kind: "help" });
    expect(parentSheet({ kind: "about" })).toBeNull();
  });
});
