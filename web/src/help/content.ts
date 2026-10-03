import { buildTopics } from "./topics";

/* Help topics, bundled at build time from src/help/topics/*.md. */

const files = import.meta.glob<string>("./topics/*.md", { query: "?raw", import: "default", eager: true });

export const HELP_TOPICS = buildTopics(files);

export const topicById = (id: string) => HELP_TOPICS.find((t) => t.id === id);

/** The topic shown as the highlighted card at the top of Help. */
export const QUICK_START_ID = "quick-start";
