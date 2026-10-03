import { ChevronRight, Rocket, Search } from "lucide-react";
import { Input } from "../components/ui/input";
import { useMediaQuery } from "../lib/useMediaQuery";
import { openSheet } from "../shell/nav";
import { MEDIA } from "../styles/breakpoints";
import { HELP_TOPICS, QUICK_START_ID, topicById } from "./content";
import { Markdown } from "./Markdown";
import { searchTopics } from "./topics";

const openTopic = (id: string) => openSheet({ kind: "help-topic", id });

/** A full-width row that opens a topic. */
function TopicRow({ title, detail, onClick }: { title: string; detail?: string | undefined; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-touch w-full cursor-pointer items-center gap-ms rounded-md px-ms py-sm text-left text-sm transition-colors hover:bg-surface-muted active:bg-surface-muted"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium text-fg">{title}</span>
          {detail && <span className="line-clamp-2 text-xs text-fg-muted">{detail}</span>}
        </span>
        <ChevronRight aria-hidden="true" className="size-icon-sm shrink-0 text-fg-muted" />
      </button>
    </li>
  );
}

/** Help home. `query` lives in the sheet host, so Back from a topic returns to the same results. */
export function HelpHome({ query, setQuery }: { query: string; setQuery: (query: string) => void }) {
  // Only put focus in the search box with a mouse: on touch it would pop up the keyboard.
  const finePointer = useMediaQuery(MEDIA.finePointer);
  const quickStart = topicById(QUICK_START_ID);
  const trimmed = query.trim();
  const results = searchTopics(HELP_TOPICS, query);

  return (
    <div className="flex flex-col gap-md pb-md">
      <div role="search">
        <label className="relative block">
          <span className="sr-only">Search help</span>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-ms size-icon-sm -translate-y-1/2 text-fg-muted" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search help"
            className="pl-xl"
            data-autofocus={finePointer || undefined}
          />
        </label>
      </div>

      {trimmed ? (
        <section aria-label="Search results" className="flex flex-col gap-xs">
          <p className="px-ms text-xs text-fg-muted" role="status" aria-live="polite">
            {results.length === 0
              ? `No topics match “${trimmed}”. Try a different word, like “name” or “reload”.`
              : `${results.length} ${results.length === 1 ? "topic" : "topics"} found`}
          </p>
          <ul className="flex flex-col">
            {results.map((r) => (
              <TopicRow key={r.topic.id} title={r.topic.title} detail={r.snippet} onClick={() => openTopic(r.topic.id)} />
            ))}
          </ul>
        </section>
      ) : (
        <>
          {quickStart && (
            <button
              type="button"
              onClick={() => openTopic(quickStart.id)}
              className="flex min-h-touch cursor-pointer items-center gap-ms rounded-lg border border-border bg-accent-subtle p-md text-left transition-colors hover:border-accent"
            >
              <Rocket aria-hidden="true" className="size-icon-lg shrink-0 text-accent" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-fg">{quickStart.title}</span>
                <span className="text-xs text-fg-muted">{quickStart.summary}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-icon-sm shrink-0 text-fg-muted" />
            </button>
          )}
          <section aria-labelledby="help-topics" className="flex flex-col gap-xs">
            <h3 id="help-topics" className="px-ms text-xs font-semibold tracking-wide text-fg-muted uppercase">
              Topics
            </h3>
            <ul className="flex flex-col">
              {HELP_TOPICS.filter((t) => t.id !== QUICK_START_ID).map((t) => (
                <TopicRow key={t.id} title={t.title} onClick={() => openTopic(t.id)} />
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

export function HelpTopicPage({ id }: { id: string }) {
  const topic = topicById(id);
  if (!topic) {
    return (
      <p className="text-sm text-fg-muted">
        This topic isn’t available.{" "}
        <button type="button" className="inline-flex min-h-touch cursor-pointer items-center font-medium text-accent underline" onClick={() => openSheet({ kind: "help" })}>
          See all help topics
        </button>
      </p>
    );
  }
  return (
    <div className="pb-md">
      <Markdown blocks={topic.blocks} onTopic={openTopic} />
    </div>
  );
}
