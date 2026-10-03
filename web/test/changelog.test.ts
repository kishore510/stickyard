import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANGELOG } from "../src/changelog/content";
import { compareVersions, parseChangelog } from "../src/changelog/parse";
import { VERSION_INFO } from "../src/version";

const SAMPLE = `# Changelog

Intro.

## [0.1.0] - 2026-10-02

### Added
- First.

## [0.10.0] - 2026-10-05

### Changed
- Wrapped
  item.

### Fixed
- Bug.
`;

describe("parseChangelog", () => {
  it("parses releases newest first, with sections", () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      {
        version: "0.10.0",
        date: "2026-10-05",
        sections: [
          { title: "Changed", items: ["Wrapped item."] },
          { title: "Fixed", items: ["Bug."] },
        ],
      },
      { version: "0.1.0", date: "2026-10-02", sections: [{ title: "Added", items: ["First."] }] },
    ]);
  });

  it("returns null for text in another format", () => {
    expect(parseChangelog("# Changelog\n\n- loose item")).toBeNull();
    expect(parseChangelog("nothing here")).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });
});

describe("CHANGELOG.md", () => {
  it("parses, and its newest entry is this version", () => {
    expect(CHANGELOG).not.toBeNull();
    expect(CHANGELOG?.[0]?.version).toBe(VERSION_INFO.version);
  });

  it("every workspace package has the same version", () => {
    for (const path of ["../../package.json", "../package.json", "../../shared/package.json", "../../worker/package.json"]) {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string };
      expect(pkg.version, path).toBe(VERSION_INFO.version);
    }
  });
});
