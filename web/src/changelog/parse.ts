/*
 * Parser for CHANGELOG.md ("Keep a Changelog" style):
 *
 *   ## [0.2.0] - 2026-10-03
 *   ### Added
 *   - Something new.
 *
 * Returns null when the text doesn't look like that, so the caller can show it as plain text.
 */

export interface ChangelogSection {
  /** "Added", "Changed", "Fixed", or whatever heading the file uses. */
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  /** ISO date (YYYY-MM-DD), if given. */
  date?: string;
  sections: ChangelogSection[];
}

const RELEASE = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECTION = /^###\s+(.+?)\s*$/;
const ITEM = /^[-*]\s+(.+)$/;
/** Indented lines continue the previous item. */
const CONTINUATION = /^\s{2,}(\S.*)$/;

/** Semver-ish comparison: numeric parts compared as numbers; "Unreleased" sorts first. */
export function compareVersions(a: string, b: string): number {
  const rank = (v: string) =>
    /^unreleased$/i.test(v)
      ? [Infinity]
      : v
          .replace(/^v/, "")
          .split(/[.-]/)
          .map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Releases, newest first, or null if the text isn't in the expected format. */
export function parseChangelog(text: string): ChangelogRelease[] | null {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | undefined;
  let section: ChangelogSection | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const r = RELEASE.exec(line);
    if (r?.[1]) {
      release = r[2] ? { version: r[1], date: r[2], sections: [] } : { version: r[1], sections: [] };
      section = undefined;
      releases.push(release);
      continue;
    }
    // Before the first release: the title and intro text.
    if (!release) {
      if (/^(#{2,}|[-*]\s)/.test(line)) return null;
      continue;
    }
    const s = SECTION.exec(line);
    if (s?.[1]) {
      section = { title: s[1], items: [] };
      release.sections.push(section);
      continue;
    }
    const item = ITEM.exec(line);
    if (item?.[1] && section) {
      section.items.push(item[1].trim());
      continue;
    }
    const more = CONTINUATION.exec(raw);
    if (more?.[1] && section && section.items.length > 0) {
      section.items[section.items.length - 1] += ` ${more[1].trim()}`;
      continue;
    }
    return null;
  }

  if (releases.length === 0) return null;
  for (const r of releases) r.sections = r.sections.filter((s) => s.items.length > 0);
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}
