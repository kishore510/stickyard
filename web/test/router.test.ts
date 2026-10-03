import { describe, expect, it } from "vitest";
import { parseHash } from "../src/router";

describe("parseHash", () => {
  it.each(["", "#", "#/"])("%j is home", (hash) => {
    expect(parseHash(hash)).toEqual({ name: "home" });
  });

  it.each(["#/room/ABC", "#/nope", "#x"])("%j is not found (no other routes in slice 0)", (hash) => {
    expect(parseHash(hash)).toEqual({ name: "not-found" });
  });
});
