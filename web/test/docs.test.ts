import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/changelog/parse";

// Docs ship with the code: these checks fail CI when the status docs fall behind a release.

const root = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "7 October 2026" -> "2026-10-07", or null. */
function isoFromLong(text: string): string | null {
  const m = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2] ?? "");
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${(m[1] ?? "").padStart(2, "0")}`;
}

/** The "Last updated: <d Month yyyy>" date at the top of a doc, as yyyy-mm-dd. */
function lastUpdated(doc: string): string | null {
  const m = /^Last updated: (\d{1,2} [A-Z][a-z]+ \d{4})/m.exec(doc);
  return m ? isoFromLong(m[1] ?? "") : null;
}

/** The last cell of every row of the first table under "## <heading>". */
function statusCells(doc: string, heading: RegExp): string[] {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && heading.test(l));
  if (start < 0) return [];
  const cells: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|") || /^\|[-| ]+\|$/.test(line)) continue;
    const parts = line.split("|").map((c) => c.trim());
    cells.push(parts[parts.length - 2] ?? "");
  }
  return cells.slice(1); // the header row
}

const mentions = (cell: string, version: string): boolean =>
  new RegExp(`\\bv${version.replace(/\./g, "\\.")}(?![\\d.])`).test(cell);

const releases = parseChangelog(root("CHANGELOG.md"));
const newest = releases[0];
const plan = root("docs/PHASE_PLAN.md");
const brief = root("docs/PROJECT_BRIEF.md");
const statusDocs = [
  { name: "PHASE_PLAN.md", cells: statusCells(plan, /Status at a glance/) },
  { name: "PROJECT_BRIEF.md", cells: statusCells(brief, /Status/) },
];

describe("docs helpers", () => {
  it("reads long dates and Last updated lines", () => {
    expect(isoFromLong("7 October 2026")).toBe("2026-10-07");
    expect(isoFromLong("7 Octember 2026")).toBeNull();
    expect(lastUpdated("# T\n\nLast updated: 12 March 2027 (thread 3).")).toBe("2027-03-12");
    expect(lastUpdated("no date")).toBeNull();
  });

  it("reads the status column of a table", () => {
    const doc = "## Status\n\n| A | Status |\n|---|---|\n| x | Done (v0.2.0) |\n| y | In review |\n\n## Next\n| z | Done |";
    expect(statusCells(doc, /Status/)).toEqual(["Done (v0.2.0)", "In review"]);
    expect(mentions("Done (v0.2.0)", "0.2.0")).toBe(true);
    expect(mentions("Done (v0.2.0)", "0.2")).toBe(false);
    expect(mentions("Done (v0.21.0)", "0.2.0")).toBe(false);
  });
});

describe("status docs keep up with the changelog", () => {
  it("has a newest release", () => {
    expect(newest).toBeDefined();
  });

  for (const { name, cells } of statusDocs) {
    it(`${name} marks the newest release Done`, () => {
      expect(cells.length).toBeGreaterThan(0);
      const done = cells.filter((c) => /^Done\b/.test(c) && mentions(c, newest?.version ?? ""));
      expect(done, `no "Done (... v${newest?.version} ...)" status row in ${name}`).not.toHaveLength(0);
    });

    it(`${name} has no released version still "in review"`, () => {
      const stale = cells.filter((c) => /in review/i.test(c) && releases.some((r) => mentions(c, r.version)));
      expect(stale, `${name}: released but still in review`).toEqual([]);
    });
  }

  it("README status names the newest release", () => {
    const status = /^\*\*Status:\*\* (.*)$/m.exec(root("README.md"))?.[1] ?? "";
    expect(mentions(status, newest?.version ?? "")).toBe(true);
  });

  for (const [name, doc] of [
    ["PHASE_PLAN.md", plan],
    ["PROJECT_BRIEF.md", brief],
  ] as const) {
    it(`${name} "Last updated" is not older than the newest release`, () => {
      const date = lastUpdated(doc);
      expect(date, `${name} needs a "Last updated: d Month yyyy" line`).not.toBeNull();
      expect((date ?? "") >= (newest?.date ?? ""), `${name} Last updated ${date} < ${newest?.date}`).toBe(true);
    });
  }
});

describe("CLAUDE.md stays small and current", () => {
  const claude = root("CLAUDE.md");

  it("is at most 6 KB (area detail goes in docs/architecture/)", () => {
    expect(new TextEncoder().encode(claude).length).toBeLessThanOrEqual(6 * 1024);
  });

  it("states the current protocol and stored-schema versions", () => {
    const protocol = /export const PROTOCOL_VERSION = (\d+);/.exec(root("shared/src/protocol.ts"))?.[1];
    const schema = /export const SCHEMA_VERSION = (\d+);/.exec(root("worker/src/noteStore.ts"))?.[1];
    expect(claude).toContain(`\`PROTOCOL_VERSION = ${protocol}\``);
    expect(claude).toContain(`\`SCHEMA_VERSION = ${schema}\``);
  });

  it("links architecture files that exist", () => {
    const index = root("docs/architecture/README.md");
    const files = [...index.matchAll(/\]\(([a-z-]+\.md)\)/g)].map((m) => m[1] ?? "");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(existsSync(new URL(`../../docs/architecture/${file}`, import.meta.url)), file).toBe(true);
  });
});
