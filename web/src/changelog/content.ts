import changelogText from "../../../CHANGELOG.md?raw";
import { parseChangelog } from "./parse";

/* The repo's CHANGELOG.md, bundled at build time and shown in What's new. */

export const CHANGELOG_TEXT = changelogText;

/** Parsed releases, newest first, or null if the file couldn't be parsed (then it's shown as text). */
export const CHANGELOG = parseChangelog(changelogText);
