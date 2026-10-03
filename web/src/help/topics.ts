import { z } from "zod";
import { blockText, parseMarkdown, type Block } from "./markdown";

/*
 * Help topics: one Markdown file per topic in src/help/topics/, each starting with
 * a small front matter block:
 *
 *   ---
 *   title: Connection
 *   order: 3
 *   summary: What the connection check means.
 *   keywords: relay, reload, offline
 *   ---
 *
 * The file name (without .md) is the topic id, used in `#/help/<id>` and `help:<id>` links.
 * Adding a topic needs only a new file; no component changes.
 */

const FrontMatter = z.object({
  title: z.string().min(1),
  order: z.number().int(),
  summary: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
});
export type FrontMatter = z.infer<typeof FrontMatter>;

export interface HelpTopic extends FrontMatter {
  id: string;
  blocks: Block[];
  /** Lower-case plain text of the body, for search. */
  text: string;
}

export const TOPIC_ID = /^[a-z0-9-]+$/;

/** Splits off and validates the front matter. Throws with the reason if it's missing or invalid. */
export function parseFrontMatter(source: string): { meta: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match?.[1] || match[2] === undefined) throw new Error("missing front matter");
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (!field?.[1] || field[2] === undefined) throw new Error(`bad front matter line: ${line}`);
    const [key, value] = [field[1], field[2]];
    fields[key] =
      key === "order"
        ? Number(value)
        : key === "keywords"
          ? value.split(",").map((k) => k.trim()).filter(Boolean)
          : value.trim();
  }
  return { meta: FrontMatter.parse(fields), body: match[2] };
}

/** Builds topics from `{ path: raw markdown }`, sorted by `order`. */
export function buildTopics(files: Record<string, string>): HelpTopic[] {
  return Object.entries(files)
    .map(([path, raw]) => {
      const id = (path.split("/").at(-1) ?? "").replace(/\.md$/, "");
      if (!TOPIC_ID.test(id)) throw new Error(`bad topic file name: ${path}`);
      const { meta, body } = parseFrontMatter(raw);
      const blocks = parseMarkdown(body);
      return { id, ...meta, blocks, text: blocks.map(blockText).join("\n").toLowerCase() };
    })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export interface SearchResult {
  topic: HelpTopic;
  /** A line of the topic that mentions the search, if the match was in the body. */
  snippet?: string;
}

const terms = (query: string) =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Topics containing every word of the query (in the title, summary, keywords or text),
 * best first: title matches, then keywords and summary, then body text.
 */
export function searchTopics(topics: HelpTopic[], query: string): SearchResult[] {
  const words = terms(query);
  const first = words[0];
  if (first === undefined) return [];
  const scored: { result: SearchResult; score: number }[] = [];
  for (const topic of topics) {
    const title = topic.title.toLowerCase();
    const meta = `${topic.keywords.join(" ")} ${topic.summary}`.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = (title.includes(w) ? 10 : 0) + (meta.includes(w) ? 5 : 0) + (topic.text.includes(w) ? 1 : 0);
      if (s === 0) all = false;
      score += s;
    }
    if (!all) continue;
    const line = topic.blocks.map(blockText).find((t) => t.toLowerCase().includes(first));
    const snippet = line && (line.length > 140 ? `${line.slice(0, 137)}…` : line);
    scored.push({ result: snippet ? { topic, snippet } : { topic }, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.result.topic.order - b.result.topic.order).map((s) => s.result);
}
